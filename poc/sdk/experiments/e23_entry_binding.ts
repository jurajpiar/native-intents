/**
 * E23 — Entry binding: the escrowed input answers only to the intent it was deposited for (atlas B1/B2).
 *
 * The PoC models RSKIP176 semantics: depositForPegin now carries the intent commitment H (sign-first
 * ordering — in production H is folded into the derived deposit ADDRESS), and _releaseInput refuses to
 * release a bound escrow to any other intent.
 *
 *  part 1: THE SQUAT, CLOSED — an attacker signs a rival intent (dust minOut, output to itself)
 *          referencing the victim's btcTxid. Admission accepts it (the ticket is real, intents are
 *          free) — but settling it reverts "input escrow bound to another intent", unwinding the
 *          delivery atomically. The victim's own intent settles normally afterwards.
 *  part 2: THE SQUAT, DEMONSTRATED — the same play against a LEGACY (unbound, H = 0) deposit
 *          succeeds: the attacker's dust intent captures the whole input. This is the pre-fix B1
 *          theft, kept as a live demonstration of why the binding exists (and of the exposure the
 *          real-pegin path retains until RSKIP176 derivation lands).
 *  part 3: BINDING IS EXCLUSIVE — re-depositing against the same txid with a DIFFERENT H reverts;
 *          topping up with the SAME H accumulates.
 *
 * Falsifier: a bound escrow is released to a mismatched intent (the theft survives the fix), the
 * victim's own settle fails on its bound escrow, the legacy theft is blocked (hidden enforcement —
 * would mean the demonstration lies), or a bound escrow can be re-bound to another intent.
 *
 * 1 node, no bitcoind. Needs the entry-binding genesis (peginIntent): down -v + rebuild if the probe fails.
 */
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { depositForPegin, peginOf, peginIntentOf } from "../src/settlement.js";
import { Solver } from "../src/solver.js";
import { Report, preflight, requireSettlement, rpcA, waitReceipt, succeeded, reverted } from "./_harness.js";
import { COW_KEY, RBTC } from "../src/config.js";
import { Wallet, getBytes, hexlify, randomBytes } from "ethers";

const INPUT = 10_000_000_000_000_000n;   // 1e16 — the victim's escrowed input
const MINOUT = 9_000_000_000_000_000n;   // the victim's honest ask
const DUST = 1_000_000_000_000n;         // the attacker's self-serving ask (max spread bait)
const GAS_BOUND = 3_000_000_000_000n;

async function main(): Promise<number> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  try { await peginIntentOf(rpcA.url, "0x" + "0".repeat(64)); }
  catch {
    console.error(`\nSettlement predates entry binding (no peginIntent). Rebuild from the repo root:\n` +
      `  docker-compose -f poc/stack/podman-compose.yml down -v && docker-compose -f poc/stack/podman-compose.yml up -d --build\n`);
    process.exit(2);
  }
  const r = new Report("E23 entry binding",
    "a bound escrow answers only to the intent it was deposited for: the txid squat reverts on the bound path, demonstrably steals on the legacy path, and bindings cannot be reassigned");

  const solver = new Solver(rpcA.url); // cow
  const cowAddr = new Wallet(COW_KEY).address;

  /** victim + attacker intents sharing one btcTxid; deposit bound (or not) to the victim's H */
  async function stage(bound: boolean) {
    const btcTxid = getBytes(randomBytes(32));
    const victim = freshWallet();
    const H = randomH();
    if (bound) await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btcTxid), INPUT, hexlify(H)));
    else await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btcTxid), INPUT)); // legacy, H = 0
    const expiry = (await rpcA.blockNumber()) + 80;
    const intent = buildIntent(victim, { H, btcTxid, expiry, minOut: MINOUT, outputToken: RBTC });
    await rpcA.sendRaw(intent.rawHex);
    const attacker = freshWallet(); // zero balance — squatting costs the attacker literally nothing
    const rival = buildIntent(attacker, { H: randomH(), btcTxid, expiry, minOut: DUST, outputToken: RBTC });
    await rpcA.sendRaw(rival.rawHex);
    return { btcTxid, victim, H, intent, attacker, rival };
  }

  // ---- part 1: bound escrow — the squat reverts, the victim settles ----
  const p1 = await stage(true);
  r.check("p1: escrow bound to the victim's H", (await peginIntentOf(rpcA.url, hexlify(p1.btcTxid))).toLowerCase() === hexlify(p1.H).toLowerCase());
  r.check("p1: the rival intent is ADMITTED (the squat is free to attempt — admission is not the defence)", true);
  const squat = await waitReceipt(rpcA, await solver.solve(p1.rival.rawHex, DUST));
  r.check("p1: settling the rival intent REVERTS ('input escrow bound to another intent')", reverted(squat), squat ? squat.status : "no receipt");
  r.check("p1: escrow untouched by the failed squat", (await peginOf(rpcA.url, hexlify(p1.btcTxid))) === INPUT);
  r.check("p1: attacker received nothing (delivery unwound atomically)", BigInt(await rpcA.getBalance(p1.attacker.address)) === 0n);
  const cowBefore = BigInt(await rpcA.getBalance(cowAddr));
  const honest = await waitReceipt(rpcA, await solver.solve(p1.intent.rawHex, MINOUT));
  r.check("p1: the victim's own intent settles on its bound escrow", succeeded(honest), honest ? honest.status : "no receipt");
  r.check("p1: victim paid the honest ask", BigInt(await rpcA.getBalance(p1.victim.address)) === MINOUT);
  r.check("p1: solver claimed the input (bound release to the matching intent)", BigInt(await rpcA.getBalance(cowAddr)) - cowBefore > INPUT - MINOUT - GAS_BOUND);

  // ---- part 2: legacy unbound escrow — the same play STEALS (why the binding exists) ----
  const p2 = await stage(false);
  r.check("p2: legacy escrow is unbound (H = 0)", BigInt(await peginIntentOf(rpcA.url, hexlify(p2.btcTxid))) === 0n);
  const theft = await waitReceipt(rpcA, await solver.solve(p2.rival.rawHex, DUST));
  r.check("p2: the squat SUCCEEDS on the unbound escrow (the B1 theft, demonstrated)", succeeded(theft), theft ? theft.status : "no receipt");
  r.check("p2: attacker was paid from the victim's input", BigInt(await rpcA.getBalance(p2.attacker.address)) === DUST);
  r.check("p2: the victim's escrow is GONE", (await peginOf(rpcA.url, hexlify(p2.btcTxid))) === 0n);
  r.check("p2: victim's own intent is still unconsumed — solvable, but now worthless to any solver", !(await isConsumed((to, d) => rpcA.ethCall(to, d), p2.H)));

  // ---- part 3: a binding cannot be reassigned ----
  const p3btc = getBytes(randomBytes(32));
  const p3H = randomH();
  await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(p3btc), INPUT, hexlify(p3H)));
  const rebind = await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(p3btc), INPUT, hexlify(randomH())).catch(() => "0x" + "0".repeat(64)));
  r.check("p3: re-binding to a different intent rejected ('escrow bound to another intent')", rebind === null || reverted(rebind), rebind ? rebind.status : "not mined");
  r.check("p3: top-up with the SAME H accumulates", succeeded(await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(p3btc), INPUT, hexlify(p3H)))) && (await peginOf(rpcA.url, hexlify(p3btc))) === INPUT * 2n);

  console.log("\nthe input now answers to its intent, not to whoever names its txid first — the modelled");
  console.log("half of RSKIP176. The real-pegin path keeps the B1 exposure until derivation lands (E24).");
  return r.done();
}

main().then((c) => process.exit(c));
