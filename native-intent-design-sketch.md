# Native intent transaction type on Rootstock — design sketch

Status: Idea stage. Working material from a brainstorming handoff, restructured for review. Nothing here is committed design. Companion diagram: `native-intent-sequence.mermaid`. Formal draft: `RSKIP-draft-native-intent-tx.md`. A proof of concept is built and verified under `poc/` — as of 2026-09-01 milestones 1 (mempool-only admission) and 2 (atomic solve) both pass on a patched rskj regtest node: the two irreducible claims (E1, E1b, E2), replay protection (E3), atomic min-out settlement (E7), and the closed consume-griefing residual (E6).

## What it is

A Rootstock-native transaction type in the RSK typed-transaction namespace (`0x02 || subtype`, reserved by RSKIP543/545/546; see rskj PR #3558). The user signs constraints — a hash-committed payload H(pipeline), minimum output, expiry height E, sponsorship terms — instead of exact calldata. Consensus enforces validity. Solvers satisfy the constraints and are paid from the spread.

It is the protocol substrate under two existing initiatives: "(near-)instant, Bitcoin-anchored execution on Rootstock" and "Intent-based batching from Bitcoin".

## The two irreducible claims

Most advertised benefits of native intents are things smart contracts do worse, not things they can't do. Only two are impossible in contract-land, because contracts run after inclusion and these are pre-inclusion properties.

**1. Mempool citizenship for an account that can't pay.** Admission and validity are decided before the EVM runs. A contract cannot turn a zero-balance, zero-history account's signed message into a gossiped mempool object. ERC-4337 built an off-protocol alt-mempool precisely because it couldn't do this in contracts.

**2. Invalidity before inclusion.** Contract expiry and replay checks execute on-chain: block space spent, gas burned, revert visible and griefable. Protocol validity means an expired or consumed intent never enters a block and costs nothing.

Everything else — constraint checking, honest signing display, commit/reveal, bounds — is quality of implementation, and no document should claim otherwise.

## Flow (v1, Bitcoin-event-backed)

The user builds a pipeline with the dApp/SDK and signs a Bitcoin transaction whose OP_RETURN carries H. Bitcoin headers reach the Bridge's SPV view at its registration cadence. Anyone holding the bytes — in practice the SDK, hitting several nodes — broadcasts the intent transaction. Admission checks: signature, BTC event visible in the Bridge view, not yet expired (current height below E), H not yet consumed. The intent gossips through the public mempool.

A solver requests the payload; the SDK reveals it off-chain (hidden from third parties only — this is front-running protection, not privacy). The solver simulates, prices, and submits an atomic bundle (intent + solution), paying the fees. At inclusion the node re-checks admission and executes the pipeline atomically. If every bound holds: H is recorded consumed, the user receives at least min-out, the solver is repaid plus spread. If any bound fails: the whole bundle reverts, H is not consumed, the intent returns to the mempool until E, and the solver eats the inclusion fee. Never solved by height E: dropped silently, nothing on chain — slow path / refund (mechanism undefined; see pressure point 5).

## Decisions taken (each revisitable)

**v1 intents are Bitcoin-event-backed.** The anti-spam ticket is a confirmed BTC transaction referenced by the intent and checked against the Bridge's SPV view at admission. This resolves the hardest problem — mempool DoS with no "sender can pay" filter — scopes v1 to the flagship flow, and gives honest signing UX from Bitcoin's side. General-purpose free intents are deferred to v2 or never.

**Inclusion is an atomic bundle; the solver pays.** Stated honestly: censorship resistance is "any bonded solver chasing visible profit", not "miners include it". The liveness argument mirrors PBS/relay markets.

**Failure allocation.** Any failed bound reverts the whole bundle; H is not consumed; the solver eats the fee, priced into spread, defended by pre-solve simulation and counterparty scoring. Known residual: a crafted-to-fail intent can burn multiple solvers' fees until E.

**Commit/reveal hides from third parties only.** The counterparty solver must see the payload off-chain to price it.

**Expiry is height-relative with a short maximum E.** Bounds the consumed-set window and makes reorgs re-evaluate cleanly: on the new branch an intent is either still includable or expired, and a dropped solve reverts with its block. RSKIP555 (fork-aware consensus, Draft) must be read before validity rules are fixed.

**The consumed set is world state under a native registry (precompile)** — the same pattern as the Bridge's processed-peg-in-txid set. Visible via plain `eth_call` and storage proofs; reorg handling is ordinary state reversion. Mental model: the consumed set is to intents what the nonce is to accounts. Open: pruning (lazy prune vs Remasc-style sweep vs accept bounded growth).

**Submission is unprivileged, split from signing and paying.** User signs constraints; solver pays at solve time; anyone may broadcast. The submitter can't modify (self-authenticating), can't forge, can only delay — and anyone can re-broadcast. Contrast the contract path, where a specific LP is the sender and their withdrawal halts the flow. (But see pressure point 2: the payload revealer holds a similar position.)

## Pressure points raised in this pass

These challenge the handoff rather than inherit it.

**1. The bundle decision weakens claim 1.** If inclusion always happens via a solver-paid bundle, the intent never needs the mempool for inclusion — the mempool is only a discovery channel, and solvers could discover intents anywhere, including from Bitcoin itself. What native mempool citizenship then irreducibly buys is narrower: consensus-uniform anti-DoS gossip rules and the absence of a privileged bundler role. Real, but the doc-00 restructure should state the claim at that reduced strength. Note also that the doc-01 "aggressive variant" (intent fully derivable from the BTC transaction) makes Bitcoin itself the mempool and dissolves the submission step entirely — that variant deserves promotion to a first-class alternative, not a flagged aside, precisely because it strengthens the weakest claim.

**2. Commit/reveal contradicts the censorship-resistance story.** "Any bonded solver chasing visible profit" — but profit is not visible without the payload, and the SDK gates the reveal. The revealer can't forge or modify, but it can starve solvers, which is a liveness dependency of the same shape as the LP-halts-flow failure the design is contrasted against. Doc 03 needs an answer: an obligation to reveal to any bonded solver, threshold-encrypted payloads, or an honest admission that the dApp is a liveness party in v1.

**3. "Instant" is not what the protocol delivers.** Admission is gated on the Bridge's SPV view, so protocol-visible latency is BTC confirmation time plus header registration cadence. Any faster experience requires a solver fronting against an event consensus cannot yet see — off-protocol risk-taking, exactly as today. The honest framing: the type delivers trust-minimised settlement of fronted flows, not instant execution. The initiative name should not survive into the RSKIP unqualified.

**4. Counterparty scoring erodes "permissionless from genesis".** The crafted-to-fail defence is off-protocol reputation. Reputation systems gatekeep. The claim already softened once (from censorship resistance to bonded-solver liveness); with scoring it softens again to "entry is permissionless, profitable participation requires standing". Say so, and quantify the griefing bound: at most one inclusion fee per willing solver per crafted intent, until E or until scoring propagates.

**5. The refund path is not a placeholder-grade gap — it dominates.** The user's BTC moves on Bitcoin regardless of what happens on Rootstock. Where it goes determines whether a user can lose funds, which outweighs every other property. The natural v1 constraint: require the BTC transaction to be a valid ordinary peg-in, so the no-solver case degrades automatically to the slow path (a normal peg-in) with no new mechanism. If the flagship flow can't be shaped that way, doc 03/04 must design an explicit refund before anything ships.

## Open questions, by owner doc

Doc 01 (envelope): who signs the intent transaction — a user EVM key (SDK-derived address) vs a signature recoverable from the Bitcoin input. The aggressive variant above.

Doc 02 (spam/propagation): admission latency is Bridge-bound. Either admission tolerates "not yet visible" with a retry window (weakens the spam filter) or the SDK waits for Bridge registration (adds latency).

Doc 03 (settlement): state the crafted-to-fail griefing window and its bounds. Fix exactly when H enters the consumed set (currently: on successful execution only — this is what allows retry after a failed solve). Resolve pressure point 2.

Doc 04 (expiry/replay/reorg): consumed-set pruning; RSKIP555 interaction.

Unowned: the slow path / refund mechanism (pressure point 5).

## Positioning

Earlier work: RSKIP36 (2017, EXECUTE opcode) and RSKIP138 (2019, multi-signed enveloping) are sponsorship-only — "who pays" — with no intent half (constraint-signing any solver can satisfy under consensus validity). No EVM chain has protocol-native intents; Ethereum's are off-protocol (ERC-4337, CoW, Across).

RIP-7560 (Ethereum's native-AA direction) is a divergence risk. Position the RSK type as covering what 7560 doesn't — no funds, no history, value arriving from Bitcoin — and reuse its vocabulary (bundle structure, validation-phase separation) so a future 7560 landing reads as family, not fork.

Launch reality: the protocol properties only hold with a competitive solver set. Mitigation: bond/endorsement mechanism live from day one; publish the solver spec with the RSKIP.

PoC scope: rskj fork with the type plus a toy solver running a fronting flow end to end; these notes become the draft RSKIP, possibly with a companion RSKIP for fee mechanics.

## References

RSKIP36 · RSKIP138 · RSKIP543 · RSKIP545 · RSKIP546 · RSKIP555 (Draft) · rskj PR #3558 · EIP-4337 · RIP-7560 · internal Notion Initiatives table entries: "(near-)instant, Bitcoin-anchored execution on Rootstock", "Intent-based batching from Bitcoin".
