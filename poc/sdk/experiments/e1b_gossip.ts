/**
 * E1b — Gossip (the stronger form of claim 1).
 *
 * Hypothesis: an intent submitted to node A propagates over p2p and appears in node B's mempool —
 * i.e. it is a genuinely gossiped protocol object, not just accepted locally.
 * Procedure: submit to A -> poll B's txpool_content until the hash appears.
 * Falsifier: it never reaches B (within timeout) while A and B are peered.
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

  const height = await rpcA.blockNumber();
  const intent = buildIntent(freshWallet(), { H: randomH(), btcTxid: new Uint8Array(32), expiry: height + 50, minOut: 0n });

  try {
    await rpcA.sendRaw(intent.rawHex);
    r.check("submitted to A", true, intent.hash);
  } catch (e) {
    r.check("submitted to A", false, errMsg(e));
    return r.done();
  }

  // tx-relay after a fresh recreate can lag the first block or two; poll generously
  const reachedB = await waitFor(async () =>
    (await rpcB.pendingTxs()).some((t) => t.hash.toLowerCase() === intent.hash.toLowerCase()), 60000);
  r.check("intent appeared in node B mempool", reachedB);
  return r.done();
}

main().then((c) => process.exit(c));
