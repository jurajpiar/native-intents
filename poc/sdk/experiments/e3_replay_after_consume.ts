/**
 * E3 — No replay after H is consumed (consumed-set = nonce-for-intents).
 *
 * Hypothesis: once a solver consumes H, any later intent committing to the same H is rejected at
 * admission. The consumed set is world state; replay protection is pre-inclusion.
 * Procedure: submit intent(H) -> solver consumes H (paid tx) -> assert isConsumed(H) -> submit a
 *            fresh intent with the SAME H -> expect rejection naming "consumed".
 * Falsifier: the second intent is accepted, or isConsumed stays false after a successful consume.
 */
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { Solver } from "../src/solver.js";
import { Report, preflight, rpcA, errMsg } from "./_harness.js";
import { waitFor } from "../src/client.js";
import { cowWallet } from "../src/config.js";
import { hexlify } from "ethers";

async function main(): Promise<number> {
  await preflight(rpcA);
  const r = new Report("E3 replay after consume", "consumed-set: a consumed H cannot be re-submitted");

  const cowBal = BigInt(await rpcA.getBalance(cowWallet().address));
  if (!r.check("solver payer (cow) is funded", cowBal > 0n, cowBal > 0n ? `${cowBal}` : "0 — run 'npm run diag'; node likely not on rsk-dev.json genesis")) return r.done();

  const H = randomH();
  const height = await rpcA.blockNumber();
  const first = buildIntent(freshWallet(), { H, btcTxid: new Uint8Array(32), expiry: height + 100, minOut: 0n });
  await rpcA.sendRaw(first.rawHex);
  r.check("first intent admitted", true, first.hash);

  const solver = new Solver(rpcA.url);
  let consumeHash = "";
  try {
    consumeHash = await solver.consume(hexlify(H));
  } catch (e) {
    r.check("solver consume submitted", false, errMsg(e));
    return r.done();
  }
  r.check("solver consume submitted", true, consumeHash);
  const mined = await waitFor(async () => {
    const rec = await rpcA.getReceipt(consumeHash).catch(() => null);
    return rec !== null && rec.blockNumber !== null;
  }, 20000);
  r.check("solver consume tx mined", mined, consumeHash);

  const consumed = await isConsumed((to, data) => rpcA.ethCall(to, data), H);
  r.check("isConsumed(H) == true", consumed);

  const replay = buildIntent(freshWallet(), { H, btcTxid: new Uint8Array(32), expiry: height + 100, minOut: 0n });
  let rejected = false;
  let msg = "";
  try {
    await rpcA.sendRaw(replay.rawHex);
  } catch (e) {
    rejected = true;
    msg = errMsg(e);
  }
  r.check("replay intent rejected", rejected, msg);
  r.check("rejection names consumed", /consum/i.test(msg), msg);
  return r.done();
}

main().then((c) => process.exit(c));
