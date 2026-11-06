/**
 * MEASUREMENT HARNESS — numbers only. This module never decides anything.
 *
 * The experiments in ../experiments answer yes/no against a stated claim, and the board in ../attacks
 * answers "does this adversary win". Neither produces a quantity, so every quantitative statement in
 * the RSKIP has so far been an assertion. This is where the quantities come from, and the deal is
 * that it reports what it saw and stops: no thresholds, no pass, no fail, no "acceptable". Reading a
 * verdict into these numbers is a separate act, done by a person, on the record.
 *
 * WHAT MAKES A NUMBER FROM HERE WORTH ANYTHING
 *
 * 1. Payloads are generated BEFORE the clock starts. Signing an intent costs an ECDSA operation on
 *    this side, which is the same order as the work being measured on the other side. Generating
 *    inside the timed loop would measure this process.
 *
 * 2. The JVM is warmed. A cold rskj is interpreting bytecode, and the first few hundred calls can be
 *    an order of magnitude slower than steady state. Warmup samples are discarded.
 *
 * 3. Variants are interleaved round-robin, not run in blocks. Anything that drifts over the run —
 *    JIT recompilation, GC, thermal throttling, a growing mempool, the laptop deciding to index
 *    something — hits every variant equally instead of penalising whichever went last.
 *
 * 4. Differences are reported with a bootstrap confidence interval. The interesting output is a
 *    MARGINAL cost (what does rule k add over rule k-1), which is a difference of medians over noisy
 *    samples. A point estimate there invites exactly the overconfidence this harness exists to stop,
 *    so when the interval straddles zero the harness says the difference is not resolvable rather
 *    than printing a number that looks like knowledge.
 *
 * 5. Every run records its environment — commit, dirty tree, node version, host, timestamp — because
 *    a latency figure with no machine attached is not evidence, and two runs on different machines
 *    are not comparable no matter how clean each looked.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname, cpus, totalmem, platform, arch } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const POC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MEASUREMENTS_DIR = join(POC, "measurements");

/** One thing being timed. `payloads` is null when this variant cannot run in this environment. */
export interface Variant {
  name: string;
  /** what this variant exercises, in plain words. Printed with the results. Not a claim about it. */
  what: string;
  /** pre-generated, one per sample, index-aligned with the round number */
  payloads: string[] | null;
  /** set when payloads is null, so a missing row is explained rather than silently absent */
  unavailable?: string;
  /**
   * Substring the node's rejection reason MUST contain for this sample to be measuring the intended
   * rule. Omit for a variant that expects acceptance.
   *
   * This is not decoration. M01's first run had two variants silently measuring a different rule than
   * they claimed: their intents aged past `E` mid-run, so most samples were rejected as expired
   * instead of reaching the step under test, and the only symptom was a rejection percentage that
   * needed interpreting. A variant that cannot prove it hit its own rule is not a measurement.
   */
  expect?: string;
  /** the timed call. Errors are expected (most variants measure a REJECTION) and are not failures. */
  run: (payload: string) => Promise<unknown>;
}

export interface Sample { variant: string; round: number; ms: number; rejected: boolean; note?: string; onTarget: boolean }

export interface Stats {
  n: number; min: number; p50: number; p90: number; p95: number; p99: number; max: number;
  mean: number; stddev: number; rejectedFraction: number;
}

const pct = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
};

export function stats(xs: number[], rejected = 0): Stats {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / (n || 1);
  const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / (n > 1 ? n - 1 : 1);
  return {
    n, min: s[0], p50: pct(s, 50), p90: pct(s, 90), p95: pct(s, 95), p99: pct(s, 99), max: s[n - 1],
    mean, stddev: Math.sqrt(variance), rejectedFraction: n ? rejected / n : 0,
  };
}

/**
 * Bootstrap CI for (median of b) - (median of a). Resamples both with replacement, which makes no
 * assumption about the shape of the latency distribution — and latency is never normal: it is
 * bounded below, has a long right tail, and is multi-modal whenever GC is involved.
 */
export function medianDiffCI(a: number[], b: number[], resamples = 2000, level = 0.95):
  { diff: number; lo: number; hi: number; resolvable: boolean } {
  const med = (xs: number[]) => pct([...xs].sort((x, y) => x - y), 50);
  const diff = med(b) - med(a);
  const draws: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const ra: number[] = new Array(a.length);
    const rb: number[] = new Array(b.length);
    for (let i = 0; i < a.length; i++) ra[i] = a[(Math.random() * a.length) | 0];
    for (let i = 0; i < b.length; i++) rb[i] = b[(Math.random() * b.length) | 0];
    draws.push(med(rb) - med(ra));
  }
  draws.sort((x, y) => x - y);
  const alpha = (1 - level) / 2;
  const lo = pct(draws, alpha * 100);
  const hi = pct(draws, (1 - alpha) * 100);
  return { diff, lo, hi, resolvable: !(lo <= 0 && hi >= 0) };
}

/** Environment stamp. A latency number without this is not evidence. */
export function environment(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const git = (cmd: string) => { try { return execSync(cmd, { cwd: POC, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return "unknown"; } };
  return {
    when: new Date().toISOString(),
    commit: git("git rev-parse --short HEAD"),
    dirty: git("git status --porcelain") !== "",
    host: hostname(),
    platform: `${platform()}/${arch()}`,
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    memGB: Math.round(totalmem() / 1e9),
    node: process.version,
    ...extra,
  };
}

export interface RunOptions {
  /** timed samples per variant */
  rounds?: number;
  /** discarded samples per variant, to get the JVM past the interpreter */
  warmup?: number;
  /** printed as the run's subject line. Describes what is being measured, not what it shows. */
  title: string;
  /** anything else worth recording alongside the samples */
  env?: Record<string, unknown>;
}

/**
 * Interleave the variants and time them. Returns every sample — the caller decides what, if
 * anything, the samples mean.
 */
export async function measure(variants: Variant[], opts: RunOptions): Promise<Sample[]> {
  const rounds = opts.rounds ?? 400;
  const warmup = opts.warmup ?? 150;
  const live = variants.filter((v) => v.payloads !== null);

  console.log(`\n=== ${opts.title} ===`);
  console.log(`measuring only — this run makes no claim about whether any number is acceptable\n`);
  for (const v of variants) {
    console.log(`  ${v.payloads ? "     " : "SKIP "}${v.name.padEnd(22)} ${v.what}`);
    if (!v.payloads) console.log(`       ${" ".repeat(22)}unavailable: ${v.unavailable ?? "no reason given"}`);
  }
  if (live.length === 0) { console.log("\nnothing to measure.\n"); return []; }

  process.stdout.write(`\nwarming up (${warmup} discarded per variant)… `);
  for (let i = 0; i < warmup; i++) {
    for (const v of live) await v.run(v.payloads![i % v.payloads!.length]).catch(() => {});
  }
  console.log("done");

  const samples: Sample[] = [];
  process.stdout.write(`sampling ${rounds} rounds, interleaved… `);
  for (let r = 0; r < rounds; r++) {
    for (const v of live) {
      // Offset past the warmup slice. Sharing indices with warmup re-sends payloads the node has
      // already seen, and for the one variant whose samples are ACCEPTED those are still sitting in
      // the mempool — so the resend is refused as a duplicate hash and the row times a rejection
      // while claiming to time an acceptance. Cost the first run 150 of its 400 samples.
      const payload = v.payloads![(warmup + r) % v.payloads!.length];
      const t0 = performance.now();
      let rejected = false;
      let note: string | undefined;
      try { await v.run(payload); } catch (e) { rejected = true; note = (e instanceof Error ? e.message : String(e)).slice(0, 120); }
      const onTarget = v.expect
        ? rejected && (note ?? "").toLowerCase().includes(v.expect.toLowerCase())
        : !rejected;
      samples.push({ variant: v.name, round: r, ms: performance.now() - t0, rejected, note, onTarget });
    }
    if (r % Math.max(1, Math.floor(rounds / 10)) === 0) process.stdout.write(".");
  }
  console.log(" done");
  return samples;
}

/** Group samples by variant, preserving the order the variants were declared in. */
export function byVariant(samples: Sample[], variants: Variant[]): Map<string, Sample[]> {
  const m = new Map<string, Sample[]>();
  for (const v of variants) if (v.payloads) m.set(v.name, []);
  for (const s of samples) m.get(s.variant)?.push(s);
  return m;
}

/**
 * Print the table and the marginals. `ladder` names the variants that form a short-circuit staircase,
 * in order — each row's marginal is measured against the row before it.
 */
export function report(samples: Sample[], variants: Variant[], ladder: string[]): void {
  const grouped = byVariant(samples, variants);
  /** A row is only usable if nearly every sample provably hit the step it claims to measure. */
  const USABLE = 0.95;
  const onTargetOf = (name: string) => (grouped.get(name) ?? []).filter((s) => s.onTarget);
  const fractionOf = (name: string) => {
    const g = grouped.get(name) ?? [];
    return g.length ? g.filter((s) => s.onTarget).length / g.length : 0;
  };

  console.log(`\n  Each row times ONE call, end to end, from this process. Lower is cheaper for the node.`);
  console.log(`  'on target' is the share of samples that provably hit the step the row claims to measure.`);
  console.log(`  Statistics use ONLY on-target samples, so a contaminated row shrinks rather than lies.\n`);
  console.log(`  ${"variant".padEnd(22)} ${"on target".padStart(10)} ${"n".padStart(6)} ${"p50".padStart(9)} ${"p90".padStart(9)} ${"p99".padStart(9)}`);
  console.log(`  ${"-".repeat(22)} ${"-".repeat(10)} ${"-".repeat(6)} ${"-".repeat(9)} ${"-".repeat(9)} ${"-".repeat(9)}`);
  const unusable: string[] = [];
  for (const v of variants) {
    if (!grouped.has(v.name)) continue;
    const frac = fractionOf(v.name);
    const on = onTargetOf(v.name);
    const flag = frac < USABLE ? "  <-- UNUSABLE" : "";
    if (frac < USABLE) unusable.push(v.name);
    if (on.length === 0) {
      console.log(`  ${v.name.padEnd(22)} ${(frac * 100).toFixed(0).padStart(9)}% ${"0".padStart(6)} ${"—".padStart(9)} ${"—".padStart(9)} ${"—".padStart(9)}${flag}`);
      continue;
    }
    const st = stats(on.map((s) => s.ms));
    console.log(`  ${v.name.padEnd(22)} ${(frac * 100).toFixed(0).padStart(9)}% ${String(st.n).padStart(6)} ${st.p50.toFixed(3).padStart(8)}m ${st.p90.toFixed(3).padStart(8)}m ${st.p99.toFixed(3).padStart(8)}m${flag}`);
  }

  if (unusable.length) {
    console.log(`\n  ${unusable.length} row(s) UNUSABLE — under ${USABLE * 100}% of samples reached the step they claim to time.`);
    console.log(`  The most common reason a sample lands elsewhere:`);
    for (const name of unusable) {
      const off = (grouped.get(name) ?? []).filter((s) => !s.onTarget);
      const tally = new Map<string, number>();
      for (const s of off) {
        // Normalise before tallying. Rejection reasons embed the offending txid or hash, and rskj
        // prints those WITHOUT a 0x prefix, so a prefix-only scrub leaves every message unique and
        // the "most common reason" is then always 1x — which hides the fact that all 400 samples
        // failed identically.
        const key = s.rejected
          ? (s.note ?? "").replace(/(0x)?[0-9a-f]{8,}/gi, "…").slice(0, 70)
          : "(accepted, but this row expected a rejection)";
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
      const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
      console.log(`    ${name.padEnd(22)} ${top ? `${top[1]}x  ${top[0]}` : "(nothing recorded)"}`);
    }
    console.log(`  Fix the variant and re-run. Do not read the numbers on those rows.`);
  }

  console.log(`\n  Marginal cost of each step — how much MORE the node spends getting one rule further.`);
  console.log(`  Median difference with a 95% bootstrap interval, on-target samples only.`);
  for (let i = 1; i < ladder.length; i++) {
    const a = ladder[i - 1], b = ladder[i];
    const label = `${a} -> ${b}`;
    if (unusable.includes(a) || unusable.includes(b)) { console.log(`    ${label.padEnd(46)} skipped — an endpoint is unusable`); continue; }
    const prev = onTargetOf(a), cur = onTargetOf(b);
    if (!prev.length || !cur.length) { console.log(`    ${label.padEnd(46)} skipped — no samples`); continue; }
    const ci = medianDiffCI(prev.map((s) => s.ms), cur.map((s) => s.ms));
    const verdict = ci.resolvable
      ? `${ci.diff >= 0 ? "+" : ""}${(ci.diff * 1000).toFixed(0)}us  [${(ci.lo * 1000).toFixed(0)}, ${(ci.hi * 1000).toFixed(0)}]`
      : `below this method's resolution — interval [${(ci.lo * 1000).toFixed(0)}, ${(ci.hi * 1000).toFixed(0)}]us spans zero`;
    console.log(`    ${label.padEnd(46)} ${verdict}`);
  }
  console.log(`\n  "Below this method's resolution" means the difference is smaller than the measurement`);
  console.log(`  noise, so this instrument cannot see it. It does NOT mean the cost is zero.`);
}

/** Write raw samples plus the environment stamp. One file per run — these accumulate deliberately. */
export function persist(name: string, samples: Sample[], env: Record<string, unknown>): string {
  mkdirSync(MEASUREMENTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(MEASUREMENTS_DIR, `${name}.${stamp}.jsonl`);
  const lines = [JSON.stringify({ record: "environment", measurement: name, ...env })];
  for (const s of samples) lines.push(JSON.stringify({ record: "sample", ...s }));
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}
