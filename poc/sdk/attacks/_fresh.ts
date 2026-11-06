/**
 * FRESH NODES — an attack ships the chain state it needs and boots forward into it.
 *
 * Two things could not be built by any transaction, so they were untestable on a shared chain:
 *
 *   a height BELOW a fork activation   A1 needs to observe the intent type being inert before its
 *                                      consensus rule activates. You cannot get there by mining
 *                                      forward, and the shared chain is thousands of blocks past it —
 *                                      which is why that attack quietly asserted `true` and reported
 *                                      a pass for years' worth of runs without testing anything.
 *   node startup FLAGS                 A2 needs a node started with `intent.requireBtcTicket=true`.
 *                                      That is process configuration, not chain state, so no amount
 *                                      of on-chain setup reaches it — it lived as a documented
 *                                      `docker run` in a README instead of on the board.
 *
 * Both become ordinary parameters here. rskj supports everything needed without a Java change:
 *
 *   - `genesis = /config/genesis.json` in the node conf. GenesisLoaderImpl tries the classpath first
 *     and then falls back to a filesystem path, so a per-attack genesis is MOUNTED, not baked.
 *   - genesis `alloc[addr]` carries `balance`, `nonce`, and `contract: { code, data }`, where `data`
 *     is a storage map applied slot by slot. So escrows, consumed commitments, credit ledgers and
 *     standing bids can all be present at block 0, with no staging transactions at all.
 *   - `blockchain.config.consensusRules.rskipIntent = N` overlays the regtest profile, making the
 *     ACTIVATION HEIGHT a knob. That is what turns A1 from a 40-second race into a plain test.
 *
 * Why forward-from-fresh rather than snapshot-and-revert, which is cheaper: `evm_revert` is the same
 * fork-choice and state-reversion machinery that F1/F2 exist to ATTACK. Using it as test
 * infrastructure would make every "isolated" result depend on the correctness of something under
 * test. Booting a new node has no such circularity.
 *
 * Fresh nodes always mine ON DEMAND. Nothing happens unless the attack says so, which removes the
 * 40-second window A1 used to race and makes every run deterministic.
 *
 * WHAT THIS CANNOT CARRY, so expectations stay honest:
 *   - Bitcoin state. bitcoind is a separate process; exit attacks still need a matured faucet and a
 *     relayed header backlog, so they stay on a warm shared stack.
 *   - Anything at a block height above 0, since genesis IS block 0. Irrelevant now that activation
 *     is configurable, which is the only height that ever mattered.
 *   - A guarantee that shipped storage is CORRECT. A miscomputed mapping slot yields a plausible
 *     starting state and a green run — the exact failure this suite has had to kill repeatedly. So
 *     `verifyAlloc` exists, and an attack shipping state is expected to read it back through the
 *     contract's own getters before asserting anything else.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, solidityPacked } from "ethers";
import { Rpc, waitFor } from "../src/client.js";
import { ACTIVATION_HEIGHT } from "../experiments/_harness.js";
import type { StackCtx } from "./_stacks.js";

const here = dirname(fileURLToPath(import.meta.url));
const POC = join(here, "..", "..");
const REPO = join(POC, "..");
const BASE_GENESIS = join(REPO, "rskj", "rskj-core", "src", "main", "resources", "genesis", "rsk-dev.json");
const IMAGE = "rskj-intent:poc";

/** One account's initial state, in the shape rskj's genesis loader expects. */
export interface GenesisAccount {
  /** wei, decimal string (rskj parses genesis balances as decimal) */
  balance?: string;
  nonce?: string;
  contract?: {
    /** runtime bytecode, unprefixed hex. Omit to keep whatever the base genesis has. */
    code?: string;
    /** slot => value. BOTH unprefixed 64-char hex — see `slot()` and `word()`. */
    data?: Record<string, string>;
  };
}

export interface FreshSpec {
  /**
   * RSKIPINTENT activation height on this node. Default is the shared stacks' height so a fresh node
   * behaves like them unless an attack deliberately wants the pre-activation window open.
   */
  activation?: number;
  /** `-Dintent.*` flags, e.g. `{ requireBtcTicket: "true" }`. */
  opts?: Record<string, string>;
  /** genesis alloc entries merged over the compiled base genesis. */
  alloc?: Record<string, GenesisAccount>;
  /** mine this many blocks before handing the node over (default 0 — the attack decides). */
  mineTo?: number;
}

export interface FreshNode extends StackCtx {
  /** container name, for diagnostics */
  container: string;
  /** remove the container and its generated config */
  stop(): void;
}

/**
 * Storage slot of `mapping[key]` declared at slot `index`, as unprefixed 64-char hex.
 *
 * Solidity puts a mapping's value at keccak256(key ‖ slotIndex) with both padded to 32 bytes. Getting
 * this wrong is silent — you write a real slot that simply is not the one the contract reads — hence
 * `verifyAlloc`.
 */
export function slot(key: string, index: number, keyType: "bytes32" | "address" = "bytes32"): string {
  return keccak256(solidityPacked([keyType, "uint256"], [key, index])).slice(2);
}

/** A uint/bytes32 storage value as unprefixed 64-char hex. Values are Hex.decode'd, so no `0x`. */
export function word(v: bigint | number | string): string {
  const n = typeof v === "string" ? BigInt(v) : BigInt(v);
  return n.toString(16).padStart(64, "0");
}

/** The consumed set lives at `slot == H` directly (sstore(H, …)), so no mapping hashing is needed. */
export const consumedSlot = (H: string): string => H.replace(/^0x/, "").toLowerCase();

const docker = (args: string[]): string =>
  execFileSync("docker", args, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

const norm = (addr: string) => addr.replace(/^0x/, "").toLowerCase();

/** Merge an attack's alloc over the compiled base genesis, and point the node at the result. */
function composeGenesis(dir: string, alloc: Record<string, GenesisAccount> = {}): string {
  const base = JSON.parse(readFileSync(BASE_GENESIS, "utf8")) as {
    alloc: Record<string, Record<string, unknown>>;
    [k: string]: unknown;
  };
  // stateRoot in the base file (if present) describes the base alloc, so it cannot survive an edit.
  delete base.stateRoot;
  for (const [addr, acc] of Object.entries(alloc)) {
    const key = norm(addr);
    const existing = (base.alloc[key] ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...existing };
    if (acc.balance !== undefined) merged.balance = acc.balance;
    if (acc.nonce !== undefined) merged.nonce = acc.nonce;
    if (acc.contract) {
      const prev = (existing.contract ?? {}) as { code?: string; data?: Record<string, string> };
      // `code` MUST be a string, even an empty one. GenesisLoaderImpl does an unconditional
      // Hex.decode(contract.getCode()), so a contract entry without it throws while parsing genesis
      // and the node dies before it opens RPC, with almost nothing in its logs to say why. That is
      // exactly what happens when planting storage on an account that had only a balance, such as
      // the Bridge precompile, whose code does not live in genesis at all.
      merged.contract = {
        code: acc.contract.code ?? prev.code ?? "",
        data: { ...(prev.data ?? {}), ...(acc.contract.data ?? {}) },
      };
    }
    if (merged.balance === undefined) merged.balance = "0";
    base.alloc[key] = merged;
  }
  const out = join(dir, "genesis.json");
  writeFileSync(out, JSON.stringify(base, null, 2) + "\n");
  return out;
}

/**
 * A standalone on-demand-mining regtest node: no peers, RPC open, evm module on.
 *
 * Deliberately NOT a copy of node-a.conf — that file pins a static `public.ip` from the compose
 * network and a peer list, neither of which exists for a lone container.
 */
function composeConf(dir: string, activation: number): string {
  const conf = `# generated per-attack node config — do not edit, see attacks/_fresh.ts
blockchain.config {
    name = "regtest"
    consensusRules {
        # the whole point of a fresh node: the activation height is a parameter
        rskipIntent = ${activation}
    }
}
# mounted genesis: GenesisLoaderImpl falls back to a filesystem path when the classpath misses
genesis = "/config/genesis.json"
database.dir = /var/lib/rsk/db

peer {
    discovery.enabled = false
    port = 50501
    networkId = 7771
    active = []
}

# mining on demand only: blocks appear when the attack calls evm_mine, never on a timer
miner {
    server.enabled = true
    client { enabled = false, autoMine = false, delayBetweenBlocks = 0 seconds }
    minGasPrice = 0
    coinbase.secret = "regtest_fresh"
}

rpc {
    providers.web {
        http {
            enabled = true
            port = 4444
            bind_address = "0.0.0.0"
            hosts = ["localhost", "0.0.0.0"]
            cors = "*"
        }
        ws.enabled = false
    }
    modules = [
        { name = "eth",    version = "1.0", enabled = "true" },
        { name = "net",    version = "1.0", enabled = "true" },
        { name = "web3",   version = "1.0", enabled = "true" },
        { name = "txpool", version = "1.0", enabled = "true" },
        { name = "rsk",    version = "1.0", enabled = "true" },
        { name = "debug",  version = "1.0", enabled = "true" },
        { name = "evm",    version = "1.0", enabled = "true" }
    ]
}

wallet { enabled = true, accounts = [] }
`;
  const out = join(dir, "node.conf");
  writeFileSync(out, conf);
  return out;
}

export class FreshNodeUnavailable extends Error {}

/**
 * Boot a private node for one attack and hand back a context shaped like any other stack's.
 *
 * The host port is assigned by docker (`-p 0:4444`) and read back, so any number of fresh nodes can
 * exist at once without port bookkeeping — and without colliding with the 4444/4454 stacks.
 */
export async function startFresh(id: string, spec: FreshSpec = {}): Promise<FreshNode> {
  try {
    docker(["image", "inspect", IMAGE]);
  } catch {
    throw new FreshNodeUnavailable(
      `the ${IMAGE} image does not exist, and a fresh node is built from it.\n` +
      `  cd poc && npm run stack:up`);
  }

  const root = join(POC, "stack", ".fresh");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, `${id}-`));
  const container = `intent-fresh-${id}-${process.pid}`;
  const activation = spec.activation ?? ACTIVATION_HEIGHT;

  composeGenesis(dir, spec.alloc);
  composeConf(dir, activation);

  const intentOpts = Object.entries(spec.opts ?? {})
    .map(([k, v]) => `-Dintent.${k}=${v}`).join(" ");

  console.log(`\n  [fresh node] ${container} — activation at ${activation}` +
    `${intentOpts ? `, ${intentOpts}` : ""}${spec.alloc ? `, ${Object.keys(spec.alloc).length} alloc override(s)` : ""}`);

  try { docker(["rm", "-f", container]); } catch { /* not running */ }
  docker([
    "run", "-d", "--name", container,
    "-p", "0:4444",
    "-e", "RSK_CONF=/config/node.conf",
    "-e", "JVM_OPTS=-Xmx2g",
    "-e", `INTENT_OPTS=${intentOpts}`,
    "-v", `${dir}:/config:ro`,
    IMAGE,
  ]);

  const stop = () => {
    try { docker(["rm", "-f", container]); } catch { /* already gone */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  let url: string;
  try {
    // "0.0.0.0:49153" (and possibly an IPv6 line) — take the first mapping's port
    const mapped = docker(["port", container, "4444/tcp"]).split("\n")[0].trim();
    const port = mapped.slice(mapped.lastIndexOf(":") + 1);
    url = `http://localhost:${port}`;
  } catch (e) {
    stop();
    throw new FreshNodeUnavailable(`could not read ${container}'s host port: ${e instanceof Error ? e.message : String(e)}`);
  }

  const rpc = new Rpc(url);
  const ready = await waitFor(async () => {
    try { await rpc.blockNumber(); return true; } catch { return false; }
  }, 180000, 1000);
  if (!ready) {
    // Gather everything BEFORE stop(), because a removed container cannot be inspected afterwards.
    // The exit code is the useful half: "exited" means it died (genesis, config), "running" means it
    // is merely slow — two completely different places to go and look.
    const state = (() => {
      try { return docker(["inspect", "-f", "{{.State.Status}} exit={{.State.ExitCode}}", container]); }
      catch { return "(unknown)"; }
    })();
    const logs = (() => { try { return docker(["logs", "--tail", "60", container]); } catch { return "(no logs)"; } })();
    stop();
    throw new FreshNodeUnavailable(
      `${container} never answered on ${url}.\n` +
      `  container state: ${state}\n` +
      `  last logs:\n${logs.split("\n").map((l) => "    " + l).join("\n")}`);
  }
  console.log(`  [fresh node] ready on ${url} at height ${await rpc.blockNumber()}`);

  const mineOne = () => rpc.call<null>("evm_mine");
  const mine = async (n = 1) => { for (let i = 0; i < n; i++) await mineOne(); };
  const mineTo = async (target: number) => {
    for (let guard = 0; (await rpc.blockNumber()) < target; guard++) {
      if (guard > 20000) throw new Error(`mineTo(${target}) made no progress on ${url}`);
      await mineOne();
    }
  };
  if (spec.mineTo) await mineTo(spec.mineTo);

  return {
    name: "fresh" as StackCtx["name"],
    rpc,
    rpc2: rpc, // a fresh node is alone; the second handle is the same node, never a peer
    onDemand: true,
    mine,
    mineTo,
    autoMine: {
      get running() { return false; },
      start() { /* a fresh node is driven explicitly; a ticker would defeat the point */ },
      async stop() { /* nothing to stop */ },
    },
    partition() { throw new Error("a fresh node has no peer to partition from"); },
    async heal() { throw new Error("a fresh node has no peer to heal"); },
    provisioned: true,
    container,
    stop,
  };
}

/**
 * Read shipped genesis state back through the contract's own getters.
 *
 * Shipping storage directly is the one part of this that can fail SILENTLY: a miscomputed mapping slot
 * writes a real slot that simply is not the one the contract reads, and the attack then runs against a
 * starting state it only believes it has. Every such value must therefore be proved through the ABI
 * before the attack asserts anything, so a bad slot is a loud failure at step one rather than a
 * plausible green run.
 */
export async function verifyAlloc(
  expectations: { what: string; read: () => Promise<bigint | string | boolean>; want: bigint | string | boolean }[],
): Promise<string[]> {
  const bad: string[] = [];
  for (const e of expectations) {
    const got = await e.read().catch((err) => `read failed: ${err instanceof Error ? err.message : String(err)}`);
    if (got !== e.want) bad.push(`${e.what}: genesis shipped ${e.want}, the contract reads ${got}`);
  }
  return bad;
}
