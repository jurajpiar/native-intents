/**
 * E11 — A failed solve reverts visibly (milestone 3 fixes the item-2 caveat).
 *
 * In m1/m2 the raw-precompile settlement swallowed failures into a success receipt. With settlement in
 * a VM contract, a failed solve reverts normally: the receipt is failed (status 0x0), and H stays
 * unconsumed with no delivery.
 * Falsifier: an under-delivering solve reports success, or consumes H, or pays the user.
 */
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { Solver } from "../src/solver.js";
import { Report, preflight, requireSettlement, rpcA, waitReceipt, reverted } from "./_harness.js";
import { cowWallet } from "../src/config.js";

const MINOUT = 1_000_000_000_000_000n; // 1e15 wei

async function main(): Promise<number> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  const r = new Report("E11 visible revert", "a failed solve reverts visibly (status 0x0) and leaves H intact");
  if (!r.check("solver payer (cow) funded", BigInt(await rpcA.getBalance(cowWallet().address)) > MINOUT)) return r.done();

  const user = freshWallet();
  const H = randomH();
  const height = await rpcA.blockNumber();
  const intent = buildIntent(user, { H, btcTxid: new Uint8Array(32), expiry: height + 95, minOut: MINOUT });
  await rpcA.sendRaw(intent.rawHex);

  // attach less than minOut -> the settlement contract reverts "under minOut"
  const rec = await waitReceipt(rpcA, await new Solver(rpcA.url).solve(intent.rawHex, MINOUT / 2n));
  r.check("under-min solve reverted (status 0x0)", reverted(rec), rec ? rec.status : "no receipt");
  r.check("H still unconsumed", !(await isConsumed((to, d) => rpcA.ethCall(to, d), H)));
  r.check("user not paid", BigInt(await rpcA.getBalance(user.address)) === 0n);
  return r.done();
}

main().then((c) => process.exit(c));
