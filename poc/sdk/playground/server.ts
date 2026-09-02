/**
 * Interactive playground server (npm run playground -> http://localhost:8667).
 *
 * A control panel over the running PoC stack: spawn USERS (payer-less wallets), compose INTENTS of
 * several types against different contracts, and spawn SOLVERS whose decision loop (see -> simulate ->
 * price -> decide -> act) streams into a per-solver log. Everything else — races, reverts on consumed H,
 * auction locks, outbids — happens on the real chain and is reported as it lands.
 *
 * Intent types:
 *   vault  BTC -> >= minOut bvBTC shares (solver deposits its own RBTC into the Vault and delivers shares)
 *   rbtc   BTC -> >= minOut native RBTC (plain best-execution swap)
 *   token  BTC -> >= minOut TOK (an ERC-20; the playground token is open-mint, so acquiring it is free
 *          for solvers — its "cost" in the pricing sim is a configured reference price, not a real one)
 *
 * "Route via auction" places a broker seed bid (minOut + 1 wei) the moment the intent is submitted,
 * engaging the genesis auction's settlement lock immediately — direct settles then revert and only
 * bidding solvers can win it. Without the seed bid the lock only engages if some solver chooses to bid
 * first, and a fast solver will usually settle at minOut before that.
 *
 * The input side is modelled with depositForPegin (as in the experiments): creating an intent escrows
 * its input against a synthetic btcTxid, playing the role of the user's peg-in.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Contract, ContractFactory, JsonRpcProvider, Network, Wallet, getBytes, hexlify, id, randomBytes } from "ethers";
import grieferArtifact from "../src/abi/Griefer.json" with { type: "json" };
import { buildIntent, randomH } from "../src/intent.js";
import { Solver } from "../src/solver.js";
import { depositForPegin, peginOf } from "../src/settlement.js";
import { auction, placeBid, placeBidToken, executeAuction, bidOf, lockedUntil, withdrawCredit, creditOf } from "../src/auction.js";
import { deployVault, vault, vaultDeposit, vaultApprove, sharesOf, vaultWithdraw } from "../src/vault.js";
import { deployToken, token, mint, approve, balanceOf } from "../src/token.js";
import { deployPool, deployTokenVault, pool, tokenVault, reserves, addLiquidity, removeLiquidity, lpBalanceOf, lpApprove, tvDeposit, tvApprove, tvSharesOf, tvWithdraw } from "../src/amm.js";
import { BtcRpc } from "../src/btcrpc.js";
import { Bridge } from "../src/bridge.js";
import { Rpc, sleep, waitFor } from "../src/client.js";
import { RPC_A, SETTLEMENT_ADDR, RBTC, COW_KEY } from "../src/config.js";

const PORT = 8667;
const rpc = new Rpc(RPC_A);
const GAS_COST = 1_000_000_000_000n; // ~1e12 wei pricing-sim allowance for a settle round-trip

// ---------- state ----------
interface UserRec { id: number; label: string; wallet: Wallet; btcAddr?: string }
type IntentType = "vault" | "rbtc" | "token" | "lpvault";
interface IntentRec {
  id: number; H: string; rawHex: string; userId: number; type: IntentType;
  input: bigint; minOut: bigint; outputToken: string; expiry: number; btcTxid: string;
  viaAuction: boolean; created: number;
}
interface SolverRec {
  id: number; label: string; key: string; addr: string; strategy: "fast" | "picky" | "auction";
  marginBps: number; log: { t: string; line: string }[]; startBal: bigint; running: boolean;
  handled: Set<string>; bidOn: Map<string, IntentType>; // auctions I have live escrow in, for recovery
}
const users: UserRec[] = [];
const intents: IntentRec[] = [];
const solvers: SolverRec[] = [];
const feed: { t: string; line: string }[] = [];
let vaultAddr = "", tokenAddr = "", poolAddr = "", tokenVaultAddr = "";
let seq = 0;

// ---------- failure-mode state (E18 scenarios, interactive) ----------
let grieferAddr = "";                      // unpayable contract bidder (no receive) — deployed on demand
const stalledH = new Set<string>();        // intents whose execute() playground solvers withhold, to demo lock decay

// ---------- observability: the BTC-side item and the H-keyed settlement record ----------
const SETTLED_TOPIC = id("Settled(bytes32,address,address,uint256,uint256)");
const settleTxCache = new Map<string, { tx: string; solver: string; block: number }>();

/** The peg-in as bitcoind sees it: mempool vs confirmed, and the OP_RETURN payload (which carries H). */
async function btcTxInfo(btcTxidHex: string): Promise<{ confirmations: number; mempool: boolean; opReturn: string | null } | null> {
  if (!btcEnabled) return null;
  const v = await viaBtc(() => btc.getRawTransactionVerbose(btcTxidHex.replace(/^0x/, ""))).catch(() => null);
  if (!v) return null;
  const asm = (v.vout || []).map((o) => o.scriptPubKey?.asm || "").find((a) => a.startsWith("OP_RETURN"));
  return { confirmations: v.confirmations ?? 0, mempool: !((v.confirmations ?? 0) > 0), opReturn: asm ? asm.replace("OP_RETURN ", "") : null };
}

/** The settlement contract's record for H: the Settled event's tx (whose calldata carried the raw
 *  signed intent — the commitment's opening) and the solver that sent it. Cached once found. */
async function settleInfo(H: string): Promise<{ tx: string; solver: string; block: number } | null> {
  const hit = settleTxCache.get(H);
  if (hit) return hit;
  const logs = await rpc.call<{ transactionHash: string; blockNumber: string }[]>("eth_getLogs",
    [{ fromBlock: "0x1", toBlock: "latest", address: SETTLEMENT_ADDR, topics: [SETTLED_TOPIC, H] }]).catch(() => []);
  if (!logs || logs.length === 0) return null;
  const l = logs[0];
  const tx = await rpc.getTx(l.transactionHash).catch(() => null);
  const info = { tx: l.transactionHash, solver: (tx as { from?: string } | null)?.from ?? "?", block: parseInt(l.blockNumber, 16) };
  settleTxCache.set(H, info);
  return info;
}

// --- real BTC side (bitcoind regtest). The BTC genuinely moves (user address -> federation, with the
// RSKIP170 OP_RETURN naming the settlement contract); only the RSK-side credit stays modelled via
// depositForPegin, because full SPV registration takes ~100 header relays per intent (E14 proved it).
const btc = new BtcRpc();
let btcEnabled = false, faucetAddr = "", federationAddr = "";
let btcChain: Promise<unknown> = Promise.resolve();
function viaBtc<T>(fn: () => Promise<T>): Promise<T> {
  const p = btcChain.then(fn, fn);
  btcChain = p.catch(() => undefined);
  return p;
}
async function btcBalanceOf(addr?: string): Promise<number> {
  if (!btcEnabled || !addr) return 0;
  const utxos = await btc.listUnspent([addr]).catch(() => []);
  return utxos.reduce((s, u) => s + u.amount, 0);
}
let fedCache = { at: 0, amount: 0 };
async function federationBalance(): Promise<number> {
  if (!btcEnabled) return 0;
  if (Date.now() - fedCache.at < 4000) return fedCache.amount;
  const r = await viaBtc(() => btc.scanTxOutSet(federationAddr)).catch(() => null);
  if (r) fedCache = { at: Date.now(), amount: r.total_amount };
  return fedCache.amount;
}

/** The definitive win/loss answer: MY transaction's receipt, not the intent's global status. */
async function myReceipt(hash: string): Promise<"mined-ok" | "reverted" | "unknown"> {
  await waitFor(async () => {
    const r = await rpc.getReceipt(hash).catch(() => null);
    return r !== null && r.blockNumber !== null;
  }, 20000);
  const r = await rpc.getReceipt(hash).catch(() => null);
  return r === null || r.blockNumber === null ? "unknown" : r.status === "0x1" ? "mined-ok" : "reverted";
}

const now = () => new Date().toLocaleTimeString();
const note = (line: string) => { feed.unshift({ t: now(), line }); if (feed.length > 80) feed.pop(); };
const slog = (s: SolverRec, line: string) => { s.log.unshift({ t: now(), line }); if (s.log.length > 120) s.log.pop(); };
const fmt = (wei: bigint) => (Number(wei) / 1e18).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");

// cow funds everything; serialise its txs to avoid nonce races
let cowChain: Promise<unknown> = Promise.resolve();
function viaCow<T>(fn: () => Promise<T>): Promise<T> {
  const p = cowChain.then(fn, fn);
  cowChain = p.catch(() => undefined);
  return p;
}
function cowW(): Wallet {
  const provider = new JsonRpcProvider(rpc.url, new Network("rsk-regtest", 33), { staticNetwork: true });
  return new Wallet(COW_KEY, provider);
}
async function fundFromCow(to: string, weis: bigint): Promise<void> {
  await viaCow(async () => {
    const tx = await cowW().sendTransaction({ to, value: weis, gasLimit: 100_000, gasPrice: 1_000_000, type: 0, chainId: 33 });
    await tx.wait();
  });
}

const grieferOv = { gasLimit: 900_000, gasPrice: 1_000_000, type: 0, chainId: 33 } as const;

async function ensureGriefer(): Promise<string> {
  if (grieferAddr) return grieferAddr;
  grieferAddr = await viaCow(async () => {
    const f = new ContractFactory(grieferArtifact.abi, grieferArtifact.bytecode, cowW());
    const c = await f.deploy({ gasLimit: 1_500_000, gasPrice: 1_000_000, type: 0, chainId: 33 });
    await c.waitForDeployment();
    return c.getAddress();
  });
  note(`GRIEFER deployed (${grieferAddr.slice(0, 10)}…) — a contract bidder that CANNOT receive RBTC. Pre-hardening, its win bricked the intent ("winner pay failed") and outbidding it was impossible ("outbid refund failed").`);
  return grieferAddr;
}

async function grieferBid(intentId: number): Promise<void> {
  const it = intents.find((x) => x.id === intentId);
  if (!it) throw new Error("no such intent");
  if (it.type !== "rbtc") throw new Error("the griefer bids native RBTC only — pick a swap (rbtc) intent");
  const addr = await ensureGriefer();
  const a = auction(rpc.url);
  const b = await bidOf(a, it.H).catch(() => null);
  const amount = (b && b.amount > it.minOut ? b.amount : it.minOut) + it.input / 50n;
  await viaCow(async () => {
    const g = new Contract(addr, grieferArtifact.abi, cowW());
    const tx = await g.doBid(await a.getAddress(), it.rawHex, { ...grieferOv, value: amount });
    await tx.wait();
  });
  note(`GRIEFER bid ${fmt(amount)} RBTC on ${it.H.slice(0, 10)}… — if it wins, watch execute succeed anyway: its input becomes pull-payment credit it can never claim. Outbid it and the refund becomes credit too.`);
}

async function grieferWithdrawAttempt(): Promise<void> {
  if (!grieferAddr) throw new Error("no griefer deployed yet — place a griefer bid first");
  const a = auction(rpc.url);
  const owed = await creditOf(a, grieferAddr).catch(() => 0n);
  try {
    await viaCow(async () => {
      const g = new Contract(grieferAddr, grieferArtifact.abi, cowW());
      const tx = await g.doWithdraw(await a.getAddress(), grieferOv);
      await tx.wait();
    });
    note(`griefer withdraw SUCCEEDED (unexpected — did it grow a receive()?); credit was ${fmt(owed)} RBTC`);
  } catch {
    note(`griefer's withdraw REVERTED in its own tx (it cannot receive RBTC) — ${fmt(owed)} RBTC of credit stays stranded, its loss alone. The ledger, the settlement, everyone else: untouched.`);
  }
}

// ---------- intent lifecycle ----------
async function intentStatus(it: IntentRec): Promise<string> {
  const consumed = await rpc.ethCall(SETTLEMENT_ADDR, "0x6346e832" + it.H.slice(2)).then((r) => BigInt(r) !== 0n).catch(() => false);
  if (consumed) return "SETTLED";
  const head = await rpc.blockNumber();
  if (head >= it.expiry) return "EXPIRED";
  const locked = await lockedUntil(auction(rpc.url), it.H).catch(() => 0n);
  if (locked !== 0n) return Number(locked) > head ? "AUCTION · bidding" : "AUCTION · executable";
  // lock gone but a bid exists: exclusivity DECAYED (deadline + GRACE passed unexecuted) —
  // direct settlement is open again at minOut, and execute() still works until H is consumed
  const b = await bidOf(auction(rpc.url), it.H).catch(() => null);
  if (b && b.deadline !== 0n) return "AUCTION · decayed";
  return "OPEN";
}

// ---------- solver brain ----------
/** RBTC cost of acquiring `amount` of the output asset (the pricing sim). */
async function costOf(type: IntentType, amount: bigint): Promise<bigint> {
  if (type === "rbtc") return amount;                // deliver native RBTC
  if (type === "vault") return amount;               // 1:1 deposit mints shares
  if (type === "token") return amount / 10n;         // open-mint; 0.1 RBTC/TOK reference price
  // lpvault: vLP is 1:1 with LP; minting `amount` LP needs proportional RBTC (TOK side is open-mint)
  const r = await reserves(pool(rpc.url, poolAddr));
  if (r.lpSupply === 0n) return amount;
  return (amount * r.rbtc) / r.lpSupply + 1n;
}

/** Current balance of the output asset for `who`. */
async function heldOutput(type: IntentType, who: string): Promise<bigint> {
  if (type === "vault") return sharesOf(vault(rpc.url, vaultAddr), who).catch(() => 0n);
  if (type === "token") return balanceOf(token(rpc.url, tokenAddr), who).catch(() => 0n);
  if (type === "lpvault") return tvSharesOf(tokenVault(rpc.url, tokenVaultAddr), who).catch(() => 0n);
  return 0n;
}

/**
 * Ensure `who` holds >= amount of the output asset, running the real acquisition route for the
 * shortfall — for lpvault that is the COMPOUND route: mint TOK, add RBTC+TOK liquidity, vault the LP.
 */
async function ensureOutput(type: IntentType, amount: bigint, key: string, addr: string): Promise<void> {
  const held = await heldOutput(type, addr);
  if (held >= amount || type === "rbtc") return;
  const need = amount - held;
  if (type === "vault") {
    const v = vault(rpc.url, vaultAddr, key);
    await vaultDeposit(v, need); await sleep(1200);
  } else if (type === "token") {
    const t = token(rpc.url, tokenAddr, key);
    await mint(t, addr, need); await sleep(1200);
  } else {
    // swap -> LP -> vault: compute the proportional legs from live reserves, with a 1% buffer
    const r = await reserves(pool(rpc.url, poolAddr));
    const rbtcLeg = (need * r.rbtc) / r.lpSupply + (need * r.rbtc) / r.lpSupply / 100n + 1n;
    const tokLeg = (rbtcLeg * r.tok) / r.rbtc;
    const t = token(rpc.url, tokenAddr, key);
    await mint(t, addr, tokLeg); await sleep(1200);
    await approve(t, poolAddr, tokLeg); await sleep(1200);
    await addLiquidity(pool(rpc.url, poolAddr, key), rbtcLeg, tokLeg); await sleep(1200);
    const lp = await lpBalanceOf(pool(rpc.url, poolAddr), addr);
    await lpApprove(pool(rpc.url, poolAddr, key), tokenVaultAddr, lp); await sleep(1200);
    await tvDeposit(tokenVault(rpc.url, tokenVaultAddr, key), lp); await sleep(1200);
  }
}

/** Approve `spender` to pull `amount` of the output asset from the solver. */
async function approveOutput(type: IntentType, spender: string, amount: bigint, key: string): Promise<void> {
  if (type === "vault") { await vaultApprove(vault(rpc.url, vaultAddr, key), spender, amount); await sleep(1200); }
  else if (type === "token") { await approve(token(rpc.url, tokenAddr, key), spender, amount); await sleep(1200); }
  else if (type === "lpvault") { await tvApprove(tokenVault(rpc.url, tokenVaultAddr, key), spender, amount); await sleep(1200); }
}

/** Liquidate idle output-asset holdings back toward RBTC (a losing solver recovering its capital). */
async function recoverOutput(s: SolverRec, type: IntentType): Promise<void> {
  if (type === "rbtc" || type === "token") return; // nothing sunk (RBTC never left; TOK was free)
  if (type === "vault") {
    const v = vault(rpc.url, vaultAddr, s.key);
    const stuck = await sharesOf(v, s.addr);
    if (stuck > 0n) { await vaultWithdraw(v, stuck); slog(s, `recovered ${fmt(stuck)} RBTC of sunk deposit via vault.withdraw`); }
  } else {
    const tv = tokenVault(rpc.url, tokenVaultAddr, s.key);
    const shares = await tvSharesOf(tv, s.addr);
    if (shares > 0n) {
      await tvWithdraw(tv, shares); await sleep(1200);
      const p = pool(rpc.url, poolAddr, s.key);
      const lp = await lpBalanceOf(p, s.addr);
      if (lp > 0n) await removeLiquidity(p, lp);
      slog(s, `unwound ${fmt(shares)} vLP back through the vault and pool (RBTC leg recovered; TOK was free anyway)`);
    }
  }
}

const unitOf = (t: IntentType) => (t === "rbtc" ? "RBTC" : t === "vault" ? "bvBTC" : t === "token" ? "TOK" : "vLP");

/** Pull-payment sweep: execute() CREDITS the winner (and any fallen-back refunds) instead of
 *  pushing RBTC, so a solver must withdraw to realise its PnL. Cheap no-op when credit is 0. */
async function sweepCredit(s: SolverRec): Promise<void> {
  const a = auction(rpc.url, s.key);
  const owed = await creditOf(a, s.addr).catch(() => 0n);
  if (owed <= 0n) return;
  await withdrawCredit(a);
  slog(s, `withdrew ${fmt(owed)} RBTC of pull-payment credit from the auction (winner input / refunds)`);
}

async function tryFill(s: SolverRec, it: IntentRec): Promise<void> {
  const status = await intentStatus(it);
  if (status === "SETTLED" || status === "EXPIRED") {
    // if I have live escrow in this auction and someone else won (or it expired), recover my capital
    if (s.bidOn.has(it.H)) {
      const b = await bidOf(auction(rpc.url, s.key), it.H).catch(() => null);
      if (b && b.bidder.toLowerCase() !== s.addr.toLowerCase()) await recoverOutput(s, it.type).catch(() => undefined);
      else await sweepCredit(s).catch(() => undefined); // I won — collect the credited input
      s.bidOn.delete(it.H);
    }
    s.handled.add(it.H);
    return;
  }

  const input = await peginOf(rpc.url, it.btcTxid);
  const cost = await costOf(it.type, it.minOut);
  const margin = input - cost - GAS_COST;
  const marginBps = input > 0n ? Number((margin * 10_000n) / input) : -1;
  const solver = new Solver(rpc.url, s.key);
  const a = auction(rpc.url, s.key);
  const unit = unitOf(it.type);

  // decayed: exclusivity lapsed (deadline + GRACE passed unexecuted). Direct settlement is open
  // again at minOut for everyone; execute() also still works — so auction solvers race the field.
  if (status === "AUCTION · decayed") {
    if (s.strategy === "auction") {
      if (stalledH.has(it.H)) {
        if (!s.handled.has(it.H + ":stall")) { s.handled.add(it.H + ":stall"); slog(s, `execute on ${it.H.slice(0, 10)}… is STALLED by scenario — lock has decayed, the field can settle at minOut`); }
        return;
      }
      slog(s, `lock on ${it.H.slice(0, 10)}… DECAYED — executing anyway (still pays the best bid if I win the race)`);
      try { await executeAuction(a, it.rawHex); s.handled.add(it.H); slog(s, `execute sent post-decay`); }
      catch (e) { slog(s, `post-decay execute failed: ${(e as Error).message.slice(0, 60)}`); }
      await sweepCredit(s).catch(() => undefined);
      return;
    }
    if (!s.handled.has(it.H + ":decay")) { s.handled.add(it.H + ":decay"); slog(s, `lock on ${it.H.slice(0, 10)}… DECAYED (deadline + GRACE passed unexecuted) — direct settle at minOut is open again`); }
    // fall through to the OPEN path below: fast/picky solvers can now settle directly
  } else if (status.startsWith("AUCTION")) {
    if (s.strategy !== "auction") {
      if (!s.handled.has(it.H + ":lock")) { s.handled.add(it.H + ":lock"); slog(s, `intent ${it.H.slice(0, 10)}… is auction-locked — direct settle would revert, skipping`); }
      return;
    }
    const b = await bidOf(a, it.H);
    if (status === "AUCTION · executable") {
      if (stalledH.has(it.H)) {
        if (!s.handled.has(it.H + ":stall")) { s.handled.add(it.H + ":stall"); slog(s, `execute on ${it.H.slice(0, 10)}… is STALLED by scenario — withholding so exclusivity decays GRACE blocks after the deadline`); }
        return;
      }
      slog(s, `auction window closed on ${it.H.slice(0, 10)}… — executing (winner ${b.bidder.toLowerCase() === s.addr.toLowerCase() ? "me!" : b.bidder.slice(0, 10) + "…"})`);
      try { await executeAuction(a, it.rawHex); s.handled.add(it.H); slog(s, `execute sent — settlement delivers the best bid`); }
      catch (e) { slog(s, `execute failed: ${(e as Error).message.slice(0, 60)}`); }
      await sweepCredit(s).catch(() => undefined);
      return;
    }
    if (b.bidder.toLowerCase() === s.addr.toLowerCase()) return; // already best
    const step = input / 100n;
    // bids are denominated in the OUTPUT asset; convert the RBTC step at the sim's reference cost
    const stepOut = it.type === "rbtc" ? step : (it.minOut * step) / (cost > 0n ? cost : 1n);
    const nextBid = (b.amount > it.minOut ? b.amount : it.minOut) + (stepOut > 0n ? stepOut : 1n);
    const marginAtBid = input - (await costOf(it.type, nextBid)) - GAS_COST;
    if (Number((marginAtBid * 10_000n) / input) < s.marginBps) {
      if (!s.handled.has(it.H + ":out")) { s.handled.add(it.H + ":out"); slog(s, `outbid on ${it.H.slice(0, 10)}… and the next bid ${fmt(nextBid)} ${unit} breaks my ${s.marginBps}bps floor — folding`); }
      return;
    }
    slog(s, `bidding ${fmt(nextBid)} ${unit} on ${it.H.slice(0, 10)}… (margin ${Number((marginAtBid * 10_000n) / input)}bps still ≥ ${s.marginBps}bps)`);
    try {
      if (it.type === "rbtc") await placeBid(a, it.rawHex, nextBid);
      else {
        await ensureOutput(it.type, nextBid, s.key, s.addr);
        await approveOutput(it.type, await a.getAddress(), nextBid, s.key);
        await placeBidToken(a, it.rawHex, nextBid);
      }
      s.bidOn.set(it.H, it.type);
    } catch (e) { slog(s, `bid failed: ${(e as Error).message.slice(0, 60)}`); }
    return;
  }

  // OPEN intent
  if (s.handled.has(it.H)) return;
  slog(s, `saw intent ${it.H.slice(0, 10)}… [${it.type}] — simulating: input ${fmt(input)}, output cost ${fmt(cost)}, gas ~${fmt(GAS_COST)}`);
  if (marginBps < s.marginBps) {
    s.handled.add(it.H);
    slog(s, `margin ${marginBps}bps < my ${s.marginBps}bps floor — PASS`);
    return;
  }
  if (s.strategy === "auction") {
    const opening = it.minOut + (it.type === "rbtc" ? input / 100n : (it.minOut + 99n) / 100n);
    slog(s, `margin ${marginBps}bps — opening an auction at ${fmt(opening)} ${unit} instead of settling at the minimum`);
    try {
      if (it.type === "rbtc") await placeBid(a, it.rawHex, opening);
      else {
        await ensureOutput(it.type, opening, s.key, s.addr);
        await approveOutput(it.type, await a.getAddress(), opening, s.key);
        await placeBidToken(a, it.rawHex, opening);
      }
      s.bidOn.set(it.H, it.type);
    } catch (e) { slog(s, `bid failed: ${(e as Error).message.slice(0, 60)}`); }
    return;
  }
  s.handled.add(it.H);
  slog(s, it.type === "lpvault"
    ? `margin ${marginBps}bps ≥ ${s.marginBps}bps — FILL via the COMPOUND route: mint TOK → add liquidity → vault the LP → settle`
    : `margin ${marginBps}bps ≥ ${s.marginBps}bps — FILL: acquiring output + settling`);
  try {
    await ensureOutput(it.type, it.minOut, s.key, s.addr);
    await approveOutput(it.type, SETTLEMENT_ADDR, it.minOut, s.key);
    const settleHash = await solver.solve(it.rawHex, it.type === "rbtc" ? it.minOut : 0n);
    // the verdict comes from OUR receipt — the intent's global status can't tell who settled it
    const verdict = await myReceipt(settleHash);
    if (verdict === "mined-ok") {
      slog(s, `WON ${it.H.slice(0, 10)}… — my settle mined 0x1: output delivered, input claimed, spread banked`);
    } else {
      slog(s, verdict === "reverted"
        ? `LOST ${it.H.slice(0, 10)}… — my settle reverted 0x0 (another solver consumed H first)`
        : `settle ${settleHash.slice(0, 12)}… still unmined after 20s — verdict unknown`);
      if (verdict === "reverted") await recoverOutput(s, it.type);
    }
  } catch (e) {
    slog(s, `fill failed: ${(e as Error).message.slice(0, 70)} — probably outraced`);
  }
}

async function solverLoop(s: SolverRec): Promise<void> {
  slog(s, `online — strategy ${s.strategy}, margin floor ${s.marginBps}bps`);
  while (s.running) {
    for (const it of intents) {
      if (!s.running) break;
      await tryFill(s, it).catch((e) => slog(s, `error: ${(e as Error).message.slice(0, 60)}`));
    }
    await sleep(1500);
  }
  slog(s, "stopped");
}

// ---------- API ----------
async function spawnUser(): Promise<UserRec> {
  const u: UserRec = { id: ++seq, label: `user ${String.fromCharCode(64 + (users.length % 26) + 1)}`, wallet: Wallet.createRandom() as unknown as Wallet };
  if (btcEnabled) {
    await viaBtc(async () => {
      u.btcAddr = await btc.getNewAddress(u.label, "legacy");
      await btc.sendToAddress(u.btcAddr, 0.05);
      await btc.generateToAddress(1, faucetAddr);
    });
  }
  users.push(u);
  note(`${u.label} spawned (${u.wallet.address.slice(0, 10)}…) — zero RBTC, as intended${u.btcAddr ? `; holds 0.05 real BTC at ${u.btcAddr.slice(0, 12)}…` : ""}`);
  return u;
}

async function createIntent(p: { userId: number; type: IntentType; inputRbtc: number; minOut: number; expiryBlocks: number; viaAuction: boolean }): Promise<IntentRec> {
  const u = users.find((x) => x.id === p.userId);
  if (!u) throw new Error("no such user");
  const input = BigInt(Math.round(p.inputRbtc * 1e6)) * 1_000_000_000_000n;
  const minOut = BigInt(Math.round(p.minOut * 1e6)) * 1_000_000_000_000n;
  const outputToken = p.type === "vault" ? vaultAddr : p.type === "token" ? tokenAddr : p.type === "lpvault" ? tokenVaultAddr : RBTC;
  // the BTC side is REAL when bitcoind is up: the user's own UTXOs move to the federation with the
  // RSKIP170 OP_RETURN, and the resulting txid is the intent's ticket. The RSK-side credit is modelled.
  // H is minted BEFORE the peg-in so the BTC transaction itself can carry it: the OP_RETURN is
  // RSKIP170 payload || H, making the bitcoin mempool item visibly committed to this intent.
  const H = randomH();
  let btcTxid: Uint8Array;
  if (btcEnabled && u.btcAddr) {
    const txid = await viaBtc(async () => {
      const t = await btc.peginFromAddress(federationAddr, SETTLEMENT_ADDR, p.inputRbtc, u.btcAddr!, hexlify(H));
      return t; // left UNMINED for a beat so the dashboard shows it in the BTC mempool first
    });
    btcTxid = getBytes("0x" + txid);
    note(`${u.label}'s BTC moved: ${p.inputRbtc} BTC ${u.btcAddr.slice(0, 10)}… → federation (peg-in ${txid.slice(0, 12)}…, OP_RETURN carries H ${hexlify(H).slice(0, 10)}…)`);
    void viaBtc(async () => { await sleep(4000); await btc.generateToAddress(1, faucetAddr); });
  } else {
    btcTxid = getBytes(randomBytes(32));
  }
  await viaCow(() => depositForPegin(rpc.url, hexlify(btcTxid), input));
  await sleep(1200);
  const head = await rpc.blockNumber();
  const it: IntentRec = {
    id: ++seq, H: hexlify(H), rawHex: "", userId: p.userId, type: p.type, input, minOut, outputToken,
    expiry: head + Math.min(p.expiryBlocks || 80, 95), btcTxid: hexlify(btcTxid), viaAuction: !!p.viaAuction, created: Date.now(),
  };
  const built = buildIntent(u.wallet, { H, btcTxid, expiry: it.expiry, minOut, outputToken });
  it.rawHex = built.rawHex;
  await rpc.sendRaw(it.rawHex);
  intents.push(it);
  note(`${u.label} signed a ${p.type} intent: ${fmt(input)} BTC in, ≥ ${fmt(minOut)} out (expiry blk ${it.expiry})${it.viaAuction ? " — routed via auction" : ""}`);
  if (it.viaAuction) {
    // broker seed bid: minOut + 1 unit of the OUTPUT asset, escrowed at creation, locking the intent to
    // the auction from block one. For token outputs the broker runs the acquisition route itself — the
    // backstop bid is a real, deliverable bid, not a bookkeeping trick.
    const seed = minOut + 1n;
    await viaCow(async () => {
      const a = auction(rpc.url);
      if (p.type === "rbtc") await placeBid(a, it.rawHex, seed);
      else {
        const cowAddr = "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826";
        await ensureOutput(p.type, seed, COW_KEY, cowAddr);
        await approveOutput(p.type, await a.getAddress(), seed, COW_KEY);
        await placeBidToken(a, it.rawHex, seed);
      }
    });
    note(`broker seed bid placed (${fmt(seed)} ${unitOf(p.type)}) — the intent is auction-locked from block one`);
  }
  return it;
}

let solverCount = 0;
async function spawnSolver(p: { strategy: "fast" | "picky" | "auction"; marginBps?: number; label?: string }): Promise<SolverRec> {
  const n = ++solverCount; // synchronous — two quick spawns can't collide on a label
  const w = Wallet.createRandom();
  const s: SolverRec = {
    id: ++seq, label: p.label || `${p.strategy}-${n}`, key: w.privateKey, addr: w.address,
    strategy: p.strategy, marginBps: p.marginBps ?? (p.strategy === "picky" ? 300 : 50),
    log: [], startBal: 0n, running: true, handled: new Set(), bidOn: new Map(),
  };
  await fundFromCow(w.address, 50_000_000_000_000_000n); // 0.05 RBTC working capital
  s.startBal = BigInt(await rpc.getBalance(w.address));
  solvers.push(s);
  note(`solver "${s.label}" spawned with 0.05 RBTC capital (${s.strategy}, ${s.marginBps}bps floor)`);
  void solverLoop(s);
  return s;
}

async function stateSnapshot() {
  const head = await rpc.blockNumber();
  const v = vault(rpc.url, vaultAddr);
  const t = token(rpc.url, tokenAddr);
  const res = await reserves(pool(rpc.url, poolAddr)).catch(() => ({ rbtc: 0n, tok: 0n, lpSupply: 0n }));
  const tv = tokenVault(rpc.url, tokenVaultAddr);
  return {
    head, vault: vaultAddr, token: tokenAddr, pool: poolAddr, tokenVault: tokenVaultAddr,
    poolReserves: { rbtc: fmt(res.rbtc), tok: fmt(res.tok), lp: fmt(res.lpSupply) },
    btcEnabled, btcHeight: btcEnabled ? await btc.getBlockCount().catch(() => 0) : 0,
    federationBtc: (await federationBalance()).toFixed(4),
    users: await Promise.all(users.map(async (u) => ({
      id: u.id, label: u.label, addr: u.wallet.address, btcAddr: u.btcAddr ?? null,
      btc: (await btcBalanceOf(u.btcAddr)).toFixed(4),
      rbtc: fmt(BigInt(await rpc.getBalance(u.wallet.address).catch(() => "0x0"))),
      shares: fmt(await sharesOf(v, u.wallet.address).catch(() => 0n)),
      tok: fmt(await balanceOf(t, u.wallet.address).catch(() => 0n)),
      vlp: fmt(await tvSharesOf(tv, u.wallet.address).catch(() => 0n)),
    }))),
    intents: await Promise.all(intents.map(async (it) => {
      const status = await intentStatus(it).catch(() => "?");
      // slot[H] in the settlement contract IS the consumed-set entry: 0 until settled, blk+1 after
      const slotH = await rpc.call<string>("eth_getStorageAt", [SETTLEMENT_ADDR, it.H, "latest"]).catch(() => "0x0");
      return {
        id: it.id, H: it.H, type: it.type, user: users.find((u) => u.id === it.userId)?.label,
        input: fmt(it.input), minOut: fmt(it.minOut), outputToken: it.outputToken, expiry: it.expiry,
        btcTxid: it.btcTxid, viaAuction: it.viaAuction, status,
        escrow: fmt(await peginOf(rpc.url, it.btcTxid).catch(() => 0n)),
        stalled: stalledH.has(it.H),
        btcTx: await btcTxInfo(it.btcTxid).catch(() => null),
        slotH: BigInt(slotH) === 0n ? null : Number(BigInt(slotH) - 1n), // block it was consumed in
        settled: status === "SETTLED" ? await settleInfo(it.H).catch(() => null) : null,
        rawHex: it.rawHex,
      };
    })),
    solvers: await Promise.all(solvers.map(async (s) => {
      const bal = BigInt(await rpc.getBalance(s.addr).catch(() => "0x0"));
      const cred = await creditOf(auction(rpc.url), s.addr).catch(() => 0n);
      return { id: s.id, label: s.label, addr: s.addr, strategy: s.strategy, marginBps: s.marginBps,
        running: s.running, rbtc: fmt(bal), pnl: fmt(bal - s.startBal), pnlNeg: bal < s.startBal,
        credit: fmt(cred), creditPos: cred > 0n, log: s.log.slice(0, 40) };
    })),
    griefer: grieferAddr
      ? { addr: grieferAddr, credit: fmt(await creditOf(auction(rpc.url), grieferAddr).catch(() => 0n)) }
      : null,
    feed: feed.slice(0, 50),
  };
}

// ---------- HTTP ----------
const here = dirname(fileURLToPath(import.meta.url));
const page = () => readFileSync(join(here, "..", "..", "playground", "index.html"));
const readBody = async (req: import("node:http").IncomingMessage) => {
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
};

async function main(): Promise<void> {
  try { await rpc.blockNumber(); } catch { console.error(`cannot reach ${rpc.url} — is the stack up?`); process.exit(2); }
  console.log("deploying playground contracts (vault, token, pool, LP vault)…");
  vaultAddr = await viaCow(() => deployVault(rpc.url));
  tokenAddr = await viaCow(() => deployToken(rpc.url));
  poolAddr = await viaCow(() => deployPool(rpc.url, tokenAddr));
  tokenVaultAddr = await viaCow(() => deployTokenVault(rpc.url, poolAddr));
  // seed the AMM at 0.1 RBTC/TOK (matches the pricing sim's reference): 1 RBTC + 10 TOK
  await viaCow(async () => {
    const t = token(rpc.url, tokenAddr);
    await mint(t, "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826", 10_000_000_000_000_000_000n); await sleep(1200);
    await approve(t, poolAddr, 10_000_000_000_000_000_000n); await sleep(1200);
    await addLiquidity(pool(rpc.url, poolAddr), 1_000_000_000_000_000_000n, 10_000_000_000_000_000_000n); await sleep(1200);
  });
  note(`contracts ready: BTC Vault ${vaultAddr.slice(0, 10)}… · TOK ${tokenAddr.slice(0, 10)}… · Pool ${poolAddr.slice(0, 10)}… (1 RBTC / 10 TOK) · LP Vault ${tokenVaultAddr.slice(0, 10)}…`);
  try {
    await btc.ensureWallet();
    faucetAddr = await btc.getNewAddress("faucet", "legacy");
    // ensure the wallet has spendable (mature) funds: 101 blocks to the faucet gives its first
    // coinbase the 100 confirmations coinbase maturity requires
    if ((await btc.getBalance().catch(() => 0)) < 1) await btc.generateToAddress(101, faucetAddr);
    federationAddr = await new Bridge(rpc).getFederationAddress();
    btcEnabled = true;
    note(`bitcoind connected — real BTC moves: users get real addresses, peg-ins hit the federation ${federationAddr.slice(0, 12)}…`);
  } catch (e) {
    note(`bitcoind unreachable (${(e as Error).message.slice(0, 50)}) — BTC side falls back to synthetic txids`);
  }

  createServer(async (req, res) => {
    const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    try {
      if (req.url === "/state") return json(200, await stateSnapshot());
      if (req.method === "POST" && req.url === "/api/user") return json(200, { id: (await spawnUser()).id });
      if (req.method === "POST" && req.url === "/api/intent") return json(200, { id: (await createIntent(await readBody(req))).id });
      if (req.method === "POST" && req.url === "/api/solver") return json(200, { id: (await spawnSolver(await readBody(req))).id });
      if (req.method === "POST" && req.url?.startsWith("/api/stop/")) {
        const s = solvers.find((x) => x.id === Number(req.url!.split("/").pop()));
        if (s) s.running = false;
        return json(200, { ok: true });
      }
      if (req.method === "POST" && req.url?.startsWith("/api/withdraw/")) {
        const s = solvers.find((x) => x.id === Number(req.url!.split("/").pop()));
        if (!s) return json(404, { error: "no such solver" });
        await sweepCredit(s);
        return json(200, { ok: true });
      }
      if (req.method === "POST" && req.url === "/api/griefer/bid") return json(200, { ok: await grieferBid(Number((await readBody(req)).intentId)).then(() => true) });
      if (req.method === "POST" && req.url === "/api/griefer/withdraw") { await grieferWithdrawAttempt(); return json(200, { ok: true }); }
      if (req.method === "POST" && req.url?.startsWith("/api/stall/")) {
        const it = intents.find((x) => x.id === Number(req.url!.split("/").pop()));
        if (!it) return json(404, { error: "no such intent" });
        if (stalledH.has(it.H)) {
          stalledH.delete(it.H);
          note(`execute UN-STALLED for ${it.H.slice(0, 10)}… — auction solvers may execute again`);
        } else {
          stalledH.add(it.H);
          note(`execute STALLED for ${it.H.slice(0, 10)}… — playground solvers withhold execute; exclusivity decays GRACE blocks after the deadline, then direct settles reopen at minOut`);
        }
        return json(200, { ok: true });
      }
      res.writeHead(200, { "content-type": "text/html" }); res.end(page());
    } catch (e) { json(500, { error: (e as Error).message }); }
  }).listen(PORT);
  console.log(`\n  playground:  http://localhost:${PORT}\n  Ctrl-C to stop.\n`);
}

main();
