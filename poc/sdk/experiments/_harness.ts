/** Shared reporting for experiments. Each experiment is a falsification attempt against a claim. */
import { JsonRpcProvider, Network, Wallet } from "ethers";
import { Rpc, Receipt, waitFor } from "../src/client.js";
import { RPC_A, RPC_B, CHAIN_ID, COW_KEY } from "../src/config.js";

export const rpcA = new Rpc(RPC_A);
export const rpcB = new Rpc(RPC_B);

/** Fund an address from cow (used to give an adversary gas money but less than minOut). Returns tx hash. */
export async function fundAccount(to: string, value: bigint, rpcUrl = RPC_A): Promise<string> {
  const provider = new JsonRpcProvider(rpcUrl, new Network("rsk-regtest", CHAIN_ID), { staticNetwork: true });
  const cow = new Wallet(COW_KEY, provider);
  const tx = await cow.sendTransaction({ to, value, gasLimit: 100_000, gasPrice: 1_000_000, type: 0, chainId: CHAIN_ID });
  return tx.hash;
}

/** Wait until a tx is mined and return its receipt (or null on timeout). */
export async function waitReceipt(rpc: Rpc, hash: string, timeoutMs = 25000): Promise<Receipt | null> {
  await waitFor(async () => {
    const r = await rpc.getReceipt(hash).catch(() => null);
    return r !== null && r.blockNumber !== null;
  }, timeoutMs);
  return rpc.getReceipt(hash).catch(() => null);
}

export const succeeded = (r: Receipt | null): boolean => r !== null && r.status === "0x1";
export const reverted = (r: Receipt | null): boolean => r !== null && r.status === "0x0";

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
