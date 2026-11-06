/**
 * E8 — Anti-spam: no BTC ticket, no admission.
 *
 * Hypothesis: with the BTC-ticket policy on, an intent whose referenced BTC txid is not a processed
 * peg-in in the Bridge SPV view is rejected at admission. This is the mempool-DoS filter that replaces
 * "sender can pay".
 * Procedure: submit an intent with a bogus btcTxid -> expect rejection naming the ticket.
 * Falsifier: it is accepted despite no valid ticket.
 *
 * REQUIRES the node running with -Dintent.requireBtcTicket=true (NOT the compose default, which pins
 * false at stack/podman-compose.yml:43,59). See ../stack/scripts/pegin.md.
 *
 * An admitted intent means one of two completely different things, and the node's response looks
 * identical either way: the anti-spam rule is OFF (nothing to test), or it is ON and has been
 * defeated (the finding). Nothing on the wire distinguishes them, so the operator has to say which
 * world this run is in — export INTENT_REQUIRE_TICKET=true alongside the node flag. Without that
 * assertion an admission exits 2 ("environment not ready") rather than claiming a falsification it
 * cannot support.
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
  // The operator's assertion that the rule is actually on. Only with it does an admission mean the
  // rule was DEFEATED; without it, an admission just means the rule was never armed.
  const asserted = process.env.INTENT_REQUIRE_TICKET === "true";
  if (!rejected && !asserted) {
    console.error(
      `\nThe intent was ADMITTED, and this run cannot tell whether that is the finding or the setup:\n` +
      `  intent.requireBtcTicket defaults to false in stack/podman-compose.yml, so the rule is\n` +
      `  probably not armed. Arm it and assert it, then re-run:\n\n` +
      `    INTENT_REQUIRE_TICKET=true docker-compose -f stack/podman-compose.yml up -d --no-build -t 120\n` +
      `    ( cd sdk && INTENT_REQUIRE_TICKET=true npm run e8 )\n\n` +
      `  Or, without touching a populated stack, against a throwaway node:\n\n` +
      `    docker run --rm -d --name rskj-ticket -p 4464:4444 -e RSK_CONF=/config/node-a.conf \\\n` +
      `      -e JVM_OPTS=-Xmx2g -e INTENT_OPTS="-Dintent.requireBtcTicket=true -Dintent.maxExpirySpan=100" \\\n` +
      `      -v "$PWD/stack/config:/config:ro" rskj-intent:poc\n` +
      `    ( cd sdk && RPC_A=http://localhost:4464 INTENT_REQUIRE_TICKET=true npm run e8 )\n\n` +
      `See ../stack/scripts/pegin.md.\n`);
    process.exit(2); // environment not ready — NOT a falsified claim
  }

  r.check("intent without a ticket is rejected", rejected, msg);
  r.check("rejection names the BTC ticket", /ticket|btc|spv/i.test(msg), msg);
  if (!rejected) {
    console.log(`\nINTENT_REQUIRE_TICKET=true was asserted, so this IS a falsification: the node admitted an\n` +
      `intent whose btcTxid is not a processed peg-in. The anti-spam filter did not hold.`);
  }
  return r.done();
}

main().then((c) => process.exit(c));
