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

A new Rootstock-native transaction type in the RSK typed-transaction namespace (`0x02 || subtype`, reserved by RSKIP543/545/546) in which the user signs constraints — a hash-committed payload, a minimum output, an expiry height, and an anti-spam reference — instead of exact calldata. Consensus enforces the constraints before inclusion; independent solvers compete to satisfy them and are paid from the spread. This document specifies the type, its mempool admission rules, and a native consumed-set registry, and describes the atomic intent+solution settlement bundle as the target design. A milestone-1 proof of concept (mempool-only) is implemented and its results are reported.

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

`data` is exactly 128 bytes, four 32-byte words:

```
data = H (32) || btcTxid (32) || expiryHeight E (32) || minOut (32)
```

`H` is a commitment to the full pipeline the user wants executed (`H = keccak256(pipeline)`); the pipeline itself is revealed off-chain to a solver at solve time. `btcTxid` references the confirmed Bitcoin transaction that serves as the anti-spam ticket. `E` is the absolute Rootstock height at which the intent expires. `minOut` is the minimum acceptable output, carried for the solver and enforced at settlement.

## Mempool admission (pre-inclusion validity)

An intent is admitted to the mempool — and therefore gossiped — only if all hold:

1. The signature is valid and the chain id matches.
2. The intent is not expired: current best height `<` `E`. A node also rejects intents whose `E` is more than a bounded number of blocks ahead, to bound the consumed-set window.
3. `H` is not already in the consumed set.
4. The anti-spam ticket is valid: `btcTxid` is visible in the Bridge SPV view (v1: it is a processed peg-in).

The intent's transaction cost is defined to be zero, so the balance and account-existence checks that normally gate a payer-less sender do not apply — this is what delivers the first motivating property. Checks 2–4 are the second: an intent that fails them is rejected here, never enters a block, and costs nothing. Checks 3 and 4 are storage reads against current state (the consumed-set registry and the Bridge's processed-peg-in set respectively).

## Consumed-set registry (precompile)

A native precompiled contract at a fixed address (`0x…01000020` in the PoC) holds the set of consumed intent commitments as ordinary world state, in the same manner as the Bridge's processed-peg-in-txid set. It exposes:

- `isConsumed(bytes32 H) → bool`
- `consumedHeight(bytes32 H) → uint256`
- `consume(bytes32 H)` — records `H`, callable by a solver's settlement.

`H` is recorded only on successful execution: the write is made on the transaction's execution track, which is committed only if the transaction succeeds. Reorg handling is ordinary state reversion. The mental model is that the consumed set is to intents what the nonce is to accounts: the registry is readable by `eth_call` and provable by storage proof.

## Settlement: atomic intent+solution bundle (design; not yet implemented)

At inclusion, an intent is satisfied by an atomic bundle containing the intent and a solver-provided solution, submitted and paid for by the solver. The bundle executes atomically: the node re-checks admission at the inclusion height, executes the pipeline, and requires that every bound holds — in particular that the user receives at least `minOut` — as a condition of the solution recording `H` consumed. If any bound fails, the whole bundle reverts, `H` is not consumed, and the intent returns to the mempool until `E`; the solver forfeits the inclusion fee. Solver repayment and spread accounting are deferred to a companion fee-mechanics RSKIP.

This is the part of the design that binds consumption to delivery. It is a block-construction change and is specified here as the target; it is not implemented in milestone 1 (see Implementation status).

## Expiry, replay, and reorg

Expiry is height-relative with a short maximum span. On a reorg, an intent on the new branch is either still includable or expired, and a dropped solution reverts with its block; the consumed set follows ordinary state reversion. Interaction with fork-aware consensus (RSKIP555, Draft) must be settled before the validity rules are finalized.

## Anti-spam ticket (v1: Bitcoin-event-backed)

v1 intents require a confirmed Bitcoin transaction, referenced by `btcTxid` and checked against the Bridge SPV view at admission. Requiring this to be an ordinary peg-in has a useful consequence: when no solver ever satisfies the intent and it expires, the Bitcoin funds are credited by the normal peg-in path, so the no-solver case degrades to the slow path with no additional refund mechanism. General-purpose ticketless intents are out of scope for v1.

# Rationale

Submission, signing, and paying are separated. The user signs constraints; a solver pays at solve time; anyone holding the bytes may broadcast. The submitter cannot modify (the intent is self-authenticating), cannot forge, and can only delay, since anyone can re-broadcast. This contrasts with the router-contract path, where a specific liquidity provider is the transaction sender and their withdrawal halts the flow.

Inclusion via a solver-paid bundle means censorship resistance is "any bonded solver chasing visible profit", not "miners include it"; the liveness argument mirrors PBS/relay markets. Commit/reveal is front-running protection, not privacy: the counterparty solver must see the payload off-chain to price it, so `H` hides it from third parties only.

Two honest qualifications. "Instant" is a property of solver fronting, not of the protocol: admission is gated on the Bridge SPV view, so protocol-visible latency is Bitcoin confirmation plus header-registration cadence. And protocol properties only cash out with a competitive solver set; a bond/endorsement mechanism should be live from day one and the solver spec published with this RSKIP, so the claim is "entry is permissionless from genesis" rather than a promise of competition.

# Backwards compatibility

The type is additive and lives behind the RSKIP543/545/546 typed-transaction activation. Existing transaction types are unaffected. The consumed-set registry is a new precompile; adding it to the genesis precompile set changes state roots at its activation and therefore must be introduced behind a proper activation gate on public networks (the PoC keeps it always-on for regtest only).

# Reference implementation and test cases

A proof of concept patches rskj on the RSKIP543/545/546 typed-transaction branch (PR #3558). It adds the subtype recognizer, the zero-cost admission path, the four admission checks, the consumed-set precompile, and excludes standalone intents from mining (milestone 1 is mempool-only). A TypeScript SDK builds and signs intents, and a toy solver consumes them.

The experiments each try to falsify a claim:

- E1 — a fresh zero-balance account's intent is admitted to the mempool. (Property 1.)
- E1b — that intent gossips to a second, peered node. (Property 1, stronger form.)
- E2 — an expired intent is rejected at admission and leaves nothing on chain. (Property 2.)
- E3 — after a solver consumes `H`, the same `H` cannot be re-submitted. (Consumed set.)
- E6 — with no atomic bundle, `consume(H)` is unbound to delivery and can be griefed per-`H`. (Residual.)
- E8 — an intent with no valid Bitcoin ticket is rejected. (Anti-spam.)

# Implementation status

As of 2026-09-01, milestone 1 (mempool-only) is implemented on PR #3558 and verified on a real build: E1, E1b, E2, E3, and E6 pass against two patched rskj regtest nodes under docker-compose. Both motivating properties are demonstrated end to end.

Not yet implemented: the atomic intent+solution bundle and `minOut` enforcement (milestone 2 — this is what turns E6 from "grief succeeds" into "grief reverts"); the positive Bitcoin-ticket path (E8 currently exercises only the negative case); and reorg behaviour. Fee mechanics (solver repayment and spread) are a planned companion RSKIP.

An implementation note surfaced by the PoC, relevant to any SDK: rskj serialises a zero `gasPrice` as a raw `0x00` byte (`RLP.encodeCoinNonNullZero`) while a zero `value` and zero `nonce` serialise as `0x80`; a signer that does not match this recomputes a different signing hash and recovers the wrong sender.

# Open questions

- Envelope: whether the intent is signed by a user EVM key (SDK-derived) or by a signature recoverable from the Bitcoin input; and the aggressive variant that packs constraints into the Bitcoin `OP_RETURN` so the intent is fully derivable from the Bitcoin transaction, dissolving the submission step.
- Admission latency is Bridge-bound: either admission tolerates "not yet visible" with a retry window (weakening the spam filter) or the SDK waits for Bridge registration (adding latency).
- Exactly when `H` enters the consumed set (currently on successful settlement only, which is what permits retry after a failed solve), and the precise griefing bound.
- Consumed-set pruning (lazy prune vs Remasc-style sweep vs bounded growth) and RSKIP555 interaction.
- The slow-path/refund mechanism when no solver bites, if the flagship flow cannot be shaped as an ordinary peg-in.

# References

- RSKIP36 — EXECUTE opcode (2017), sponsorship-only prior work.
- RSKIP138 — multi-signed enveloping (2019), sponsorship-only prior work.
- RSKIP543 / RSKIP545 / RSKIP546 — typed transactions and the `0x02` RSK namespace; rskj PR #3558.
- RSKIP555 (Draft) — fork-aware consensus.
- EIP-155 — replay-protected transaction signing.
- EIP-2718 — typed transaction envelope.
- ERC-4337 — off-protocol account abstraction and its alternative mempool.
- RIP-7560 — native account abstraction direction on Ethereum (divergence to track; reuse its bundle/validation-phase vocabulary).
- Companion RSKIP (planned) — intent fee mechanics: solver repayment and spread.
