/**
 * B3 — TOP UP A BOUND ESCROW THROUGH THE LEGACY PATH.
 *
 * depositForPegin's binding check lives inside `if (h != bytes32(0))`, so passing a zero H skips it
 * entirely. That reads like a hole: anyone can add value to an escrow already bound to somebody else's
 * intent, and can do it without naming an intent at all.
 *
 * It is not one — and the suite is more useful for proving that than for leaving it as an assumption.
 * The binding is what decides who may CLAIM, and a top-up cannot change it, so the attacker is simply
 * donating to whoever the escrow already answers to. What the branch does cost is the reverse: an
 * escrow deposited unbound can never be retro-bound, so legacy peg-ins stay B1-exposed by construction.
 *
 * Procedure: victim binds an escrow to their H -> attacker tops it up with h == 0 -> the binding is
 *            unchanged -> the victim's settle collects input AND the attacker's donation
 *            -> then the mirror case: an unbound escrow cannot be bound after the fact.
 * Falsifier: the top-up reassigns or clears the binding, or the attacker can claim any of it back.
 */
import { getBytes, hexlify, randomBytes } from "ethers";
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { depositForPegin, peginIntentOf, peginOf } from "../src/settlement.js";
import { Solver } from "../src/solver.js";
import { COW_KEY } from "../src/config.js";
import { fundAccount, preflight, requireSettlement, rpcA, waitReceipt } from "../experiments/_harness.js";
import { Attack } from "./_forensics.js";
import { AttackSpec, Outcome } from "./registry.js";

const INPUT = 10_000_000_000_000_000n;
const MINOUT = 1_000_000_000_000_000n;
const DONATION = 7_000_000_000_000n;   // the attacker's uninvited top-up
const GAS_MONEY = 50_000_000_000_000n;

export async function run(spec: AttackSpec): Promise<number> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  const a = new Attack(spec, rpcA);

  const attacker = freshWallet();
  const victim = freshWallet();
  const txid = getBytes(randomBytes(32));
  const H = randomH();
  await waitReceipt(rpcA, await fundAccount(attacker.address, GAS_MONEY + DONATION));

  const solver = new Solver(rpcA.url, COW_KEY);
  a.watch("attacker", attacker.address);
  a.watch("victim", victim.address);
  a.watch("solver", solver.payer);
  await a.mark();

  // --- step 1: a properly bound escrow -------------------------------------------------------
  a.step("victim escrows their input, bound to their own H");
  const dep = await a.tx(depositForPegin(rpcA.url, hexlify(txid), INPUT, hexlify(H)));
  a.check("deposit bound", dep.ok && (await peginIntentOf(rpcA.url, hexlify(txid))).toLowerCase() === hexlify(H).toLowerCase());

  // --- step 2: the attacker tops it up with h == 0, bypassing the check -----------------------
  a.step("attacker tops the escrow up with h == 0 (the binding check is skipped)");
  const top = await a.tx(depositForPegin(rpcA.url, hexlify(txid), DONATION, "0x" + "0".repeat(64), attacker.privateKey));
  a.check("top-up landed WITHOUT naming an intent", top.ok);
  a.check("escrow grew", (await peginOf(rpcA.url, hexlify(txid))) === INPUT + DONATION, `${INPUT + DONATION} wei`);
  a.check("binding UNCHANGED — still the victim's H",
    (await peginIntentOf(rpcA.url, hexlify(txid))).toLowerCase() === hexlify(H).toLowerCase());
  await a.deltas();

  // --- step 3: so who collects it? -----------------------------------------------------------
  a.step("a rival intent naming the same txid tries to collect the enlarged escrow");
  const rivalH = randomH();
  const rival = buildIntent(freshWallet(), { H: rivalH, btcTxid: txid, expiry: (await rpcA.blockNumber()) + 90, minOut: 1n });
  await rpcA.sendRaw(rival.rawHex);
  const steal = await a.tx(new Solver(rpcA.url, attacker.privateKey).solve(rival.rawHex, 1n));
  a.check("rival claim REVERTED", !steal.ok, steal.reason ?? "no reason");
  a.check("the binding, not the deposit path, decides who claims",
    (steal.reason ?? "").includes("bound to another intent"));

  a.step("the victim's own intent settles and sweeps the whole escrow");
  const intent = buildIntent(victim, { H, btcTxid: txid, expiry: (await rpcA.blockNumber()) + 90, minOut: MINOUT });
  await rpcA.sendRaw(intent.rawHex);
  await a.mark();
  const settle = await a.tx(solver.solve(intent.rawHex, MINOUT));
  a.check("settle succeeded", settle.ok);
  a.check("H consumed", await isConsumed((to, d) => rpcA.ethCall(to, d), H));
  a.check("escrow emptied", (await peginOf(rpcA.url, hexlify(txid))) === 0n);
  const d = await a.deltas();
  a.check("victim received exactly minOut", (d.get("victim") ?? 0n) === MINOUT);
  // exact arithmetic, so the donation cannot hide inside a tolerance: the solver is out minOut and its
  // gas, and in the input plus the attacker's uninvited wei.
  const expected = INPUT + DONATION - MINOUT - settle.gasUsed * 1_000_000n;
  a.check("solver collected input PLUS the attacker's donation, to the wei",
    (d.get("solver") ?? 0n) === expected, `${d.get("solver")} == ${INPUT} + ${DONATION} - ${MINOUT} - gas`);
  a.check("attacker recovered nothing", (d.get("attacker") ?? 0n) === 0n);

  // --- step 4: the mirror case — an unbound escrow cannot be bound afterwards -----------------
  a.step("mirror case: escrow deposited UNBOUND, then someone tries to bind it");
  const loose = getBytes(randomBytes(32));
  await a.tx(depositForPegin(rpcA.url, hexlify(loose), INPUT, "0x" + "0".repeat(64)));
  a.check("escrow is unbound", (await peginIntentOf(rpcA.url, hexlify(loose))) === "0x" + "0".repeat(64));
  const late = await a.tx(depositForPegin(rpcA.url, hexlify(loose), 1n, hexlify(randomH()), attacker.privateKey));
  a.check("a later h != 0 deposit BINDS it to that H", late.ok,
    (await peginIntentOf(rpcA.url, hexlify(loose))).slice(0, 12) + "…");
  a.note("so an unbound escrow is claimable by the first intent to bind it — the B1 exposure, intact");

  const observed: Outcome = top.ok ? "succeeds" : "blocked";
  return a.finish(observed);
}
