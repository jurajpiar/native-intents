/**
 * E16 — Cross-node reorg (genuine p2p). The two-node upgrade of E9 (which models a reorg on one node with
 * evm_snapshot/evm_revert). Here a real competing chain from a second node causes the first to reorg, so
 * the node's own fork-choice — not a test-only rollback — orphans the settle.
 *
 * Both nodes mine ON DEMAND (evm_mine; see node-*-reorg.conf). The reorg is driven by partitioning them
 * with `docker stop`/`start`:
 *   1. both synced at h0 (>= the RSKIPINTENT activation height)
 *   2. stop B; on A: submit the intent + settle, mine one block  -> A has the settle at h0+1
 *   3. stop A, start B; on B: mine two blocks                     -> B has a heavier chain (h0+2), no settle
 *   4. start A; A reconnects, sees B's higher-total-difficulty chain, and REORGS onto it
 *   5. the settle is orphaned: delivery reverts, H is no longer consumed, the intent is re-solvable
 *
 * Falsifier: A doesn't adopt B's chain, or after the reorg the user keeps the delivered output, H stays
 * consumed, or the intent can't be re-solved.
 *
 * Needs the dedicated reorg stack up (docker-compose.reorg.yml; host ports 4454/4455, containers
 * rskj-a-reorg / rskj-b-reorg) and a working `docker` CLI. Standalone; not part of `npm run all`.
 * Slow: it stops/starts JVM nodes (~1–2 min).
 */
import { execSync } from "node:child_process";
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { Solver } from "../src/solver.js";
import { Rpc, waitFor, sleep } from "../src/client.js";
import { Report, waitReceipt, succeeded } from "./_harness.js";
import { RBTC } from "../src/config.js";
import { getBytes, randomBytes } from "ethers";

const A_URL = "http://localhost:4454";
const B_URL = "http://localhost:4455";
const A_NODE = "rskj-a-reorg";
const B_NODE = "rskj-b-reorg";
const ACTIVATION = 40;                     // RSKIPINTENT regtest activation height
const MINOUT = 1_000_000_000_000_000n;     // 1e15 wei RBTC output

const rpcA = new Rpc(A_URL);
const rpcB = new Rpc(B_URL);

const docker = (args: string): string => execSync(`docker ${args}`, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const mine = (rpc: Rpc) => rpc.call<null>("evm_mine");
const blockHash = async (rpc: Rpc, n: number): Promise<string> =>
  ((await rpc.call<{ hash: string } | null>("eth_getBlockByNumber", ["0x" + n.toString(16), false]))?.hash) ?? "none";
const consumedOn = (rpc: Rpc, H: Uint8Array) => isConsumed((to, d) => rpc.ethCall(to, d), H);

async function mineTo(rpc: Rpc, target: number): Promise<void> {
  while ((await rpc.blockNumber()) < target) await mine(rpc);
}

/** wait until a node's RPC answers after a start (JVM boot) */
async function waitReady(rpc: Rpc, label: string, timeoutMs = 90000): Promise<void> {
  const ok = await waitFor(async () => { try { await rpc.blockNumber(); return true; } catch { return false; } }, timeoutMs, 1000);
  if (!ok) { console.error(`\n${label} did not become ready within ${timeoutMs}ms`); process.exit(2); }
}

async function preflight(): Promise<void> {
  try { docker("version --format {{.Server.Version}}"); }
  catch { console.error("\nDocker CLI not available — E16 needs it to partition the nodes."); process.exit(2); }
  for (const [rpc, node, url] of [[rpcA, A_NODE, A_URL], [rpcB, B_NODE, B_URL]] as const) {
    try { await rpc.blockNumber(); }
    catch {
      console.error(
        `\nCannot reach ${node} at ${url}. Bring up the reorg stack first:\n` +
        `  cd poc && npm run stack:reorg:up\n` +
        `or let a board run do it for you:\n` +
        `  cd poc && npm run attacks:provision      # provisions whatever each attack declares\n` +
        `(if the image is missing, npm run stack:up builds it — the reorg stack reuses it)\n`
      );
      process.exit(2);
    }
  }
  // on-demand mining sanity: height must NOT advance on its own (else these aren't the reorg configs)
  const h = await rpcA.blockNumber();
  await sleep(2500);
  if ((await rpcA.blockNumber()) !== h) {
    console.error(`\n${A_NODE} is auto-mining — E16 needs the on-demand reorg configs (node-a-reorg.conf). Recreate with docker-compose.reorg.yml.`);
    process.exit(2);
  }
}

async function main(): Promise<number> {
  await preflight();
  const r = new Report("E16 cross-node reorg", "a competing chain from node B causes node A to reorg, orphaning the settle (H + delivery revert, intent re-solvable)");

  // --- phase 0 (PRECONDITION, hard-gated): peer, mine past activation, B fully synced ---
  // RPC-up is not p2p-peered: the JVM answers RPC well before the handshake completes, and mining into
  // an unpeered network leaves B at genesis (observed on the first run: B=0 while A=41). So wait for
  // net_peerCount >= 1 on BOTH nodes before producing any block, then give the initial sync a generous
  // window with progress logging. Failing here is a harness/timing problem, not the claim under test —
  // exit instead of letting every later check cascade-fail misleadingly.
  const peered = await waitFor(async () =>
    (await rpcA.peerCount().catch(() => 0)) >= 1 && (await rpcB.peerCount().catch(() => 0)) >= 1, 120000, 1000);
  if (!peered) {
    console.error(`\nprecondition failed: nodes never peered (A=${await rpcA.peerCount().catch(() => 0)} B=${await rpcB.peerCount().catch(() => 0)} peers). Check the reorg stack logs.`);
    process.exit(2);
  }
  await mineTo(rpcA, ACTIVATION + 1);
  const h0 = await rpcA.blockNumber();
  const synced = await waitFor(async () => {
    const b = await rpcB.blockNumber().catch(() => -1);
    console.log(`  sync: A=${h0} B=${b}`);
    return b >= h0;
  }, 120000, 3000);
  if (!synced) {
    console.error(`\nprecondition failed: B never synced to A (A=${h0}, B=${await rpcB.blockNumber().catch(() => -1)}) despite being peered. Check the reorg stack logs.`);
    process.exit(2);
  }
  r.check("precondition: peered and B synced past activation", (await rpcB.blockNumber()) >= h0, `h0=${h0}`);

  // the intent (RBTC output) and its solver, prepared up front
  const user = freshWallet();
  const H = randomH();
  const intent = buildIntent(user, { H, btcTxid: getBytes(randomBytes(32)), expiry: h0 + 90, minOut: MINOUT, outputToken: RBTC });
  const solver = new Solver(A_URL); // cow, settles against node A

  // --- phase 1: partition (stop B), settle on A, mine one block ---
  console.log(`\npartitioning: docker stop ${B_NODE}`);
  docker(`stop ${B_NODE}`);
  await rpcA.sendRaw(intent.rawHex);                     // intent into A's mempool
  const settleHash = await solver.solve(intent.rawHex, MINOUT);
  await mine(rpcA);                                      // A mines h0+1 with the settle
  const recA = await waitReceipt(rpcA, settleHash);
  const aHeight1 = await rpcA.blockNumber();
  r.check("pre-reorg: settle mined on A", succeeded(recA) && aHeight1 === h0 + 1, `status=${recA?.status} h=${aHeight1}`);
  r.check("pre-reorg: A delivered the output", BigInt(await rpcA.getBalance(user.address)) === MINOUT);
  r.check("pre-reorg: A shows H consumed", await consumedOn(rpcA, H));
  const orphanHash = await blockHash(rpcA, h0 + 1);      // A's soon-to-be-orphaned block

  // --- phase 2: swap the partition (stop A, start B), build a heavier chain on B ---
  console.log(`\nswapping: docker stop ${A_NODE}; docker start ${B_NODE}`);
  docker(`stop ${A_NODE}`);
  docker(`start ${B_NODE}`);
  await waitReady(rpcB, B_NODE);
  // B restarts from its own DB and must resume at h0 (it synced there in phase 0) — hard-gate this too
  const bResumed = await waitFor(async () => (await rpcB.blockNumber().catch(() => -1)) >= h0, 30000, 1000);
  if (!bResumed) {
    console.error(`\nprecondition failed: B resumed at ${await rpcB.blockNumber().catch(() => -1)}, expected h0=${h0}. Its DB did not persist?`);
    process.exit(2);
  }
  await mine(rpcB); await mine(rpcB);                    // B mines h0+1, h0+2 (no settle)
  const bHeight = await rpcB.blockNumber();
  r.check("B built a heavier chain without the settle", bHeight === h0 + 2 && !(await consumedOn(rpcB, H)), `B=${bHeight}`);
  r.check("B's block at h0+1 differs from A's orphan", (await blockHash(rpcB, h0 + 1)) !== orphanHash);

  // --- phase 3: heal (start A) — A should reorg onto B's heavier chain ---
  console.log(`\nhealing: docker start ${A_NODE}`);
  docker(`start ${A_NODE}`);
  await waitReady(rpcA, A_NODE);
  await waitFor(async () => (await rpcA.peerCount().catch(() => 0)) >= 1, 60000, 1000); // re-peer
  const reorged = await waitFor(async () => (await rpcA.blockNumber().catch(() => 0)) >= h0 + 2 && !(await consumedOn(rpcA, H)), 90000, 1500);
  const aHeight2 = await rpcA.blockNumber();

  r.check("A reorged onto B's chain (adopted h0+2)", reorged && aHeight2 >= h0 + 2, `A=${aHeight2}`);
  if (!reorged) {
    // THIS is the claim under test — report the failure with diagnostics rather than cascading through
    // phase 4 (whose effect-based checks would pass trivially on the un-reorged chain).
    console.error(`\nA did not adopt B's chain: A=${aHeight2} (h0+2=${h0 + 2}), A@h0+1=${(await blockHash(rpcA, h0 + 1)).slice(0, 18)}…, orphan=${orphanHash.slice(0, 18)}…, peers=${await rpcA.peerCount().catch(() => 0)}`);
    return r.done();
  }
  r.check("A now holds B's block at h0+1 (settle orphaned)", (await blockHash(rpcA, h0 + 1)) !== orphanHash);
  r.check("delivery reverted — user balance back to 0", BigInt(await rpcA.getBalance(user.address)) === 0n);
  r.check("H no longer consumed after the reorg", !(await consumedOn(rpcA, H)));

  // --- phase 4: the intent is re-solvable on the reorged chain ---
  // Re-seed intent + settle. rskj may already have returned the orphaned settle to A's mempool; that tx
  // is byte-identical (cow nonce 0) so a re-send is "already known" — harmless. Either way the settle is
  // pending, so we assert on EFFECTS after mining rather than on the send succeeding.
  await rpcA.sendRaw(intent.rawHex).catch(() => {});
  const reSettle = await solver.solve(intent.rawHex, MINOUT).catch(() => settleHash); // same hash if already pending
  await mine(rpcA);
  const recA2 = await waitReceipt(rpcA, reSettle).catch(() => null);
  r.check("intent re-solved: output delivered again", BigInt(await rpcA.getBalance(user.address)) === MINOUT, recA2 ? `settle=${recA2.status}` : "by effect");
  r.check("intent re-solved: H consumed again", await consumedOn(rpcA, H));

  if (reorged) console.log(`\nA orphaned its own settle block (${orphanHash.slice(0, 10)}…) on adopting B's heavier chain, then re-solved the same intent.`);
  return r.done();
}

main().then((c) => process.exit(c));
