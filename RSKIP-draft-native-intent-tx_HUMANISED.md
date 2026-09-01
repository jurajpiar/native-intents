| RSKIP | XXX |
|---|---|
| **Title** | Native intent transaction type |
| **Created** | 2026-09-01 |
| **Author** | juraj@rootstocklabs.com |
| **Purpose** | Usability, Interoperability |
| **Layer** | Core |
| **Complexity** | 2 |
| **Status** | Draft |

# Abstract

This RSKIP proposes a Rootstock-native intent transaction in the RSK typed-transaction namespace
(`0x02 || subtype`, introduced by RSKIP543/545/546). Instead of signing exact calldata, the user signs
a set of constraints: a commitment to an execution pipeline, a Bitcoin transaction reference, an
expiry height, a minimum output, and an output asset.

Nodes enforce the admission constraints before the intent enters the mempool. Independent solvers can
then compete to fulfil it. A solver settles the intent through an atomic contract call, receives the
escrowed input, and keeps the spread after delivering the requested output.

This document defines the transaction format, mempool rules, consumed-set handling, and settlement
path. A proof of concept implements and tests those mechanics on regtest. A miner-assembled consensus
bundle is not part of the current design.

# Motivation

Many features associated with native intents can be built in smart contracts. This proposal is based
on two narrower properties that contracts cannot provide because contracts execute only after a
transaction is included.

The first is **mempool access for an account that cannot pay**. Admission happens before the EVM runs,
so a contract cannot make a signed message from a new, zero-balance account eligible for public gossip.
ERC-4337 addresses the same limitation with a separate, off-protocol mempool.

The second is **invalidity before inclusion**. Contract-based expiry and replay checks take up block
space and consume gas, even when they revert. Protocol admission can reject an expired or already
consumed intent before it reaches a block, at no cost and with no on-chain trace.

Constraint checking, signing UX, commit/reveal, and output bounds remain important, but none of them
alone warrants a consensus change. The two pre-inclusion properties above are the load-bearing claims.

The main use case is Bitcoin-anchored execution on Rootstock. A solver may front the requested output
against a Bitcoin event, then settle once that event is visible to the Bridge. “Instant” execution is
therefore a solver service and risk decision, not a protocol guarantee.

# Specification

## Transaction envelope

An intent uses the RSK typed-transaction namespace:

```
0x02 || 0x49 || rlp([nonce, gasPrice, gasLimit, to, value, data, v, r, s])
```

`0x02` selects the RSK namespace and `0x49` (`INTENT_SUBTYPE`) selects the intent subtype. The body uses
the existing nine-field legacy layout, with the signed constraints stored in `data`. This reuses the
RSKIP543/545/546 parser and encoder rather than introducing another envelope.

For a non-zero chain ID, the signing hash is:

```
keccak256(0x02 || 0x49 || rlp([
  nonce, gasPrice, gasLimit, to, value, data, chainId, "", ""
]))
```

The signature uses EIP-155, with `v = yParity + chainId * 2 + 35`. The chain ID must not be zero.

`to` is the fixed settlement-contract address. Standalone intents are never mined, so this address is
mainly part of the authenticated envelope. Both `gasPrice` and `value` are zero. The SDK normally uses
a fresh key for each intent, making the commitment `H`, rather than an account nonce, the meaningful
uniqueness key.

## Signed constraints

The current intent payload is exactly 160 bytes: five 32-byte words.

```
data = H (32) || btcTxid (32) || expiryHeight E (32) || minOut (32) || outputToken (32)
```

- `H` is `keccak256(pipeline)`, a commitment to the execution pipeline. The pipeline itself is revealed
  to a solver off-chain.
- `btcTxid` identifies the processed Bitcoin peg-in used as the anti-spam ticket and input reference.
- `E` is the absolute Rootstock block height at which the intent expires.
- `minOut` is the minimum amount the solver must deliver.
- `outputToken` is the output asset. The zero address means native RBTC; otherwise the low 20 bytes hold
  an ERC-20 address.

## Activation

The intent subtype is controlled by a dedicated consensus rule. Before that rule activates, nodes
reject native intents as inactive. After activation, the zero-cost rule, mempool validation, and parsing
precompile become available together.

The PoC defines `RSKIPINTENT` and activates it at regtest block 40 so E13 can exercise both sides of the
boundary. A public-network implementation must also deploy the settlement contract during the fork
transition rather than including it in genesis, and must test the resulting activation-block state
root.

The RSKIP543/545/546 typed-transaction rules must already be active.

## Mempool admission

An intent may enter the mempool, and therefore be gossiped, only when all of the following are true:

1. The intent rule is active.
2. The signature is valid and uses the correct chain ID.
3. The data layout is valid.
4. The current best height is below `E`, and `E` is no further ahead than the configured maximum span.
5. `H` is not present in the settlement contract's consumed set.
6. When ticket enforcement is enabled, `btcTxid` is visible as a processed peg-in in the Bridge's SPV
   state.

The transaction cost of an active intent is defined as zero. This bypasses the balance and account-
existence checks that would otherwise reject a payer-less sender. Expired, consumed, or ticketless
intents are rejected at admission and never enter a block.

Standalone intents are removed from miners' candidate transaction list. They exist in the public
mempool as authenticated discovery objects; settlement happens through a normal solver-paid
transaction.

## Consumed set and parser

The fixed-address settlement contract owns the consumed set in ordinary contract storage. The slot
key is `H`, allowing admission to check consumption with a direct state read. The contract also exposes
`isConsumed(bytes32 H)` for ordinary calls.

A separate, stateless precompile parses and authenticates `rawIntentTx`. It recovers the sender and
returns the signed fields to the settlement contract. It holds no consumed state and cannot settle an
intent. Keeping this precompile stateless avoids the unsafe failure semantics observed when stateful
settlement was attempted in a raw precompile.

Consumption is written on the settlement transaction's execution track. If settlement reverts, the
write and every related transfer revert with it. Chain reorganisation follows normal world-state
reversion.

## Atomic settlement

A solver fulfils an intent by calling `Settlement.settle(rawIntentTx)`. In one VM transaction, the
contract:

1. authenticates and parses the signed intent through the stateless precompile;
2. checks that the intent has not expired and that `H` is still unconsumed;
3. records `H` on the current execution track to prevent re-entrant settlement;
4. delivers at least `minOut` of the selected output asset to the recovered user;
5. releases the RBTC escrow identified by `btcTxid` to the solver; and
6. emits the settlement event.

The whole call reverts if any check or transfer fails. The user either receives the required output and
the solver receives the input, or neither happens. A failed solver loses gas, but `H` remains solvable
until `E`.

The VM provides the bundle semantics; no block-construction change is required. A consensus-level
bundle could be added later if miner-controlled pairing, ordering, MEV protection, or multi-intent
settlement becomes necessary.

## Expiry, replay, and reorganisation

Expiry uses an absolute block height with a short maximum horizon. After a reorg, the intent is assessed
against the new canonical state and height. If the removed branch contained a settlement, both the
delivery and the consumed marker disappear, allowing the intent to be solved again if it has not
expired.

The interaction with fork-aware consensus under RSKIP555 remains to be settled before the validity
rules are finalised.

## Bitcoin-backed anti-spam ticket

v1 uses a processed Bitcoin peg-in as the admission ticket. Requiring a real Bitcoin event makes free
mempool admission costly enough to resist trivial spam and keeps the first version focused on the
Bitcoin-to-Rootstock flow. General-purpose ticketless intents are out of scope.

The ticket and the economic input are related but not yet unified in the PoC. `depositForPegin` models
the peg-in credit to the settlement contract. Production needs the Bridge or federation to credit that
contract and bind the escrow to `btcTxid` directly.

Because the production design escrows the peg-in in the contract, expiry also needs a defined recovery
path. It is not sufficient to say that an ordinary peg-in automatically leaves the funds in the user's
account: in this architecture, the contract is the beneficiary.

# Rationale

Signing, broadcasting, and paying are deliberately separate. The user signs the constraints; anyone
may relay the authenticated bytes; the solver pays when settlement is profitable. A relay cannot alter
or forge the intent, and another party can rebroadcast if it delays delivery.

The public mempool provides common admission and discovery without requiring a privileged bundler. It
does not itself guarantee settlement. Liveness depends on solvers being able to discover the intent,
obtain the pipeline reveal, and identify a positive spread.

Commit/reveal is front-running protection rather than privacy. A solver must see the pipeline to price
it. The reveal mechanism must not quietly turn the dApp into the only liveness provider; v1 should at
least require reveal to any eligible bonded solver.

Finally, a competitive solver set cannot be assumed at launch. The accurate claim is that entry can be
permissionless from activation, while profitable participation may still depend on capital,
reputation, and access to reveals.

# Backwards compatibility

The transaction subtype is additive and depends on the RSKIP543/545/546 namespace. Existing
transaction types are unchanged.

On public networks, the new precompile must be registered through an activation-gated address list.
Adding it to `GENESIS_ADDRESSES` would alter historical state roots and prevent patched nodes from
re-syncing existing chains. The PoC now gates the parser through `CONSENSUS_ENABLED_ADDRESSES`, although
its settlement contract is still genesis-deployed on regtest.

# Reference implementation and tests

The PoC patches the RSKIP543/545/546 branch of rskj (PR #3558). It adds subtype recognition, the
activation-gated zero-cost path, pre-inclusion checks, miner exclusion, a stateless parsing precompile,
and a fixed-address settlement contract. A TypeScript SDK builds and signs intents, while a toy solver
drives settlement.

Each experiment is an attempt to falsify a claim:

- **E1:** a fresh, zero-balance account's intent is admitted.
- **E1b:** the admitted intent is gossiped to a peered node.
- **E2:** an expired intent is rejected and leaves nothing on-chain.
- **E3:** a settled `H` cannot be submitted again.
- **E6:** under-delivery reverts without consuming `H`.
- **E7:** settlement delivers at least `minOut` and consumes `H` atomically.
- **E8/E8+:** a bogus Bitcoin ticket is rejected and a processed peg-in ticket is accepted.
- **E9:** reverting the settlement state restores both delivery and solvability.
- **E10:** the output may be an ERC-20.
- **E11:** failed settlement produces a visible failed receipt and leaves `H` untouched.
- **E12:** the solver receives the escrowed peg-in input after delivering the output.
- **E13:** intents are rejected before activation and admitted afterwards.

# Implementation status

As of 1 September 2026, the PoC has exercised milestones 1–4 on patched rskj regtest nodes:

- Mempool admission and gossip establish the two pre-inclusion claims.
- Atomic VM settlement closes the original consumption-griefing hole.
- Contract-based settlement adds ERC-20 outputs and visible revert semantics.
- Escrow release repays the solver and provides the spread.
- A dedicated consensus rule gates intent admission, the zero-cost path, and the parser.

The positive ticket path registers a genuine regtest peg-in through public `receiveHeader` and
`registerBtcTransaction` calls. E9 uses `evm_snapshot`/`evm_revert` to exercise ordinary state
reversion; a real two-miner partition and merge has not been tested.

Two implementation details are especially important. First, rskj encodes a zero `gasPrice` as a raw
`0x00`, while zero `value` and `nonce` use `0x80`; an SDK that misses this difference recovers the wrong
sender. Second, exceptions thrown by a raw precompile do not currently propagate as failed receipts.
The current design resolves the latter by keeping stateful settlement in the VM and using the precompile
only for parsing.

Still outstanding are production peg-in-to-contract crediting, an expiry recovery path for escrow,
fork-block deployment of the settlement contract, solver discovery and reveal rules, bonding, price
competition, and any future consensus-level bundle.

# Open questions

- Should the intent use an SDK-derived EVM key or a signature recoverable from the Bitcoin input?
- Should the Bitcoin transaction contain enough data to derive the entire intent and remove the
  separate broadcast step?
- How should admission behave while a valid Bitcoin event is not yet visible to the Bridge?
- How should expired, unsolved escrow be returned safely?
- How should old consumed entries be pruned, and how should RSKIP555 affect validity?
- What solver reveal, bonding, and competition rules are needed for launch?

# References

- RSKIP36 — EXECUTE opcode and sponsorship-only prior work.
- RSKIP138 — multi-signed enveloping and sponsorship-only prior work.
- RSKIP543, RSKIP545, and RSKIP546 — typed transactions and the `0x02` RSK namespace; rskj PR #3558.
- RSKIP555 (Draft) — fork-aware consensus.
- EIP-155 — replay-protected signing.
- EIP-2718 — typed transaction envelopes.
- ERC-4337 — off-protocol account abstraction and its alternative mempool.
- RIP-7560 — Ethereum's native account-abstraction direction.
- `RSKIP-draft-native-intent-fees.md` — companion fee mechanics.
