|RSKIP|XXX|
| --- | --- |
|**Title**|Native intent transaction type|
|**Created**|2026-09-01|
|**Author**|juraj@rootstocklabs.com|
|**Purpose**|Usability, Interoperability|
|**Layer**|Core|
|**Complexity**|2|
|**Status**|Draft|

# Abstract

A new Rootstock-native transaction type in the RSK typed-transaction namespace (`0x02 || subtype`, reserved by RSKIP543/545/546) in which the user signs constraints — a hash-committed payload, a minimum output, an output asset, an expiry height, and an anti-spam reference — instead of exact calldata. Consensus enforces the constraints before inclusion; independent solvers compete to satisfy them and are paid from the spread. This document specifies the type, its mempool admission rules, the consumed set, outcome-based settlement (including the exit path whose output is BTC delivered on Bitcoin), and the activation gate. A proof of concept implements the full lifecycle — Bitcoin in, Bitcoin out, with the user never sending a Rootstock transaction — and every property below is verified by falsification experiments (E1–E19) against patched rskj regtest nodes and a real bitcoind.

# Motivation

Most advertised benefits of native intents are things smart contracts do worse, not things they cannot do. This proposal rests on only two properties that are impossible in contract-land, because contracts execute after inclusion and these are pre-inclusion properties.

First, mempool citizenship for an account that cannot pay. Admission and validity are decided before the EVM runs, so a zero-balance, zero-history account's signed message can become a gossiped mempool object. A contract cannot make that happen; ERC-4337 built an off-protocol alternative mempool precisely because it could not do this in contracts.

Second, invalidity before inclusion. A contract-level expiry or replay check runs on-chain: it spends block space, burns gas, and produces a revert that is visible and can be griefed. Protocol validity means an expired or already-consumed intent never enters a block and costs nothing.

Everything else — constraint checking, honest signing UX, commit/reveal, output bounds — is quality of implementation and does not by itself justify a consensus change. The specification below is shaped so that these two properties are the load-bearing ones.

The flagship application is near-instant, Bitcoin-anchored execution on Rootstock: value arriving from Bitcoin, with a solver fronting the result on Rootstock against a Bitcoin event, settled trust-minimally once the event is visible to the Bridge.

# Specification

## Transaction envelope

An intent is an RSK-namespace typed transaction:

```
0x02 || 0x49 || rlp([nonce, gasPrice, gasLimit, to, value, data, v, r, s])
```

`0x02` is the RSK namespace prefix and `0x49` (`INTENT_SUBTYPE`) selects the intent subtype. The body is the legacy nine-field list; the signed constraints live in `data`. This reuses the RSKIP543/545/546 typed-transaction machinery unchanged, so no new parser or encoder is required.

The signing hash follows the RSK-namespace scheme for a non-zero chain id: `keccak256(0x02 || 0x49 || rlp([nonce, gasPrice, gasLimit, to, value, data, chainId, "", ""]))`, with EIP-155 `v = yParity + chainId*2 + 35`. The chain id must be non-zero.

`to` is the consumed-set registry address (below). `gasPrice` and `value` are zero; the intent is a free mempool object (see admission). The sender is recovered from the signature; the SDK derives a fresh address per intent so that intent uniqueness is keyed by the payload commitment rather than by an account nonce.

## Intent constraints (the `data` field)

`data` is exactly 160 bytes, five 32-byte words:

```
data = H (32) || btcTxid (32) || expiryHeight E (32) || minOut (32) || outputToken (32)
```

`H` is a commitment to the full pipeline the user wants executed (`H = keccak256(pipeline)`); the pipeline itself is revealed off-chain to a solver at solve time. `btcTxid` references the confirmed Bitcoin transaction that serves as the anti-spam ticket (and, in the fee RSKIP, keys the input escrow). `E` is the absolute Rootstock height at which the intent expires. `minOut` is the minimum acceptable output, enforced at settlement. `outputToken` names the output asset: the zero address for native RBTC, an ERC-20 address for tokens (vault shares and LP tokens included — settlement is outcome-based, so any pipeline whose terminal step tokenises is expressible), or the reserved sentinel `0x…01000023` meaning *BTC delivered on Bitcoin* (an exit intent; `minOut` is then denominated in satoshis, and `H` additionally commits to the user's Bitcoin destination: `H = keccak256("BTCOUT" || hash160 || salt)`, verified on-chain at settlement without the format growing a field).

## Mempool admission (pre-inclusion validity)

An intent is admitted to the mempool — and therefore gossiped — only if all hold:

1. The signature is valid and the chain id matches.
2. The intent is not expired: current best height `<` `E`. A node also rejects intents whose `E` is more than a bounded number of blocks ahead, to bound the consumed-set window.
3. `H` is not already in the consumed set.
4. The anti-spam ticket is valid: `btcTxid` is visible in the Bridge SPV view (v1: it is a processed peg-in).

The intent's transaction cost is defined to be zero, so the balance and account-existence checks that normally gate a payer-less sender do not apply — this is what delivers the first motivating property. Checks 2–4 are the second: an intent that fails them is rejected here, never enters a block, and costs nothing. Checks 3 and 4 are storage reads against current state (the consumed-set registry and the Bridge's processed-peg-in set respectively).

## Parse precompile and the consumed set

Two fixed addresses split the work:

- **Parse precompile** (`0x…01000020`): stateless. Given the raw signed intent bytes it reconstructs the RSK-namespace signing hash, recovers the user, and returns the decoded fields `(user, H, btcTxid, E, minOut, outputToken)` — the one step impractical in Solidity. Any contract may staticcall it, so settlement-layer contracts (the settlement contract, the auction) authenticate intents without duplicating signature logic.
- **Settlement contract** (`0x…01000021`, deployed at activation): owns the consumed set as ordinary contract storage at slot `== H`, readable by `eth_call`, provable by storage proof, and read directly by mempool admission. `isConsumed(bytes32 H) → bool` is the public view.

`H` is recorded only on successful settlement: the write commits only if the settling transaction succeeds, so consumption is bound to delivery by construction. Reorg handling is ordinary state reversion — verified both by state-rollback (E9) and by a genuine two-node partition/merge in which a node's own fork choice orphans a settlement, reverts delivery and `H`, and the intent settles again on the new chain (E16). The mental model stands: the consumed set is to intents what the nonce is to accounts.

## Settlement: atomic solve

An intent is satisfied by a single solver transaction that calls the settlement contract's `settle(rawIntentTx)`. In one transaction the settlement contract authenticates the intent (a stateless parse precompile recovers the user from the signature — the one step impractical in Solidity), re-checks admission at the inclusion height (unexpired, `H` unconsumed), delivers at least `minOut` of the output asset to the user (native RBTC, or an ERC-20 via `transferFrom`), and only then records `H` consumed in its own storage. Transaction atomicity is the all-or-nothing guarantee: if any bound fails — delivery short of `minOut`, expired, already consumed — the whole call reverts, `H` is not consumed, the intent remains solvable until `E`, and the solver forfeits the gas. This is what binds consumption to delivery: the only way to consume an intent's `H` is to satisfy it.

This is realized without a block-construction change, and settlement runs in the VM (a contract deployed at activation), so failures revert visibly. The solver transaction carries the signed intent bytes, so it is self-contained, and EVM transaction atomicity supplies the bundle semantics. A consensus-level bundle object (miner-assembled intent+solution, for MEV and ordering control) remains a possible future refinement. Solver repayment, the input claim, price competition (the above-`minOut` auction), and the exit path are specified in the companion fee-mechanics RSKIP.

Two settlement-adjacent mechanisms live alongside `settle` and are specified in the companion RSKIP: an auction lock (while an open auction exists for `H` in the designated auction contract, `settle` rejects other callers, so bids above `minOut` cannot be undercut by a bypass at the minimum), and `settleBtcOut` for exit intents (the solver proves a real Bitcoin payment to the destination committed in `H` — SPV inclusion against the Bridge's header chain via RSKIP122 `getBtcTransactionConfirmations`, plus an on-chain parse of the payout transaction — then claims the escrowed input).

## Expiry, replay, and reorg

Expiry is height-relative with a short maximum span. On a reorg, an intent on the new branch is either still includable or expired, and a dropped solution reverts with its block; the consumed set follows ordinary state reversion. Interaction with fork-aware consensus (RSKIP555, Draft) must be settled before the validity rules are finalized.

## Anti-spam ticket (v1: Bitcoin-event-backed)

v1 intents require a confirmed Bitcoin transaction, referenced by `btcTxid` and checked against the Bridge SPV view at admission. Requiring this to be an ordinary peg-in has a useful consequence: when no solver ever satisfies the intent and it expires, the Bitcoin funds are credited by the normal peg-in path, so the no-solver case degrades to the slow path with no additional refund mechanism. General-purpose ticketless intents are out of scope for v1.

# Rationale

Submission, signing, and paying are separated. The user signs constraints; a solver pays at solve time; anyone holding the bytes may broadcast. The submitter cannot modify (the intent is self-authenticating), cannot forge, and can only delay, since anyone can re-broadcast. This contrasts with the router-contract path, where a specific liquidity provider is the transaction sender and their withdrawal halts the flow.

Inclusion via a solver-paid bundle means censorship resistance is "any bonded solver chasing visible profit", not "miners include it"; the liveness argument mirrors PBS/relay markets. Commit/reveal is front-running protection, not privacy: the counterparty solver must see the payload off-chain to price it, so `H` hides it from third parties only.

Two honest qualifications. "Instant" is a property of solver fronting, not of the protocol: admission is gated on the Bridge SPV view, so protocol-visible latency is Bitcoin confirmation plus header-registration cadence. And protocol properties only cash out with a competitive solver set; a bond/endorsement mechanism should be live from day one and the solver spec published with this RSKIP, so the claim is "entry is permissionless from genesis" rather than a promise of competition.

# Backwards compatibility

The type is additive and lives behind the RSKIP543/545/546 typed-transaction activation, and everything in this proposal is gated by its own consensus rule (`RSKIPINTENT` in the PoC): the zero-cost admission path, the parse precompile's availability, and the settlement/auction contract deployments all activate at the fork height and are inert before it (verified in E13 — pre-activation intents are rejected with a distinct reason; post-activation they are admitted). Existing transaction types are unaffected.

# Reference implementation and test cases

A proof of concept patches rskj on the RSKIP543/545/546 typed-transaction branch (PR #3558). It adds the subtype recognizer, the zero-cost admission path, the four admission checks, the consumed-set precompile, and excludes standalone intents from mining (milestone 1 is mempool-only). A TypeScript SDK builds and signs intents, and a toy solver consumes them.

The experiments each try to falsify a claim:

- E1 — a fresh zero-balance account's intent is admitted to the mempool. (Property 1.)
- E1b — that intent gossips to a second, peered node. (Property 1, stronger form.)
- E2 — an expired intent is rejected at admission and leaves nothing on chain. (Property 2.)
- E3 — after a solver consumes `H`, the same `H` cannot be re-submitted. (Consumed set.)
- E7 — a solve delivers ≥ `minOut` to the user and records `H` consumed, atomically. (Settlement.)
- E6 — an under-delivering solve reverts and leaves `H` intact; consumption requires delivery. (m1 residual closed.)
- E8 — an intent with no valid Bitcoin ticket is rejected; an intent referencing a real processed peg-in is admitted. (Anti-spam, both directions.)
- E9 — a reorg that drops the solve reverts both `H` and the delivery, and the intent is solvable again. (Reorg / state reversion.)
- E10 — an intent whose output is an ERC-20 is settled by delivering the token to the user. (Token output.)
- E11 — a failed solve reverts visibly (status 0x0) and leaves `H` intact. (Visible revert.)
- E12 — the solver claims the escrowed input and keeps the spread; the user gets the output. (Fee mechanics; companion RSKIP.)
- E13 — intents are rejected before the activation height and admitted after. (Activation gate.)
- E14 — a real RSKIP170 peg-in credits the settlement contract; `settle` releases the actual pegged-in input to the solver. (Real input binding.)
- E15 — two bonded solvers race one intent: exactly one settle lands, the user is paid once, the loser reverts. (First-valid-inclusion; bonding.)
- E16 — a genuine two-node p2p partition/merge orphans a settlement; delivery and `H` revert and the intent settles again. (Reorg, full p2p form.)
- E17/E17b — solvers bid above `minOut`; the user receives the best bid; the enforced auction closes the settle-at-minimum bypass while bid-free intents settle exactly as before. (Price competition.)
- E19 — a solver's real Bitcoin payment to the user's address, SPV-proven, settles the exit intent and releases the input; a reserved exit rejects other solvers even with valid proofs; wrong destinations and replayed payout outputs revert; a lapsed reservation's bond sweetens the next fill. (Exit path.)

# Implementation status

As of 2026-09-01, milestones 1 (mempool-only admission) and 2 (atomic solve) are implemented on PR #3558 and verified on a real build against two patched rskj regtest nodes under docker-compose. Milestone 1: E1, E1b, E2 demonstrate the two irreducible claims. Milestone 2: E7 demonstrates atomic settlement (a solve delivers ≥ `minOut` to the user and records `H` consumed in one transaction), E3 demonstrates replay protection, and E6 demonstrates that the m1 consume-griefing residual is closed (an under-delivering solve reverts and leaves `H` intact).

The positive Bitcoin-ticket path is implemented and verified end to end on a real build: a driver registers a genuine regtest peg-in through the public `receiveHeader` / `registerBtcTransaction` path (the regtest `receiveHeader` throttle is dropped to zero so the headers coinbase maturity forces can be relayed), and E8-positive admits an intent that references it while still rejecting a bogus ticket. Because the anti-spam ticket is required to be an ordinary peg-in, the no-solver case degrades to a normal peg-in credit — the refund story of pressure point 5.

Reorg state-reversion is demonstrated (E9): using `evm_snapshot`/`evm_revert` — the same state-reversion path a real reorg takes — a dropped `solve` reverts both `H` and the delivery, and the intent becomes solvable again. A genuine two-miner p2p partition/merge is not tested; it is lower value because the consumed set is ordinary world state that reverts by construction.

Milestone 3 moved settlement into a VM contract (genesis-deployed) that calls a stateless parse precompile, delivers the output (RBTC or ERC-20), and records `H` in its own storage. Two consequences: arbitrary ERC-20 outputs are now supported (E10), and — because settlement runs in the VM — a failed `solve` reverts visibly (E11), retiring the precompile-revert caveat below via the recommended VM-contract route. The consumed set is the contract's storage at slot == H, which admission reads exactly as before.

Milestone 4 implemented the fee mechanics (companion RSKIP): the settlement contract escrows the input (the peg-in, keyed by btcTxid) and releases it to the solver as repayment plus spread when it settles, verified cross-asset in E12 (user pegs in RBTC, receives an ERC-20; solver claims the RBTC input). A finding: native RBTC cannot be pulled from the user, so the input is escrowed in the contract rather than authorised for transfer from the user's balance.

The productionization items are also implemented and verified. Activation gate: an `RSKIPINTENT` consensus rule gates admission, the precompile, and the deployments (E13). Real input binding: a genuine RSKIP170 v1 peg-in whose OP_RETURN names the settlement contract credits it directly, the Bridge records the (destination, amount) pair per txid, and `settle` releases the actual pegged-in input (E14) — in production this could instead reuse Flyover's Programmable Peg-in Addresses (RSKIP176), an already-audited mechanism for crediting a contract keyed by a derivation hash. Solver market: a bond contract (E15), the above-`minOut` auction in both off-consensus and enforced shapes with token-denominated bids, pull-payment hardening and lock decay (E17/E17b), and the exit path with SPV-verified solver payouts and bonded reservations (E19). A genuine two-node p2p reorg is verified (E16). See `PRODUCTIONIZATION.md` for the full analysis, including the relationship to Flyover.

Not implemented, by design: a consensus-level bundle object (settlement is a single solve transaction, a VM contract call), the off-chain reveal protocol, and endorsement/reputation — the latter two ship as specification with this RSKIP.

Two implementation notes surfaced by the PoC. First, relevant to any SDK: rskj serialises a zero `gasPrice` as a raw `0x00` byte (`RLP.encodeCoinNonNullZero`) while a zero `value` and zero `nonce` serialise as `0x80`; a signer that does not match this recomputes a different signing hash and recovers the wrong sender. Second, relevant to the settlement design: in the current executor a raw precompiled-contract exception is not propagated to the transaction receipt. For a precompile, `go()` takes the `vm == null` branch and commits the transaction track unconditionally, and the receipt status is derived from an execution-error string that the precompile path never sets — so a throwing precompile reports success with its writes committed. Bridge and Remasc are subject to the same behaviour and are written to avoid throwing for expected failures, handling them internally instead. The PoC works within this by making `solve` write only after all checks pass (a failed solve therefore has no effect: no delivery, `H` unconsumed) and by judging outcomes on state effects, not receipt status. Making a failed `solve` revert *visibly* should not be done by changing the shared precompile path — that would alter Bridge and Remasc consensus behaviour. The clean route is to invoke settlement through a thin VM contract that calls the registry: the VM execution path already rolls back state and fails the receipt on a failed call, so a failed `solve` would revert normally. Alternatively the precompile can return an explicit result code the caller checks. This is a settlement-path refinement, not a change to the transaction type or the consumed set.

# Open questions

- Envelope: whether the intent is signed by a user EVM key (SDK-derived) or by a signature recoverable from the Bitcoin input; and the aggressive variant that packs constraints into the Bitcoin `OP_RETURN` so the intent is fully derivable from the Bitcoin transaction, dissolving the submission step. (The PoC already carries `H` in the peg-in's OP_RETURN alongside the RSKIP170 payload, as a step in this direction.)
- Admission latency is Bridge-bound: either admission tolerates "not yet visible" with a retry window (weakening the spam filter) or the SDK waits for Bridge registration (adding latency). A fast-fill variant — lower-confirmation tickets with the reorg risk collateralised by solver bonds — is the flyover-style answer and needs its own analysis.
- Exit intents couple three parameters that must be sized together: the intent's expiry must budget for the solver's Bitcoin confirmations plus the on-chain proof work, the reservation window must fit inside the expiry, and `MIN_BTC_CONF` allocates the payout-reorg risk (it protects the *user*; the solver's bond is the backstop). Regtest values (expiry ≤ 95 blocks, window 30, conf 1) do not transfer to mainnet.
- A native permit: exiting a live position (vault shares, LP tokens) without any user Rootstock transaction requires the intent itself to carry a transfer authorisation the settlement contract can exercise. EIP-2612 covers permit-aware tokens; the protocol-level generalisation is open.
- Recovery of an expired exit intent's escrowed input (Flyover's `refundUserPegOut` is the model); currently a documented gap.
- Consumed-set pruning (lazy prune vs Remasc-style sweep vs bounded growth) and RSKIP555 interaction.
- Enforced vs off-consensus auction: a governance decision this proposal surfaces rather than makes (see the companion RSKIP and `PRODUCTIONIZATION.md`).

# References

- RSKIP36 — EXECUTE opcode (2017), sponsorship-only prior work.
- RSKIP138 — multi-signed enveloping (2019), sponsorship-only prior work.
- RSKIP543 / RSKIP545 / RSKIP546 — typed transactions and the `0x02` RSK namespace; rskj PR #3558.
- RSKIP122 — Bitcoin transaction confirmations query (`getBtcTransactionConfirmations`); the SPV primitive the exit path builds on.
- RSKIP170 — peg-in transaction version 1 (OP_RETURN destination); the input-binding mechanism verified in E14.
- RSKIP176 — Programmable Peg-in Addresses (Flyover); the production alternative for crediting the settlement contract.
- Flyover / Liquidity Bridge Contract — the closest production relative (see `PRODUCTIONIZATION.md`, "Relationship to Flyover"): its `refundPegOut` is shape-for-shape this proposal's `settleBtcOut`, and its LP collateral/penalty model is the precedent for solver bonds.
- RSKIP555 (Draft) — fork-aware consensus.
- EIP-155 — replay-protected transaction signing.
- EIP-2718 — typed transaction envelope.
- ERC-4337 — off-protocol account abstraction and its alternative mempool.
- RIP-7560 — native account abstraction direction on Ethereum (divergence to track; reuse its bundle/validation-phase vocabulary).
- Companion RSKIP — intent fee mechanics: solver repayment and spread (`RSKIP-draft-native-intent-fees.md`).
