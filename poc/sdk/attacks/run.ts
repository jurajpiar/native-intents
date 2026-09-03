/**
 * The red-team runner: a menu over ../attacks/registry.ts.
 *
 * Interactive by default (`npm run attack`); scriptable so CI can run the whole board:
 *
 *   npm run attack                 menu
 *   npm run attacks                run every runnable attack (CI form)
 *   npm run attacks -- e7          run one attack — bare ids work, no --id= needed
 *   npm run attacks -- e7 e8 b2    run several
 *   npm run attacks -- E           run one threat class (a bare class letter)
 *   npm run attacks -- list        print the board and exit
 *   npm run attacks -- --provision m3   bring up whatever stack the attack needs, first
 *
 * An attack may DECLARE the infrastructure it needs (`stack:` in the registry). Anything about block
 * CONTENTS — ordering, a block-height window, a deliberate reorg — cannot be expressed on a stack that
 * mines on a timer, so it asks for one that mines on demand. Without --provision a missing stack is
 * reported as such, with the command that would fix it; with it, the runner brings the stack up, and
 * tears down only what it started, only when asked (--teardown).
 *
 * The flag forms (--list/--all/--class=E/--id=e8) still work. Selectors given on the command line
 * always win over the npm script's default, so `npm run attacks -- e7` runs ONLY e7.
 *
 * Exit code 0 means every attack that ran behaved as the registry predicts. Non-zero means at least
 * one deviated — the system did something its own documentation does not claim.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ATTACKS, AttackSpec, CLASSES, Expected, OUTCOME_LABEL, ThreatClass, byClass, byId } from "./registry.js";
import { printSpecHeader } from "./_forensics.js";
import { StackCtx, StackName, StackUnavailable, disposeStacks, ensureStack, stackWhat, teardown } from "./_stacks.js";

const here = dirname(fileURLToPath(import.meta.url));
const EXPERIMENTS = join(here, "..", "experiments");

/**
 * A run's outcome. The distinction that matters is between `deviation` — the system behaved unlike its
 * own documentation, which is the finding worth acting on — and the two ways a run can tell you nothing:
 * `broken` (the script threw before reporting) and `environment` (the stack is not configured for it).
 * Collapsing those into one bucket turns every stale experiment into a false alarm.
 */
type Status = "as-predicted" | "deviation" | "partial" | "broken" | "environment" | "not-run" | "skipped";
const results = new Map<string, Status>();
/**
 * Wrapped scripts are shared by several attack ids (e19 serves both e1 and e2), so a board run
 * executes each script once and reuses the outcome. Scoped to one board run and cleared at its start,
 * so an interactive retry after fixing the stack actually re-runs.
 *
 * KNOWN LIMITATION, not fixed by the scoping: e1 and e2 both inherit e19's AGGREGATE verdict, so a
 * failure in either one marks both. Per-attack attribution needs e19's assertions split by attack, or
 * the two ids pointed at separate scripts.
 */
const ranScripts = new Map<string, Status>();

/** --provision / --teardown, read once in main(); starting containers is never assumed. */
let provision = false;
let doTeardown = false;
/** One StackCtx per stack per run, so a board run provisions each stack at most once. */
const stacks = new Map<StackName, StackCtx>();

/**
 * Resolve the stack an attack declared, bringing it up if allowed. Cached: a class run of four
 * reorg-stack attacks must not restart the nodes four times (each boot is a JVM, ~1-2 min).
 */
async function stackFor(spec: AttackSpec): Promise<StackCtx> {
  const name: StackName = spec.stack ?? "default";
  const had = stacks.get(name);
  if (had) return had;
  const ctx = await ensureStack(name, { provision });
  stacks.set(name, ctx);
  return ctx;
}

function teardownProvisioned(): void {
  if (!doTeardown) {
    const mine = [...stacks.values()].filter((c) => c.provisioned).map((c) => c.name);
    if (mine.length) console.log(`  left the provisioned stack(s) up: ${mine.join(", ")} — add --teardown to remove them\n`);
    return;
  }
  for (const ctx of stacks.values()) if (ctx.provisioned) teardown(ctx.name);
}

const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
/** Never print a bare outcome key: "succeeds" alone does not say WHOSE. See OUTCOME_LABEL. */
const tag = (e: Expected) => OUTCOME_LABEL[e];

/** Cut a label to fit its column without letting it shove the next one sideways. */
const trunc = (t: string, n: number) => (t.length <= n ? t : t.slice(0, n - 1) + "…");

/**
 * One class, counted honestly.
 *
 * The old form printed "5 attacks  4 attack BLOCKED  1 UNTESTED", which silently mixed two different
 * kinds of statement: outcomes established by a run, and outcomes nobody has tested. Splitting
 * WRITTEN from NOT WRITTEN first, and breaking down only the written ones, means the numbers on this
 * line cannot overstate what is known.
 */
function summariseClass(cls: ThreatClass): string {
  const all = byClass(cls);
  const written = all.filter((a) => a.impl.kind !== "untested");
  const counts = new Map<Expected, number>();
  for (const a of written) counts.set(a.expected, (counts.get(a.expected) ?? 0) + 1);
  const order: Expected[] = ["blocked", "contained", "succeeds", "untested"];
  const parts = order.filter((k) => counts.has(k)).map((k) => `${counts.get(k)} ${tag(k)}`);
  const gap = all.length - written.length;
  const cover = `${written.length} written${gap ? `, ${gap} not` : ""}`;
  return `${pad(String(all.length), 3)}  ${pad(cover, 18)}${parts.length ? "→ " + parts.join(" · ") : ""}`;
}

/** Every attack, class by class, in menu order. */
const allOrdered = (): AttackSpec[] => (Object.keys(CLASSES) as ThreatClass[]).flatMap((c) => byClass(c));

/**
 * The board: what this suite IS, what the words on it mean, and how much of it is real.
 *
 * A reader arriving at this output cold has three questions — what am I looking at, is "ATTACK WORKS"
 * good or bad news, and how much of this was actually tested — and the previous version answered none
 * of them. `menu` is off for a non-interactive `list`, where keystroke hints are noise.
 */
function board(opts: { menu?: boolean } = {}): void {
  const total = ATTACKS.length;
  const written = ATTACKS.filter((a) => a.impl.kind !== "untested").length;
  console.log(`\nnative intents — red team\n`);
  console.log(`  ${total} attacks on the native-intent design, filed by the SURFACE they target rather than by`);
  console.log(`  the order they were written. Every entry states the outcome it expects BEFORE it runs, so a`);
  console.log(`  run that disagrees with the board is the finding — not a failing test.\n`);
  console.log(`  Outcomes name their subject, so no line can be read backwards:`);
  console.log(`    ${pad("attack BLOCKED", 17)}the attack cannot land`);
  console.log(`    ${pad("harm CONTAINED", 17)}it lands, and the damage stays with the attacker`);
  console.log(`    ${pad("ATTACK WORKS", 17)}it lands and costs someone else something`);
  console.log(`    ${pad("[bracketed]", 17)}a prediction on record that NO attack has been written for yet\n`);
  console.log(`  ${pad("class", 52)}${pad("n", 3)}  ${pad("coverage", 18)}outcomes of the written ones`);
  for (const cls of Object.keys(CLASSES) as ThreatClass[]) {
    console.log(`  ${cls}  ${pad(trunc(CLASSES[cls], 47), 49)}${summariseClass(cls)}`);
  }
  console.log(`\n  ${written} of ${total} attacks are written; the other ${total - written} are listed so the gap is visible, not absent.`);
  if (opts.menu) {
    const letters = Object.keys(CLASSES).join("");
    console.log(`\n  [*] run all   [${letters}] one class   [<id>] one attack   [l] list attacks   [q] quit`);
  }
}

/** Every attack, class by class, with its prediction and how it is implemented. */
function list(): void {
  for (const cls of Object.keys(CLASSES) as ThreatClass[]) {
    console.log(`\n  ${cls} · ${CLASSES[cls]}`);
    console.log(`    ${pad("id", 5)}${pad("attack", 60)}${pad("predicted", 17)}how it runs`);
    for (const a of byClass(cls)) {
      const how = a.impl.kind === "wrapped" ? `wraps ${a.impl.script.replace(/\.ts$/, "")}`
        : a.impl.kind === "native" ? "native (full forensics)" : "NOT WRITTEN — run it to see why";
      const done = results.get(a.id);
      const mark = done === "as-predicted" ? " ✓" : done === "deviation" ? " ‼"
        : done === "broken" || done === "environment" ? " ✗" : "";
      const pred = a.impl.kind === "untested" ? `[${tag(a.expected)}]` : tag(a.expected);
      // No pad on the last column: trailing whitespace on every row makes a diff of this output noisy.
      console.log(`    ${pad(a.id, 5)}${pad(a.name, 60)}${pad(pred, 17)}${how}${mark}`);
    }
  }
  console.log(`\n  "predicted" is what the registry commits to in advance. [bracketed] means no attack`);
  console.log(`  exists yet, so nothing has tested it. A ✓/‼/✗ marks what THIS session actually ran.\n`);
}

/** Run a wrapped experiment, streaming its output live while keeping a copy to classify by. */
function runScript(script: string, env: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", join(EXPERIMENTS, script)],
      { stdio: ["inherit", "pipe", "pipe"], env: { ...process.env, ...env } });
    let out = "";
    // setEncoding, not chunk.toString(): the suite prints '…', '·' and '✓', and a Buffer boundary
    // landing mid-codepoint would turn those into replacement characters in the streamed output.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const tee = (t: string, to: NodeJS.WriteStream) => { out += t; to.write(t); };
    child.stdout?.on("data", (c: string) => tee(c, process.stdout));
    child.stderr?.on("data", (c: string) => tee(c, process.stderr));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
    child.on("error", (e) => resolve({ code: 1, out: `${out}\nspawn failed: ${e.message}` }));
  });
}

/**
 * Read the evidence the experiment printed, rather than guessing from its prose.
 *
 * Exit code 2 is the ONLY environment signal, and every environment guard in the wrapped set uses it
 * (_harness.ts requireSettlement/preflight, plus each experiment's own genesis probe). An earlier
 * version also matched phrases like "Relaunch with -Dintent.requireBtcTicket=true" — but e8 prints
 * that line only when the intent WAS admitted, i.e. in exactly the case that is the finding, so the
 * heuristic swallowed the one deviation it was meant to explain. e8 now exits 2 itself when it cannot
 * establish which world it is in, which is the only place that ambiguity can honestly be resolved.
 *
 * A printed FAIL row is decisive even if the script later threw: checks that already failed are
 * evidence, and demoting them to "broken" would hide them.
 */
function classify(code: number, out: string): Status {
  if (code === 0) return "as-predicted";
  if (code === 2) return "environment";
  if (/^\s*FAIL\s/m.test(out)) return "deviation";
  // No RESULT: line means Report.done() was never reached — the script threw, so it proved nothing.
  return /^RESULT:/m.test(out) ? "deviation" : "broken";
}

async function runOne(spec: AttackSpec, inBoardRun = false): Promise<Status> {
  if (inBoardRun && spec.notInAll) {
    printSpecHeader(spec, { needs: true });
    console.log(`SKIPPED on the default stack: ${spec.notInAll}`);
    console.log(`  run it explicitly with: npm run attack -- --id=${spec.id}\n`);
    results.set(spec.id, "skipped");
    return "skipped";
  }
  if (spec.impl.kind === "untested") {
    printSpecHeader(spec, { needs: true });
    console.log(`NOT EXERCISED: ${spec.impl.why}\n`);
    results.set(spec.id, "not-run");
    return "not-run";
  }

  // Both runnable kinds need their stack resolved first. A missing stack is an ENVIRONMENT result,
  // not a defence result: reporting "blocked" because nothing was running would be a false pass.
  let ctx: StackCtx;
  try {
    ctx = await stackFor(spec);
  } catch (e) {
    console.log(`\n=== ${spec.id.toUpperCase()}  ${spec.name}`);
    console.log(`${pad("needs", 11)}${spec.needs}`);
    if (e instanceof StackUnavailable) {
      console.log(`\nWRONG STACK — this attack declares the "${e.stack}" stack (${stackWhat(e.stack)}).`);
      console.log(`  ${e.hint}\n`);
    } else {
      console.log(`\nWRONG STACK — ${e instanceof Error ? e.message : String(e)}\n`);
    }
    results.set(spec.id, "environment");
    return "environment";
  }
  if (ctx.name !== "default") console.log(`\n  [stack: ${ctx.name}] ${stackWhat(ctx.name)}${ctx.provisioned ? " — provisioned by this run" : " — already up, reusing"}`);

  if (spec.impl.kind === "wrapped") {
    const script = spec.impl.script;
    printSpecHeader(spec, { needs: true });
    const cached = inBoardRun ? ranScripts.get(script) : undefined;
    if (cached !== undefined) {
      console.log(`\n(${script} already ran this session for another attack — reusing its result: ${cached})\n`);
      results.set(spec.id, cached);
      return cached;
    }
    console.log(`\nrunning experiments/${script} — its own checks are the attack log\n`);
    // The experiments read RPC_A/RPC_B from the environment, so a wrapped attack on a non-default
    // stack needs no per-experiment changes — just the right URLs.
    const { code, out } = await runScript(script,
      ctx.name === "default" ? {} : { RPC_A: ctx.rpc.url, RPC_B: ctx.rpc2.url });
    const st = classify(code, out);
    ranScripts.set(script, st);
    if (st === "broken") console.log(`\n(experiment threw before reporting — a stale experiment, not a defence result)\n`);
    results.set(spec.id, st);
    return st;
  }

  try {
    const mod = await spec.impl.load();
    const code = await mod.run(spec, ctx);
    // 3 = the attack ran and nothing disagreed, but it skipped part of itself (a precondition it
    // could not establish). Neither a pass nor a deviation — it must not be counted as either.
    const st: Status = code === 0 ? "as-predicted" : code === 3 ? "partial" : "deviation";
    results.set(spec.id, st);
    return st;
  } catch (e) {
    // An attack may discover only at runtime that its stack is stale (a genesis contract it needs is
    // missing or older than it needs). That is the stack's problem, not the attack's, so it must not
    // be reported as a broken experiment — the two send the reader to completely different places.
    if (e instanceof StackUnavailable) {
      console.log(`\nWRONG STACK — ${e.hint}\n`);
      results.set(spec.id, "environment");
      return "environment";
    }
    console.error(`\n${spec.id.toUpperCase()} could not run: ${e instanceof Error ? e.message : String(e)}\n`);
    results.set(spec.id, "broken");
    return "broken";
  }
}

async function runMany(specs: AttackSpec[]): Promise<void> {
  ranScripts.clear(); // a fresh board run re-runs everything, even after an earlier failure
  // Group by declared stack, keeping each group in board order. Interleaving stacks would work, but
  // it reads as chaos in the log and makes the one-stack-at-a-time provisioning invisible.
  const order = [...specs].sort((x, y) => (x.stack ?? "default").localeCompare(y.stack ?? "default"));
  for (const s of order) await runOne(s, true);
  summary(specs);
}

/** Statuses where the system was actually asked something. Everything else observed NOTHING. */
const OBSERVED: Status[] = ["as-predicted", "deviation", "partial"];

function summary(specs: AttackSpec[]): void {
  console.log(`\n================ RED TEAM SUMMARY ================`);
  // The two right-hand columns are PREDICTED and OBSERVED, and unlabelled they read as one statement:
  // "ATTACK WORKS / not exercised" looks self-contradictory rather than like a prediction nobody
  // tested. Hence the header, and hence the brackets below.
  console.log(`  ${pad("id", 5)}${pad("attack", 60)}${pad("predicted", 17)}this run`);
  for (const s of specs) {
    const st = results.get(s.id) ?? "not-run";
    const label: Record<Status, string> = {
      "as-predicted": "as predicted", deviation: "DEVIATION", partial: "PARTLY exercised",
      broken: "experiment broken",
      environment: "wrong stack", skipped: "skipped (wrong stack)", "not-run": "not exercised",
    };
    // A prediction nothing tested is shown in [brackets]: it is what we committed to in advance, not
    // something the run established. Reading it as a finding is the mistake the brackets prevent.
    const pred = OBSERVED.includes(st) ? tag(s.expected) : `[${tag(s.expected)}]`;
    // 60/17: "reorg a settled exit after the BTC payment is irreversible" is 57 chars and used to run
    // straight into its own outcome ("...irreversiblecontained"), which is how a summary stops being read.
    console.log(`  ${pad(s.id.toUpperCase(), 5)}${pad(s.name, 60)}${pad(pred, 17)}${label[st]}`);
  }
  const n = (st: Status) => specs.filter((s) => (results.get(s.id) ?? "not-run") === st).length;
  console.log(`\n  ${n("as-predicted")} as predicted · ${n("deviation")} deviation(s) · ` +
    `${n("partial")} partly exercised · ${n("broken")} experiment(s) broken · ` +
    `${n("environment") + n("skipped")} needing another stack · ${n("not-run")} not exercised`);
  const unobserved = specs.filter((s) => !OBSERVED.includes(results.get(s.id) ?? "not-run")).length;
  if (unobserved) {
    console.log(`  [bracketed] = a prediction on record that this run did not test — ${unobserved} of ${specs.length} rows.`);
  }
  if (n("deviation") === 0 && (n("partial") || n("broken") || n("environment") || n("skipped") || n("not-run"))) {
    console.log(`  no deviations — but the board is INCOMPLETE: the bracketed lines are unverified, not passed.`);
  }
  console.log("");
}

const anyDeviation = () => [...results.values()].some((s) => s === "deviation");
const anyIncomplete = () => [...results.values()].some((s) => s === "broken" || s === "environment" || s === "skipped" || s === "partial");
/** 0 = every attack that ran behaved as predicted. 1 = a deviation. 3 = no deviations, but incomplete. */
const exitCode = (): number => (anyDeviation() ? 1 : anyIncomplete() ? 3 : 0);

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const flag = (name: string) => argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));

  // Bare words (anything that is not a --flag and not the argument separator) are selectors: attack
  // ids, single class letters, or "all"/"list". `npm run attacks -- e7` used to run the WHOLE board,
  // because the npm script hardcoded --all and the trailing id was silently ignored.
  provision = !!flag("provision");
  doTeardown = !!flag("teardown");
  const words = argv.filter((a) => a !== "--" && !a.startsWith("--")).map((w) => w.toLowerCase());
  const wantAll = words.includes("all") || words.includes("*");
  const wantList = words.includes("list");
  const selectors = words.filter((w) => w !== "all" && w !== "*" && w !== "list");

  if (flag("list") || wantList) { board(); list(); return 0; }

  if (selectors.length) {
    const specs: AttackSpec[] = [];
    for (const w of selectors) {
      const one = byId(w);
      if (one) { specs.push(one); continue; }
      const cls = w.length === 1 && CLASSES[w.toUpperCase() as ThreatClass] ? byClass(w) : [];
      if (cls.length) { specs.push(...cls); continue; }
      console.error(`no such attack or class: "${w}" — try: npm run attacks -- list`);
      return 2;
    }
    // de-duplicate while keeping the order asked for (e.g. `-- E e8` should not run e8 twice)
    const seen = new Set<string>();
    const unique = specs.filter((sp) => (seen.has(sp.id) ? false : (seen.add(sp.id), true)));
    await runMany(unique); // prints the summary itself
    teardownProvisioned();
    return exitCode();
  }

  if (flag("all") || wantAll || flag("default-all")) {
    await runMany(allOrdered());
    teardownProvisioned();
    return exitCode();
  }
  const cls = flag("class");
  if (cls) {
    const c = cls.split("=")[1]?.toUpperCase();
    const specs = c ? byClass(c) : [];
    if (!specs.length) { console.error(`no such class: ${c}. Classes: ${Object.keys(CLASSES).join(", ")}`); return 2; }
    await runMany(specs);
    teardownProvisioned();
    return exitCode();
  }
  const id = flag("id");
  if (id) {
    const spec = byId(id.split("=")[1] ?? "");
    if (!spec) { console.error(`no such attack: ${id.split("=")[1]}. Try --list.`); return 2; }
    await runOne(spec);
    summary([spec]); // a wrapped attack prints its own checks but no verdict — say what it counted as
    teardownProvisioned();
    return exitCode();
  }

  // interactive — but readline's question() never resolves on a closed stdin, so a flagless run in
  // CI or under a pipe would print the board and hang forever rather than doing anything.
  if (!process.stdin.isTTY) {
    board();
    console.error(`\nno TTY: the menu needs an interactive terminal. Pass a selector instead:\n` +
      `  npm run attacks -- list         print the board\n` +
      `  npm run attacks                 run every runnable attack\n` +
      `  npm run attacks -- E            one threat class\n` +
      `  npm run attacks -- e8           one attack (bare id, or several: e8 b2)\n` +
      `  npm run attacks -- --provision m3   bring up the stack the attack needs first\n`);
    return 2;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    board({ menu: true });
    const answer = (await rl.question("> ")).trim().toLowerCase();
    if (answer === "q" || answer === "") break;
    if (answer === "l") { list(); continue; }
    // The class check comes FIRST: input is lowercased, so an `answer === "a"` shortcut for "run all"
    // would shadow class A and make it unreachable from a menu that advertises [A-F].
    if (answer.length === 1 && CLASSES[answer.toUpperCase() as ThreatClass]) {
      await runMany(byClass(answer));
      continue;
    }
    if (answer === "*") { await runMany(allOrdered()); continue; }
    const spec = byId(answer);
    if (!spec) { console.log(`\n  no such attack or class: "${answer}" — [l] lists them\n`); continue; }
    await runOne(spec);
  }
  rl.close();
  process.stdin.pause(); // release stdin so the process can exit on its own once main() resolves
  return exitCode();
}

/**
 * Shut down cleanly — which needs more care than it looks.
 *
 * The rule here is "never truncate the summary", because that is what the board run is FOR: piping it
 * into a file or a pager is the normal way to read it, and a half-written summary is worse than none.
 * That is why this used to be a bare `process.exitCode = c` with no exit() call.
 *
 * But setting an exit code only ends the process once the event loop is EMPTY, and a board run leaves
 * things in it: a stack's mining ticker (a setInterval), and ethers providers that may still hold a
 * poller. The result was a run that printed its full summary and then sat there forever, which reads
 * as a hang in the attack rather than as litter in the runner.
 *
 * So: stop what we own, then flush stdout and exit explicitly. The write callback fires only once the
 * stream has drained, so the exit cannot cut the summary short — both properties at once, rather than
 * trading one for the other.
 */
main().then(async (c) => {
  process.exitCode = c;
  await disposeStacks();
  process.stdout.write("", () => process.exit(c));
});
