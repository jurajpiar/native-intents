/**
 * E9 — A reorg reverts a solve cleanly (claim 2's reorg story).
 *
 * The consumed set and the delivered output are ordinary world state, so a reorg that drops the solve's
 * block must revert both, leaving the intent solvable again on the new branch. We model the reorg with
 * evm_snapshot / evm_revert (revert rolls the chain + state back to the snapshot height, exactly a
 * losing branch being discarded).
 *
 * Procedure: snapshot -> solve an intent (H consumed, user paid) -> evm_revert to the snapshot ->
 *            assert H is unconsumed and the user's balance reverted -> re-solve -> assert it works again.
 * Falsifier: after the reorg H stays consumed, the user keeps the delivery, or the intent can't be re-solved.
 *
 * Run standalone (it rolls the chain back, so it is kept out of `npm run all`):  npm run e9
 */
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { Solver } from "../src/solver.js";
import { Report, preflight, rpcA, waitReceipt } from "./_harness.js";
import { cowWallet } from "../src/config.js";
import { sleep } from "../src/client.js";

const MINOUT = 1_000_000_000_000_000n; // 1e15 wei

async function main(): Promise<number> {
  await preflight(rpcA);
  const r = new Report("E9 reorg reverts a solve", "claim 2: a dropped solve reverts with its block; consumed set follows state reversion");
  const isC = (H: Uint8Array) => isConsumed((to, d) => rpcA.ethCall(to, d), H);
  const bal = (a: string) => rpcA.getBalance(a).then(BigInt);

  if (!r.check("solver payer (cow) funded", (await bal(cowWallet().address)) > MINOUT)) return r.done();

  const snap = await rpcA.snapshot();
  const user = freshWallet();
  const H = randomH();
  const height = await rpcA.blockNumber();
  const intent = buildIntent(user, { H, btcTxid: new Uint8Array(32), expiry: height + 95, minOut: MINOUT });

  // settle on the branch that will be dropped
  await rpcA.sendRaw(intent.rawHex);
  await waitReceipt(rpcA, await new Solver(rpcA.url).solve(intent.rawHex));
  r.check("before reorg: H consumed", await isC(H));
  r.check("before reorg: user paid >= minOut", (await bal(user.address)) >= MINOUT);

  // reorg: discard the branch containing the solve
  r.check("evm_revert succeeded", await rpcA.revert(snap));
  await sleep(1500);
  r.check("after reorg: H unconsumed (consumed set reverted)", !(await isC(H)));
  r.check("after reorg: user balance reverted to 0", (await bal(user.address)) === 0n);

  // the intent is solvable again on the new branch
  await rpcA.sendRaw(intent.rawHex);
  await waitReceipt(rpcA, await new Solver(rpcA.url).solve(intent.rawHex));
  r.check("re-solve after reorg: H consumed again", await isC(H));
  r.check("re-solve after reorg: user paid again", (await bal(user.address)) >= MINOUT);
  return r.done();
}

main().then((c) => process.exit(c));
