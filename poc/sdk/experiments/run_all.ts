/**
 * Runs the experiments that work against the default 2-node compose (requireBtcTicket=false).
 * E8 is excluded here because it needs a node launched with -Dintent.requireBtcTicket=true.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const suite = [
  "e1_zero_balance_admission.ts",
  "e1b_gossip.ts",
  "e2_expiry_costs_nothing.ts",
  "e3_replay_after_consume.ts",
  "e7_atomic_settlement.ts",
  "e6_consume_griefing.ts",
  "e10_token_output.ts",
  "e11_visible_revert.ts",
];

const results: { name: string; code: number }[] = [];
for (const f of suite) {
  const res = spawnSync("npx", ["tsx", join(here, f)], { stdio: "inherit" });
  results.push({ name: f, code: res.status ?? 1 });
}

console.log("\n================ SUITE SUMMARY ================");
for (const r of results) console.log(`  ${r.code === 0 ? "PASS" : "FAIL"}  ${r.name}`);
const failed = results.filter((r) => r.code !== 0).length;
console.log(failed === 0 ? "\nAll experiments behaved as predicted.\n" : `\n${failed} experiment(s) did not behave as predicted.\n`);
process.exit(failed === 0 ? 0 : 1);
