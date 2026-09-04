/**
 * B6 — THE CONSUMED SET USED TO SHARE AN ADDRESS SPACE WITH THE CONTRACT'S OWN MAPPINGS.
 *
 * CONFIRMED, THEN FIXED. This ran as a live attack first and succeeded exactly as predicted; it is
 * now the regression test for the fix. The description below is in the past tense on purpose — it
 * records what was true, because that is what the test exists to keep untrue.
 *
 * Settlement recorded a consumed intent with `assembly { sstore(H, add(number(), 1)) }` — at slot
 * number `H` itself, not at a slot derived from `H`. And `H` is thirty-two bytes the user picks, with
 * nothing anywhere checking where they came from.
 *
 * Solidity puts `someMapping[k]` at `keccak256(abi.encode(k, declarationIndex))`. That is a public
 * function of public inputs, so an attacker does not have to invert anything or search for a
 * preimage: to land on a chosen mapping entry they COMPUTE its address and sign an intent whose `H`
 * is that value. Settling then writes `block.number + 1` into a variable the contract believes only
 * it can reach.
 *
 * Settlement's declaration order fixes the targets:
 *
 *     slot 0  claimedPegin        slot 3  exitReservations
 *     slot 1  pegin               slot 4  credit
 *     slot 2  claimedBtcOut       slot 5  peginIntent
 *
 * WHAT LIMITS IT. `settle` requires `sload(H) == 0`, so only a currently-EMPTY entry can be hit. The
 * value written is `block.number + 1`, which as a quantity is negligible. The damage is entirely in
 * targets where any non-zero value is semantically meaningful — booleans, and bindings.
 *
 * `peginIntent` is the sharpest, because `depositForPegin` guards it:
 *
 *     require(peginIntent[btcTxid] == bytes32(0) || peginIntent[btcTxid] == binding,
 *             "escrow bound to another intent")
 *
 * Poison that slot and the escrow for that txid can never be funded by anyone, ever. The attacker
 * needs the victim's `btcTxid` in advance, and the design hands it to them: the txid is fixed when the
 * user signs the Bitcoin transaction, becomes public the moment it is broadcast, and registration
 * cannot happen for roughly a hundred Bitcoin confirmations afterwards. The poisoning window IS the
 * peg-in wait.
 *
 * THE FIX, WHICH THIS NOW REGRESSION-TESTS. The consumed set moved out of the settlement contract
 * entirely, to a precompile at 0x…24 that owns its own address and derives keys under a domain tag
 * (keccak256("intentConsumed-" || hex(H))). Two namespaces where there was one, so a chosen H can
 * reach nothing but the set itself.
 *
 * WHY THIS TEST CANNOT PASS VACUOUSLY. "The mappings are untouched" would also be true if the
 * attacker's settlement had quietly done nothing at all — the same phantom pass this suite keeps
 * having to kill. So the assertions come in a pair, and it is the pair that means something:
 *
 *     isConsumed(H)        MUST be true   — the marker was written, so the settle really happened
 *     legacyIsConsumed(H)  MUST be false  — and it was NOT written to the old raw-slot namespace
 *
 * `legacyIsConsumed` exists on the contract for exactly this: a deprecated reader of the retired
 * namespace, kept so the fix is demonstrable rather than merely asserted.
 *
 * Falsifier: the attacker's settlement fails (nothing was written, so nothing below is evidence —
 * reported as a skip); the marker turns up in the legacy namespace; a mapping getter changes; the
 * victim's deposit is still refused; or the reverse-direction intent is still refused as consumed.
 */
import { getBytes, hexlify, randomBytes, ZeroHash } from "ethers";
import { buildIntent, freshWallet, isConsumed } from "../src/intent.js";
import { bindingOf, claimedPeginOf, depositForPegin, legacyIsConsumedOf, peginIntentOf, peginOf } from "../src/settlement.js";
import { Solver } from "../src/solver.js";
import { COW_KEY } from "../src/config.js";
import { preflight, requireSettlement, rpcA, waitReceipt } from "../experiments/_harness.js";
import { Attack } from "./_forensics.js";
import { slot } from "./_fresh.js";
import { AttackSpec, Outcome } from "./registry.js";

/** Settlement's storage layout, by declaration order. */
const SLOT = { claimedPegin: 0, pegin: 1, claimedBtcOut: 2, exitReservations: 3, credit: 4, peginIntent: 5 };

const ESCROW = 1_000_000_000_000_000n;
const MINOUT = 1_000_000_000_000n;

export async function run(spec: AttackSpec): Promise<number> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  const a = new Attack(spec, rpcA);
  const solver = new Solver(rpcA.url, COW_KEY);

  // NOTE: the first draft read this getter through a hand-written selector, and the constant was
  // claimedBtcOut's — so the attack would have inspected the wrong mapping and reported whatever it
  // found. Read through the ABI, which compile.js keeps in step with the deployed bytecode.
  const claimedPegin = (txid: string) => claimedPeginOf(rpcA.url, txid);

  /**
   * Settle one intent whose H is `targetSlot`. The attacker is both the signing user and the solver,
   * so this costs gas and nothing else — the escrow it deposits comes straight back.
   */
  const poison = async (targetSlot: string, label: string) => {
    const user = freshWallet();
    const ownTxid = hexlify(randomBytes(32));
    const H = getBytes(targetSlot);
    await waitReceipt(rpcA, await depositForPegin(rpcA.url, ownTxid, ESCROW, bindingOf(targetSlot, user.address)));
    const intent = buildIntent(user, {
      H, btcTxid: getBytes(ownTxid), expiry: (await rpcA.blockNumber()) + 90, minOut: MINOUT,
    });
    // Offering it to the pool is cosmetic here — `settle` takes the intent as calldata and never
    // requires it to have been gossiped (E24). Tolerating a refusal keeps this attack runnable
    // whichever way the node's ticket rule is set.
    await rpcA.sendRaw(intent.rawHex).catch(() => {});
    return a.tx(solver.solve(intent.rawHex, MINOUT), label);
  };

  // ---- target 1: a boolean the contract believes only it can set ---------------------------------
  a.step("pick a victim btcTxid and confirm the contract has never seen it");
  const victimTxid = hexlify(randomBytes(32));
  a.check("claimedPegin(victimTxid) is false", !(await claimedPegin(victimTxid)), victimTxid.slice(0, 14) + "…");
  a.check("peginIntent(victimTxid) is unset", (await peginIntentOf(rpcA.url, victimTxid)) === ZeroHash);
  a.check("pegin(victimTxid) is empty", (await peginOf(rpcA.url, victimTxid)) === 0n);

  a.step("compute where claimedPegin[victimTxid] LIVES, and sign an intent whose H is that address");
  const slotClaimed = "0x" + slot(victimTxid, SLOT.claimedPegin);
  a.note(`keccak256(abi.encode(victimTxid, ${SLOT.claimedPegin})) = ${slotClaimed.slice(0, 22)}…`);
  a.note("no preimage search — the mapping's own address formula is public and takes public inputs");
  const first = await poison(slotClaimed, "settle(H = slot of claimedPegin[victimTxid])");
  if (!first.ok) {
    a.check("the attacker's own settlement succeeded", false, first.reason ?? "no reason");
    a.skip("the whole attack", "nothing was written, so the getters below prove nothing either way");
    return a.finish("blocked");
  }
  a.check("the attacker's own settlement succeeded — an ordinary, honest-looking settle", true, first.hash.slice(0, 14) + "…");

  // The pair. Either half alone would be satisfiable by a settlement that did nothing.
  a.check("the marker WAS written — isConsumed(H) is true", await isConsumed((to, d) => rpcA.ethCall(to, d), getBytes(slotClaimed)),
    "so the settle really ran, and something really was stored");
  a.check("but NOT in the old raw-slot namespace — legacyIsConsumed(H) is false",
    !(await legacyIsConsumedOf(rpcA.url, slotClaimed)), "the marker went to the precompile at 0x…24");
  a.check("and claimedPegin(victimTxid) is UNTOUCHED", !(await claimedPegin(victimTxid)),
    "a chosen H can no longer reach a declared mapping");

  // ---- target 2: the binding guard, which turns the write into a denial --------------------------
  a.step("now the same trick against peginIntent, where the write locks the escrow out permanently");
  const victim2 = hexlify(randomBytes(32));
  const slotBinding = "0x" + slot(victim2, SLOT.peginIntent);
  const second = await poison(slotBinding, "settle(H = slot of peginIntent[victim2])");
  a.check("second settlement succeeded", second.ok, second.reason ?? "");
  const poisoned = await peginIntentOf(rpcA.url, victim2);
  a.check("peginIntent(victim2) is still unset", poisoned === ZeroHash, poisoned);

  a.step("the victim funds their escrow — the honest path, with a correct binding");
  const victim = freshWallet();
  const victimH = hexlify(randomBytes(32));
  const deposit = await a.tx(
    depositForPegin(rpcA.url, victim2, ESCROW, bindingOf(victimH, victim.address)),
    "depositForPegin(victim2, honest binding)");
  a.check("the victim's deposit SUCCEEDS", deposit.ok, deposit.reason ?? "");
  a.check("and the escrow holds the input", (await peginOf(rpcA.url, victim2)) === ESCROW, `${ESCROW} wei`);

  // ---- the reverse direction: an occupied mapping slot silently consumes an H --------------------
  a.step("the same aliasing in reverse — an ordinary deposit makes an unrelated H unusable");
  const liveTxid = hexlify(randomBytes(32));
  await waitReceipt(rpcA, await depositForPegin(rpcA.url, liveTxid, ESCROW, ZeroHash));
  a.check("pegin(liveTxid) is now non-zero — an ordinary, honest deposit", (await peginOf(rpcA.url, liveTxid)) === ESCROW);
  const slotLive = "0x" + slot(liveTxid, SLOT.pegin);
  const stillborn = buildIntent(freshWallet(), {
    H: getBytes(slotLive), btcTxid: getBytes(randomBytes(32)),
    expiry: (await rpcA.blockNumber()) + 90, minOut: MINOUT,
  });
  let admitted = true;
  let why = "";
  try { await rpcA.sendRaw(stillborn.rawHex); } catch (e) { admitted = false; why = e instanceof Error ? e.message : String(e); }
  a.check("an intent with that H is ADMITTED — a live mapping entry no longer consumes an H",
    admitted, why.slice(0, 110) || "admitted");

  a.note("Before the fix, the consumed set was not in a slot — it was spread over all 2^256 of them, at");
  a.note("addresses the user chose, and every declared mapping lived in that same space. The write was");
  a.note("limited to currently-zero entries and to the value block.number+1, so the harm was in the");
  a.note("booleans and bindings rather than in amounts. peginIntent was the worst: depositForPegin");
  a.note("refuses any binding that does not match what is already stored, so one poisoned slot stranded");
  a.note("that txid's input for good — and the window was the peg-in wait itself, since the txid is");
  a.note("public on Bitcoin for ~100 confirmations before registration can happen.");
  a.note("The set now lives at the precompile 0x…24, at its own address and under a domain tag, so a");
  a.note("chosen H reaches nothing but the set. Settlement keeps legacyIsConsumed as a deprecated");
  a.note("reader of the retired namespace, which is what lets the pair of checks above be decisive.");
  a.note("STILL WORTH WRITING: the claimedBtcOut variant, where the pre-fix write made a solver's");
  a.note("already-paid bitcoin unclaimable. It needs bitcoind, and it should be run against the OLD");
  a.note("genesis to record the severity that was fixed rather than to re-prove the fix.");

  const observed: Outcome = (await claimedPegin(victimTxid)) || !deposit.ok || !admitted ? "succeeds" : "blocked";
  return a.finish(observed);
}
