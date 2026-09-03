/**
 * Static checks on the attack board — no node, no stack, ~1 second.
 *
 * These exist because of a specific failure: four newly written attacks reported "experiment broken"
 * on a full board run, all four for the same reason, and each one had already spent minutes bringing
 * a chain to the right state before throwing. The harness's guard was doing its job — it throws when
 * a `watch()` is registered after the first `mark()`, because a late watch has no baseline and a
 * missing baseline reads as a ZERO DELTA, which a check phrased as "the attacker gained nothing"
 * would score as a pass. But a runtime guard only fires once you have paid for the run.
 *
 * So the same rules are checked here by reading the source. A mistake that costs three minutes to
 * discover gets discovered a hundred times; one that costs a second gets fixed.
 *
 * Rules enforced:
 *   1. every a.watch() appears before the first a.mark()
 *   2. a.mark() appears before any a.deltas()
 *   3. every native attack's module exists and exports run()
 *   4. every registry id is unique, lowercase, and matches its class letter
 *   5. an attack declaring a non-default stack does not silently take the default one
 *
 * Run: npm run test:board
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ATTACKS, CLASSES, ThreatClass } from "../attacks/registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const ATTACK_DIR = join(here, "..", "attacks");

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failures++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

console.log("\n=== attack board — static checks ===\n");

// ---- 1 & 2: the forensics ordering rules, read out of the source ------------------------------
const lineOf = (src: string, idx: number) => src.slice(0, idx).split("\n").length;
const offsets = (src: string, re: RegExp) => [...src.matchAll(re)].map((m) => m.index ?? 0);

let scanned = 0;
for (const spec of ATTACKS) {
  if (spec.impl.kind !== "native") continue;
  // The registry loads modules lazily by path, so derive the filename the same way the loader does.
  const file = nativeFileFor(spec.id);
  if (!file) { check(`${spec.id}: module file found`, false, "no attacks/<id>_*.ts"); continue; }
  const src = readFileSync(file, "utf8");
  scanned++;

  const marks = offsets(src, /\ba\.mark\(/g);
  const watches = offsets(src, /\ba\.watch\(/g);
  const deltas = offsets(src, /\ba\.deltas\(/g);

  if (watches.length && marks.length) {
    const late = watches.filter((w) => w > marks[0]);
    check(`${spec.id}: every watch() precedes the first mark()`, late.length === 0,
      late.length ? `line ${lineOf(src, late[0])} — a late watch has no baseline, and a zero delta reads as a pass` : "");
  }
  if (deltas.length) {
    check(`${spec.id}: mark() precedes the first deltas()`,
      marks.length > 0 && marks[0] < deltas[0],
      marks.length === 0 ? `line ${lineOf(src, deltas[0])} — deltas() with no baseline throws` : "");
  }
  if (watches.length) {
    check(`${spec.id}: watch() is paired with a mark()`, marks.length > 0,
      marks.length === 0 ? "watched parties but never took a baseline" : "");
  }
  // 5: an attack that controls block production must have asked for a stack that can
  if (/\bctx\.(mine|autoMine|partition|heal)\b/.test(src)) {
    check(`${spec.id}: controls block production, so declares a non-default stack`,
      spec.stack !== undefined && spec.stack !== "default",
      spec.stack === undefined ? "uses ctx.mine/autoMine but stack is unset — it would run on the timer stack" : "");
  }
}
check("native attacks were found and scanned", scanned > 0, `${scanned} module(s)`);

// ---- 3: every native module exists and exports run() ------------------------------------------
for (const spec of ATTACKS) {
  if (spec.impl.kind !== "native") continue;
  const file = nativeFileFor(spec.id);
  if (!file) continue;
  const src = readFileSync(file, "utf8");
  check(`${spec.id}: exports run()`, /export\s+async\s+function\s+run\s*\(/.test(src));
  check(`${spec.id}: returns a.finish()`, /a\.finish\(/.test(src),
    "the verdict line comes from finish(observed); without it the runner cannot classify the run");
}

// ---- 3b: wrapped scripts point at files that exist --------------------------------------------
for (const spec of ATTACKS) {
  if (spec.impl.kind !== "wrapped") continue;
  const p = join(here, "..", "experiments", spec.impl.script);
  check(`${spec.id}: wraps an experiment that exists`, existsSync(p), spec.impl.script);
}

// ---- 4: registry hygiene ----------------------------------------------------------------------
const ids = ATTACKS.map((a) => a.id);
check("ids are unique", new Set(ids).size === ids.length,
  ids.filter((x, i) => ids.indexOf(x) !== i).join(", "));
check("ids are lowercase", ids.every((i) => i === i.toLowerCase()));
for (const spec of ATTACKS) {
  check(`${spec.id}: id prefix matches class ${spec.cls}`, spec.id.startsWith(spec.cls.toLowerCase()));
}
for (const cls of Object.keys(CLASSES) as ThreatClass[]) {
  const n = ATTACKS.filter((a) => a.cls === cls).length;
  check(`class ${cls} has at least one attack`, n > 0, `${n}`);
}
/**
 * An untested entry with no reason is the one thing the board must never contain: it turns a visible
 * gap back into an invisible one.
 *
 * Note what is deliberately NOT asserted: that an unimplemented attack has `expected: "untested"`.
 * Some of them carry a real prediction instead (`m2` predicts `succeeds`, `m4` predicts `contained`),
 * and that is better, not worse — committing to an outcome before you can run it is the whole reason
 * the registry states expectations up front. The summary prints the prediction alongside "not
 * exercised", so nothing is passed off as verified. The assertion worth making is the inverse: an
 * entry that predicts nothing must not be runnable, because then the run has nothing to agree or
 * disagree with, and "as predicted" would be meaningless.
 */
for (const spec of ATTACKS) {
  if (spec.impl.kind === "untested") {
    check(`${spec.id}: untested entry states why`, spec.impl.why.trim().length > 20);
  } else {
    check(`${spec.id}: runnable entry predicts an outcome`, spec.expected !== "untested",
      "a run cannot agree with a prediction that was never made");
  }
}

/** attacks/<id>_<something>.ts — the naming the registry's dynamic imports rely on. */
function nativeFileFor(id: string): string | null {
  const hit = readdirSync(ATTACK_DIR).find((f) => f.startsWith(`${id}_`) && f.endsWith(".ts"));
  return hit ? join(ATTACK_DIR, hit) : null;
}

console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
