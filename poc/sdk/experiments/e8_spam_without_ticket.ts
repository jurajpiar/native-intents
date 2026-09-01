/**
 * E8 — Anti-spam: no BTC ticket, no admission.
 *
 * Hypothesis: with the BTC-ticket policy on, an intent whose referenced BTC txid is not a processed
 * peg-in in the Bridge SPV view is rejected at admission. This is the mempool-DoS filter that replaces
 * "sender can pay".
 * Procedure: submit an intent with a bogus btcTxid -> expect rejection naming the ticket.
 * Falsifier: it is accepted despite no valid ticket.
 *
 * REQUIRES the node running with -Dintent.requireBtcTicket=true (NOT the compose default). Launch a
 * node with that flag, or set INTENT_REQUIRE_TICKET awareness in your run. See stack/README.
 */
import { buildIntent, freshWallet, randomH } from "../src/intent.js";
import { Report, preflight, rpcA, errMsg } from "./_harness.js";
import { randomBytes, getBytes } from "ethers";

async function main(): Promise<number> {
  await preflight(rpcA);
  const r = new Report("E8 spam without BTC ticket", "anti-spam: intents need a confirmed BTC peg-in ticket");

  const height = await rpcA.blockNumber();
  const bogusTxid = getBytes(randomBytes(32)); // not a processed peg-in
  const intent = buildIntent(freshWallet(), { H: randomH(), btcTxid: bogusTxid, expiry: height + 50, minOut: 0n });

  let rejected = false;
  let msg = "";
  try {
    await rpcA.sendRaw(intent.rawHex);
  } catch (e) {
    rejected = true;
    msg = errMsg(e);
  }
  r.check("intent without a ticket is rejected", rejected, msg);
  r.check("rejection names the BTC ticket", /ticket|btc|spv/i.test(msg), msg);
  if (!rejected) {
    console.log("\nIf this was accepted, the node is likely running with requireBtcTicket=false. Relaunch with -Dintent.requireBtcTicket=true.");
  }
  return r.done();
}

main().then((c) => process.exit(c));
