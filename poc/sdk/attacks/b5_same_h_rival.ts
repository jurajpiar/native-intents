/**
 * B5 — A RIVAL INTENT WITH THE VICTIM'S OWN H.
 *
 * B1 established that an escrow answers only to the intent it was deposited for, and tested that with
 * a rival carrying a DIFFERENT commitment. This attack asked the question B1 did not: what binds the
 * escrow to the intent's SIGNER?
 *
 * Originally, nothing did. The binding was `peginIntent[btcTxid] == H`, and H is thirty-two bytes
 * sitting in the clear in every intent in the public mempool. An attacker copied the victim's H and
 * btcTxid into an intent of their own, signed with their own key, asking for one wei. Every admission
 * rule passed — valid signature, exact layout, same processed peg-in, H not yet consumed — and
 * settlement recovered `user` from the SIGNATURE, so the attacker was paid the dust while the solver
 * took the whole escrow and consumed H. The victim's intent was then refused everywhere as consumed.
 *
 * Two things made it worse than a race. The dust twin is the MORE attractive of the two to any solver,
 * since its spread is the entire input. And the solver can simply BE the attacker: see an intent, sign
 * a dust twin, settle that — no race, no accomplice, total capture for the price of gas.
 *
 * THE FIX, which this now regression-tests: the escrow binds to `keccak256(H || signer)`, so a rival
 * with a different key computes a different binding and commands no funds. The pipeline commitment was
 * never an authenticator — settlement is outcome-based and never needs the preimage, so an opaque H is
 * as settleable as a known one; only the signature identifies who may claim.
 *
 * This was a property of the DESIGN, not of the PoC's escrow model: RSKIP-176's derivation hash is
 * built from (H, userRefundBtcAddress, lbcAddress, lpBtcAddress), none of which is the Rootstock
 * signer, so a production deposit address would have bound to H alone in exactly the same way. The
 * RSKIP now specifies keccak256(H || signer) as the derivation argument.
 *
 * Falsifier: the rival settles anyway (the binding does not include the signer after all), or the
 * VICTIM's own intent stops working (the fix broke the honest path), or the escrow moves at all.
 */
import { getBytes, hexlify, randomBytes } from "ethers";
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { bindingOf, depositForPegin, peginIntentOf, peginOf } from "../src/settlement.js";
import { Solver } from "../src/solver.js";
import { COW_KEY } from "../src/config.js";
import { preflight, requireSettlement, rpcA } from "../experiments/_harness.js";
import { waitReceipt } from "../experiments/_harness.js";
import { Attack } from "./_forensics.js";
import { AttackSpec, Outcome } from "./registry.js";

const INPUT = 10_000_000_000_000_000n;
const HONEST_MINOUT = 1_000_000_000_000_000n;
const DUST = 1n;

export async function run(spec: AttackSpec): Promise<number> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  const a = new Attack(spec, rpcA);
  const solver = new Solver(rpcA.url, COW_KEY);

  a.step("victim signs an intent and escrows a real input, bound to the intent's H");
  const victim = freshWallet();
  const attacker = freshWallet();
  const btcTxid = getBytes(randomBytes(32));
  const H = randomH();
  await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btcTxid), INPUT, bindingOf(H, victim.address)));
  const honest = buildIntent(victim, { H, btcTxid, expiry: (await rpcA.blockNumber()) + 90, minOut: HONEST_MINOUT });
  await rpcA.sendRaw(honest.rawHex);
  a.watch("victim", victim.address);
  a.watch("attacker", attacker.address);
  a.watch("solver", solver.payer);
  await a.mark();
  a.check("victim's intent is public in the mempool — and so are its H and btcTxid",
    (await rpcA.pendingTxs()).some((t) => t.hash?.toLowerCase() === honest.hash.toLowerCase()));
  a.check("escrow funded", (await peginOf(rpcA.url, hexlify(btcTxid))) === INPUT, `${INPUT} wei`);
  a.check("bound to the (H, victim) pair — not to H alone",
    (await peginIntentOf(rpcA.url, hexlify(btcTxid))).toLowerCase() === bindingOf(H, victim.address).toLowerCase(),
    `binding = keccak256(H || ${victim.address.slice(0, 10)}…)`);

  a.step("attacker copies H and btcTxid into an intent of THEIR OWN, asking for one wei");
  const rival = buildIntent(attacker, { H, btcTxid, expiry: (await rpcA.blockNumber()) + 90, minOut: DUST });
  a.check("same H, same btcTxid, different signer, dust ask",
    rival.H === honest.H && rival.sender.toLowerCase() === attacker.address.toLowerCase(),
    `H=${honest.H.slice(0, 12)}… user=${rival.sender.slice(0, 10)}…`);
  let admitted = true;
  let reason = "";
  try { await rpcA.sendRaw(rival.rawHex); } catch (e) { admitted = false; reason = e instanceof Error ? e.message : String(e); }
  a.check("the rival is ADMITTED — every admission rule passes, including the ticket", admitted, reason.slice(0, 100));
  a.check("both intents now sit in the pool sharing one H",
    (await rpcA.pendingTxs()).filter((t) => [honest.hash, rival.hash].map((h) => h.toLowerCase()).includes(t.hash?.toLowerCase() ?? "")).length === 2);

  a.step("a solver tries to settle the DUST intent — it is the more profitable of the two");
  const settled = await a.tx(solver.solve(rival.rawHex, DUST), "settle(rival)");
  a.check("settlement REFUSED", !settled.ok, settled.reason ?? "no reason");
  a.check("refused on the ESCROW BINDING, not incidentally",
    /escrow bound to another intent/.test(settled.reason ?? ""), settled.reason ?? "");
  a.check("H is untouched", !(await isConsumed((to, d) => rpcA.ethCall(to, d), H)));
  a.check("the escrow is intact", (await peginOf(rpcA.url, hexlify(btcTxid))) === INPUT);
  const d = await a.deltas();
  a.check("the attacker got nothing — its delivery unwound with the revert", (d.get("attacker") ?? 0n) === 0n, `${d.get("attacker")}`);
  a.check("the victim lost nothing", (d.get("victim") ?? 0n) === 0n, `${d.get("victim")}`);

  a.step("and the HONEST path still works — a fix that broke it would be no fix");
  const good = await a.tx(solver.solve(honest.rawHex, HONEST_MINOUT), "settle(victim's intent)");
  a.check("the victim's own intent settles", good.ok, good.reason ?? "");
  a.check("the victim was paid their signed minOut",
    ((await a.deltas()).get("victim") ?? 0n) === HONEST_MINOUT, `${HONEST_MINOUT} wei`);
  a.check("H consumed exactly once", await isConsumed((to, d) => rpcA.ethCall(to, d), H));
  a.check("the escrow released", (await peginOf(rpcA.url, hexlify(btcTxid))) === 0n);

  a.note("H is public the moment the intent is, so it was never an authenticator. The signature is what");
  a.note("identifies who may claim, and the binding now commits to it: keccak256(H || signer).");
  a.note("The same correction applies to RSKIP-176 — the derivation argument must be that pair, not H,");
  a.note("because none of its other inputs (refund address, LBC, LP) is the Rootstock signer.");

  const observed: Outcome = settled.ok ? "succeeds" : "blocked";
  return a.finish(observed);
}
