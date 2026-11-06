/**
 * STACKS — let an attack declare the infrastructure it needs, and bring it up.
 *
 * Why this exists: a whole class of attack is untestable on the default stack, not because it is hard
 * to write but because the default stack mines on a timer. Anything about BLOCK CONTENTS — censorship,
 * ordering, starving a block-height window, orphaning a settled exit — needs a node that mines when
 * TOLD to. Without that, those attacks can only ever be listed as "untested", which quietly converts a
 * real gap in the analysis into a permanent one.
 *
 * The reorg stack already provides exactly that (on-demand `evm_mine`, two partitionable nodes; E16
 * uses it), but only one experiment knew how to reach it, with the ports and container names hardcoded.
 * Here a stack is DECLARED, and the runner brings up whichever one the attack asks for.
 *
 * Two things make on-demand mining usable rather than merely available:
 *
 *   autoMine   Nothing confirms unless someone mines, so every ordinary SDK call — depositForPegin,
 *              bid, fundAccount — would hang. A background ticker mines while the attack SETS UP, and
 *              is stopped only for the critical section the attack actually needs to control. Without
 *              this, every attack on this stack would have to be rewritten around manual mining.
 *   partition  stop/start a node by container name, so a tx can be given to one node and withheld from
 *              the other. This is what makes censorship observable: a censoring miner does not race a
 *              rival's transaction, it simply never has it.
 *
 * Provisioning is OPT-IN (`--provision`) and IDEMPOTENT: a stack that already answers is reused as-is
 * and never torn down, because it may be the user's own working stack with state they care about.
 * Teardown likewise happens only for a stack this process started, and only when asked — `down -v`
 * destroys volumes, which is not a thing to do to someone's node on a guess.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Rpc, waitFor, sleep } from "../src/client.js";
import { ACTIVATION_HEIGHT, REBUILD_HINT, genesisProblems } from "../experiments/_harness.js";

const here = dirname(fileURLToPath(import.meta.url));
const POC = join(here, "..", "..");

export type StackName = "default" | "reorg";

interface StackDef {
  /** compose file, relative to poc/ */
  compose: string;
  /** host RPC URLs: [primary, secondary] */
  urls: [string, string];
  /** container names, when the attack needs to stop/start them (partitioning) */
  containers: [string, string];
  /** true when blocks are produced only by evm_mine */
  onDemand: boolean;
  what: string;
}

const STACKS: Record<StackName, StackDef> = {
  default: {
    compose: "stack/podman-compose.yml",
    urls: ["http://localhost:4444", "http://localhost:4445"],
    containers: ["", ""], // compose-generated names; partitioning is not offered here
    onDemand: false,
    what: "bitcoind + two timer-mining rskj nodes (the everyday stack)",
  },
  reorg: {
    compose: "stack/docker-compose.reorg.yml",
    urls: ["http://localhost:4454", "http://localhost:4455"],
    containers: ["rskj-a-reorg", "rskj-b-reorg"],
    onDemand: true,
    what: "two on-demand-mining rskj nodes, partitionable by name (no bitcoind)",
  },
};

/** A ticker that mines while ordinary SDK calls are in flight, and can be paused for the real test. */
export interface AutoMine {
  start(everyMs?: number): void;
  stop(): Promise<void>;
  readonly running: boolean;
}

export interface StackCtx {
  /** "fresh" is an ephemeral single node built per attack — see ./_fresh.ts. */
  name: StackName | "fresh";
  /** primary node — pass this to `new Attack(spec, ctx.rpc)` and to anything taking a url */
  rpc: Rpc;
  /** the second node: the rival miner, or the far side of a partition */
  rpc2: Rpc;
  onDemand: boolean;
  /** mine exactly n blocks on a node (on-demand stacks only) */
  mine(n?: number, on?: Rpc): Promise<void>;
  /** advance a node to at least `target` height */
  mineTo(target: number, on?: Rpc): Promise<void>;
  autoMine: AutoMine;
  /** cut a node off from its peer (container stop). Throws on stacks with no named containers. */
  partition(which: 0 | 1): void;
  /** bring it back and wait for its RPC */
  heal(which: 0 | 1): Promise<void>;
  /** true when this process brought the stack up (and so may tear it down) */
  provisioned: boolean;
}

/**
 * Every StackCtx handed out, so the runner can shut their tickers down at the end.
 *
 * autoMine is a setInterval, and a setInterval HOLDS THE NODE EVENT LOOP OPEN. The runner finishes
 * with `process.exitCode = c` rather than `process.exit(c)` — deliberately, so a summary being piped
 * somewhere is not truncated — which means a single live timer leaves the process hanging after the
 * board has printed. Two independent guards: unref() below, and this list.
 */
const live: StackCtx[] = [];

/** Stop every mining ticker this process started. Safe to call more than once. */
export async function disposeStacks(): Promise<void> {
  for (const c of live) await c.autoMine.stop();
  live.length = 0;
}

const compose = (() => {
  const tries: [string, string[]][] = [
    ["docker", ["compose"]], ["docker-compose", []], ["podman-compose", []],
  ];
  let found: [string, string[]] | null = null;
  return (): [string, string[]] => {
    if (found) return found;
    for (const [bin, pre] of tries) {
      try {
        execFileSync(bin, [...pre, "version"], { stdio: "ignore" });
        found = [bin, pre];
        return found;
      } catch { /* try the next */ }
    }
    throw new Error("no compose CLI found (tried: docker compose, docker-compose, podman-compose)");
  };
})();

const dockerCli = (args: string[]): string =>
  execFileSync("docker", args, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

const alive = async (rpc: Rpc): Promise<boolean> => {
  try { await rpc.blockNumber(); return true; } catch { return false; }
};

export class StackUnavailable extends Error {
  constructor(readonly stack: StackName | "fresh", readonly hint: string) {
    super(`stack "${stack}" is not up — ${hint}`);
  }
}

/**
 * Make the named stack available, or throw StackUnavailable with the command that would fix it.
 * `provision` is the caller's decision (the runner's --provision), never assumed: starting containers
 * is a side effect on the user's machine.
 */
export async function ensureStack(name: StackName, opts: { provision?: boolean } = {}): Promise<StackCtx> {
  const def = STACKS[name];
  const rpc = new Rpc(def.urls[0]);
  const rpc2 = new Rpc(def.urls[1]);
  let provisioned = false;

  if (!(await alive(rpc))) {
    if (!opts.provision) {
      const byHand = name === "reorg" ? "npm run stack:reorg:up" : "npm run stack:up";
      throw new StackUnavailable(name,
        `${def.what}.\n` +
        `  bring it up yourself:     cd poc && ${byHand}\n` +
        `  or let the runner do it:  cd poc && npm run attacks -- ${name === "default" ? "" : "--provision "}<ids>`);
    }
    const [bin, pre] = compose();
    console.log(`\n  provisioning the "${name}" stack — ${def.what}`);
    console.log(`  ${bin} ${[...pre, "-f", def.compose, "up", "-d"].join(" ")}`);
    try {
      execFileSync(bin, [...pre, "-f", def.compose, "up", "-d"], { cwd: POC, stdio: "inherit" });
    } catch (e) {
      throw new StackUnavailable(name, `compose failed: ${e instanceof Error ? e.message : String(e)}\n` +
        `  the reorg stack reuses the image built by the main stack — build it once with:\n` +
        `    cd poc && npm run stack:up`);
    }
    provisioned = true;
    console.log(`  waiting for both nodes' RPC…`);
    for (const [i, r] of [rpc, rpc2].entries()) {
      if (!(await waitFor(() => alive(r), 180000, 2000))) {
        throw new StackUnavailable(name, `node ${i === 0 ? "A" : "B"} at ${r.url} never answered (JVM boot can take a while; check the container logs)`);
      }
    }
  }

  const ctx = makeCtx(name, def, rpc, rpc2, provisioned);

  // Genesis check AFTER readiness: the contracts are baked into the image, so wrong or missing
  // bytecode means a persisted DB from an older build, not a wrong stack.
  await requireCurrentGenesis(ctx);

  // On-demand stacks start at height 0 and the intent rules are gated on a fork height, so nothing
  // works until someone mines past it. Doing it here means an attack never has to think about it.
  if (def.onDemand) {
    const h = await rpc.blockNumber();
    if (h < ACTIVATION_HEIGHT) {
      console.log(`  mining to the RSKIPINTENT activation height (${h} -> ${ACTIVATION_HEIGHT})`);
      await ctx.mineTo(ACTIVATION_HEIGHT);
    }
  }
  return ctx;
}

function makeCtx(name: StackName, def: StackDef, rpc: Rpc, rpc2: Rpc, provisioned: boolean): StackCtx {
  const mineOne = (on: Rpc) => on.call<null>("evm_mine");

  const mine = async (n = 1, on: Rpc = rpc) => {
    if (!def.onDemand) throw new Error(`stack "${name}" mines on a timer — mine() is meaningless here`);
    for (let i = 0; i < n; i++) await mineOne(on);
  };
  const mineTo = async (target: number, on: Rpc = rpc) => {
    if (!def.onDemand) { await waitFor(async () => (await on.blockNumber()) >= target, 240000, 1000); return; }
    // Bounded: a node that has stopped accepting evm_mine must fail loudly, not spin.
    for (let guard = 0; (await on.blockNumber()) < target; guard++) {
      if (guard > 5000) throw new Error(`mineTo(${target}) on ${on.url} made no progress`);
      await mineOne(on);
    }
  };

  let timer: NodeJS.Timeout | null = null;
  const autoMine: AutoMine = {
    get running() { return timer !== null; },
    start(everyMs = 400) {
      if (!def.onDemand || timer) return;
      // Errors are swallowed deliberately: the ticker keeps running across a partition, where the
      // stopped node's RPC is gone by design. A throw here would kill the attack for a normal event.
      timer = setInterval(() => { void mineOne(rpc).catch(() => {}); }, everyMs);
      // unref: mine while the process has real work, but never be the reason it stays alive. Without
      // this, an attack that leaves the ticker running hangs the whole board after its last line.
      timer.unref?.();
    },
    async stop() {
      if (timer) { clearInterval(timer); timer = null; await sleep(50); }
    },
  };

  const partition = (which: 0 | 1) => {
    const c = def.containers[which];
    if (!c) throw new Error(`stack "${name}" has no named containers — partitioning needs the reorg stack`);
    dockerCli(["stop", c]);
  };
  const heal = async (which: 0 | 1) => {
    const c = def.containers[which];
    if (!c) throw new Error(`stack "${name}" has no named containers`);
    dockerCli(["start", c]);
    const r = which === 0 ? rpc : rpc2;
    if (!(await waitFor(() => alive(r), 180000, 2000))) throw new Error(`${c} did not come back`);
  };

  const ctx: StackCtx = { name, rpc, rpc2, onDemand: def.onDemand, mine, mineTo, autoMine, partition, heal, provisioned };
  live.push(ctx);
  return ctx;
}

/**
 * Refuse to run against a node whose genesis contracts are not the ones just compiled.
 *
 * Delegates the comparison to the harness so the experiments and the attack board cannot drift apart
 * on what "current" means; only the failure behaviour differs (experiments exit 2, attacks throw so
 * the runner can class it as an ENVIRONMENT result rather than a broken attack).
 */
export async function requireCurrentGenesis(ctx: StackCtx): Promise<void> {
  const problems = await genesisProblems(ctx.rpc);
  if (!problems.length) return;
  throw new StackUnavailable(ctx.name,
    `the "${ctx.name}" stack is not running the current contracts:\n` +
    problems.map((m) => `    - ${m}`).join("\n") + "\n" +
    `  Genesis applies only to a FRESH chain, and each stack keeps its OWN volumes:\n` +
    REBUILD_HINT);
}

/** Tear down a stack this process started. Never called for one that was already up. */
export function teardown(name: StackName): void {
  const def = STACKS[name];
  const [bin, pre] = compose();
  console.log(`\n  tearing down the "${name}" stack it provisioned (down -v)`);
  try { execFileSync(bin, [...pre, "-f", def.compose, "down", "-v"], { cwd: POC, stdio: "inherit" }); }
  catch (e) { console.error(`  teardown failed: ${e instanceof Error ? e.message : String(e)}`); }
}

export const stackWhat = (name: StackName | "fresh"): string =>
  name === "fresh" ? "an ephemeral single node built for this attack alone" : STACKS[name].what;
