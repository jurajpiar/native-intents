/**
 * E6 — The m1 consume-griefing residual is closed (milestone 2).
 *
 * In m1, consume(H) was permissionless: anyone could burn an intent's H without delivering anything.
 * m2 removes consume; the only way to record H is solve(intent), which forces delivery of >= minOut to
 * the user. This experiment shows the grief is now impossible: an adversary that cannot (or will not)
 * deliver minOut has its solve reverted, and — crucially — H stays unconsumed, so the honest solver
 * can still serve the intent.
 *
 * Procedure: honest intent(H, minOut) admitted -> an under-funded adversary (gas money, but < minOut)
 *            attempts solve -> assert it reverts and H is still unconsumed -> a funded solver then
 *            settles it successfully.
 * Falsifier: the adversary consumes H without paying the user, or a reverted solve strands H.
 */
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { Solver } from "../src/solver.js";
import { Report, preflight, rpcA, waitReceipt, fundAccount } from "./_harness.js";
// rskj reports a throwing precompile as status=0x1, so we judge success/failure by EFFECTS
// (was H consumed? was the user paid?), not by receipt status.
import { cowWallet } from "../src/config.js";

const MINOUT = 1_000_000_000_000_000n; // 1e15 wei
const GAS_MONEY = 1_000_000_000_000n;  // 1e12 wei — covers gas, far below minOut

async function main(): Promise<number> {
  await preflight(rpcA);
  const r = new Report("E6 consume-griefing closed", "m2: consumption requires delivery; a failed solve leaves H intact");

  if (!r.check("honest solver payer (cow) funded", BigInt(await rpcA.getBalance(cowWallet().address)) > MINOUT)) return r.done();

  const user = freshWallet();
  const H = randomH();
  const height = await rpcA.blockNumber();
  const intent = buildIntent(user, { H, btcTxid: new Uint8Array(32), expiry: height + 100, minOut: MINOUT });
  await rpcA.sendRaw(intent.rawHex);
  r.check("honest intent admitted", true, intent.hash);

  // under-funded adversary: enough for gas, nowhere near minOut
  const adversary = freshWallet();
  await waitReceipt(rpcA, await fundAccount(adversary.address, GAS_MONEY));
  r.check("adversary funded below minOut", BigInt(await rpcA.getBalance(adversary.address)) < MINOUT);

  const adversarySolver = new Solver(rpcA.url, adversary.privateKey);
  await waitReceipt(rpcA, await adversarySolver.solve(intent.rawHex));
  // grief failed iff it had no effect: H untouched and the user unpaid
  r.check("H still unconsumed after grief attempt", !(await isConsumed((to, d) => rpcA.ethCall(to, d), H)));
  r.check("user not paid by the grief attempt", BigInt(await rpcA.getBalance(user.address)) === 0n);

  // honest solver can still serve the intent
  const honest = new Solver(rpcA.url);
  await waitReceipt(rpcA, await honest.solve(intent.rawHex));
  r.check("user now paid >= minOut", BigInt(await rpcA.getBalance(user.address)) >= MINOUT);
  r.check("H now consumed", await isConsumed((to, d) => rpcA.ethCall(to, d), H));

  console.log("\nnote: E6 now PASSES by the grief FAILING — the m1 residual is closed by atomic solve.");
  return r.done();
}

main().then((c) => process.exit(c));
