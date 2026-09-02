# Productionization notes

The PoC proves the mechanics on regtest with three deliberate shortcuts: the peg-in credit is modelled
by a contract call, the intent machinery is always-on at genesis, and there is no solver market. This
note is what it would take to remove each shortcut. It is design, not built. Plain caveats inline.

## A. Real peg-in → contract crediting

In the flagship flow the input is a Bitcoin peg-in, and the fee mechanics require that RBTC to be
escrowed in the settlement contract so `settle` can release it to the solver. Native RBTC cannot be
pulled from an account, so the peg-in must credit the contract, not the user. The PoC models this with
`depositForPegin(btcTxid)`. In production the peg-in itself must do it.

> Status: implemented in the PoC (experiment E14), via option 3 below plus a small Bridge getter. A
> RSKIP170 v1 peg-in names the settlement contract in its OP_RETURN, so the Bridge credits the contract;
> `executePegIn` additionally records `(destination, amount)` per btc txid, and a new public
> `getPeginInfo(bytes32)` Bridge method lets the settlement contract verify the destination is itself and
> release the exact pegged-in input to the solver. This retires `depositForPegin` (kept as a fallback for
> non-BTC test paths). Not done: the OP_RETURN peg-in still credits the contract with no callback — the
> contract pulls the amount via the getter — which is the pragmatic no-VM-callback shape of option 1.

Today an RSK peg-in credits an RSK address derived from the BTC sender key; it does not call contracts.
Three options, in order of faithfulness:

1. **Peg-in that names the contract, with a Bridge callback (recommended, but a Bridge change).** Extend
   the peg-in so a BTC transaction whose `OP_RETURN` designates the settlement contract (and carries the
   intent commitment `H`) credits that contract and invokes a hook — `settlement.onPegin(btcTxid, H){value}`
   — which records the escrow. This ties the anti-spam ticket, the input, and the intent into one
   Bitcoin transaction: the same peg-in is the ticket *and* the escrowed input. It also collapses the
   two-message flow (the `0x02||0x49` intent tx becomes derivable from the Bitcoin tx — the "aggressive
   variant" in the design sketch's doc 01). Cost: a Bridge/consensus change, and peg-in-with-callback is
   a new Bridge capability that needs its own security review (reentrancy from the Bridge into a
   contract, gas accounting during peg-in processing).

2. **Peg-in credits the user; a relayer deposits into the contract.** Keep the Bridge unchanged: the
   peg-in credits the user's derived address, and a relayer (the dApp/SDK, or the solver) moves it into
   the escrow. This needs an on-chain action by someone holding the user's funds, which either breaks
   the payer-less property (if it's the user) or introduces a trusted relayer. Weakest option; only
   useful as a stopgap before the Bridge change.

3. **The settlement contract is a federation-recognised peg-in destination.** A middle path: register the
   settlement contract as a peg-in destination so the federation credits it directly, with the intent
   association carried out-of-band (keyed by `btcTxid`). Less coupling than a full callback, but the
   escrow-to-intent binding is then only as strong as the off-chain association.

Recommendation: option 1, as a companion Bridge RSKIP. It is the only one that keeps the flow trustless
and payer-less, and it is the natural home for the "ticket = input = one peg-in" unification the design
already points at. Until it exists, the PoC's `depositForPegin` is the honest stand-in and should be
labelled as such.

## B. Activation gate (instead of always-on genesis)

> Status: implemented in the PoC (experiment E13). A `RSKIPINTENT` consensus rule now gates the free-tx
> cost, the mempool admission (pre-activation intents are rejected "not active"), and the parse
> precompile (moved to `CONSENSUS_ENABLED_ADDRESSES`); regtest activates it at block 40. Still modelled,
> not productionised: the settlement contract is genesis-deployed rather than deployed at the fork block.


The PoC turns everything on at genesis: the parse precompile is in `GENESIS_ADDRESSES`, the settlement
contract is a genesis alloc, and the free-tx cost, subtype admission, and miner exclusion are
unconditional. That is fine for a fresh regtest chain but wrong for an existing network — adding the
precompile to `GENESIS_ADDRESSES` changes the state root at the RSKIP126 activation block, so a patched
node cannot re-sync mainnet/testnet history.

Production wants one network upgrade gating the whole intent surface behind an activation height:

- A new `ConsensusRule` (say `RSKIPnnn`) added to a `NetworkUpgrade`. Everything below is gated on it.
- The parse precompile registered via `CONSENSUS_ENABLED_ADDRESSES` (activation-gated), not
  `GENESIS_ADDRESSES`. This avoids the state-root problem.
- `Transaction.transactionCost == 0` for the intent subtype, the `TxPendingValidator`/pool admission
  rule, and the miner exclusion all gated on the rule.
- The settlement contract deployed **at the activation block**, the way RSK introduces system contracts
  at forks (create the account and set its code in the fork transition), rather than as a genesis alloc.
  Its address is fixed and known to the gated admission read.
- The typed-transaction dependency (RSKIP543/545/546) must be active first; the intent rule should
  require it.

The consumed set is the settlement contract's own storage, so it needs no separate activation. Test
coverage should include the pre-activation path (an intent before the fork is a plain, rejected typed
tx) and the activation-block state-root, exactly the shape of the existing RSKIP546 hardfork tests.

## C. Solver market — spec and bonding

> Status: bonding + competing solvers implemented in the PoC (experiment E15). A standalone `Bond.sol`
> (SDK-deployed, no genesis change and no consensus rule) lets solvers stake, exposes `bonded(address)`,
> and lets an arbiter `slash` a stake; E15 stakes two solvers and races them on one intent. The race
> confirms first-valid-inclusion: settlement records `H` atomically, so exactly one settle lands and the
> other reverts on the already-consumed `H` — the user is paid once and the winner claims the input
> spread. Crucially the bond is NOT on the settle path (settle never reads it), keeping entry
> permissionless — the property the "off-consensus" framing below requires. Not done (stays as spec): the
> reveal/pipeline protocol, endorsement/reputation, and the above-`minOut` auction refinement.

The protocol delivers pre-inclusion admission and atomic, delivery-bound settlement; it does not deliver
a solver. The properties only cash out with a competitive solver set, and that is market structure, kept
deliberately off-consensus. Two pieces ship with the RSKIP, neither a consensus rule:

**Solver specification (published with the RSKIP).** The off-chain protocol a solver implements:
- Discovery: how a solver sees an intent (public mempool gossip of the `0x02||0x49` tx, or watching
  Bitcoin directly in the aggressive variant).
- Reveal: how a solver obtains the pipeline preimage behind `H` from the dApp/SDK. This is the design's
  pressure point 2 — the reveal-gating party is a liveness dependency of the same shape as the LP the
  design set out to remove. The spec must pin this down: an obligation to reveal to any bonded solver,
  threshold-encrypted payloads decryptable by bonded solvers, or an explicit admission that the dApp is
  a liveness party in v1. Recommendation: reveal-to-any-bonded-solver in v1, threshold encryption later.
- Pricing and submission: how a solver simulates, prices `minOut` vs the input, and constructs the
  `settle` transaction (including the ERC-20 approval when the output is a token).

**Bonding and endorsement (a contract, off-consensus).** A bond a solver stakes, slashable for provable
misbehaviour, plus optional endorsement for reputation. Kept out of consensus on purpose: making it a
validity gate would recreate the permissioned-liquidity-provider problem intents exist to avoid. It
addresses two residuals:
- The crafted-to-fail griefing window (a solver spending gas on intents built to revert): bounded to one
  gas cost per willing solver per intent, discouraged by reputation and — if slashable patterns can be
  proven on-chain — by the bond.
- Launch reality: a single-LP launch has no competitive set, so the claim is "entry is permissionless
  from genesis, profitable participation requires standing." The bond/endorsement mechanism should be
  live from day one so the softened claim is true from the start.

An optional refinement, addable later without a consensus change, lets solvers compete to deliver more
than `minOut` within a short window (an auction above the base first-valid-inclusion rule).

> Status: the auction is implemented in the PoC in BOTH shapes, deliberately, because they disagree on a
> real trade-off. E17 (off-consensus): a standalone `Auction.sol` any party can deploy — solvers escrow
> bids above `minOut`, the outbid are refunded, and after a 10-block window `execute()` settles, paying
> the user the best bid and the winning bidder the claimed input. E17 also demonstrates the honest
> caveat: under the base first-valid-inclusion rule a solver can bypass an unenforced auction and settle
> directly at `minOut` (the stranded bidder reclaims). E17b (enforced): the same contract genesis-deployed
> at `0x..01000022`, with `settle` rejecting every caller but the auction while an OPEN auction exists for
> `H` — including after the bidding deadline, so the permissionless `execute()` cannot be front-run. That
> closes the bypass but makes the auction a Settlement rule rather than pure market structure, cutting
> against this section's own off-consensus framing. Enforcement engages only once someone bids (bid-free
> intents settle exactly as before — regression-checked), and opening the lock requires escrowing a bid
> above `minOut`, so the user always nets more than their ask. The trade-off between the two shapes is a
> governance decision the RSKIP should surface, not bury.

## D. The path back to BTC (exit intents)

> Status: implemented AND verified in the PoC (experiment E19, all checks green — including the
> reservation exclusivity, wrong-destination rejection, per-output replay guard, and the squatter-lapse
> bond forfeit; `btcout` type in the playground). `settleBtcOut` in the
> settlement contract verifies a solver's REAL Bitcoin payment — SPV inclusion via the Bridge's header
> chain (RSKIP122 `getBtcTransactionConfirmations`, already public and statically callable) plus an
> on-chain parse of the raw payout transaction showing an unclaimed P2PKH output of ≥ `minOut` sats to
> the destination committed in `H` — then consumes `H` and releases the escrowed input to the solver.

The exit is the mirror image of the peg-in flow, and it completes the design's central promise: the user's
entire lifecycle stays on Bitcoin. They sign an exit intent whose output is BTC delivered on Bitcoin —
`outputToken` is a sentinel (`0x..01000023`) and `H` commits to their BTC address:
`H = keccak256("BTCOUT" || hash160 || salt)`, so the destination is user-signed without the intent format
growing a field, and revealed to solvers off-chain like the rest of the pipeline. A solver pays the
address from its own UTXOs and proves it; the SPV proof points the opposite way from the peg-in's.

Why solver-direct payment rather than a Bridge peg-out: `releaseBtc` derives the BTC destination from the
caller's own key (no arbitrary destinations, and not callable meaningfully from a contract), and a peg-out
takes hours; a solver payout is a single Bitcoin transaction to exactly the address the user asked for,
priced into the spread. Design consequences worth carrying into the RSKIP:

- **Confirmation policy is the solver's risk, not the user's.** `MIN_BTC_CONF` (1 in the PoC) sets how
  deep the payout must be before it can settle. A Bitcoin reorg after settlement cannot un-consume `H` —
  but it CAN unwind the payout while the solver keeps the input, so the number protects the USER and
  should be meaningfully higher than 1 in production; the solver's bond (section C) is the natural
  backstop for the residual.
- **Batched exits.** The claim guard is per payout OUTPUT, not per transaction: one Bitcoin transaction
  paying N users can settle N exit intents, amortising BTC fees across fills — a real solver efficiency
  the PoC's contract already supports.
- **Exit races would burn the loser's BTC — so exits are RESERVED.** If two solvers raced an exit, both
  would have irreversibly paid the user (who is paid twice) and only one claims the input; nobody
  competes under that rule. The implemented fix (`reserveExit`, in E19 and the playground): before
  paying, a solver posts a bond (10% of the payout) for exclusive settlement rights over a
  `RESERVE_WINDOW` — the race moves to the RSK leg, where losing costs gas, never bitcoin. Squatting is
  priced: a lapsed reservation's bond is forfeited INTO the input escrow, so a stalled exit becomes
  strictly more profitable for the next solver — the mechanism heals its own delays, and the user stays
  BTC-only (no unusable RBTC compensation). Reservation is opt-in (an unreserved exit is still
  first-valid), but a rational solver always reserves; the RSKIP should carry this as a first-class part
  of the exit design, with window and bond sized for mainnet confirmation latency.
- **The input side still needs a native permit.** The PoC escrows the exit's input (`depositForPegin`
  stand-in); a real user exiting a live position (vault shares, LP) would need to authorise the pull
  without an RSK transaction of their own. EIP-2612-style permits cover permit-aware tokens; a
  protocol-level answer — the intent itself carrying a transfer authorisation the settlement contract can
  exercise — is the clean generalisation and belongs in the RSKIP discussion.
- PoC parser scope: legacy P2PKH payout outputs only (no segwit); regtest wallets here are legacy, and a
  production implementation would extend the output matcher, not the mechanism.

## Relationship to Flyover

Flyover (the LBC + LP protocol) is the closest production relative of this design — effectively "intents
specialised to the peg, with a pre-chosen counterparty" — and it de-risks several of our mechanisms
because it has already shipped them:

- **The exit mechanism is production-proven.** LBC `refundPegOut(quoteHash, btcTx, btcBlockHeaderHash,
  partialMerkleTree, merkleBranchHashes)` is shape-for-shape our `settleBtcOut`: the LP pays the user's
  BTC address, then proves the payment on RSK (raw non-witness tx + SPV branch against the Bridge) to be
  refunded. Two binding styles differ and are worth comparing in the RSKIP: Flyover embeds the quote hash
  in an OP_RETURN output of the payout tx at a fixed position; we commit the destination inside `H` and
  guard per `(txid, vout)` — ours needs no extra payout output and supports batched payouts, theirs makes
  the payment↔service binding explicit on Bitcoin. LBC's audited Solidity for BTC tx validation is
  directly reusable.
- **Peg-in binding could reuse RSKIP176 instead of a new Bridge change.** Milestone A added a custom
  `getPeginInfo`; production could instead ride Flyover's Programmable Peg-in Addresses (RSKIP176), where
  the Bridge already refunds a contract keyed by a derivation hash — the settlement contract plus `H`
  slots naturally into the derivation. Less new consensus surface, existing audits.
- **Collateral and penalties exist.** LBC LPs register with collateral, quotes carry a `penaltyFee`, and
  `refundPegOut` applies punishments — production precedent for our solver bond (C) and the exit
  reservation bond, including sizing experience.
- **Flyover LPs are the bootstrap solver set.** They already run BTC liquidity, LP servers, and proof
  infrastructure; "entry is permissionless, profitable participation requires standing" is easiest to
  make true from day one by onboarding them. Flyover peg-in (LP advances funds after a few confirmations
  and waits out the 100 itself) is also exactly the fast-fill variant sketched above — with the reorg
  risk-transfer already priced by a live market.

What intents add over Flyover, precisely: no pre-agreed counterparty (open per-fill competition and
auctions instead of a bilateral quote), outcome-based settlement (`minOut` of a terminal asset, any
route) instead of quoted calldata (`callForUser`), no user RSK transaction for exits (Flyover's
`depositPegout` requires one), and mempool citizenship for the payer-less ask. One Flyover feature we
lack and should adopt: `refundUserPegOut` — the user's recovery path when the counterparty never
delivers. Our analogue (recovering an expired exit intent's escrowed input) is currently a documented
gap.

## Cross-cutting: the executor revert path

The PoC settles through a VM contract precisely because a raw precompile cannot revert visibly in the
current executor (a precompile exception reports success and commits). Production settlement should stay
a contract for this reason, or the executor should be changed to propagate precompile exceptions to the
receipt — but that is a shared-path change affecting the Bridge and Remasc and needs the full test suite.
Keeping settlement in a contract is the lower-risk choice and is what the PoC does.

## References

- RSKIP-draft-native-intent-tx.md, RSKIP-draft-native-intent-fees.md (this repo).
- Design sketch, pressure points 2 (reveal liveness), 3 (instant is a solver property), 4 (permissionless
  softens to "entry"), 5 (refund = peg-in).
- RSKIP543/545/546 (typed transactions), RSKIP126 (precompiled-contract storage roots), RSKIP199/200
  (peg-in / receiveHeader publicity), RSKIP87 (whitelist removal).
- RIP-7560 (native AA direction to track), ERC-4337 (off-protocol precedent).
