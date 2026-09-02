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
import { buildIntent, btcOutH, randomH } from "../src/intent.js";
import { Solver } from "../src/solver.js";
import { depositForPegin, peginOf, settleBtcOut, reserveExit, exitBondFor } from "../src/settlement.js";
import { branchFromTxOutProof } from "../src/merkle.js";
import { auction, placeBid, placeBidToken, executeAuction, bidOf, lockedUntil, withdrawCredit, creditOf } from "../src/auction.js";
import { deployVault, vault, vaultDeposit, vaultApprove, sharesOf, vaultWithdraw } from "../src/vault.js";
import { deployToken, token, mint, approve, balanceOf } from "../src/token.js";
import { deployPool, deployTokenVault, pool, tokenVault, reserves, addLiquidity, removeLiquidity, lpBalanceOf, lpApprove, tvDeposit, tvApprove, tvSharesOf, tvWithdraw } from "../src/amm.js";
import { BtcRpc } from "../src/btcrpc.js";
import { Bridge } from "../src/bridge.js";
import { Rpc, sleep, waitFor } from "../src/client.js";
import { RPC_A, SETTLEMENT_ADDR, RBTC, BTC_OUT, COW_KEY } from "../src/config.js";

const PORT = 8667;
const rpc = new Rpc(RPC_A);
const GAS_COST = 1_000_000_000_000n; // ~1e12 wei pricing-sim allowance for a settle round-trip

// ---------- state ----------
interface UserRec { id: number; label: string; wallet: Wallet; btcAddr?: string }
type IntentType = "vault" | "rbtc" | "token" | "lpvault" | "btcout";
interface IntentRec {
  id: number; H: string; rawHex: string; userId: number; type: IntentType;
  input: bigint; minOut: bigint; outputToken: string; expiry: number; btcTxid: string;
  viaAuction: boolean; created: number;
  // exit intents (btcout): the "reveal" — H's preimage parts a solver needs to settle. minOut is SATS.
  salt?: Uint8Array; btcDest?: string;
}
interface SolverRec {
  id: number; label: string; key: string; addr: string; strategy: "fast" | "picky" | "auction";
  marginBps: number; log: { t: string; line: string }[]; startBal: bigint; running: boolean;
  handled: Set<string>; bidOn: Map<string, IntentType>; // auctions I have live escrow in, for recovery
  btcAddr?: string; // funded BTC address for filling exit intents (btcout)
  txHashes: string[]; gasWei: bigint; // receipts pending / accumulated gasUsed × gasPrice
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
const execSent = new Map<string, number>(); // H -> last execute attempt (ms); debounces duplicate executes across solvers

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
  if (type === "btcout") return amount * 10_000_000_000n + 200_000_000_000_000n; // sats -> wei (1:1 peg) + ~0.0002 BTC payout fee
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
  return 0n; // rbtc: native; btcout: the output lives on Bitcoin — nothing to hold on RSK
}

/**
 * Ensure `who` holds >= amount of the output asset, running the real acquisition route for the
 * shortfall — for lpvault that is the COMPOUND route: mint TOK, add RBTC+TOK liquidity, vault the LP.
 */
async function ensureOutput(type: IntentType, amount: bigint, key: string, addr: string): Promise<void> {
  if (type === "rbtc" || type === "btcout") return; // native / paid on Bitcoin — nothing to acquire on RSK
  const held = await heldOutput(type, addr);
  if (held >= amount) return;
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
  if (type === "rbtc" || type === "token" || type === "btcout") return; // nothing recoverable on RSK
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

const unitOf = (t: IntentType) =>
  (t === "rbtc" ? "RBTC" : t === "vault" ? "bvBTC" : t === "token" ? "TOK" : t === "lpvault" ? "vLP" : "sats (on Bitcoin)");

/** Pull-payment sweep: execute() CREDITS the winner (and any fallen-back refunds) instead of
 *  pushing RBTC, so a solver must withdraw to realise its PnL. Cheap no-op when credit is 0. */
async function sweepCredit(s: SolverRec): Promise<void> {
  const a = auction(rpc.url, s.key);
  const owed = await creditOf(a, s.addr).catch(() => 0n);
  if (owed <= 0n) return;
  s.txHashes.push(await withdrawCredit(a));
  slog(s, `withdrew ${fmt(owed)} RBTC of pull-payment credit from the auction (winner input / refunds)`);
}

/** Accumulate gasUsed × gasPrice for this solver's tracked txs (all playground txs use gasPrice 1e6).
 *  Acquisition-route helper txs aren't tracked — each is ~1e-7 RBTC, so the bound is micro-RBTC. */
async function gasSpent(s: SolverRec): Promise<bigint> {
  const pending = s.txHashes.splice(0);
  for (const h of pending) {
    const r = await rpc.getReceipt(h).catch(() => null);
    if (r && r.blockNumber !== null && r.gasUsed) s.gasWei += BigInt(r.gasUsed) * 1_000_000n;
    else if (r === null || r.blockNumber === null) s.txHashes.push(h); // unmined — retry next poll
  }
  return s.gasWei;
}

/** RBTC value of the solver's non-RBTC positions, priced with the same sim solvers use:
 *  bvBTC 1:1, TOK at the 0.1 reference, vLP at live pool reserves. */
async function parkedValue(s: SolverRec): Promise<{ held: bigint; escrow: bigint }> {
  let held = 0n;
  for (const type of ["vault", "token", "lpvault"] as IntentType[]) {
    const amt = await heldOutput(type, s.addr).catch(() => 0n);
    if (amt > 0n) held += await costOf(type, amt).catch(() => 0n);
  }
  let escrow = 0n;
  for (const [H, type] of s.bidOn) {
    const b = await bidOf(auction(rpc.url), H).catch(() => null);
    if (b && b.bidder.toLowerCase() === s.addr.toLowerCase() && b.deadline !== 0n) {
      escrow += type === "rbtc" ? b.amount : await costOf(type, b.amount).catch(() => 0n);
    }
  }
  return { held, escrow };
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

  const input = await peginOf(rpc.url, it.btcTxid).catch((e) => {
    if (!s.handled.has(it.H + ":dead")) {
      s.handled.add(it.H + ":dead");
      slog(s, `Settlement unreadable (pegin(${it.btcTxid.slice(0, 10)}…) returned no data) — no code at 0x..21? Stale/rebuilding genesis: down -v + rebuild. ${(e as Error).message.slice(0, 60)}`);
    }
    return null;
  });
  if (input === null) return;
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
      if (Date.now() - (execSent.get(it.H) ?? 0) < 10_000) return; // debounced
      execSent.set(it.H, Date.now());
      slog(s, `lock on ${it.H.slice(0, 10)}… DECAYED — executing anyway (still pays the best bid if I win the race)`);
      try { s.txHashes.push(await executeAuction(a, it.rawHex)); s.handled.add(it.H); slog(s, `execute sent post-decay`); }
      catch (e) { execSent.delete(it.H); slog(s, `post-decay execute failed: ${(e as Error).message.slice(0, 60)}`); }
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
      if (Date.now() - (execSent.get(it.H) ?? 0) < 10_000) return; // an execute for H is already in flight
      execSent.set(it.H, Date.now());
      slog(s, `auction window closed on ${it.H.slice(0, 10)}… — executing (winner ${b.bidder.toLowerCase() === s.addr.toLowerCase() ? "me!" : b.bidder.slice(0, 10) + "…"})`);
      try { s.txHashes.push(await executeAuction(a, it.rawHex)); s.handled.add(it.H); slog(s, `execute sent — settlement delivers the best bid`); }
      catch (e) { execSent.delete(it.H); slog(s, `execute failed: ${(e as Error).message.slice(0, 60)}`); }
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
      if (it.type === "rbtc") s.txHashes.push(await placeBid(a, it.rawHex, nextBid));
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
  if (input === 0n) {
    // the peg-in escrow tx may simply not be mined yet — a PASS decided now would stick forever.
    if (!s.handled.has(it.H + ":wait")) { s.handled.add(it.H + ":wait"); slog(s, `escrow for ${it.H.slice(0, 10)}… not visible yet (peg-in unmined?) — re-simulating until it is`); }
    return;
  }
  slog(s, `saw intent ${it.H.slice(0, 10)}… [${it.type}] — simulating: input ${fmt(input)}, output cost ${fmt(cost)}, gas ~${fmt(GAS_COST)}`);
  if (marginBps < s.marginBps) {
    s.handled.add(it.H);
    slog(s, `margin ${marginBps}bps < my ${s.marginBps}bps floor — PASS`);
    return;
  }
  // exit intents (btcout): the fill is a REAL Bitcoin payment + SPV proof. No auction (bids would
  // escrow nothing on RSK); every strategy fills directly. NOTE the honest hazard: if two solvers race
  // an exit, BOTH have paid real BTC and only one claims the input — the loser's BTC is gone (the user
  // is paid twice). Exit racing is expensive by construction; see PRODUCTIONIZATION.
  if (it.type === "btcout") {
    if (!btcEnabled || !s.btcAddr) {
      if (!s.handled.has(it.H)) { s.handled.add(it.H); slog(s, `exit intent ${it.H.slice(0, 10)}… — no BTC capital (bitcoind offline?), PASS`); }
      return;
    }
    s.handled.add(it.H);
    const u = users.find((x) => x.id === it.userId);
    if (!u?.btcAddr || !it.btcDest || !it.salt) { slog(s, `exit intent ${it.H.slice(0, 10)}… missing reveal — PASS`); return; }
    if (marginBps < s.marginBps) { slog(s, `exit margin ${marginBps}bps < my floor — PASS`); return; }
    // RESERVE before paying a single satoshi: losing this race costs gas, not bitcoin
    const bond = exitBondFor(it.minOut);
    slog(s, `margin ${marginBps}bps ≥ ${s.marginBps}bps — reserving the exit first (bond ${fmt(bond)} RBTC; my BTC payment cannot be raced)`);
    const resVerdict = await myReceipt(await reserveExit(rpc.url, it.rawHex, bond, s.key));
    if (resVerdict !== "mined-ok") {
      slog(s, `reservation lost — another solver holds ${it.H.slice(0, 10)}…. Cost: gas only, ZERO bitcoin. PASS`);
      return;
    }
    slog(s, `reserved — FILL (exit): paying ${Number(it.minOut) / 1e8} BTC to ${u.btcAddr.slice(0, 12)}… ON BITCOIN`);
    try {
      const { txid, rawHex } = await viaBtc(async () => {
        const res = await btc.payToAddress(s.btcAddr!, u.btcAddr!, Number(it.minOut) / 1e8);
        await btc.generateToAddress(1, faucetAddr);
        return res;
      });
      slog(s, `paid — payout ${txid.slice(0, 12)}… confirmed on Bitcoin; relaying headers + proving on RSK`);
      const bridge = new Bridge(rpc, s.key);
      const startH = await bridge.bestChainHeight();
      const bestH = await viaBtc(() => btc.getBlockCount());
      let lastHeaderTx: string | null = null;
      for (let h = startH + 1; h <= bestH; h++) {
        lastHeaderTx = await bridge.receiveHeader(await viaBtc(async () => btc.getBlockHeaderRaw(await btc.getBlockHash(h))));
      }
      if (lastHeaderTx) await myReceipt(lastHeaderTx); // batch-send, single receipt wait
      const v = await viaBtc(() => btc.getRawTransactionVerbose(txid));
      const payHeight = bestH - ((v.confirmations ?? 1) - 1);
      const blockHash = await viaBtc(() => btc.getBlockHash(payHeight));
      const branch = branchFromTxOutProof(await viaBtc(() => btc.getTxOutProof([txid])), txid);
      const settleHash = await settleBtcOut(rpc.url, {
        rawIntentTx: it.rawHex, salt: it.salt, btcDest: it.btcDest, rawBtcTx: rawHex,
        btcBlockHash: "0x" + blockHash, merklePath: branch.path, merkleHashes: branch.hashes,
      }, s.key);
      const verdict = await myReceipt(settleHash);
      slog(s, verdict === "mined-ok"
        ? `WON ${it.H.slice(0, 10)}… — SPV proof accepted, input + bond back. Full circle: the user got BTC, never touched Rootstock.`
        : `settle ${verdict} on ${it.H.slice(0, 10)}… — unexpected while holding the reservation (investigate)`);
    } catch (e) {
      slog(s, `exit fill failed: ${(e as Error).message.slice(0, 80)}`);
    }
    return;
  }
  if (s.strategy === "auction") {
    const opening = it.minOut + (it.type === "rbtc" ? input / 100n : (it.minOut + 99n) / 100n);
    slog(s, `margin ${marginBps}bps — opening an auction at ${fmt(opening)} ${unit} instead of settling at the minimum`);
    try {
      if (it.type === "rbtc") s.txHashes.push(await placeBid(a, it.rawHex, opening));
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
      if (verdict === "reverted") {
        const consumed = await rpc.ethCall(SETTLEMENT_ADDR, "0x6346e832" + it.H.slice(2)).then((r) => BigInt(r) !== 0n).catch(() => false);
        if (consumed) {
          slog(s, `LOST ${it.H.slice(0, 10)}… — my settle reverted 0x0 (another solver consumed H first)`);
          await recoverOutput(s, it.type);
        } else {
          // NOT a race — H is still open. Most likely my acquisition/approval txs weren't mined
          // when solve fired. Keep the position (no unwind) and retry next loop.
          s.handled.delete(it.H);
          slog(s, `settle reverted but H is UNCONSUMED — not a race (output/approval likely unmined); retrying next pass`);
        }
      } else slog(s, `settle ${settleHash.slice(0, 12)}… still unmined after 20s — verdict unknown`);
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
      await tryFill(s, it).catch((e) => {
        const m = (e as Error & { info?: { method?: string } });
        slog(s, `error${m.info?.method ? ` in ${m.info.method}()` : ""}: ${m.message.slice(0, 120)}`);
      });
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
  // exit intents denominate minOut in SATS (delivered on Bitcoin); everything else in wei-scale units
  const minOut = p.type === "btcout" ? BigInt(Math.round(p.minOut * 1e8)) : BigInt(Math.round(p.minOut * 1e6)) * 1_000_000_000_000n;
  const outputToken = p.type === "vault" ? vaultAddr : p.type === "token" ? tokenAddr : p.type === "lpvault" ? tokenVaultAddr : p.type === "btcout" ? BTC_OUT : RBTC;

  if (p.type === "btcout") {
    // the EXIT: the user's RSK-side value (escrowed here as the input) goes back to BTC at their own
    // address. H commits to that address — no peg-in happens (the value is already on the RSK side).
    if (!btcEnabled || !u.btcAddr) throw new Error("exit intents need bitcoind (the user has no BTC address)");
    const salt = getBytes(randomBytes(32));
    const btcDest = await btc.hash160Of(u.btcAddr);
    const H = btcOutH(btcDest, salt);
    const btcTxid = getBytes(randomBytes(32));
    await viaCow(() => depositForPegin(rpc.url, hexlify(btcTxid), input));
    await sleep(1200);
    const head = await rpc.blockNumber();
    const it: IntentRec = {
      id: ++seq, H: hexlify(H), rawHex: "", userId: p.userId, type: p.type, input, minOut, outputToken,
      expiry: head + Math.min(p.expiryBlocks || 80, 95), btcTxid: hexlify(btcTxid), viaAuction: false,
      created: Date.now(), salt, btcDest,
    };
    it.rawHex = buildIntent(u.wallet, { H, btcTxid, expiry: it.expiry, minOut, outputToken }).rawHex;
    await rpc.sendRaw(it.rawHex);
    intents.push(it);
    note(`${u.label} signed an EXIT intent: ${fmt(input)} RSK-side value out as ≥ ${Number(minOut) / 1e8} BTC to ${u.btcAddr.slice(0, 12)}… (H commits to the address)`);
    if (p.viaAuction) note(`auction routing ignored for exits: bids would escrow nothing on RSK`);
    return it;
  }
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
    log: [], startBal: 0n, running: true, handled: new Set(), bidOn: new Map(), txHashes: [], gasWei: 0n,
  };
  await fundFromCow(w.address, 50_000_000_000_000_000n); // 0.05 RBTC working capital
  if (btcEnabled) {
    await viaBtc(async () => {
      s.btcAddr = await btc.getNewAddress(s.label, "legacy");
      await btc.sendToAddress(s.btcAddr, 0.05);           // BTC capital for filling exit intents
      await btc.generateToAddress(1, faucetAddr);
    });
  }
  s.startBal = BigInt(await rpc.getBalance(w.address));
  solvers.push(s);
  note(`solver "${s.label}" spawned with 0.05 RBTC${s.btcAddr ? " + 0.05 BTC" : ""} capital (${s.strategy}, ${s.marginBps}bps floor)`);
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
        input: fmt(it.input), minOut: it.type === "btcout" ? (Number(it.minOut) / 1e8).toString() : fmt(it.minOut),
        outputToken: it.outputToken, expiry: it.expiry,
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
      const gas = await gasSpent(s).catch(() => s.gasWei);
      const { held, escrow } = await parkedValue(s).catch(() => ({ held: 0n, escrow: 0n }));
      // liquid PnL is what the balance says; adjusted PnL counts capital merely parked in
      // credits, live bid escrow, and held output positions (valued at the pricing sim)
      const liquid = bal - s.startBal;
      const adj = liquid + cred + escrow + held;
      return { id: s.id, label: s.label, addr: s.addr, strategy: s.strategy, marginBps: s.marginBps,
        running: s.running, rbtc: fmt(bal), pnl: fmt(liquid), pnlNeg: liquid < 0n,
        adjPnl: fmt(adj), adjNeg: adj < 0n, gas: fmt(gas),
        parked: fmt(cred + escrow + held), parkedPos: cred + escrow + held > 0n,
        credit: fmt(cred), creditPos: cred > 0n, escrowVal: fmt(escrow), heldVal: fmt(held),
        log: s.log.slice(0, 40) };
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

let bootAnchor = "";
async function chainAnchor(): Promise<string> {
  const blk = await rpc.call<{ hash?: string } | null>("eth_getBlockByNumber", ["0x1", false]).catch(() => null);
  return blk?.hash ?? "";
}
/** A wiped-and-rebuilt chain invalidates everything this server holds in memory (intents, users,
 *  deployed contract addresses). Detect it via the block-1 hash and freeze instead of error-looping. */
function watchChainReset(): void {
  let noted = false;
  setInterval(async () => {
    if (noted) return;
    const a = await chainAnchor();
    if (!a) return;
    if (!bootAnchor) { bootAnchor = a; return; }
    if (a !== bootAnchor) {
      noted = true;
      note(`CHAIN RESET detected (block-1 hash changed) — in-memory intents and contract addresses reference the OLD chain. Solvers frozen; restart the playground server.`);
      for (const sv of solvers) { sv.running = false; slog(sv, "frozen: chain reset detected — restart the playground server"); }
    }
  }, 5000);
}

async function main(): Promise<void> {
  try { await rpc.blockNumber(); } catch { console.error(`cannot reach ${rpc.url} — is the stack up?`); process.exit(2); }
  bootAnchor = await chainAnchor();
  watchChainReset();
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
    // sync the Bridge's SPV view to the BTC tip NOW, so exit fills only relay a couple of new headers
    // instead of a ~100-header backlog inside an intent's lifetime (which would expire it)
    await viaCow(async () => {
      const bridge = new Bridge(rpc);
      const from = await bridge.bestChainHeight();
      const to = await btc.getBlockCount();
      if (to > from) {
        note(`syncing Bridge headers ${from + 1}…${to} (one-off backlog)…`);
        let last: string | null = null;
        for (let h = from + 1; h <= to; h++) last = await bridge.receiveHeader(await btc.getBlockHeaderRaw(await btc.getBlockHash(h)));
        if (last) await myReceipt(last);
        note(`Bridge synced to BTC height ${to}`);
      }
    });
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
