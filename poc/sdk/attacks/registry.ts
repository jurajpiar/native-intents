/**
 * The attack registry — the single source of truth for what has been attacked, what defends it, and
 * what has NOT been attacked yet.
 *
 * The experiments in ../experiments/ are organised by the order they were invented (E1…E23). That is
 * the wrong axis for red-teaming: it tells you nothing about which part of the surface is covered.
 * Here every attack is filed under the surface it targets, carries the defence that stops it (as a
 * file:line you can go read), and — crucially — declares its EXPECTED outcome up front. A run that
 * agrees with the registry is a pass; a run that disagrees is the finding.
 *
 * `expected: "untested"` entries are deliberate: an attack surface with no attack written against it
 * should be VISIBLE in the menu, not absent from it.
 */

import type { StackCtx, StackName } from "./_stacks.js";

export type ThreatClass = "A" | "B" | "C" | "D" | "E" | "F" | "M";

export const CLASSES: Record<ThreatClass, string> = {
  A: "admission / consensus (pre-inclusion)",
  B: "entry escrow (peg-in side)",
  C: "settlement atomicity",
  D: "auction / exclusivity",
  E: "exit (BTC-out)",
  F: "reorg / liveness",
  M: "miner / block producer (ordering, censorship, reorg as strategy)",
};

/** What the attacker achieves. `contained` = it lands but the damage stays with the attacker. */
export type Outcome = "blocked" | "contained" | "succeeds";
export type Expected = Outcome | "untested";

/**
 * How an outcome is PRINTED. The keys above are terse because they are code; on a report they were
 * ambiguous in the worst possible way — a bare "succeeds" reads equally as "the attack succeeded" and
 * "the defence successfully stopped it", which are opposite findings. Every label therefore names its
 * SUBJECT, so no line can be read backwards:
 *
 *   blocked    -> "attack BLOCKED"    the attack could not land at all
 *   contained  -> "harm CONTAINED"    it landed, and the damage stayed with the attacker
 *   succeeds   -> "ATTACK WORKS"      it landed and cost someone else something
 *
 * "ATTACK WORKS" is deliberately the loudest of the three: it is the only one that describes the
 * system doing something it should not.
 */
export const OUTCOME_LABEL: Record<Expected, string> = {
  blocked: "attack BLOCKED",
  contained: "harm CONTAINED",
  succeeds: "ATTACK WORKS",
  untested: "UNTESTED",
};

/** Sentence form, for a run's closing RESULT line. */
export const OUTCOME_SENTENCE: Record<Outcome, string> = {
  blocked: "the ATTACK WAS BLOCKED",
  contained: "the attack LANDED but the HARM WAS CONTAINED",
  succeeds: "the ATTACK WORKED",
};

export type Impl =
  /** Written against the forensics harness: full step / revert-reason / balance-delta reporting. */
  | { kind: "native"; load: () => Promise<{ run: (spec: AttackSpec, ctx: StackCtx) => Promise<number> }> }
  /** An existing experiment that already performs this attack; the runner shells out and streams it. */
  | { kind: "wrapped"; script: string }
  /** No attack written yet. Listed so the gap is visible rather than silently absent. */
  | { kind: "untested"; why: string };

export interface AttackSpec {
  /** menu selector, lowercase: class letter + index. */
  id: string;
  cls: ThreatClass;
  name: string;
  /** what the attack points at — contract function or consensus rule, with a line where useful. */
  target: string;
  /** the attacker's theory of the case, in one sentence. */
  premise: string;
  expected: Expected;
  /** why that outcome is expected (shown next to it). */
  expectedWhy?: string;
  /** the code that stops it, or an honest "none". */
  defence: string;
  /** what it would cost if the defence were absent. */
  severity: string;
  /** environment the run needs. */
  needs: string;
  /**
   * The infrastructure the attack runs against. Omitted means "default" — the everyday stack.
   * An attack about BLOCK CONTENTS (ordering, censorship, a block-height window, a deliberate reorg)
   * cannot be expressed on a stack that mines on a timer, so it names one that mines on demand and the
   * runner brings that up for it (see ./_stacks.ts). Declaring this is what stops "needs another
   * stack" from being a permanent excuse for leaving a surface unexercised.
   */
  stack?: StackName;
  /**
   * Set when the attack cannot run on the default stack, with the reason. Full-board runs SKIP these
   * rather than reporting a guaranteed failure as a finding (../experiments/run_all.ts excludes E8 for
   * exactly this reason); `--id=<id>` still runs it.
   */
  notInAll?: string;
  /** printed after the verdict — the one-line takeaway. */
  conclusion?: string;
  /** printed as FINDING(S) when the attack teaches something the docs get wrong or omit. */
  finding?: string | string[];
  impl: Impl;
}

export const ATTACKS: AttackSpec[] = [
  // ---------------------------------------------------------------- A · admission / consensus
  {
    id: "a1", cls: "A", name: "submit an intent before activation",
    target: "rskj IntentAdmission — RSKIPINTENT consensus gate",
    premise: "the intent tx type is parseable by the node before the fork activates, so send it early",
    expected: "blocked", expectedWhy: "activation is a consensus rule, not a policy flag",
    defence: "rskj-patch IntentAdmission + regtest.conf rskipIntent height",
    severity: "a pre-fork intent in a block splits consensus",
    needs: "1 node, run right after `up`",
    impl: { kind: "wrapped", script: "e13_activation_gate.ts" },
  },
  {
    id: "a2", cls: "A", name: "flood the mempool with free intents",
    target: "rskj IntentAdmission — anti-spam ticket",
    premise: "intents are payer-less and gasPrice 0, so N of them from N fresh keys cost the attacker nothing",
    expected: "blocked", expectedWhy: "admission demands a confirmed BTC peg-in ticket",
    defence: "intent.requireBtcTicket=true (Bridge processed-height check at admission)",
    severity: "free unbounded mempool growth — the core DoS objection to payer-less txs",
    needs: "1 node, ticket **on**",
    notInAll: "the default stack pins requireBtcTicket=false (podman-compose.yml:43,59), so the intent is " +
      "admitted by design. Verified PASSING against a throwaway ticket-on node: `docker run --rm -d " +
      "--name rskj-ticket -p 4464:4444 -e RSK_CONF=/config/node-a.conf -e JVM_OPTS=-Xmx2g " +
      "-e INTENT_OPTS=\"-Dintent.requireBtcTicket=true -Dintent.maxExpirySpan=100\" " +
      "-v \"$PWD/stack/config:/config:ro\" rskj-intent:poc`, then " +
      "`RPC_A=http://localhost:4464 INTENT_REQUIRE_TICKET=true npm run attack -- --id=a2`. " +
      "Rejected with \"BTC ticket not visible in Bridge SPV view\". Needs no bitcoind and leaves a " +
      "populated stack alone",
    impl: { kind: "wrapped", script: "e8_spam_without_ticket.ts" },
  },
  {
    id: "a3", cls: "A", name: "admit an already-expired intent",
    target: "rskj IntentAdmission — expiry check",
    premise: "an expired intent that still gets admitted leaves junk in the pool for free",
    expected: "blocked", expectedWhy: "expiry is checked at admission, before the pool",
    defence: "IntentAdmission expiry rule (E2 asserts nothing lands on chain)",
    severity: "free pool pollution with intents nobody can ever settle",
    needs: "1 node",
    impl: { kind: "wrapped", script: "e2_expiry_costs_nothing.ts" },
  },
  {
    id: "a4", cls: "A", name: "race the expiry boundary",
    target: "IntentAdmission expiry vs Settlement.settle (:150)",
    premise: "an intent admitted at expiry-1 and mined at expiry passes admission but fails settlement — burning the solver's gas and its delivered output's approval",
    expected: "untested",
    defence: "settle re-checks `block.number < expiry`; whether the two checks can disagree is unmeasured",
    severity: "solvers griefed into gas loss on intents that were valid when they committed",
    needs: "1 node",
    impl: { kind: "untested", why: "needs a settle submitted at exactly expiry-1 with deterministic block timing" },
  },
  {
    id: "a5", cls: "A", name: "malformed intent payload",
    target: "parse precompile 0x…20 / Settlement.settle (:144)",
    premise: "a truncated or over-long data field might parse to garbage rather than reverting",
    expected: "blocked", expectedWhy: "IntentAdmission checks the 160-byte length before slicing, so a bad payload is declined rather than fatal",
    defence: "`require(ok && ret.length == 192)` — but the precompile's own behaviour on short input is unprobed",
    severity: "a parse that returns attacker-chosen fields would forge user/minOut",
    needs: "1 node",
    impl: { kind: "native", load: () => import("./a5_malformed_payload.js") },
  },

  // ---------------------------------------------------------------- B · entry escrow (peg-in side)
  {
    id: "b1", cls: "B", name: "txid squatting (steal a peg-in escrow)",
    target: "Settlement._releaseInput (:358)",
    premise: "name the victim's btcTxid in a dust-minOut intent of your own and claim their escrowed input",
    expected: "blocked", expectedWhy: "the escrow is bound to the intent it was deposited for",
    defence: "Settlement.peginIntent binding (:113) — the PoC model of RSKIP176 entry binding",
    severity: "direct theft of the user's entire pegged-in input",
    needs: "1 node, entry-binding genesis",
    conclusion: "E23 also keeps the pre-fix theft reproducible against a legacy UNBOUND escrow, as evidence.",
    impl: { kind: "wrapped", script: "e23_entry_binding.ts" },
  },
  {
    id: "b2", cls: "B", name: "binding front-run",
    target: "Settlement.depositForPegin (:121)",
    premise: "depositForPegin is permissionless, so bind the victim's btcTxid to an H you control for 1 wei — their own deposit then reverts and their intent becomes unservable",
    expected: "succeeds", expectedWhy: "a PoC-model artefact of a permissionless deposit call",
    defence: "none in the PoC. In production the binding is not a call argument — RSKIP176 derives the deposit ADDRESS from H, so only the matching intent's peg-in can land there.",
    severity: "denial of entry: a 1-wei tx makes a user's peg-in unescrowable and their intent worthless to solvers",
    needs: "1 node",
    conclusion: "the exposure is in the PoC's escrow MODEL, not in the design — but it is the model every other B-class experiment runs on.",
    finding: "b1's binding fix closes theft and opens denial: whoever binds first owns the txid. Production must derive the binding, never accept it as an argument.",
    impl: { kind: "native", load: () => import("./b2_binding_frontrun.js") },
  },
  {
    id: "b3", cls: "B", name: "top-up a bound escrow via the legacy path",
    target: "Settlement.depositForPegin (:122) — the `h != 0` guard",
    premise: "passing h == 0 skips the binding check entirely, so top up an escrow already bound to somebody else",
    expected: "succeeds", expectedWhy: "the guard is inside `if (h != 0)`; the legacy path never reads peginIntent",
    defence: "none — and none needed, see the finding",
    severity: "none: the top-up is claimable only by the bound intent, so the attacker is donating",
    needs: "1 node",
    conclusion: "verified benign. Worth keeping in the suite precisely because it LOOKS exploitable.",
    finding: "the h==0 branch cannot be turned against the bound holder, but it does mean a legacy escrow can never be retro-bound: unbound peg-ins stay B1-exposed by construction, exactly as _releaseInput's comment admits.",
    impl: { kind: "native", load: () => import("./b3_unbound_topup.js") },
  },
  {
    id: "b4", cls: "B", name: "squat a REAL peg-in credit",
    target: "Settlement._releaseInput real-pegin branch (:343)",
    premise: "the Bridge's peg-in record carries no H, so the b1 theft should still work against a genuine peg-in",
    expected: "untested",
    defence: "none by construction — the OP_RETURN has no room for H; RSKIP176 derivation is the production answer",
    severity: "theft of a real pegged-in input (the b1 severity, on the path that actually matters)",
    needs: "1 node + bitcoind; relays headers",
    impl: { kind: "untested", why: "needs E14's real-peg-in driver re-run with a rival intent naming the same txid" },
  },

  // ---------------------------------------------------------------- C · settlement atomicity
  {
    id: "c1", cls: "C", name: "consume H without delivering",
    target: "Settlement.settle (:169)",
    premise: "burn the intent's H while paying the user nothing, so no honest solver can serve it",
    expected: "blocked", expectedWhy: "consumption and delivery are the same transaction",
    defence: "Settlement.settle minOut check + atomic revert (:169-171)",
    severity: "griefing every intent to death for the price of gas (the m1 hole)",
    needs: "1 node",
    impl: { kind: "wrapped", script: "e6_consume_griefing.ts" },
  },
  {
    id: "c2", cls: "C", name: "replay a settled intent",
    target: "Settlement consumed set (:160)",
    premise: "re-submit the same signed intent after it settled and get paid the input twice",
    expected: "blocked", expectedWhy: "H is stored consumed before any interaction",
    defence: "sstore(H) effects-first (:164) + admission-side consumed check",
    severity: "double release of the input escrow",
    needs: "1 node",
    impl: { kind: "wrapped", script: "e3_replay_after_consume.ts" },
  },
  {
    id: "c3", cls: "C", name: "under-deliver and keep the input",
    target: "Settlement.settle (:169-176)",
    premise: "deliver less than minOut but still claim the escrowed input",
    expected: "blocked", expectedWhy: "delivery is asserted before the input is released",
    defence: "settle's minOut require + _releaseInput ordering",
    severity: "the solver keeps the spread AND the shortfall",
    needs: "1 node",
    impl: { kind: "wrapped", script: "e7_atomic_settlement.ts" },
  },
  {
    id: "c4", cls: "C", name: "fail invisibly",
    target: "Settlement.settle — VM revert visibility",
    premise: "a failing settle that reports success (the m2 precompile behaviour) hides griefing from everyone watching receipts",
    expected: "blocked", expectedWhy: "settlement is a VM contract, so failure is status 0x0",
    defence: "m3 moved settlement into the VM (Settlement.sol)",
    severity: "silent failures — no monitoring can distinguish a grief from a fill",
    needs: "1 node",
    impl: { kind: "wrapped", script: "e11_visible_revert.ts" },
  },
  {
    id: "c5", cls: "C", name: "reenter settle from a payee's callback",
    target: "Settlement._pay (:104) and withdraw (:116) — the two places a contract payee gets control",
    premise: "settle pushes to msg.sender twice (excess refund, input release), so a contract solver's receive() runs mid-settlement and can call straight back in",
    expected: "blocked",
    expectedWhy: "two independent defences: the settle-path pushes are capped at 30,000 gas so a callback cannot run at all, and effects-first ordering (sstore(H) before any external call) makes a same-H reentry from the UNCAPPED withdraw() meet a consumed H",
    defence: "PUSH_GAS = 30_000 on _pay (:104) closes the settle path; sstore(H) at :164 closes the withdraw path",
    severity: "double release of a second escrow inside one transaction",
    needs: "1 node, hardened genesis",
    conclusion: "the reachable surface is not where it looks. settle's callbacks are gas-capped below a single SSTORE, so a contract solver executes no code there; withdraw() is uncapped by necessity and is the real surface, where ordering rather than a guard is what refuses the reentry. A nested settle of a DIFFERENT intent stays permitted, which is correct — a blanket reentrancy guard would break nesting for no gain.",
    finding: "the F1-F4 pull-payment cap closed a reentrancy surface it was not written for. PUSH_GAS = 30_000 was added so an unpayable payee could not revert a settlement; because 30,000 gas does not cover one SSTORE (20,000) plus the cold SLOADs before it, it also means a contract solver's receive() cannot execute ANY logic on the settle path — it runs out of gas and the payout falls back to credit. The first version of this attack aimed at that surface and reported a deviation precisely because the callback never fired.",
    impl: { kind: "native", load: () => import("./c5_reenter_settle.js") },
  },
  {
    id: "c6", cls: "C", name: "reenter withdraw() to drain the credit ledger",
    target: "Settlement.withdraw (:98)",
    premise: "re-enter withdraw during its push and collect the same credit twice",
    expected: "blocked", expectedWhy: "both credit ledgers zero the balance before transferring, so a nested withdraw finds nothing",
    defence: "credit zeroed before the call (:101) — effects-first, so a reentry sees 0 and reverts",
    severity: "drain of the whole pull-payment ledger",
    needs: "1 node, new attacker contract",
    impl: { kind: "native", load: () => import("./c6_reenter_withdraw.js") },
  },
  {
    id: "c7", cls: "C", name: "misbehaving ERC-20 output",
    target: "Settlement.settle token branch (:176)",
    premise: "a fee-on-transfer or silently-failing token means the user receives less than minOut while H is consumed",
    expected: "succeeds", expectedWhy: "settle checks transferFrom's RETURN VALUE, not a balance delta — a short or lying token under-delivers, and the loss lands on the user who chose it",
    defence: "`require(transferFrom(...))` catches a false return, but NOT a token that transfers less than it reports",
    severity: "the user is short-changed on every token intent using such a token",
    needs: "1 node, new token contract",
    impl: { kind: "native", load: () => import("./c7_bad_token_output.js") },
  },

  // ---------------------------------------------------------------- D · auction / exclusivity
  {
    id: "d1", cls: "D", name: "bypass an open auction at minOut",
    target: "Settlement.settle auction lock (:152-156)",
    premise: "settle directly at minOut while an auction holds bids above it, pocketing the difference",
    expected: "blocked", expectedWhy: "settlement consults the genesis auction's lock",
    defence: "Settlement's lockedUntil check against auction 0x…22",
    severity: "the user loses the entire auction premium on every intent",
    needs: "1 node, E17b genesis",
    conclusion: "E17 keeps the UNENFORCED case reproducible next to it, so the difference is visible.",
    impl: { kind: "wrapped", script: "e17b_enforced_auction.ts" },
  },
  {
    id: "d2", cls: "D", name: "brick an intent with an unpayable winning bid",
    target: "Auction.execute — winner payout",
    premise: "win with a contract that rejects RBTC, so execute can never complete and the intent is frozen until expiry",
    expected: "contained", expectedWhy: "the payout downgrades to a withdrawable credit",
    defence: "pull-payment fallback (Settlement._pay / auction credit ledger)",
    severity: "any intent can be frozen for the price of one bid",
    needs: "1 node, hardened genesis",
    impl: { kind: "wrapped", script: "e18_failure_containment.ts" },
  },
  {
    id: "d3", cls: "D", name: "block higher bids with a poisoned token refund",
    target: "Auction.placeBidToken — outbid refund",
    premise: "bid with a token whose transfers you can switch off, so refunding you reverts and no higher bid can land",
    expected: "contained", expectedWhy: "the refund downgrades to creditToken, recoverable via withdrawToken",
    defence: "auction token credit ledger (E21 part 3)",
    severity: "lock the auction at the attacker's own bid",
    needs: "1 node, credit-ledger genesis",
    impl: { kind: "wrapped", script: "e21_credit_claims.ts" },
  },
  {
    id: "d4", cls: "D", name: "front-run the closing bid / ride the decay boundary",
    target: "Auction lockedUntil + GRACE decay",
    premise: "bid in the window's last block, or settle directly one block before the decay opens",
    expected: "untested",
    defence: "E18 proves the lock decays AFTER grace and not inside it; the exact boundary block is not attacked",
    severity: "off-by-one either strands the intent or reopens it a block early at minOut",
    needs: "1 node, hardened genesis",
    impl: { kind: "untested", why: "needs block-exact submission at lockedUntil+GRACE and ±1" },
  },

  // ---------------------------------------------------------------- E · exit (BTC-out)
  {
    id: "e1", cls: "E", name: "settle an exit by paying the wrong BTC address",
    target: "Settlement._checkBtcOutIntent (:310)",
    premise: "prove a real, confirmed BTC payment — to an address you control rather than the user's",
    expected: "blocked", expectedWhy: "H commits to the destination hash160",
    defence: "H == keccak256(\"BTCOUT\" || dest20 || salt) (:310)",
    severity: "the solver claims the input having paid itself — total loss for the user",
    needs: "1 node + bitcoind, E19 genesis",
    impl: { kind: "wrapped", script: "e19_btc_exit.ts" },
  },
  {
    id: "e2", cls: "E", name: "poach a reserved exit with a valid proof",
    target: "Settlement.settleBtcOut reservation gate (:277)",
    premise: "another solver's payout is public on Bitcoin — copy its proof and claim the input first",
    expected: "blocked", expectedWhy: "a live reservation is exclusive to its reserver",
    defence: "reservation gate (:275-278)",
    severity: "the paying solver loses real, irreversible BTC to a proof thief",
    needs: "1 node + bitcoind, E19 genesis",
    impl: { kind: "wrapped", script: "e19_btc_exit.ts" },
  },
  {
    id: "e3", cls: "E", name: "replay one BTC payout across several exits",
    target: "Settlement._findPayment claimed-set (:388) / claimedBtcOut key (:337)",
    premise: "one confirmed payout transaction, several exit intents committing the same destination — settle them all off a single payment",
    expected: "contained", expectedWhy: "the claimed set is keyed per OUTPUT, so one output settles exactly one intent",
    defence: "claimedBtcOut[keccak256(payTxid, voutIdx)] (:337), checked inside the output scan (:388)",
    severity: "the solver claims N escrows for one payment — theft of N-1 users' inputs",
    needs: "1 node + bitcoind, E19 genesis",
    conclusion: "E19 already replays a single-output payout; this probes the multi-output case the key was designed for.",
    impl: { kind: "native", load: () => import("./e3_payout_replay.js") },
  },
  {
    id: "e4", cls: "E", name: "squat an exit to death",
    target: "Settlement.reserveExit / forfeitExpiredExitBond (:241)",
    premise: "reserve an exit and never pay, repeatedly, so the intent expires with the user unpaid and your bond stranded",
    expected: "blocked", expectedWhy: "an expired-while-reserved bond is forfeited to the user by anyone",
    defence: "forfeitExpiredExitBond (:241) + the window-outlives-intent check (:221)",
    severity: "free denial of every exit intent (pre-fix the bond stranded forever)",
    needs: "1 node, forfeit genesis; ~45-block wait",
    impl: { kind: "wrapped", script: "e22_exit_bond_expiry.ts" },
  },
  {
    id: "e5", cls: "E", name: "abuse the payout parser",
    target: "Settlement._findPayment / _varint (:367-405)",
    premise: "the payout parser is hand-rolled Solidity over attacker-supplied bytes — feed it serialisations it was not written for",
    expected: "contained", expectedWhy: "calldata indexing is bounds-checked, so a malformed tx reverts rather than mis-parsing",
    defence: "the segwit guard (:370), calldata bounds checks, and _varint's 0xfe/0xff revert (:403)",
    severity: "a mis-parse that reads an attacker-chosen value or destination forges a payout that never happened",
    needs: "1 node + bitcoind, E19 genesis; relays headers",
    finding: ["the segwit guard at :370 is DEAD CODE, and \"legacy payout transactions only\" is wrong twice over. A real witness serialisation never reaches the guard — _checkAndClaimBtcPayment hashes it first, and sha256d of witness bytes is the wtxid, so the Bridge rejects it as unconfirmed. Strip the witness and the same payout settles normally, because the stripped bytes ARE the txid the merkle proof commits to. Segwit solvers are not locked out; they just have to strip before they call, and nothing documents that.",
      "_findPayment's output scan WAS O(outputs), unbounded, and paid for by the SETTLER: a 254-output payout with the payment last exhausted the 1,500,000 gas limit every SDK caller sends, and the safe batch size was written down nowhere. FIXED alongside the E8 settler commitment: MAX_PAYOUT_OUTPUTS bounds the scan, so an over-wide payout is refused cheaply and by name, and the batch ceiling is now a named constant a solver can read.",
      "the parser did not mis-parse once: Solidity 0.8 bounds-checks calldata indexing and slicing, so every malformed shape reverted with a named reason rather than reading past its buffer. The hand-rolled parse is sound; its restrictions are just mis-documented."],
    impl: { kind: "native", load: () => import("./e5_payout_parser.js") },
  },
  {
    id: "e8", cls: "E", name: "burn a solver's payout with a dust intent",
    target: "Settlement.settleBtcOut (:260) — the reservation gate keys on H, not on the payment",
    premise: "a Bitcoin payout is public bytes naming the user's address in the clear; point your own one-satoshi intent at the same destination and settle it with the honest solver's proof",
    expected: "blocked", expectedWhy: "the payout must carry an OP_RETURN settler commitment (\"RSKX\" || settler address) and settleBtcOut requires msg.sender to match it",
    defence: "settler commitment in the payout itself — entitlement travels with the payment, not with the (public, replayable) proof. Committing the SETTLER rather than H keeps batching: one 25-byte output protects every payment in the transaction.",
    severity: "pre-fix: the paying solver lost its BTC irreversibly for the price of dust plus gas, repeatable on every payout",
    needs: "1 node + bitcoind, E19 genesis; relays headers",
    conclusion: "FIXED. The hijack is refused on the commitment check, the paying solver settles normally, and a payout built without a commitment is unclaimable by anyone (mandatory by design — an optional commitment would just be harvested when omitted).",
    finding: "reserveExit is documented as the protection against 'losing an UNRESERVED exit race costs real bitcoin' (settlement.ts), and it does stop e2's poach. It does not stop this: the gate is keyed by H, so a rival intent on the same destination is outside it. Binding a claim to the payout's own funding — or committing the settler in H — is the missing piece.",
    impl: { kind: "native", load: () => import("./e8_payout_hijack.js") },
  },
  {
    id: "e6", cls: "E", name: "grind a salt so one payout fits two intents",
    target: "Settlement._checkBtcOutIntent H commitment (:310)",
    premise: "H = keccak256(\"BTCOUT\" || dest || salt) with an attacker-chosen salt — find two salts that let one payout answer two intents",
    expected: "untested",
    defence: "keccak256 preimage resistance; the per-output claimed set makes the win worthless even if found",
    severity: "none if the claimed set holds (see e3) — listed because the salt is attacker-chosen and the coupling is not obvious",
    needs: "1 node",
    impl: { kind: "untested", why: "an attack on keccak256 itself; kept as an explicit non-goal rather than an unlisted assumption" },
  },
  {
    id: "e7", cls: "E", name: "brick your own exit settle as an unpayable reserver",
    target: "Settlement.settleBtcOut bond refund (:292)",
    premise: "reserve from a contract that rejects RBTC, pay real BTC, then find your own settle reverts on the bond refund — opening a double-payment window",
    expected: "contained", expectedWhy: "the bond refund is best-effort and downgrades to a credit",
    defence: "_pay fallback on the bond refund (:292)",
    severity: "a solver that has paid irreversible BTC cannot settle, and after the lapse someone else can be paid too",
    needs: "1 node + bitcoind, E20 genesis; two 30-block lapses",
    conclusion: "verified: E20's checks pass. Two harness faults found along the way, neither in the mechanism. (1) It had never run — e20_exit_containment.ts built its intents with expiry = head + 150, above the admission cap of 100 (intent.maxExpirySpan, pinned in podman-compose.yml), so the script threw before its first check; now +90, since the widest part needs ~67 blocks for its takeover reserve to clear RESERVE_WINDOW. (2) The E8 settler-commitment fix then broke part 3: its payout committed to cow while the SETTLER is the unpayable Griefer contract, so settleBtcOut refused it on the new check. payAndProve now takes the settler explicitly — a fair warning that the commitment must name whoever calls settle, not whoever funds the BTC.",
    impl: { kind: "wrapped", script: "e20_exit_containment.ts" },
  },

  // ---------------------------------------------------------------- F · reorg / liveness
  {
    id: "f1", cls: "F", name: "keep the output when the settle is orphaned",
    target: "consumed set + delivery under state reversion",
    premise: "get paid, then reorg the settle away so H is free again and the escrow can be claimed twice",
    expected: "blocked", expectedWhy: "delivery and H revert together with the block",
    defence: "state reversion — H lives in contract storage, not off-chain bookkeeping",
    severity: "double spend of the input across the reorg",
    needs: "1 node (evm_snapshot/evm_revert)",
    impl: { kind: "wrapped", script: "e9_reorg.ts" },
  },
  {
    id: "f2", cls: "F", name: "orphan a settle with a heavier chain (real p2p)",
    target: "fork choice vs settlement finality",
    premise: "out-mine the chain containing the settle from a partitioned node, then heal",
    expected: "blocked", expectedWhy: "the orphaned settle's effects revert and the intent is re-solvable",
    defence: "fork choice + state reversion (the f1 argument under genuine p2p)",
    severity: "as f1, without the single-node modelling caveat",
    needs: "**reorg stack** (docker-compose.reorg.yml) + docker CLI; slow",
    impl: { kind: "wrapped", script: "e16_cross_node_reorg.ts" },
  },
  {
    id: "f3", cls: "F", name: "replay a payout proof across a BTC header reorg",
    target: "Bridge SPV view vs claimedBtcOut",
    premise: "settle an exit, then reorg the BTC chain so the payout is no longer confirmed — the user's BTC is gone but H stays consumed",
    expected: "untested",
    defence: "MIN_BTC_CONF (:331) prices the reorg depth; nothing re-validates a settled exit afterwards",
    severity: "the user's exit is marked settled by a payment that no longer exists on Bitcoin",
    needs: "1 node + bitcoind with invalidateblock",
    impl: { kind: "untested", why: "needs bitcoind invalidateblock past MIN_BTC_CONF plus a Bridge header re-relay" },
  },
  {
    id: "m1", cls: "M", name: "lift the intent out of a pending settle and front-run it",
    target: "the settle transaction's own calldata — it carries the whole authenticated intent",
    premise: "a solver's settle broadcasts rawIntentTx in the clear; copy those bytes out of the mempool and settle the same intent first, with a higher gas price (a miner does the same for free, by ordering its own block)",
    expected: "succeeds", expectedWhy: "first-valid-inclusion with no exclusivity: whoever lands first consumes H, and a miner decides what lands first",
    defence: "none for a bid-free intent. An OPEN auction is the only thing that reserves an intent (D1), and it must be bid upon first",
    severity: "the honest solver loses its gas and, for a compound intent, the real capital it spent acquiring the output; repeatable on every profitable settle",
    needs: "1 node, ticket off",
    conclusion: "the intent is self-authenticating, which is what lets ANYONE relay it — and equally what lets anyone who sees it settle it. The auction lock is the mitigation the design already has; without a bid there is none.",
    impl: { kind: "native", load: () => import("./m1_settle_frontrun.js") },
  },
  {
    id: "m2", cls: "M", name: "censor rival solvers while settling as yourself",
    target: "block construction — MinerUtils has no intent-specific rule beyond excluding intents",
    premise: "a mining solver drops every OTHER solver's settle from its blocks and includes only its own, becoming a privileged solver without breaking a single rule",
    expected: "succeeds", expectedWhy: "transaction selection is a miner's prerogative; nothing in the design can compel inclusion",
    defence: "none at the protocol level — the honest framing is that liveness rests on 'some miner will include a profitable settle', not on any single one doing so",
    severity: "spread capture concentrates in mining solvers; the user still gets minOut, so it is a competition harm rather than a theft",
    needs: "on-demand mining (the reorg stack), plus a node-side transaction-selection hook",
    stack: "reorg",
    impl: {
      kind: "untested",
      why: "on-demand mining now exists (see ./_stacks.ts), but persistent exclusion does not: evm_mine " +
        "includes whatever the pool holds, so declining to include a specific sender needs a patched " +
        "MinerUtils in the rskj clone. Withholding the tx by partitioning the nodes instead would " +
        "demonstrate a network split, not censorship — a different claim wearing this one's name.",
    },
  },
  {
    id: "m3", cls: "M", name: "starve an auction by ordering, then take it at the floor",
    target: "Auction.bid / execute — the bidding window and GRACE decay are block-height rules",
    premise: "hold rival bids out of blocks until the deadline passes, or hold execute() out until exclusivity decays, then settle at minOut yourself",
    expected: "succeeds", expectedWhy: "both the window and the decay are measured in blocks a miner controls the contents of",
    defence: "GRACE decay bounds the damage to 'the user gets minOut instead of the best bid' — the intent cannot be bricked, only cheapened",
    severity: "the user loses the auction surplus the mechanism exists to give them",
    needs: "on-demand mining (the reorg stack) — provisioned automatically with --provision",
    stack: "reorg",
    conclusion: "a deadline denominated in BLOCKS is a clock for users and a counter for miners. Both of the auction's limits are block counts, so whoever produces blocks can close the bidding window in zero wall-clock time, or wait out the GRACE decay and settle at the floor around a higher standing bid. minOut holds and stakes are reclaimable, so nothing is stolen — what is lost is price discovery, which is the whole product of an auction.",
    finding: "GRACE cuts both ways. It was added so a persistently reverting execute() cannot brick an intent (S4), and it is simultaneously a documented, permissionless route to the floor price for whoever controls block production. Both halves of that trade belong in the spec.",
    impl: { kind: "native", load: () => import("./m3_auction_clock.js") },
  },
  {
    id: "m4", cls: "M", name: "reorg a settled exit after the BTC payment is irreversible",
    target: "the consumed set under a deliberate (not accidental) reorg",
    premise: "a mining majority orphans a settleBtcOut after the solver's Bitcoin payment has confirmed, so H un-consumes while the bitcoin stays spent",
    expected: "contained", expectedWhy: "the claimedBtcOut entry reverts with everything else, so the solver can re-present the SAME proof and settle again — its BTC is not lost, only delayed",
    defence: "ordinary state reversion (F1/F2) plus the per-output claim reverting in step with it",
    severity: "if the claim did NOT revert in step, the solver's payment would be unclaimable and its BTC gone",
    needs: "an on-demand-mining stack WITH bitcoind — the reorg stack deliberately has none",
    stack: "reorg",
    impl: {
      kind: "untested",
      why: "E16's partition technique already orphans a settle, and ./_stacks.ts can now drive it from " +
        "the board. What is missing is bitcoind on that stack: an EXIT settle needs a real BTC payment " +
        "and header proof, and the reorg stack has no Bitcoin node. Wants a third compose file " +
        "(on-demand mining + bitcoind) rather than any new attack logic.",
    },
  },
];

export const byId = (id: string): AttackSpec | undefined => ATTACKS.find((a) => a.id === id.toLowerCase());
/** Attacks in a class, ordered by their numeric id so insertions do not scramble the menu. */
export const byClass = (cls: string): AttackSpec[] =>
  ATTACKS.filter((a) => a.cls === cls.toUpperCase())
    .sort((x, y) => Number(x.id.slice(1)) - Number(y.id.slice(1)));
