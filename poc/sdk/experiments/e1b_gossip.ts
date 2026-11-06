/**
 * E1b — Gossip (the stronger form of claim 1).
 *
 * Hypothesis: an intent submitted to node A propagates over p2p and appears in node B's mempool —
 * i.e. it is a genuinely gossiped protocol object, not just accepted locally.
 * Procedure: submit to A -> poll B's txpool_content until the hash appears. Right after a fresh
 * recreate, rskj's tx relay can lag its first announcements even once peered — an intent submitted
 * into that window is never re-announced. So on a miss the experiment retries ONCE with a FRESH
 * intent (a genuinely broken gossip path still fails both attempts).
 * Falsifier: neither intent reaches B (within timeout) while A and B are peered.
 *
 * Needs both nodes up and peered (podman-compose brings up rskj-a and rskj-b).
 */
import { buildIntent, freshWallet, randomH } from "../src/intent.js";
import { Report, preflight, rpcA, rpcB, errMsg } from "./_harness.js";
import { waitFor } from "../src/client.js";

async function main(): Promise<number> {
  await preflight(rpcA);
  await preflight(rpcB);
  const r = new Report("E1b intent gossip A->B", "claim 1: intents propagate as p2p mempool objects");

  // static-IP active peers can take a little while to connect after a fresh recreate
  await waitFor(async () => (await rpcA.peerCount().catch(() => 0)) >= 1, 40000);
  const peers = await rpcA.peerCount().catch(() => 0);
  r.check("node A has >=1 peer", peers >= 1, `net_peerCount=${peers}`);

  /** submit a fresh intent to A and poll B for it; returns whether it arrived */
  async function submitAndAwaitGossip(label: string): Promise<boolean> {
    const height = await rpcA.blockNumber();
    const intent = buildIntent(freshWallet(), { H: randomH(), btcTxid: new Uint8Array(32), expiry: height + 50, minOut: 0n });
    try {
      await rpcA.sendRaw(intent.rawHex);
      r.check(`submitted to A${label}`, true, intent.hash);
    } catch (e) {
      r.check(`submitted to A${label}`, false, errMsg(e));
      return false;
    }
    // tx-relay after a fresh recreate can lag the first block or two; poll generously
    return waitFor(async () =>
      (await rpcB.pendingTxs()).some((t) => t.hash.toLowerCase() === intent.hash.toLowerCase()), 60000);
  }

  let reachedB = await submitAndAwaitGossip("");
  if (!reachedB) {
    console.log("first intent never reached B — startup relay lag? retrying once with a FRESH intent…");
    reachedB = await submitAndAwaitGossip(" (retry)");
  }
  r.check("intent appeared in node B mempool", reachedB);
  return r.done();
}

main().then((c) => process.exit(c));
