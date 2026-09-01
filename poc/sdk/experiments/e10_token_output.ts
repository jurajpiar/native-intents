/**
 * E10 — ERC-20 output (milestone 3).
 *
 * Hypothesis: an intent whose output asset is an ERC-20 is settled by the contract delivering >= minOut
 * of that token to the user (via transferFrom from the solver), and records H — atomically.
 * Falsifier: the user isn't credited the token, or H is consumed without the token being delivered.
 *
 * Deploys a test ERC-20, mints to the solver (cow), approves the settlement contract, then settles a
 * token-output intent (value 0; delivery is the ERC-20 transfer).
 */
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { Solver } from "../src/solver.js";
import { deployToken, token, mint, approve, balanceOf } from "../src/token.js";
import { Report, preflight, requireSettlement, rpcA, waitReceipt, succeeded } from "./_harness.js";
import { cowWallet, SETTLEMENT_ADDR } from "../src/config.js";

const MINOUT = 1_000_000_000_000_000_000n; // 1 token (1e18)

async function main(): Promise<number> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  const r = new Report("E10 ERC-20 output", "settlement delivers an ERC-20 output to the user, atomically");

  const tokenAddr = await deployToken(rpcA.url);
  r.check("test token deployed", /^0x[0-9a-fA-F]{40}$/.test(tokenAddr), tokenAddr);
  const cowToken = token(rpcA.url, tokenAddr); // cow signer
  await waitReceipt(rpcA, await mint(cowToken, cowWallet().address, MINOUT * 10n));
  await waitReceipt(rpcA, await approve(cowToken, SETTLEMENT_ADDR, MINOUT * 10n));

  const user = freshWallet();
  const H = randomH();
  const height = await rpcA.blockNumber();
  const intent = buildIntent(user, { H, btcTxid: new Uint8Array(32), expiry: height + 95, minOut: MINOUT, outputToken: tokenAddr });
  await rpcA.sendRaw(intent.rawHex);
  r.check("token intent admitted", true, intent.hash);

  const solver = new Solver(rpcA.url); // cow
  const rec = await waitReceipt(rpcA, await solver.solve(intent.rawHex, 0n)); // token output: no RBTC value
  r.check("solve succeeded", succeeded(rec), rec ? rec.status : "no receipt");

  const userBal = await balanceOf(cowToken, user.address);
  r.check("user received >= minOut of the token", userBal >= MINOUT, `${userBal}`);
  r.check("H consumed", await isConsumed((to, d) => rpcA.ethCall(to, d), H));
  return r.done();
}

main().then((c) => process.exit(c));
