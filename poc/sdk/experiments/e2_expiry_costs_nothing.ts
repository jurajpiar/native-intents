/**
 * E2 — Invalidity before inclusion costs nothing (irreducible claim 2).
 *
 * Hypothesis: an expired intent is rejected at admission — it never enters the mempool, never reaches
 * a block, burns no gas, leaves nothing on chain. (A contract-level expiry check cannot do this: it
 * runs post-inclusion, spending block space and gas.)
 * Procedure: build an intent with E <= current height -> submit -> expect a rejection naming expiry
 *            -> assert it is NOT in the mempool and left no receipt.
 * Falsifier: the expired intent is accepted, or shows up anywhere on chain.
 */
import { buildIntent, freshWallet, randomH } from "../src/intent.js";
import { Report, preflight, rpcA, errMsg } from "./_harness.js";

async function main(): Promise<number> {
  await preflight(rpcA);
  const r = new Report("E2 expiry costs nothing", "claim 2: an expired intent never enters a block and costs nothing");

  const height = await rpcA.blockNumber();
  const expired = buildIntent(freshWallet(), { H: randomH(), btcTxid: new Uint8Array(32), expiry: height, minOut: 0n }); // E == height => expired

  let rejected = false;
  let msg = "";
  try {
    await rpcA.sendRaw(expired.rawHex);
  } catch (e) {
    rejected = true;
    msg = errMsg(e);
  }
  r.check("expired intent rejected at admission", rejected, msg);
  r.check("rejection names expiry", /expire/i.test(msg), msg);

  const inPool = (await rpcA.pendingTxs()).some((t) => t.hash.toLowerCase() === expired.hash.toLowerCase());
  r.check("not in mempool", !inPool);

  const receipt = await rpcA.getReceipt(expired.hash).catch(() => null);
  r.check("no receipt / nothing on chain", receipt === null || receipt.blockNumber === null);
  return r.done();
}

main().then((c) => process.exit(c));
