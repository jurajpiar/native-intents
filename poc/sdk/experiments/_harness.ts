/** Shared reporting for experiments. Each experiment is a falsification attempt against a claim. */
import { Rpc } from "../src/client.js";
import { RPC_A, RPC_B } from "../src/config.js";

export const rpcA = new Rpc(RPC_A);
export const rpcB = new Rpc(RPC_B);

export class Report {
  private rows: { name: string; ok: boolean; detail: string }[] = [];
  constructor(public title: string, public claim: string) {
    console.log(`\n=== ${title} ===`);
    console.log(`claim under test: ${claim}\n`);
  }
  check(name: string, ok: boolean, detail = ""): boolean {
    this.rows.push({ name, ok, detail });
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    return ok;
  }
  /** returns process exit code (0 = claim survived / experiment behaved as predicted) */
  done(): number {
    const failed = this.rows.filter((r) => !r.ok).length;
    console.log(failed === 0 ? `\nRESULT: as predicted — claim survived.\n` : `\nRESULT: ${failed} check(s) FAILED — claim falsified or bug.\n`);
    return failed === 0 ? 0 : 1;
  }
}

export async function preflight(rpc: Rpc): Promise<void> {
  try {
    await rpc.blockNumber();
  } catch (e) {
    console.error(`\nCannot reach node at ${rpc.url}. Is the stack up? (podman-compose up -d)\n${(e as Error).message}`);
    process.exit(2);
  }
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
