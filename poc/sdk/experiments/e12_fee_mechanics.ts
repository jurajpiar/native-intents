/**
 * E12 — Fee mechanics: the solver claims the input and keeps the spread (milestone 4).
 *
 * Cross-asset flagship: the user pegs in RBTC (the input) and wants a token (the output). The solver
 * delivers >= minOut of the token to the user and, in the same settle, claims the escrowed input RBTC
 * as repayment. Its profit is the spread — value(input RBTC) − value(minOut token) − gas.
 *
 * The peg-in credit is modelled by depositForPegin (native RBTC cannot be pulled from the user, so the
 * input is escrowed in the settlement contract — as a real peg-in crediting the contract would do).
 *
 * Falsifier: the user isn't credited the output, the solver doesn't receive the input, the escrow isn't
 * cleared, or H isn't consumed.
 */
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { Solver } from "../src/solver.js";
import { deployToken, token, mint, approve, balanceOf } from "../src/token.js";
import { depositForPegin, peginOf } from "../src/settlement.js";
import { Report, preflight, requireSettlement, rpcA, waitReceipt, succeeded } from "./_harness.js";
import { cowWallet, SETTLEMENT_ADDR } from "../src/config.js";
import { getBytes, hexlify, randomBytes } from "ethers";

const INPUT = 10_000_000_000_000_000n;      // 1e16 wei RBTC — the pegged-in input
const MINOUT = 1_000_000_000_000_000_000n;  // 1e18 — token output the user wants
const GAS_BOUND = 2_000_000_000_000n;       // 2e12 wei — loose upper bound on gas for the assertion

async function main(): Promise<number> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  const r = new Report("E12 fee mechanics", "solver claims the input (peg-in) and keeps the spread; user gets the output");

  // token setup: mint to the solver (cow) and approve the settlement contract
  const tokenAddr = await deployToken(rpcA.url);
  const cowToken = token(rpcA.url, tokenAddr);
  await waitReceipt(rpcA, await mint(cowToken, cowWallet().address, MINOUT * 10n));
  await waitReceipt(rpcA, await approve(cowToken, SETTLEMENT_ADDR, MINOUT * 10n));

  // model the peg-in: escrow INPUT rbtc for a unique btcTxid (ticket off, so any txid is fine)
  const btcTxid = getBytes(randomBytes(32));
  await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btcTxid), INPUT));
  r.check("input escrowed for the peg-in", (await peginOf(rpcA.url, hexlify(btcTxid))) === INPUT);

  const user = freshWallet();
  const H = randomH();
  const height = await rpcA.blockNumber();
  const intent = buildIntent(user, { H, btcTxid, expiry: height + 95, minOut: MINOUT, outputToken: tokenAddr });
  await rpcA.sendRaw(intent.rawHex);

  const solver = new Solver(rpcA.url); // cow
  const solverRbtcBefore = BigInt(await rpcA.getBalance(solver.payer));
  const rec = await waitReceipt(rpcA, await solver.solve(intent.rawHex, 0n)); // token output: no RBTC value
  r.check("settle succeeded", succeeded(rec), rec ? rec.status : "no receipt");

  // user got the output; solver claimed the input; escrow cleared; spread realized
  r.check("user received >= minOut of the token (output)", (await balanceOf(cowToken, user.address)) >= MINOUT);
  const solverDelta = BigInt(await rpcA.getBalance(solver.payer)) - solverRbtcBefore;
  r.check("solver claimed the input RBTC (delta ~ INPUT, minus gas)", solverDelta > INPUT - GAS_BOUND, `delta=${solverDelta}`);
  r.check("escrow cleared", (await peginOf(rpcA.url, hexlify(btcTxid))) === 0n);
  r.check("H consumed", await isConsumed((to, d) => rpcA.ethCall(to, d), H));

  console.log(`\nspread = value(${INPUT} wei RBTC input) − value(${MINOUT} token output) − gas, kept by the solver (priced off-chain).`);
  return r.done();
}

main().then((c) => process.exit(c));
