/**
 * E8-positive — a valid BTC ticket admits the intent.
 *
 * Hypothesis: with ticket enforcement ON, an intent whose btcTxid references a peg-in that IS processed
 * in the Bridge SPV view is admitted, while a bogus txid is still rejected. This closes the anti-spam
 * loop: the ticket is a real confirmed peg-in.
 * Falsifier: the valid-ticket intent is rejected, or (sanity) a bogus-ticket intent is admitted.
 *
 * Prereq: node running with -Dintent.requireBtcTicket=true, and a processed peg-in — run `npm run pegin`
 * first, then:  PEGIN_TXID=<txid> npm run e8pos
 */
import { buildIntent, freshWallet, randomH } from "../src/intent.js";
import { Report, preflight, rpcA, errMsg } from "./_harness.js";
import { getBytes, randomBytes } from "ethers";

async function main(): Promise<number> {
  await preflight(rpcA);
  const r = new Report("E8 positive BTC ticket", "a real peg-in ticket admits the intent; a bogus one does not");

  const txid = process.env.PEGIN_TXID;
  if (!txid) {
    console.error("\nSet PEGIN_TXID first (run `npm run pegin`).\n");
    process.exit(2);
  }
  const btcTxid = getBytes("0x" + txid.replace(/^0x/, ""));
  if (btcTxid.length !== 32) {
    console.error("\nPEGIN_TXID must be 32-byte hex.\n");
    process.exit(2);
  }
  const height = await rpcA.blockNumber();

  // sanity: enforcement must be ON, else the positive result is meaningless
  const bogus = buildIntent(freshWallet(), { H: randomH(), btcTxid: getBytes(randomBytes(32)), expiry: height + 50, minOut: 0n });
  let bogusRejected = false;
  let bmsg = "";
  try { await rpcA.sendRaw(bogus.rawHex); } catch (e) { bogusRejected = true; bmsg = errMsg(e); }
  if (!r.check("ticket enforcement ON (bogus txid rejected)", bogusRejected && /ticket|btc|spv/i.test(bmsg),
    bogusRejected ? bmsg : "bogus intent ADMITTED — start the node with -Dintent.requireBtcTicket=true")) {
    return r.done();
  }

  // the real thing
  const intent = buildIntent(freshWallet(), { H: randomH(), btcTxid, expiry: height + 50, minOut: 0n });
  let accepted = false;
  let amsg = "";
  try {
    const h = await rpcA.sendRaw(intent.rawHex);
    accepted = h.toLowerCase() === intent.hash.toLowerCase();
  } catch (e) { amsg = errMsg(e); }
  r.check("intent with a valid peg-in ticket is admitted", accepted, amsg || intent.hash);
  return r.done();
}

main().then((c) => process.exit(c));
