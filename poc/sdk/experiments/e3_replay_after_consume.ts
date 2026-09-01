/**
 * E3 — No replay after H is consumed (consumed-set = nonce-for-intents).
 *
 * Hypothesis: once an intent is solved (H recorded consumed), any later intent committing to the same
 * H is rejected at admission. Replay protection is pre-inclusion and keyed by H.
 * Procedure: build intent(H) -> solve it (delivers minOut, consumes H) -> build a FRESH intent with
 *            the same H -> expect admission to reject it naming "consumed".
 * Falsifier: the second intent is admitted, or isConsumed stays false after a successful solve.
 */
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { Solver } from "../src/solver.js";
import { Report, preflight, rpcA, waitReceipt, errMsg } from "./_harness.js";
import { cowWallet } from "../src/config.js";

const MINOUT = 1_000_000_000_000_000n; // 1e15 wei

async function main(): Promise<number> {
  await preflight(rpcA);
  const r = new Report("E3 replay after consume", "consumed-set: a consumed H cannot be re-submitted");

  if (!r.check("solver payer (cow) funded", BigInt(await rpcA.getBalance(cowWallet().address)) > MINOUT)) return r.done();

  const H = randomH();
  const height = await rpcA.blockNumber();
  const intentA = buildIntent(freshWallet(), { H, btcTxid: new Uint8Array(32), expiry: height + 100, minOut: MINOUT });
  await rpcA.sendRaw(intentA.rawHex);
  r.check("first intent admitted", true, intentA.hash);

  const solver = new Solver(rpcA.url);
  await waitReceipt(rpcA, await solver.solve(intentA.rawHex));
  r.check("isConsumed(H) == true after solve", await isConsumed((to, d) => rpcA.ethCall(to, d), H));

  // replay: a brand-new intent (fresh sender) committing to the SAME H
  const intentB = buildIntent(freshWallet(), { H, btcTxid: new Uint8Array(32), expiry: height + 100, minOut: MINOUT });
  let rejected = false;
  let msg = "";
  try {
    await rpcA.sendRaw(intentB.rawHex);
  } catch (e) {
    rejected = true;
    msg = errMsg(e);
  }
  r.check("replay intent rejected at admission", rejected, msg);
  r.check("rejection names consumed", /consum/i.test(msg), msg);
  return r.done();
}

main().then((c) => process.exit(c));
