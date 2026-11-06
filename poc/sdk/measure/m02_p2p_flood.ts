/**
 * M02 — WHAT A FLOOD OF INTENTS DOES TO A NODE THAT RECEIVES THEM OVER PEER-TO-PEER.
 *
 * CLAIMS row 7 asserts that "rejection is cheap enough that free admission is not a DoS surface", and
 * notes that M01 measured the RPC path only. An attacker would use the p2p path. This measures node B,
 * the stack's non-mining peer, while intents reach it from node A by gossip. Nothing is submitted to
 * B except one start-up probe that B must refuse.
 *
 * FIRST RUN (2026-11-06, measurements/m02_p2p_flood.2026-11-06T17-12-48-219Z.jsonl). Floods of 2,000
 * intents at ~1,150/s through A. B received only 537 to 869 per flood, no canary arrived, and B fell
 * up to 218 blocks behind A while its CPU stayed low. The rskj source explains it: Stats.update
 * (org/ethereum/net/server/Stats.java) returns score -1 once a peer has sent more than
 * peer.messageQueue.thresholdPerMinutePerPeer (default 1,000) messages in the current minute, and
 * NodeMessageHandler.allowByScore then drops EVERY message from that peer for the rest of the minute,
 * blocks included. A relays each RPC-submitted intent as its own message. So the first run measured
 * B muting A, not B's admission cost. This version separates the two:
 *
 *   M02_MODE=probe       one intent at a time, straight to B and through A, printing B's refusal reason.
 *   M02_MODE=staircase   B on its default limits. Paced floods at rising rates, each long enough to
 *                        cross a minute boundary, recording how far B falls behind A and what share of
 *                        a sample of the intents reaches B. Expected knee: ~1,000/minute ≈ 17/s.
 *   M02_MODE=cost        B with its per-peer limits lifted (B_JAVA_OPTS, see below), so every intent
 *                        arrives, PACED below B's processing ceiling (first cost attempts, 2026-11-06:
 *                        bursts of 1,500 at >1,000/s took B 15–20 s to work through, 75–100 intents/s,
 *                        from its log; rskj also evicts pool entries 10 blocks after adding them,
 *                        transaction.outdated.threshold = 10, so a slow backlog empties the pool). Interleaved rounds of refused_at_b / admitted_at_b / idle, recording
 *                        B's CPU per intent. This is the number CLAIMS row 7 is about.
 *
 * Variants (both modes rely on the two nodes' different expiry horizons, which the RSKIP makes node
 * configuration, not consensus; run with INTENT_SPAN_A=100 INTENT_SPAN_B=30):
 *   refused_at_b   E = best + 60: A admits and relays; B recovers the signature and refuses at rule 4.
 *   admitted_at_b  E = best + E_ADMITTED: both admit. The realistic attack, since one peg-in can back
 *                  unlimited intents (attack a6). The ticket rule is off on this stack; with it on,
 *                  admission adds one storage read, which M01 measured.
 *   idle           nothing sent: B's background cost over a window of the same kind.
 *
 * WHAT THIS CANNOT DO.
 * - A is the attacker's entry point, so the rate is capped by what A admits over RPC. A purpose-built
 *   flooder on the wire protocol could go faster and batch many intents per message, which would also
 *   change how fast the per-peer message limit is reached. Rates here are what an RPC-only attacker
 *   gets through one honest node.
 * - Container CPU covers everything B does in the window. The idle rounds make the difference
 *   attributable; variants are interleaved so drift hits all of them.
 * - In staircase mode, each sampled intent is looked up at B about 3 s after it was sent (the first
 *   staircase attempt looked them up only at the end of a 75 s step, after most had expired; its rows
 *   were discarded). An intent can still fail to reach B's pool either because the message was dropped or
 *   because B, lagging, sees its E as too far ahead. The sampled delivery share does not tell these
 *   apart; the lag column does.
 *
 * Run from poc/ (fish), with the SLUICE stack stopped (it uses the same ports):
 *   staircase:  env INTENT_SPAN_A=100 INTENT_SPAN_B=30 docker-compose -f stack/podman-compose.yml up -d
 *               env M02_MODE=staircase npm run m02
 *   cost:       env INTENT_SPAN_A=100 INTENT_SPAN_B=30 B_JAVA_OPTS="-Dpeer.messageQueue.thresholdPerMinutePerPeer=100000000 -Dpeer.messageQueue.maxSizePerPeer=1000000" docker-compose -f stack/podman-compose.yml up -d
 *               env M02_MODE=cost npm run m02
 * Knobs: M02_RATES (staircase, intents/s, default "5,10,15,20,30,60"), M02_SECONDS (per step or flood,
 * default 75 staircase / 60 cost), M02_ROUNDS (cost, default 4, first is warm-up), M02_RATE (cost,
 * intents/s, default 50), M02_ENGINE (podman|docker, default podman),
 * M02_B_CONTAINER (default: the running container whose name contains "rskj-b", not "reorg").
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getBytes, randomBytes } from "ethers";
import { buildIntent, freshWallet, randomH } from "../src/intent.js";
import { Rpc, sleep } from "../src/client.js";
import { RPC_A, RPC_B } from "../src/config.js";
import { preflight } from "../experiments/_harness.js";
import { environment, stats, medianDiffCI, MEASUREMENTS_DIR } from "./_bench.js";

const MODE = (process.env.M02_MODE ?? "cost") as "staircase" | "cost" | "probe";
const ENGINE = process.env.M02_ENGINE ?? "podman";
const E_REFUSED = 60, E_ADMITTED = 25;   // B's horizon is 30
const CANARIES = 20;
const RATE = Number(process.env.M02_RATE ?? 50);   // cost mode: below B's measured p2p processing ceiling (~75–100/s)

const a = new Rpc(RPC_A);
const b = new Rpc(RPC_B);
const sh = (cmd: string) => execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

function containerB(): string {
  if (process.env.M02_B_CONTAINER) return process.env.M02_B_CONTAINER;
  const names = sh(`${ENGINE} ps --format '{{.Names}}'`).split("\n").filter((n) => n.includes("rskj-b") && !n.includes("reorg"));
  if (names.length !== 1) throw new Error(`expected one running rskj-b container, found ${JSON.stringify(names)}; set M02_B_CONTAINER`);
  return names[0];
}

/** CPU time of B's container in microseconds (cgroup v2, else v1). */
function cpuUsec(c: string): number {
  try {
    const m = sh(`${ENGINE} exec ${c} cat /sys/fs/cgroup/cpu.stat`).match(/usage_usec\s+(\d+)/);
    if (m) return Number(m[1]);
  } catch { /* fall through to v1 */ }
  return Number(sh(`${ENGINE} exec ${c} cat /sys/fs/cgroup/cpuacct/cpuacct.usage`)) / 1000;
}

async function poolSize(r: Rpc): Promise<number> {
  try {
    const s = await r.call<{ pending: string | number; queued: string | number }>("txpool_status");
    const v = (x: string | number) => (typeof x === "string" ? parseInt(x, 16) : x);
    return v(s.pending) + v(s.queued);
  } catch {
    return (await r.pendingTxs()).length;
  }
}

const intent = (expiry: number) =>
  buildIntent(freshWallet(), { H: randomH(), btcTxid: getBytes(randomBytes(32)), expiry, minOut: 0n }).rawHex;

const lagNow = async () => (await a.blockNumber()) - (await b.blockNumber());

/** Wait until B is back in step with A (lag ≤ 2) or `maxMs` passes; returns the final lag. */
async function waitInStep(maxMs: number): Promise<number> {
  const end = Date.now() + maxMs;
  let lag = await lagNow();
  while (lag > 2 && Date.now() < end) { await sleep(1000); lag = await lagNow(); }
  return lag;
}

/** Poll until every hash is known to B or `maxMs` passes; returns how many are known. */
async function seenAtB(hashes: string[], maxMs: number): Promise<number> {
  const end = Date.now() + maxMs;
  const pending = new Set(hashes);
  while (pending.size && Date.now() < end) {
    for (const h of [...pending]) if (await b.getTx(h).catch(() => null)) pending.delete(h);
    if (pending.size) await sleep(1000);
  }
  return hashes.length - pending.size;
}

async function checkHorizons(): Promise<void> {
  const h0 = await a.blockNumber();
  try { await b.sendRaw(intent(h0 + E_REFUSED)); throw new Error("B admitted an intent at best+60: B's horizon is not below 60. Restart with INTENT_SPAN_B=30."); }
  catch (e) { if (!/too far ahead/.test(String(e))) throw e; }
  try { await a.sendRaw(intent(h0 + E_REFUSED)); }
  catch (e) { throw new Error(`A refused an intent at best+60 (${e}); A's horizon must be above 60 (INTENT_SPAN_A=100).`); }
}

function persistRows(rows: unknown[], extra: Record<string, unknown>): void {
  mkdirSync(MEASUREMENTS_DIR, { recursive: true });
  const file = join(MEASUREMENTS_DIR, `m02_p2p_flood.${MODE}.${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  writeFileSync(file, [JSON.stringify({ env: environment({ measurement: "m02_p2p_flood", mode: MODE, engine: ENGINE, ...extra }) }), ...rows.map((x) => JSON.stringify(x))].join("\n") + "\n");
  console.log(`\nwritten: ${file}`);
}

// ---------------------------------------------------------------- staircase: where does B mute A?

async function staircase(c: string): Promise<void> {
  const rates = (process.env.M02_RATES ?? "5,10,15,20,30,60").split(",").map(Number);
  const seconds = Number(process.env.M02_SECONDS ?? 75);
  console.log(`M02 staircase: B ${c}; rates ${rates.join(", ")} intents/s, ${seconds} s each; B on default limits`);
  const rows: Record<string, unknown>[] = [];
  for (const rate of rates) {
    const lagBefore = await waitInStep(180_000);
    await sleep(Math.max(0, 61_000 - (Date.now() % 60_000)));   // start just after a minute boundary
    const cpu0 = cpuUsec(c); const t0 = Date.now();
    let sent = 0, admitted = 0, maxLag = 0;
    const samples: string[] = [];
    const checks: Promise<number>[] = [];   // each sample is looked up at B ~3 s after it was sent, well inside its 25-block life
    let stop = false;
    const watcher = (async () => { while (!stop) { maxLag = Math.max(maxLag, await lagNow().catch(() => 0)); await sleep(500); } })();
    for (let s = 0; s < seconds; s++) {
      const best = await a.blockNumber();
      const batch = Array.from({ length: rate }, () => intent(best + E_ADMITTED));
      for (let i = 0; i < batch.length; i++) {
        const due = t0 + (s + i / rate) * 1000;
        if (due > Date.now()) await sleep(due - Date.now());
        sent++;
        try { const h = await a.sendRaw(batch[i]); admitted++; if (i === 0) { samples.push(h); checks.push(sleep(3000).then(() => seenAtB([h], 5000))); } } catch { /* refused at A: counted by sent − admitted */ }
      }
    }
    const delivered = (await Promise.all(checks)).reduce((x, y) => x + y, 0);
    stop = true; await watcher;
    const windowMs = Date.now() - t0;
    const row = { mode: "staircase", rate, seconds, sent, admittedAtA: admitted, lagBefore, maxLag, lagAfter: await lagNow(),
      sampled: samples.length, sampledSeenAtB: delivered, deliveredShare: samples.length ? delivered / samples.length : NaN,
      cpuUsec: cpuUsec(c) - cpu0, windowMs };
    rows.push(row);
    console.log(`  ${String(rate).padStart(3)}/s  admitted@A ${String(admitted).padStart(5)}  B lag max ${String(maxLag).padStart(4)} (after ${row.lagAfter})  sample seen at B ${delivered}/${samples.length}  B cpu ${(row.cpuUsec / 1000).toFixed(0)} ms over ${(windowMs / 1000).toFixed(0)} s`);
  }
  persistRows(rows, { rates, seconds, eAdmitted: E_ADMITTED, containerB: c });
}

/** Paced flood through A: `rate` intents/s for `seconds`, each built just before sending with E = A's best + `ahead`. */
async function paced(rate: number, seconds: number, ahead: number): Promise<{ sent: number; admitted: number; firstError?: string; lastHash?: string }> {
  const t0 = Date.now();
  let sent = 0, admitted = 0, firstError: string | undefined, lastHash: string | undefined;
  for (let s = 0; s < seconds; s++) {
    const best = await a.blockNumber();
    const batch = Array.from({ length: rate }, () => intent(best + ahead));
    for (let i = 0; i < batch.length; i++) {
      const due = t0 + (s + i / rate) * 1000;
      if (due > Date.now()) await sleep(due - Date.now());
      sent++;
      try { lastHash = await a.sendRaw(batch[i]); admitted++; } catch (e) { firstError ??= e instanceof Error ? e.message : String(e); }
    }
  }
  return { sent, admitted, firstError, lastHash };
}

// ---------------------------------------------------------------- cost: CPU per intent, limits lifted

async function settle(c: string, idlePerMs: number): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const u0 = cpuUsec(c); const t0 = performance.now();
    await sleep(1000);
    if ((cpuUsec(c) - u0) / (performance.now() - t0) <= idlePerMs * 1.5 + 50) return;
  }
}

async function cost(c: string): Promise<void> {
  const ROUNDS = Number(process.env.M02_ROUNDS ?? 4);
  const SECONDS = Number(process.env.M02_SECONDS ?? 60);
  console.log(`M02 cost: B ${c}; ${ROUNDS} rounds (first is warm-up), ${RATE}/s for ${SECONDS} s per flood; B's per-peer limits must be lifted`);

  // the limits must actually be lifted, or this mode re-measures the first run
  {
    // paced at RATE for 25 s = 1,250 intents at the default 50/s, over the 1,000-per-minute default limit
    await sleep(Math.max(0, 61_000 - (Date.now() % 60_000)));
    await paced(RATE, 25, E_ADMITTED);
    const canary = await a.sendRaw(intent((await a.blockNumber()) + E_ADMITTED));
    const ok = (await seenAtB([canary], 15_000)) === 1;
    console.log(`  limit check: ${RATE * 25} intents through A at ${RATE}/s within one minute, canary ${ok ? "arrived" : "MISSING"}`);
    if (!ok) throw new Error("B is still muting A: restart the stack with B_JAVA_OPTS lifting peer.messageQueue limits (see header).");
  }

  await sleep(3000);
  const u0 = cpuUsec(c); const t0 = performance.now(); await sleep(5000);
  const idlePerMs = (cpuUsec(c) - u0) / (performance.now() - t0);

  const rows: Record<string, number | string | boolean | undefined>[] = [];
  const order = ["idle", "refused_at_b", "admitted_at_b"];
  for (let r = 0; r < ROUNDS; r++) {
    for (const v of order.map((_, i) => order[(i + r) % order.length])) {
      await settle(c, idlePerMs);
      const poolBefore = await poolSize(b);
      let maxLag = 0, stop = false;
      const watcher = (async () => { while (!stop) { maxLag = Math.max(maxLag, await lagNow().catch(() => 0)); await sleep(500); } })();
      const cpu0 = cpuUsec(c); const w0 = performance.now();
      const res = v === "idle"
        ? await sleep(SECONDS * 1000).then(() => ({ sent: 0, admitted: 0, firstError: undefined as string | undefined }))
        : await paced(RATE, SECONDS, v === "refused_at_b" ? E_REFUSED : E_ADMITTED);
      const canaryHashes: string[] = [];
      if (v !== "idle") for (let i = 0; i < CANARIES; i++) { try { canaryHashes.push(await a.sendRaw(intent((await a.blockNumber()) + E_ADMITTED))); } catch { /* unseen */ } }
      await settle(c, idlePerMs);
      const windowMs = performance.now() - w0;
      const cpu = cpuUsec(c) - cpu0;
      const canariesSeen = await seenAtB(canaryHashes, 30_000);
      stop = true; await watcher;
      const row = { mode: "cost", round: r, variant: v, warmup: r === 0, sent: res.sent, admittedAtA: res.admitted, refusedAtA: res.sent - res.admitted,
        offeredPerSec: v === "idle" ? 0 : RATE,
        windowMs: Math.round(windowMs), cpuUsec: cpu, poolBefore, poolAfter: await poolSize(b), maxLag,
        canariesSent: canaryHashes.length, canariesSeen, firstErrorAtA: res.firstError };
      rows.push(row);
      console.log(`  r${r} ${v.padEnd(14)} admitted@A ${String(row.admittedAtA).padStart(5)}  ${String(row.offeredPerSec).padStart(5)}/s  B cpu ${(cpu / 1000).toFixed(0).padStart(6)} ms over ${(windowMs / 1000).toFixed(1)} s  pool ${poolBefore}→${row.poolAfter}  lag ≤${maxLag}  canaries ${canariesSeen}/${canaryHashes.length}`);
    }
  }

  const perIntent = (v: string) => rows.filter((x) => !x.warmup && x.variant === v).map((x) => {
    const idle = rows.find((y) => y.round === x.round && y.variant === "idle")!;
    return ((x.cpuUsec as number) - ((idle.cpuUsec as number) / (idle.windowMs as number)) * (x.windowMs as number)) / Math.max(1, x.admittedAtA as number);
  });
  const ref = perIntent("refused_at_b"), adm = perIntent("admitted_at_b");
  const fmt = (s: ReturnType<typeof stats>) => `p50 ${s.p50.toFixed(1)}  min ${s.min.toFixed(1)}  max ${s.max.toFixed(1)}  (n=${s.n})`;
  console.log(`\nB's CPU per intent received over p2p, µs (idle subtracted):`);
  console.log(`  refused_at_b   ${fmt(stats(ref))}`);
  console.log(`  admitted_at_b  ${fmt(stats(adm))}`);
  const d = medianDiffCI(ref, adm);
  console.log(`  admitted − refused: ${d.diff.toFixed(1)} µs, 95% CI [${d.lo.toFixed(1)}, ${d.hi.toFixed(1)}]${d.resolvable ? "" : " — not resolvable at this n"}`);
  const suspect = rows.filter((x) => (x.canariesSeen as number) < (x.canariesSent as number));
  if (suspect.length) console.log(`  !! ${suspect.length} round(s) with missing canaries: intents may not all have reached B; those rows are suspect`);
  persistRows(rows, { rounds: ROUNDS, rate: RATE, seconds: SECONDS, eRefused: E_REFUSED, eAdmitted: E_ADMITTED, idleUsecPerMs: idlePerMs, containerB: c });
}

/** Diagnostic: why does an intent A relays not appear in B's pool? Asks B's own RPC for the refusal. */
async function probe(): Promise<void> {
  const show = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160);
  const [ha, hb] = [await a.blockNumber(), await b.blockNumber()];
  console.log(`probe: A at ${ha}, B at ${hb}, B peers ${await b.peerCount()}, B pool ${await poolSize(b)}`);
  for (const ahead of [5, 15, 25]) {
    const raw = intent((await a.blockNumber()) + ahead);
    try { const h = await b.sendRaw(raw); console.log(`  E = best+${ahead}, sent to B directly: admitted (${h.slice(0, 10)}…), seen by getTx: ${(await seenAtB([h], 3000)) === 1}`); }
    catch (e) { console.log(`  E = best+${ahead}, sent to B directly: REFUSED — ${show(e)}`); }
  }
  for (const ahead of [5, 15, 25]) {
    const raw = intent((await a.blockNumber()) + ahead);
    try { const h = await a.sendRaw(raw); console.log(`  E = best+${ahead}, sent to A: admitted; reached B within 10 s: ${(await seenAtB([h], 10_000)) === 1}`); }
    catch (e) { console.log(`  E = best+${ahead}, sent to A: REFUSED — ${show(e)}`); }
  }
  console.log(`  B pool now ${await poolSize(b)}`);
}

async function main(): Promise<void> {
  await preflight(a);
  await preflight(b, { waitActivation: false });
  const c = containerB();
  // A freshly (re)created B answers RPC long before it has a peer and has caught up with A; flooding
  // then measures a node that is not listening yet (the first cost attempt failed its limit check so)
  const peered = await (async () => { const end = Date.now() + 300_000; while (Date.now() < end) { if ((await b.peerCount().catch(() => 0)) >= 1) return true; await sleep(2000); } return false; })();
  if (!peered) throw new Error("B has no peer after 5 minutes: check that rskj-b is running and dials A");
  const lag = await waitInStep(600_000);
  console.log(`B ready: peered, ${lag} blocks behind A`);
  if (lag > 2) throw new Error(`B is still ${lag} blocks behind A after 10 minutes; not starting`);
  await checkHorizons();
  if (MODE === "probe") return probe();
  if (MODE === "staircase") await staircase(c);
  else if (MODE === "cost") await cost(c);
  else throw new Error(`M02_MODE must be staircase, cost or probe, not ${MODE}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
