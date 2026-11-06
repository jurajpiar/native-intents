/**
 * Forensics for the attack suite.
 *
 * An experiment's Report (../experiments/_harness.ts) answers "did the claim survive". An attack has
 * to answer a harder question — "what exactly did the attacker get away with" — so every step here
 * records the attacker's transaction hash, the revert REASON when it fails, the gas it burnt, and the
 * balance delta of every watched party. Same ok/FAIL check vocabulary, extended with steps + deltas.
 */
import { AbiCoder } from "ethers";
import { Rpc, waitFor } from "../src/client.js";
import { AttackSpec, CLASSES, Outcome , OUTCOME_LABEL, OUTCOME_SENTENCE } from "./registry.js";

const coder = AbiCoder.defaultAbiCoder();
const REVERT_SEL = "08c379a0"; // Error(string)
const PANIC_SEL = "4e487b71";  // Panic(uint256) — asserts, overflow, out-of-bounds; a code, no string

/** Solidity's panic codes, so an out-of-bounds calldata read reads as one rather than as hex. */
const PANIC_NAMES: Record<string, string> = {
  "0x1": "assert failed", "0x11": "arithmetic overflow", "0x12": "division by zero",
  "0x21": "invalid enum value", "0x22": "bad storage byte array", "0x31": "pop from empty array",
  "0x32": "array/calldata out of bounds", "0x41": "out of memory", "0x51": "bad internal function",
};

/** Everything rskj might have tucked a revert payload into, flattened to one searchable string. */
function errBlob(e: unknown): string {
  if (e === null || e === undefined) return "";
  if (typeof e === "string") return e;
  const parts = new Set<string>();
  const o = e as Record<string, unknown>;
  if (e instanceof Error) parts.add(e.message);
  for (const k of ["data", "info", "error", "body", "shortMessage", "reason", "cause", "message"]) {
    const v = o[k];
    if (typeof v === "string") parts.add(v);
    else if (v && typeof v === "object") parts.add(JSON.stringify(v));
  }
  return [...parts].join(" ");
}

/** Pull an Error(string) reason out of an rskj failure: the ABI payload if present, else the prose. */
export function decodeRevertReason(e: unknown): string | null {
  const blob = errBlob(e);
  const abi = blob.match(new RegExp(`(?:0x)?${REVERT_SEL}([0-9a-fA-F]+)`));
  if (abi) {
    try {
      const s = coder.decode(["string"], "0x" + abi[1].padEnd(Math.ceil(abi[1].length / 64) * 64, "0"))[0];
      if (typeof s === "string" && s.length) return s;
    } catch { /* fall through to the prose form */ }
  }
  // rskj's prose form is "VM Exception while processing transaction: revert <reason>", and the blob may
  // hold several copies of it (message + data + shortMessage) — take one reason, not a concatenation.
  // A Panic carries a code rather than a string. Reporting it beats falling through to the prose
  // branch, which would find no reason and say "(no reason)" for a genuine bounds-check revert.
  const panic = blob.match(new RegExp(`(?:0x)?${PANIC_SEL}([0-9a-fA-F]{64})`));
  if (panic) {
    const code = "0x" + BigInt("0x" + panic[1]).toString(16);
    return `Panic(${code})${PANIC_NAMES[code] ? " " + PANIC_NAMES[code] : ""}`;
  }
  // rskj's prose form is "VM Exception while processing transaction: revert <reason>" — note there is
  // NO colon after "revert", so the colon must stay optional. The \b after the optional "ed" is what
  // stops a bare "transaction reverted" (no reason at all) from capturing the "ed" as its reason.
  const prose = blob.match(/\brevert(?:ed)?\b:?\s*([^"\\\n]*)/);
  const one = prose ? prose[1].split(/\s*VM Exception/)[0].trim() : "";
  return one || null;
}

/**
 * Why did this mined-but-failed transaction revert? Receipts carry only status, so replay the tx as an
 * eth_call. Replayed at its OWN block (end-of-block state, so a rival tx ordered ahead of it in the
 * same block is included) — that is what reproduces race reverts, which pre-block state would not.
 */
export async function revertReasonOf(rpc: Rpc, hash: string): Promise<string | null> {
  const tx = await rpc.call<RawTx | null>("eth_getTransactionByHash", [hash]).catch(() => null);
  if (!tx) return null;
  try {
    await rpc.call("eth_call", [
      { from: tx.from, to: tx.to, data: tx.input, value: tx.value, gas: tx.gas },
      tx.blockNumber ?? "latest",
    ]);
    return null; // the replay did NOT revert: the on-chain failure was gas- or ordering-dependent
  } catch (e) {
    return decodeRevertReason(e);
  }
}

interface RawTx { from: string; to: string | null; input: string; value: string; gas: string; blockNumber: string | null }
interface RawReceipt { status: string; gasUsed: string; blockNumber: string | null; logs: RawLog[] }
export interface RawLog { address: string; topics: string[]; data: string }

/** A transaction as the attack log reports it. */
export interface TxForensics {
  hash: string;
  ok: boolean;          // mined with status 0x1
  mined: boolean;
  gasUsed: bigint;
  reason: string | null; // revert reason when !ok
  logs: RawLog[];
  block: number | null;
}

const short = (h: string) => `${h.slice(0, 10)}…`;
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));

/** Signed wei delta, rendered so both dust and real money read at a glance. */
export function fmtDelta(v: bigint): string {
  if (v === 0n) return "0";
  const sign = v < 0n ? "-" : "+";
  const a = v < 0n ? -v : v;
  if (a >= 10n ** 13n) return `${sign}${(Number(a) / 1e18).toFixed(8).replace(/0+$/, "").replace(/\.$/, "")} rbtc`;
  return `${sign}${a} wei`;
}

/**
 * The brief for one attack: what it points at, what the attacker believes, what we predict, and what
 * stops it. Exported because a WRAPPED attack deserves the same brief as a native one — it used to
 * print two thin lines and then hand over to an experiment written before the registry existed, so
 * the reader got the experiment's own framing and never saw the premise or the severity.
 *
 * `needs` is shown only for wrapped runs: a native attack's environment is handled by the stack
 * layer, but a wrapped experiment can still fail on a stack the reader has to think about.
 */
export function printSpecHeader(spec: AttackSpec, opts: { needs?: boolean } = {}): void {
  const bar = "=".repeat(Math.max(4, 62 - spec.id.length - spec.name.length));
  console.log(`\n=== ${spec.id.toUpperCase()}  ${spec.name} ${bar}`);
  console.log(`${pad("class", 11)}${spec.cls} · ${CLASSES[spec.cls]}`);
  console.log(`${pad("target", 11)}${spec.target}`);
  console.log(`${pad("premise", 11)}${spec.premise}`);
  console.log(`${pad("expected", 11)}${OUTCOME_LABEL[spec.expected]}${spec.expectedWhy ? " — " + spec.expectedWhy : ""}`);
  console.log(`${pad("severity", 11)}${spec.severity}`);
  console.log(`${pad("defence", 11)}${spec.defence}`);
  if (opts.needs) console.log(`${pad("needs", 11)}${spec.needs}`);
  console.log("");
}

export class Attack {
  private rows: { name: string; ok: boolean; detail: string }[] = [];
  private watched: { label: string; addr: string }[] = [];
  private base = new Map<string, bigint>();
  private stepNo = 0;
  private skips: string[] = [];

  constructor(readonly spec: AttackSpec, readonly rpc: Rpc) {
    printSpecHeader(spec);
  }

  /**
   * Register a party whose balance deltas matter. Must be called before the first mark(): a watch
   * added afterwards would have no baseline, and a missing baseline reads as ZERO MOVEMENT — which a
   * check written as `d.get("attacker") === 0n` would report as proof the attacker gained nothing.
   * A loud throw is the only safe behaviour here.
   */
  watch(label: string, addr: string): void {
    if (this.base.size > 0) {
      throw new Error(
        `watch("${label}") called after mark(): it would have no baseline, and a missing baseline ` +
        `reads as a zero delta — which a "gained nothing" check would score as a pass. Watch first, then mark.`);
    }
    this.watched.push({ label, addr });
  }

  /** Snapshot every watched balance; deltas() reports movement since this point and re-marks. */
  async mark(): Promise<void> {
    for (const w of this.watched) this.base.set(w.addr, BigInt(await this.rpc.getBalance(w.addr)));
  }

  step(label: string): void {
    console.log(`  step ${++this.stepNo}  ${label}`);
  }

  note(line: string): void {
    console.log(`          ${line}`);
  }

  /** Record something the attack could not exercise here (missing dependency, node refusal). */
  skip(name: string, why: string): void {
    this.skips.push(`${name}: ${why}`);
    console.log(`          skip  ${name} — ${why}`);
  }

  /** Wait for a tx, decode its outcome, and print the forensic line. */
  async tx(hashOrPromise: string | Promise<string>, label = ""): Promise<TxForensics> {
    let hash: string;
    try {
      hash = await hashOrPromise;
    } catch (e) {
      // rejected before inclusion (admission rule, ethers preflight): still a forensic result
      const reason = decodeRevertReason(e) ?? (e instanceof Error ? e.message : String(e));
      console.log(`          ${label ? label + "  " : ""}NOT SENT  — ${reason.slice(0, 120)}`);
      return { hash: "", ok: false, mined: false, gasUsed: 0n, reason, logs: [], block: null };
    }
    await waitFor(async () => {
      const r = await this.rpc.call<RawReceipt | null>("eth_getTransactionReceipt", [hash]).catch(() => null);
      return r !== null && r.blockNumber !== null;
    }, 30000);
    const rec = await this.rpc.call<RawReceipt | null>("eth_getTransactionReceipt", [hash]).catch(() => null);
    if (!rec) {
      console.log(`          ${label ? label + "  " : ""}tx ${short(hash)}  NOT MINED (timed out)`);
      return { hash, ok: false, mined: false, gasUsed: 0n, reason: "not mined", logs: [], block: null };
    }
    const ok = rec.status === "0x1";
    const gasUsed = BigInt(rec.gasUsed ?? "0x0");
    const reason = ok ? null : await revertReasonOf(this.rpc, hash);
    const head = `          ${label ? label + "  " : ""}tx ${short(hash)}  gas ${gasUsed.toLocaleString("en-GB")}`;
    console.log(ok ? `${head}  mined ok` : `${head}  REVERTED ${reason ? `"${reason}"` : "(no reason)"}`);
    return { hash, ok, mined: true, gasUsed, reason, logs: rec.logs ?? [], block: Number(rec.blockNumber) };
  }

  /**
   * Print each watched party's movement since mark(), then re-mark for the next step.
   *
   * Snapshot every address ONCE, compute all labels against the old baseline, and only then re-mark.
   * Re-marking inside the loop made a second label on the same address read a delta of zero — the
   * same silent-zero hazard watch() guards against, arriving by a different route.
   */
  async deltas(): Promise<Map<string, bigint>> {
    const snap = new Map<string, bigint>();
    for (const w of this.watched) {
      if (!snap.has(w.addr)) snap.set(w.addr, BigInt(await this.rpc.getBalance(w.addr)));
    }
    const out = new Map<string, bigint>();
    const parts: string[] = [];
    for (const w of this.watched) {
      const base = this.base.get(w.addr);
      if (base === undefined) throw new Error(`no baseline for watch("${w.label}") — call mark() after every watch()`);
      const d = snap.get(w.addr)! - base;
      out.set(w.label, d);
      parts.push(`${w.label} ${fmtDelta(d)}`);
    }
    for (const [addr, v] of snap) this.base.set(addr, v);
    if (parts.length) console.log(`          ${parts.join("   ")}`);
    return out;
  }

  check(name: string, ok: boolean, detail = ""): boolean {
    this.rows.push({ name, ok, detail });
    console.log(`          ${ok ? "ok  " : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    return ok;
  }

  /**
   * Close the attack: compare what actually happened against what the registry predicted. Exit 0 means
   * the prediction held (whether that prediction was "blocked" or "succeeds"); non-zero means the
   * system deviated from its documented behaviour — the finding worth acting on.
   */
  finish(observed: Outcome): number {
    const failed = this.rows.filter((r) => !r.ok).length;
    const deviated = observed !== this.spec.expected;
    console.log("");
    if (deviated) {
      console.log(`RESULT: DEVIATION — the registry predicted "${OUTCOME_LABEL[this.spec.expected]}", ` +
        `the run observed "${OUTCOME_LABEL[observed]}".`);
    } else {
      console.log(`RESULT: ${OUTCOME_SENTENCE[observed]} — as predicted.`);
    }
    if (failed) console.log(`        ${failed} check(s) FAILED — see above.`);
    for (const s of this.skips) console.log(`        not exercised: ${s}`);
    if (this.spec.conclusion) console.log(`        ${this.spec.conclusion}`);
    const findings = this.spec.finding === undefined ? []
      : Array.isArray(this.spec.finding) ? this.spec.finding : [this.spec.finding];
    for (const [i, f] of findings.entries()) {
      console.log(`\nFINDING${findings.length > 1 ? ` ${i + 1}/${findings.length}` : ""}: ${f}`);
    }
    console.log("");
    // Exit codes match the runner's: 0 every check ran and agreed, 1 a deviation or a failed check,
    // 3 nothing disagreed but part of the attack was NOT EXERCISED. Returning 0 with skips on the
    // board would file a half-run attack as a pass, which is the exact confusion the summary's
    // "incomplete, not passed" line exists to prevent — and it hid a decay squeeze that never ran.
    if (failed > 0 || deviated) return 1;
    return this.skips.length > 0 ? 3 : 0;
  }
}
