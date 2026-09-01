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
