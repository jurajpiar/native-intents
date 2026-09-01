/**
 * E13 — Activation gate (productionization B).
 *
 * The intent type is behind a consensus rule (RSKIPINTENT), activated at a nonzero height on regtest
 * (block 40). Before activation an intent is inert — rejected at admission as "not active"; after
 * activation it is admitted normally. This demonstrates the real activation story that replaces the
 * PoC's always-on-genesis behaviour.
 *
 * Run this FIRST, right after `up`, to catch the pre-activation window (regtest mines ~1 block/s, so the
 * window is ~40s). If run later it only checks the post-activation case and says so.
 */
import { buildIntent, freshWallet, randomH } from "../src/intent.js";
import { Report, preflight, rpcA, errMsg, ACTIVATION_HEIGHT } from "./_harness.js";
import { waitFor } from "../src/client.js";

const ACTIVATION = ACTIVATION_HEIGHT; // rskipIntent activation height on regtest

async function main(): Promise<number> {
  await preflight(rpcA, { waitActivation: false }); // don't wait — we want to observe the pre-activation window
  const r = new Report("E13 activation gate", "the intent type is inert before its activation height and works after");
  const height = await rpcA.blockNumber();
  console.log(`current height ${height}, activation at ${ACTIVATION}`);

  if (height < ACTIVATION) {
    const pre = buildIntent(freshWallet(), { H: randomH(), btcTxid: new Uint8Array(32), expiry: ACTIVATION + 50, minOut: 0n });
    let rejected = false;
    let msg = "";
    try { await rpcA.sendRaw(pre.rawHex); } catch (e) { rejected = true; msg = errMsg(e); }
    r.check("pre-activation: intent rejected", rejected, msg);
    r.check("rejection names activation", /not active/i.test(msg), msg);
    console.log(`waiting for height >= ${ACTIVATION}...`);
    await waitFor(async () => (await rpcA.blockNumber()) >= ACTIVATION, 120000, 1000);
  } else {
    r.check("pre-activation window already passed (run e13 right after `up` to see it)", true, `height ${height} >= ${ACTIVATION}`);
  }

  const h2 = await rpcA.blockNumber();
  const post = buildIntent(freshWallet(), { H: randomH(), btcTxid: new Uint8Array(32), expiry: h2 + 50, minOut: 0n });
  let accepted = false;
  let amsg = "";
  try {
    const hash = await rpcA.sendRaw(post.rawHex);
    accepted = hash.toLowerCase() === post.hash.toLowerCase();
  } catch (e) { amsg = errMsg(e); }
  r.check("post-activation: intent admitted", accepted, amsg || post.hash);
  return r.done();
}

main().then((c) => process.exit(c));
