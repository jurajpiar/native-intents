/**
 * Parse every mermaid block in the repo with the REAL mermaid parser.
 *
 * mermaid_lint.py greps for the two characters that have broken these diagrams before. That is a
 * floor, not a check: it passes anything whose failure mode it has not already met, and this repo has
 * broken its diagrams four times. This runs mermaid itself, so a malformed arrow, an unknown
 * participant, or a bad shape fails here instead of in the reader's browser.
 *
 * Skips with exit 0 when mermaid/jsdom are not installed, so a fresh clone that has not run
 * `npm install` still gets the character lint rather than a confusing hard failure.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKIP = new Set(["node_modules", ".git", "rskj", "rskj-patch", "dist", "build"]);

/**
 * Both `.md` (fenced blocks) and `.mermaid` (whole file is one diagram). The python lint only ever
 * looked at `.md`, which left native-intent-sequence.mermaid unchecked by anything at all.
 */
function diagramFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...diagramFiles(p));
    else if (name.endsWith(".md") || name.endsWith(".mermaid")) out.push(p);
  }
  return out;
}

let mermaid;
try {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  for (const k of ["Element", "SVGElement", "HTMLElement", "Node", "getComputedStyle", "requestAnimationFrame", "MutationObserver"]) {
    if (!(k in globalThis) && k in dom.window) globalThis[k] = dom.window[k];
  }
  // navigator is a getter-only global on modern Node
  try { Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true }); } catch { /* already usable */ }
  mermaid = (await import("mermaid")).default;
  mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });
} catch (e) {
  console.log(`  mermaid parse SKIPPED — ${(e?.message ?? e).toString().split("\n")[0]}`);
  console.log(`  (run 'npm install' in poc/sdk to enable it. mermaid_lint.py still ran.)`);
  process.exit(0);
}

let blocks = 0;
let bad = 0;
for (const file of diagramFiles(ROOT)) {
  const src = readFileSync(file, "utf8");
  const found = file.endsWith(".mermaid")
    ? (src.trim() ? [src] : [])
    : [...src.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (const [i, text] of found.entries()) {
    blocks++;
    const where = found.length > 1 ? `${relative(ROOT, file)} block ${i + 1}` : relative(ROOT, file);
    try {
      await mermaid.parse(text, { suppressErrors: false });
    } catch (e) {
      bad++;
      console.log(`  FAIL  ${where}`);
      console.log(String(e?.message ?? e).split("\n").slice(0, 8).map((l) => `        ${l}`).join("\n"));
    }
  }
}

if (bad === 0) console.log(`  all mermaid blocks PARSE (${blocks} block(s) via mermaid ${mermaid.version ?? ""})`);
process.exit(bad === 0 ? 0 : 1);
