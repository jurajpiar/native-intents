/** Shared reporting for experiments. Each experiment is a falsification attempt against a claim. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, Network, Wallet } from "ethers";
import { Rpc, Receipt, waitFor } from "../src/client.js";
import { AUCTION_ADDR, RPC_A, RPC_B, CHAIN_ID, COW_KEY, SETTLEMENT_ADDR } from "../src/config.js";

const POC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Every genesis contract, with the file holding the exact runtime bytecode it should be serving.
 * `compile.js` writes these and injects the same bytes into the rskj clone's genesis, so they are
 * the authority on what a correctly-built node runs.
 */
const GENESIS_CONTRACTS = [
  { label: "Settlement", addr: SETTLEMENT_ADDR, hex: "settlement.runtime.hex" },
  { label: "Auction", addr: AUCTION_ADDR, hex: "auction.runtime.hex" },
] as const;

/**
 * Compare what the node is serving against what was last compiled. Returns one line per problem.
 *
 * Checking only that code EXISTS — which is what this guard used to do — misses the failure that
 * actually happens: a node built before the contracts changed serves perfectly good but WRONG
 * bytecode, and the run then fails somewhere far from the cause. Probing for a specific function is
 * no better, because a function can survive a semantic change (the auction kept `WINDOW()` across the
 * rewrite of its decay rule, so a probe on it passed against stale code).
 *
 * These contracts have no constructor — genesis injects runtime code directly — so a correctly-built
 * node serves the compiled bytes verbatim, and an exact comparison is both possible and decisive.
 */
export async function genesisProblems(rpc: Rpc): Promise<string[]> {
  const dir = join(POC, "rskj-patch", "genesis");
  const out: string[] = [];
  for (const g of GENESIS_CONTRACTS) {
    const f = join(dir, g.hex);
    const have = (await rpc.getCode(g.addr).catch(() => "0x")).toLowerCase();
    if (!have || have === "0x") { out.push(`${g.label} has NO CODE at ${g.addr}`); continue; }
    if (!existsSync(f)) continue; // nothing to compare against
    const want = "0x" + readFileSync(f, "utf8").trim().replace(/^0x/, "").toLowerCase();
    if (have !== want) {
      out.push(`${g.label} at ${g.addr} is running ${(have.length - 2) / 2} bytes, but the compiled ` +
        `contract is ${(want.length - 2) / 2} bytes — this node predates the current build`);
    }
  }
  return out;
}

/**
 * How to get a stack onto the current contracts. Both compose files, deliberately: they are separate
 * projects with their own volumes, so `down -v` on one leaves the other on old bytecode — which is
 * exactly how a stale reorg stack survived two rebuilds.
 */
export const REBUILD_HINT =
  `  cd poc && npm run stack:reset\n` +
  `\n` +
  `  (that wipes BOTH stacks' volumes and rebuilds the image. The reorg stack comes up on demand —\n` +
  `   npm run attacks -- --provision <id>, or npm run stack:reorg:up. Long form, if you prefer:\n` +
  `     docker-compose -f stack/podman-compose.yml down -v\n` +
  `     docker-compose -f stack/docker-compose.reorg.yml down -v\n` +
  `     docker-compose -f stack/podman-compose.yml up -d --build)`;

/** Guard for settlement experiments: the genesis contracts must be present AND current. */
export async function requireSettlement(rpc: Rpc): Promise<void> {
  const problems = await genesisProblems(rpc);
  if (problems.length === 0) return;
  console.error(
    `\nThis node is not running the current genesis contracts:\n` +
    problems.map((m) => `  - ${m}`).join("\n") + "\n\n" +
    `Genesis applies only to a FRESH chain, so a persisted DB keeps the old code:\n` +
    REBUILD_HINT + "\n"
  );
  process.exit(2);
}

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

/** RSKIPINTENT activation height on regtest (must match rskipIntent in regtest.conf). */
export const ACTIVATION_HEIGHT = 40;

export async function preflight(rpc: Rpc, opts: { waitActivation?: boolean } = {}): Promise<void> {
  try {
    await rpc.blockNumber();
  } catch (e) {
    console.error(`\nCannot reach node at ${rpc.url}. Is the stack up? (docker-compose up -d)\n${(e as Error).message}`);
    process.exit(2);
  }
  // Intents are gated behind the RSKIPINTENT activation height on regtest; wait for it unless opted out.
  if (opts.waitActivation !== false) {
    await waitFor(async () => (await rpc.blockNumber().catch(() => 0)) >= ACTIVATION_HEIGHT, 120000, 1000);
  }
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
