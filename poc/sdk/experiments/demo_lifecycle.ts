/**
 * Live demo: the full native-intent lifecycle, narrated, on the default stack (npm run demo).
 *
 * Serves the dashboard at http://localhost:8666 and proxies both nodes' JSON-RPC same-origin
 * (/rpc/a, /rpc/b) — rskj rejects OPTIONS preflights and non-JSON content types, so a browser page
 * cannot call the nodes cross-origin directly. Narration beats are published at /story so the
 * dashboard displays each act as it happens.
 *
 * The story is a REALISTIC user journey: "put my 0.01 BTC to work in the BTC Vault" — one signature,
 * no RBTC held, no gas, no bridge UI. The intent asks for >= 0.0099 bvBTC vault shares; solvers do the
 * plumbing (peg-in claim + vault deposit) and keep the ~1% spread.
 *
 * Acts:
 *   1  the payer-less vault intent enters the mempool and gossips to node B     (claim 1)
 *   2  an expired intent is rejected at admission — zero on-chain footprint     (claim 2)
 *   3  two solvers race to fill the vault intent: one wins, the replay is blocked (consumed set)
 *   4  a second user swaps BTC->RBTC via auction: bid war, bypass rejected, best bid wins (E17b)
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getBytes, hexlify, randomBytes, Wallet } from "ethers";
import { buildIntent, freshWallet, randomH } from "../src/intent.js";
import { Solver } from "../src/solver.js";
import { depositForPegin } from "../src/settlement.js";
import { auction, placeBid, executeAuction, bidOf, withdrawCredit } from "../src/auction.js";
import { deployVault, vault, vaultDeposit, vaultApprove, sharesOf } from "../src/vault.js";
import { preflight, requireSettlement, rpcA, fundAccount, waitReceipt, succeeded, reverted, errMsg } from "./_harness.js";
import { RBTC, RPC_A, RPC_B, SETTLEMENT_ADDR } from "../src/config.js";
import { sleep, waitFor } from "../src/client.js";

const PORT = 8666;
const INPUT = 10_000_000_000_000_000n;         // 1e16 — the 0.01 BTC peg-in (1:1 RBTC)
const MIN_SHARES = 9_900_000_000_000_000n;     // 0.0099 bvBTC — user's ask; solver spread ~1%
const MINOUT = 1_000_000_000_000_000n;         // 1e15 — act 4's plain RBTC swap ask
const BID_LOW = MINOUT + 200_000_000_000_000n;
const BID_HIGH = MINOUT + 400_000_000_000_000n;

// --- dashboard server + narration ---
const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(here, "..", "..", "demo", "dashboard.html"));
const story: { act: string; text: string }[] = [];
const manifest: { vault?: string; symbol?: string } = {};
const RPC_URL = { a: RPC_A, b: RPC_B } as const;

createServer(async (req, res) => {
  try {
    if (req.method === "POST" && (req.url === "/rpc/a" || req.url === "/rpc/b")) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const upstream = await fetch(RPC_URL[req.url.endsWith("a") ? "a" : "b"], {
        method: "POST", headers: { "content-type": "application/json" }, body: Buffer.concat(chunks),
      });
      res.writeHead(upstream.status, { "content-type": "application/json" });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } else if (req.url === "/story") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(story));
    } else if (req.url === "/manifest") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(manifest));
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page);
    }
  } catch (e) {
    res.writeHead(502); res.end(errMsg(e));
  }
}).listen(PORT);

function narrate(act: string, text: string): void {
  story.push({ act, text });
  console.log(`\n[${act}] ${text}`);
}
const beat = (ms = 5000) => sleep(ms);

// --- the story ---
async function main(): Promise<void> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  console.log(`\n  dashboard:  http://localhost:${PORT}\n`);
  const vaultAddr = await deployVault(rpcA.url);
  manifest.vault = vaultAddr; manifest.symbol = "bvBTC";
  narrate("setup", `open http://localhost:${PORT} — the BTC Vault is live at ${vaultAddr.slice(0, 10)}…; the story starts in 12 seconds`);
  await beat(12000);

  // Act 1 — payer-less admission + gossip (a REAL intent: BTC into the vault)
  const userA = freshWallet();
  narrate("act 1 · mempool citizenship", `a user wants their 0.01 BTC earning in the BTC Vault. They hold NO RBTC — they sign one intent: "≥ 0.0099 bvBTC shares to me", anchored to their peg-in…`);
  const h1 = await rpcA.blockNumber();
  const btc1 = getBytes(randomBytes(32));
  const H1 = randomH();
  const intent1 = buildIntent(userA, { H: H1, btcTxid: btc1, expiry: h1 + 80, minOut: MIN_SHARES, outputToken: vaultAddr });
  await rpcA.sendRaw(intent1.rawHex);
  narrate("act 1 · mempool citizenship", `accepted — no payer, no gas, yet a first-class mempool citizen. Watch it gossip to node B.`);
  await beat(7000);

  // Act 2 — invalidity is free
  narrate("act 2 · free invalidity", `now an EXPIRED intent — consensus should reject it at admission, costing nobody anything…`);
  const dead = buildIntent(freshWallet(), { H: randomH(), btcTxid: getBytes(randomBytes(32)), expiry: await rpcA.blockNumber(), minOut: MINOUT, outputToken: RBTC });
  const rejection = await rpcA.sendRaw(dead.rawHex).then(() => null, (e) => errMsg(e));
  narrate("act 2 · free invalidity", rejection
    ? `rejected by the node: "${rejection.slice(0, 80)}" — zero on-chain footprint, zero cost.`
    : `UNEXPECTED: the expired intent was accepted (this would falsify claim 2).`);
  await beat(6000);

  // Act 3 — two solvers race to fill the vault intent
  narrate("act 3 · solver race", `the 0.01 BTC peg-in is escrowed. TWO solvers spot the intent; each deposits its own RBTC into the vault for shares and races to deliver them…`);
  await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btc1), INPUT, hexlify(H1)));
  const s2key = Wallet.createRandom().privateKey;
  await waitReceipt(rpcA, await fundAccount(new Wallet(s2key).address, INPUT * 2n));
  const solver1 = new Solver(rpcA.url);
  const solver2 = new Solver(rpcA.url, s2key);
  const v1 = vault(rpcA.url, vaultAddr);
  const v2 = vault(rpcA.url, vaultAddr, s2key);
  await Promise.all([
    waitReceipt(rpcA, await vaultDeposit(v1, MIN_SHARES)).then(async () => waitReceipt(rpcA, await vaultApprove(v1, SETTLEMENT_ADDR, MIN_SHARES))),
    waitReceipt(rpcA, await vaultDeposit(v2, MIN_SHARES)).then(async () => waitReceipt(rpcA, await vaultApprove(v2, SETTLEMENT_ADDR, MIN_SHARES))),
  ]);
  const [ra] = await Promise.all([
    solver1.solve(intent1.rawHex, 0n).then((h) => waitReceipt(rpcA, h)),   // share output: no RBTC attached
    solver2.solve(intent1.rawHex, 0n).then((h) => waitReceipt(rpcA, h)),
  ]);
  const winner = succeeded(ra) ? "solver 1" : "solver 2";
  const userShares = await sharesOf(v1, userA.address);
  narrate("act 3 · solver race", `${winner} won — the loser reverted on the consumed H. The user now holds ${Number(userShares) / 1e18} bvBTC IN the vault (never touched RBTC); the winner claimed the 0.01 peg-in, keeping the ~1% spread.`);
  await beat(4000);
  const replay = await solver1.solve(intent1.rawHex, 0n).then((h) => waitReceipt(rpcA, h)).catch(() => null);
  narrate("act 3 · solver race", replay === null || reverted(replay)
    ? `a replay of the settled intent just reverted — H is consumed, forever.`
    : `UNEXPECTED: replay succeeded.`);
  await beat(6000);

  // Act 4 — the auction
  narrate("act 4 · auction", `final act: a second user just wants RBTC for their BTC at the best price — and solvers COMPETE ON PRICE, bidding to deliver MORE than the ask…`);
  const userB = freshWallet();
  const btc2 = getBytes(randomBytes(32));
  const H2 = randomH();
  await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btc2), INPUT, hexlify(H2)));
  const intent2 = buildIntent(userB, { H: H2, btcTxid: btc2, expiry: (await rpcA.blockNumber()) + 80, minOut: MINOUT, outputToken: RBTC });
  await rpcA.sendRaw(intent2.rawHex);
  const a1 = auction(rpcA.url);
  const a2 = auction(rpcA.url, s2key);
  await waitReceipt(rpcA, await placeBid(a1, intent2.rawHex, BID_LOW));
  narrate("act 4 · auction", `solver 1 bids 0.0012 RBTC (ask was 0.001) — a 10-block bidding window opens.`);
  await beat(4000);
  await waitReceipt(rpcA, await placeBid(a2, intent2.rawHex, BID_HIGH));
  narrate("act 4 · auction", `solver 2 outbids at 0.0014 — solver 1's escrow is refunded instantly.`);
  await beat(4000);
  const bypass = await solver1.solve(intent2.rawHex, MINOUT).then((h) => waitReceipt(rpcA, h)).catch(() => null);
  narrate("act 4 · auction", bypass === null || reverted(bypass)
    ? `solver 1 tries to BYPASS the auction and settle at the bare minimum — rejected: while an auction is open, only the auction can settle.`
    : `UNEXPECTED: the bypass landed (is this the E17b genesis?).`);
  const bidInfo = await bidOf(a1, H2);
  narrate("act 4 · auction", `waiting for the bidding window to close (block ${bidInfo.deadline})…`);
  await waitFor(async () => BigInt(await rpcA.blockNumber()) >= bidInfo.deadline, 40000, 1000);
  await waitReceipt(rpcA, await executeAuction(a1, intent2.rawHex));
  await waitReceipt(rpcA, await withdrawCredit(a2)); // pull-payment: winner withdraws its credited input
  narrate("act 4 · auction", `executed. The user asked for 0.001 RBTC and received 0.0014 — the BEST BID, not the minimum. The winning solver withdrew the credited 0.01 input. Competition priced the intent.`);
  await beat(3000);

  narrate("fin", `that's the lifecycle: free admission, free invalidity, atomic competitive settlement, price discovery. Dashboard stays live — Ctrl-C to stop.`);
  console.log("\nserver still running for inspection — Ctrl-C to exit.\n");
}

main().catch((e) => { console.error(errMsg(e)); process.exit(1); });
