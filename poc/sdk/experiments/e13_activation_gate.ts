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
    /**
     * The pre-activation window is GONE, and there is no honest way to report that as a pass.
     *
     * This used to be `r.check(..., true, ...)` — a check that asserted nothing and always passed, so
     * the board printed "attack BLOCKED · as predicted" for the activation gate on a chain where the
     * gate could not possibly be exercised. That is a phantom pass: the output looks like evidence and
     * contains none.
     *
     * Exit 2 is the runner's ENVIRONMENT code, which is exactly what this is — the claim is testable,
     * just not on a chain that is already past the fork. It costs nothing in coverage: the
     * post-activation half of this claim is exercised by every other experiment that admits an intent.
     */
    console.error(
      `\nThe pre-activation window has already passed: height ${height} >= activation ${ACTIVATION}.\n` +
      `This experiment can only observe the gate on a chain BELOW the activation height, so there is\n` +
      `nothing here to test — reporting a pass would assert something this run cannot know.\n\n` +
      `Two ways to see the gate:\n` +
      `  cd poc && npm run attacks -- a1     # a1 builds its own node with a settable activation height,\n` +
      `                                      # mining on demand, so the window never closes (preferred)\n` +
      `  cd poc && npm run stack:reset && npm run sdk -- e13   # or race a fresh chain: ~40s of window\n`
    );
    process.exit(2);
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
