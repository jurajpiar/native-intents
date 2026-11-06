---
rskip: XXX
title: Native intent transactions
description: A mempool-only transaction type carrying signed constraints, settled by a third party through an ordinary transaction.
status: Draft
purpose: Usa
author: JP (@jurajpiar)
layer: Core
complexity: 3
created: 2026-09-04
---

# Native intent transactions

|RSKIP          |XXX          |
| :------------ |:-------------|
|**Title**      |Native intent transactions |
|**Created**    |04-SEP-2026 |
|**Author**     |JP |
|**Purpose**    |Usa |
|**Layer**      |Core |
|**Complexity** |3 |
|**Status**     |Draft |

## Abstract

This proposal adds a transaction type in which the sender signs a set of constraints instead of
calldata. The transaction pays no gas and is never included in a block. Nodes validate it, hold it in
the mempool and relay it. A third party reads it from the mempool and fulfils it by sending an
ordinary, gas-paying transaction to a designated contract, which delivers at least the signed minimum
output to the sender and pays the third party from value the sender pegged in from Bitcoin.

The proposal defines: the transaction envelope and its signing scheme; the 160-byte constraint
payload; the rule that such a transaction costs nothing; the conditions under which a node admits it;
the requirement that block producers exclude it; two precompiled contracts, one that parses and
authenticates the transaction and one that owns the set of already-fulfilled constraints; one new
Bridge query; and two contracts installed at activation, one that performs settlement and one that
runs an optional price auction.

The result is that an account holding no RBTC and sending no Rootstock transaction can have value
arriving from Bitcoin converted into a chosen asset on Rootstock.

## Terminology

Defined here and used consistently below.

- **Intent** — a transaction of the type defined by this proposal. It carries constraints, not
  calldata, pays no gas, and is never mined.
- **User** — the account that signed the intent. Recovered from the signature; never charged.
- **Solver** — any account that fulfils an intent by calling the settlement contract. Pays the gas.
- **Peg-in** — a Bitcoin transaction that credits value on Rootstock through the Bridge.
- **Input** — the pegged-in value associated with an intent. Held by the settlement contract, not by
  the user, because native currency cannot be taken from an account without a transaction from it.
- **`minOut`** — the smallest amount of the output asset the user will accept. Signed by the user and
  enforced during settlement.
- **Spread** — the difference between the value of the input and the value of `minOut`. This is the
  solver's revenue; the protocol neither sets nor collects it.
- **`H`** — a 32-byte value the user chooses, unique per intent. It identifies the intent and is the
  key of the consumed set. No rule constrains how it is produced.
- **Consumed set** — the record of which `H` values have been settled. It prevents an intent from
  being settled twice. It serves the same purpose for intents that the account nonce serves for
  ordinary transactions.
- **Binding** — `keccak256(H ‖ signer)`. Ties an input to one intent and one signing key.
- **Ticket** — the `btcTxid` field of an intent, which must name a peg-in the Bridge has already
  processed. It is what makes a free transaction cost something to produce.
- **Fronting** — a solver delivering the output before the peg-in is final, accepting Bitcoin
  reorganisation and capital-time risk in exchange for a larger spread.

## Motivation

Two properties are required and cannot be obtained from contract code, because contract code runs
only after a transaction has been included in a block.

**Mempool admission for an account that cannot pay.** Admission happens before the EVM runs. A signed
message from an account with a zero balance can become a relayed mempool object only if the node
treats it specially. A contract cannot cause this. ERC-4337 addresses the same limitation by running a
second, off-protocol mempool with its own relayers.

**Rejection before inclusion.** An expired or already-settled intent is refused at admission. It
occupies no block space and costs nobody gas. The contract-level equivalent consumes both, even when
it reverts.

Everything else this proposal contains — constraint checking, the settlement contract, the auction —
is ordinary contract work and does not by itself justify a consensus change. It is specified here
because the two properties above are useless without a settlement path, and because the contracts that
provide that path are installed at activation and therefore cannot be changed without a further
network upgrade.

The intended use is value arriving from Bitcoin. A user with bitcoin and no RBTC signs one Bitcoin
transaction and one intent, and receives a chosen Rootstock asset without ever holding RBTC or sending
a Rootstock transaction.

Two costs of that outcome are stated here rather than in the Rationale, because they are properties of
the design and not of any implementation. A funded party must send one Rootstock transaction to
register the peg-in before the intent becomes admissible, so the flow is free for the user and not for
everyone. And a solver chooses whether to front; if none does, the user waits for the peg-in to
finalise.

## Specification

### Overview

In order:

1. The user picks `H`, fixes a signing key, and computes `binding = keccak256(H ‖ signer)`.
2. A deposit address is derived from that binding under RSKIP-176. The user pays it in Bitcoin. This
   fixes `btcTxid`.
3. The user signs an intent over `(H, btcTxid, E, minOut, outputToken)`.
4. Once the Bitcoin transaction has the Bridge's required confirmations, a funded party registers the
   peg-in. The settlement contract now holds the input, bound to `binding`.
5. The intent is broadcast. Any party may broadcast it; the bytes authenticate themselves. Nodes admit
   and relay it, and block producers exclude it from blocks.
6. A solver reads the intent from the mempool and calls `settle` with its raw bytes. In one
   transaction the settlement contract marks `H` consumed, delivers at least `minOut` to the user, and
   releases the input to the solver.
7. Any later intent carrying the same `H` is refused at admission.

Steps 1 to 3 involve no chain. Step 5 cannot precede step 4, because admission requires the ticket to
be visible.

### Transaction type

An intent uses the RSK typed-transaction namespace of RSKIP-543:

```
0x02 || rsk-tx-type || rlp([nonce, gasPrice, gasLimit, to, value, data, v, r, s])
```

`0x02` is the namespace prefix. `rsk-tx-type` selects the subtype; **`0x49` is proposed** and the final
value is assigned on acceptance. The body reuses the nine-field legacy layout, so no new outer encoder
is required.

For a non-zero chain ID the signing hash is:

```
keccak256(
  0x02 || rsk-tx-type ||
  rlp([nonce, gasPrice, gasLimit, to, value, data, chainId, "", ""])
)
```

The signature follows EIP-155, with `v = yParity + chainId * 2 + 35`. The chain ID MUST be non-zero.
The signature MUST be canonical: `s` MUST be in the lower half of the curve order, as required for all
Rootstock transactions.

`to` MUST be the settlement contract address. `gasPrice` and `value` MUST both be zero.

The sender is recovered from the signature. A wallet SHOULD use a fresh key for each intent, so that
uniqueness comes from `H` rather than from an account nonce.

**Encoding requirement.** Rootstock's RLP encodes a zero `gasPrice` as the single byte `0x00`, and a
zero `value` or `nonce` as the empty string `0x80`. A signer MUST reproduce this exactly. A generic RLP
encoder produces different bytes, a different signing hash, and recovery to a different address.

### Signed payload

`data` MUST be exactly 160 bytes, five 32-byte words:

```
data = H (32) || btcTxid (32) || expiryHeight E (32) || minOut (32) || outputToken (32)
```

- `H` — the intent identifier. Any 32 bytes. No rule inspects its provenance, and settlement never
  requires a preimage.
- `btcTxid` — the ticket, and the key of the input escrow. Big-endian display order, as Bitcoin
  reports it.
- `E` — the absolute Rootstock block height at which the intent expires. MUST be representable in 63
  bits.
- `minOut` — the minimum output. Denominated in the smallest unit of `outputToken`.
- `outputToken` — a 32-byte word holding a 20-byte address right-aligned. The zero address means
  native RBTC. Any other address means that ERC-20 token.

The value `0x…01000023` is **reserved** as an `outputToken` sentinel meaning that the output is
Bitcoin, delivered on Bitcoin. That path is not specified in this proposal. An implementation of this
proposal alone MUST refuse the sentinel in `settle`.

### Transaction cost

When the rule of this proposal is active, an intent's transaction cost is zero. Balance and
account-existence checks therefore do not reject a sender that holds nothing.

### Mempool admission

A node MUST refuse an intent unless all of the following hold. The order is the order in which a node
reaches them; each check may assume the previous ones passed.

1. The rule of this proposal is active at the current best height.
2. The signature is valid and canonical, and the chain ID matches the node's.
3. `data` is exactly 160 bytes.
4. `E` is representable in 63 bits.
5. The current best height is below `E`.
6. `H` is not in the consumed set.
7. `btcTxid` names a peg-in the Bridge has already processed.

Rules 1 to 7 are validity rules: they define what an admissible intent is, and a node MUST apply all
of them.

**Separately, a node MUST bound how far into the future `E` may be**, and MUST refuse an intent whose
`E` exceeds that bound. The bound is node configuration, not a consensus rule, for the same reason a
minimum gas price is node configuration under RSKIP-09: it limits how long a node is willing to hold
an object, not whether the object is well formed. Nodes MAY choose different bounds. A consequence
MUST be stated plainly: a valid intent may be held by some nodes and refused by others, so relaying is
best-effort and a wallet cannot assume network-wide propagation.

Refusals at any of these points leave no on-chain trace and consume no gas.

### Block production

A block producer MUST exclude intents from candidate blocks. An intent never appears in a block. The
settlement transaction that fulfils it is an ordinary transaction and is mined normally. Proof-of-work
and merged mining are unaffected.

### Parsing precompile

A precompiled contract at a designated address accepts the raw intent transaction as its entire input
and returns

```
abi.encode(address user, bytes32 H, bytes32 btcTxid, uint256 E, uint256 minOut, address outputToken)
```

which is 192 bytes. It reconstructs the signing hash, recovers the user, and verifies that the input
is an intent with a 160-byte payload. It reads and writes no state and is safe under `STATICCALL`. On
malformed input it fails, so a caller's `STATICCALL` returns failure.

This exists because reconstructing the namespace signing hash and recovering the signer cannot be done
safely or affordably in contract code. Reference gas cost: 30 000.

### Consumed-set precompile

A precompiled contract at a designated address owns the consumed set.

- `isConsumed(bytes32 H) returns (uint256)` — zero if `H` has not been settled, otherwise the block
  height at which it was marked, plus one. Readable by anyone, safe under `STATICCALL`.
- `markConsumed(bytes32 H) returns (uint256)` — records `H` and returns the marker written.

`markConsumed` MUST fail unless the immediate caller is the settlement contract. It MUST fail under
`STATICCALL`. It MUST fail if `H` is already recorded.

The storage key MUST be a domain-separated derivation of `H`, not `H` itself. The reference derivation
is `keccak256(utf8("intentConsumed-" ‖ hex(H)))`. Mempool admission reads this contract's address with
the identical derivation.

Both requirements are load-bearing and are explained in the Rationale. The derivation MUST be fixed
before the first settlement occurs: markers written under one derivation are invisible under another,
so a later change would make every settled `H` available again.

Reference gas costs: 800 for the read, 20 000 for the write.

### Bridge query

The Bridge gains one method, available only when this proposal's rule is active:

- `getPeginInfo(bytes32 btcTxid) returns (bytes)` — 64 bytes, being the peg-in's destination address
  and amount as two 32-byte words, or empty if the Bridge has no record.

The Bridge records these two values when it processes a peg-in. The method is read-only and callable
with `STATICCALL`. Reference gas cost: 30 000. It exists so the settlement contract can release
exactly the amount that was pegged in, to the account it was pegged in for.

### Settlement contract

A contract is installed at a designated address at activation. Its behaviour is part of this proposal
because it is installed by the upgrade and because the consumed-set precompile grants it, and only it,
the ability to mark an intent settled.

`settle(bytes rawIntentTx)` MUST, in this order:

1. Call the parsing precompile and fail unless it returns 192 bytes.
2. Fail if the recovered user is the zero address, or if `outputToken` is the reserved Bitcoin
   sentinel.
3. Fail if the current height is not below `E`.
4. If an auction is open for `H`, fail unless the caller is the auction contract.
5. Fail if `H` is already consumed.
6. Call `markConsumed(H)`. This MUST happen before any value moves, so that a re-entrant `settle` for
   the same `H` fails at step 5.
7. Deliver at least `minOut` of `outputToken` to the user.
8. Release the input to the caller.

For an ERC-20 output, delivery MUST be verified by the **change in the user's balance** across the
transfer, not by the transfer's return value. A token that charges a fee on transfer moves less than
it reports, and a non-conforming token may report success having moved nothing; a return-value check
would let settlement consume `H` and release the input while the user received less than they signed
for. An implementation SHOULD also accept an empty return from the transfer, because tokens predating
the finalised ERC-20 return no data; the balance check is what makes accepting silence safe, since an
address that is not a token also returns nothing and moves nothing, and so fails the balance check.

The input MUST be released only to a caller presenting an intent whose binding matches. The escrow
records `keccak256(H ‖ signer)` and settlement re-derives it from the signature-recovered user.
Binding to `btcTxid` alone, or to `H` alone, is insufficient; the Rationale explains why.

Any failure MUST revert the whole call. Either the user receives the output and the solver receives the
input, or neither happens. A failed attempt costs the solver gas and leaves the intent available until
`E`.

Payments to solvers MUST NOT depend on a transfer succeeding. If a recipient cannot accept native
currency, the amount MUST become a credit that the recipient can withdraw later. Such a transfer
SHOULD carry a bounded gas stipend rather than forwarding the remaining gas; the reference value is
30 000. Payment to the **user** remains a hard requirement: if the user cannot receive the output,
settlement MUST fail.

The contract MUST provide a read of the consumed set for callers, and MUST provide a path by which the
input can be recovered by the user after `E` if no solver acted. The recovery path is not fully
specified here; see Open questions.

The same contract also implements settlement for the reserved Bitcoin-output sentinel. That path is
specified separately and is out of scope for this proposal.

### Auction contract

A second contract is installed at a designated address at activation. It allows solvers to bid above
`minOut`, returning part of the spread to the user.

- A bid MUST exceed `minOut` and the current best bid, and MUST be escrowed when placed. Native bids
  are escrowed by value; ERC-20 bids by transfer, verified by balance change exactly as in settlement.
- The first valid bid opens a bidding window of a fixed number of blocks. The window MUST NOT extend
  beyond `E`.
- While an auction is open for `H`, the settlement contract MUST refuse any caller other than the
  auction. This closes the path where a solver ignores a standing higher bid and settles at `minOut`.
- After the window closes, anyone MAY trigger execution. Execution settles at the winning bid and
  pays the amount above `minOut` to the user.
- Exclusivity MUST be releasable, so that an auction which cannot execute does not hold an intent
  until `E`. The release MUST be triggered by an execution attempt that was **observed to fail**, and
  MUST NOT be triggered by elapsed time alone. The Rationale explains why.
- An execution attempt MUST require a gas floor comfortably above a settlement's cost before making
  the inner call. The reference value is 500 000.
- An outbid bidder MUST be able to reclaim its escrow, and MUST NOT be able to block a higher bid by
  refusing payment. All payouts follow the credit rule above.

Reference values: bidding window 10 blocks, release delay after an observed failure 10 blocks.

### Activation

This proposal is gated by a dedicated consensus rule. Before its activation height the zero-cost path,
the admission rules, both precompiles and both contracts are inert. At the activation height the
precompiles become callable and the two contracts are installed.

RSKIP-543, RSKIP-545 and RSKIP-546 MUST already be active. The activation height is TBD.

### Parameters

Every value this proposal fixes or leaves open.

| Parameter | Reference value | Status |
|---|---|---|
| `rsk-tx-type` subtype | `0x49` | proposed; assigned on acceptance |
| Payload length | 160 bytes | fixed |
| Parsing precompile gas | 30 000 | reference |
| `isConsumed` gas | 800 | reference |
| `markConsumed` gas | 20 000 | reference |
| `getPeginInfo` gas | 30 000 | reference |
| Consumed-set key derivation | `keccak256(utf8("intentConsumed-" ‖ hex(H)))` | reference; MUST be fixed before first use |
| Expiry horizon | 100 blocks in the reference implementation | **node configuration, not consensus** |
| Payment gas stipend | 30 000 | reference |
| Auction bidding window | 10 blocks | reference |
| Auction release delay | 10 blocks after an observed failure | reference |
| Auction execution gas floor | 500 000 | reference |
| Activation height | — | TBD |

The reference values were chosen for a test network. None of them has been justified for mainnet.

## Rationale

**Why the sender signs constraints rather than calldata.** A user whose value is arriving from Bitcoin
cannot pay for execution and cannot know, at signing time, what execution will be available. Signing a
bound on the outcome delegates the route to whoever can serve it, without delegating custody: the user
receives at least what they signed for or nothing happens.

**Why the solver takes the input rather than a fee.** A separate fee would need separate funding, which
is the thing the user does not have. Paying through the spread makes the exchange self-funding. A fixed
protocol fee would also misprice risks that vary by asset, size, volatility, capital cost and
confirmation depth.

**Why the intent is never mined.** It pays nothing, so including it would be unpriced block space. It
carries no execution, so there is nothing to execute. Keeping it out of blocks also means an intent
that is never settled leaves no permanent record.

**Why the consumed set is a precompile and not contract storage.** An earlier version of this design
put it in the settlement contract at storage slot `H`. That is unsafe, and the reason generalises past
any one implementation. Solidity places `someMapping[k]` at `keccak256(abi.encode(k, declarationIndex))`
— a public formula over public inputs — while `H` is 32 bytes the user chooses and no rule constrains.
An attacker can therefore compute the storage address of a chosen mapping entry, sign an intent whose
`H` is that address, and have settlement write into a variable the contract believes only it can reach.
This was measured on a node, not reasoned about: a flag guarding a peg-in claim was set with no peg-in
ever claimed, and poisoning the binding entry for a not-yet-registered `btcTxid` made that input
permanently unclaimable, because the deposit path refuses any binding that disagrees with what is
already stored. The attacker learns the victim's `btcTxid` from Bitcoin, roughly a hundred
confirmations before registration can occur.

Two requirements follow. The set MUST have a namespace nothing else shares — its own address, and a
domain-separated key within it. And the node and the precompile MUST derive that key identically,
because a divergence would leave admission reading a permanently empty location and silently ceasing to
refuse settled intents.

Placing it in a precompile does not enlarge the consensus surface. Mempool admission reads it, so every
node must agree on it either way; under the contract-storage design that agreement was on a contract's
bytecode, which is the same obligation wearing different clothes. It is also where the state belongs:
the consumed set does for intents what the account nonce does for ordinary transactions, and nonces are
node state.

**Why `markConsumed` is restricted to one caller.** Without the restriction, anyone could mark any `H`
consumed and destroy a stranger's intent for the price of gas. That would be worse than the problem the
precompile solves.

**Why the input binds to `keccak256(H ‖ signer)`.** Binding to `btcTxid` alone lets anyone who sees the
peg-in create a rival intent naming it and claim the input. Binding to `H` as well is not enough: `H`
travels in the clear in every intent in the mempool, and settlement recovers the user from the
signature, so an attacker can copy a victim's `H` and `btcTxid` into an intent of their own asking for a
trivial `minOut`, and be paid that trivial amount while a solver takes the whole input and `H` is
consumed. The victim's own intent is then permanently unsettleable. The signature is the only part a
rival cannot forge, so the binding must commit to it. RSKIP-176's derivation inputs — the refund
address, the liquidity-bridge contract, the liquidity provider — include no Rootstock signer, so the
derivation argument must be this pair rather than `H`.

**Why delivery is checked by balance change.** Stated in the Specification because it is normative. The
reason is that a return value describes what a token claims, and settlement must depend on what the
user received.

**Why auction exclusivity is released by observed failure and not by elapsed time.** Releasing after a
period hands the intent to whoever withholds the auction's execution: wait out the period, then settle
at `minOut` around a higher standing bid. For a native-currency output the elapsed-time form has no
legitimate trigger at all, because an auction holding the winning bid cannot fail to fund the settlement
it wraps. The execution attempt must therefore catch the failure and record it without reverting — a
revert would roll back the record the release reads — and must require a gas floor first, or EIP-150's
63/64 forwarding rule lets anyone under-gas the attempt so the inner settlement dies while the recording
survives, releasing a healthy auction on demand.

**Why block-denominated deadlines are stated as a limitation rather than fixed.** An auction's window is
a block count, which behaves as elapsed time for ordinary participants and as a controllable counter for
whoever produces blocks. A producer can bid the floor and mine out the window so no rival enters.
`minOut` still binds and the consumed set still admits one settlement, so this costs price discovery
rather than principal — but price discovery is the auction's only product. Timestamps do not fix it: a
block's timestamp must exceed its parent's but may run ahead of real time by the network's future-time
allowance, so a producer can still close any practical window at once, merely not repeatedly. The
structural answer is that price discovery denominated in on-chain time is capturable by whoever orders
blocks. This proposal specifies block heights and records the consequence.

**Why the expiry horizon is node configuration.** It limits how long a node will hold an object, not
whether the object is well formed. Two honest nodes may reasonably disagree, exactly as they may
disagree about a minimum gas price. Making it consensus would require fixing a value, and the only
values examined so far are known to be wrong: the reference 100 blocks is about fifty minutes against a
peg-in wait of roughly two thousand blocks.

**Why the ticket is a validity rule.** Unlike the horizon, it defines what an intent references. A node
cannot apply it selectively without changing what an admissible intent is. It is also the only cost
behind a free object. Its weakness is recorded under Open questions: as specified, one peg-in satisfies
it for any number of intents.

## Backward compatibility

This proposal requires a network upgrade and every node must update.

The transaction type is additive within the RSKIP-543 namespace and behind its own activation rule.
Existing transaction types are unchanged. Existing contracts are unaffected: nothing in this proposal
alters the semantics of any current opcode, precompile or Bridge method, and the one Bridge addition is
read-only.

Because intents never appear in blocks, clients that verify block contents need not understand the
envelope. They continue to observe ordinary settlement transactions and the resulting state changes.

Two designated addresses receive code at activation and one receives state. Any account already
existing at those addresses would conflict; the addresses are reserved and unused.

## Implementations

A reference implementation exists as a patch on the rskj typed-transaction branch (PR #3558, which
implements RSKIP-545 and RSKIP-546 and contains nothing of this proposal). The node-side change is
573 lines across 17 files, four of them new: the admission checks, the shared constants, the parsing
precompile and the consumed-set precompile. The remainder is the zero-cost rule, the activation rule,
the block-producer exclusion, the precompile registrations, the Bridge query and the genesis entries.

The two contracts are compiled with solc 0.8.19 and installed as runtime bytecode at activation.

Two implementation notes that cost significant time and are not documented elsewhere:

- A stateful precompile in rskj MUST extend `Bridge`, `RemascContract` or `NativeContract`. The VM
  builds precompile arguments and calls `init()` only for those three types, so any other base class
  receives no repository and every call fails as an unexplained failure with no message. The stateless
  parsing precompile is unaffected because it needs no state. `NativeContract` does not expose the
  calling frame, so the caller restriction on `markConsumed` requires capturing the program invoke
  during `init` and reading the owner address from it.
- Rootstock reports a non-canonical (`s` in the upper half) signature as an invalid chain ID, because
  the chain-ID check and the signature-component check share one error path. A signer that does not
  normalise `s` will be told its chain ID is wrong.

## Test cases

The reference suite treats each case as an attempt to disprove one claim, and separates three
questions: whether a claim is false, whether a stated adversary wins, and how much something costs.

Covered, on a patched test network and against a real bitcoind where relevant: admission and relaying
of a zero-balance sender's intent; free rejection of an expired intent; refusal of a replay after
settlement; atomic settlement with native and ERC-20 outputs; visible failure of a failed settlement;
single-node and two-node reorganisation; the activation gate; peg-in binding with a real peg-in;
capture of a rival intent's escrow; competing solvers; both auction forms including credit fallbacks
and failure-triggered release; and settlement by a solver given nothing but a node's RPC address, which
is the case the Motivation depends on.

Adversarial cases are recorded with their outcomes, including those that succeed. Two are relevant to
this specification's requirements: the storage-aliasing attack described in the Rationale, and a
measurement showing that one peg-in satisfies the ticket rule for at least forty-one intents.

Test cases for the consumed-set derivation are mandatory, in both directions: a settled `H` MUST be
refused at admission, and an admission that stops refusing settled intents MUST fail the suite. A
divergence between the node's derivation and the precompile's is otherwise silent.

## Open questions

These are unresolved. Each is a decision this proposal does not make.

1. **What the ticket should bind.** As specified, the rule asks only whether the referenced txid is a
   processed peg-in. Nothing binds it to the signer, counts how many intents name it, or deduplicates.
   One peg-in therefore admits an unbounded number of intents, measured at forty-one before the test
   was stopped. Checking that an escrow bound to `keccak256(H ‖ signer)` exists would make the cost one
   Bitcoin transaction per intent, which is the design's own premise; it would also require an escrow
   marker whose namespace must be separated from the consumed set for the reason given in the
   Rationale. This is not adopted here because it makes admission strictly later, which interacts with
   question 2.

2. **Who registers the peg-in, and when the intent may be broadcast.** Requiring a visible ticket means
   registration must precede broadcast, which excludes a solver that learns of intents from the mempool
   and leaves a funded party as the registrant. It also forces the user to sign `E` roughly two
   thousand blocks before admission tests it, against a Bitcoin wait whose standard deviation is larger
   than the reference expiry horizon. Alternatives: admit an intent whose ticket is not yet visible;
   accept a Bitcoin transaction at shallow depth by carrying an inclusion proof in the envelope, which
   requires a variable-length payload; or size the expiry horizon to absorb the wait. Fronting, which
   the Motivation names as the source of any fast experience, requires solvers to see the intent before
   registration, so as specified the mempool is closed for exactly the window fronting occupies.

3. **Recovery of an unclaimed input.** If no solver settles before `E`, the input remains with the
   settlement contract. An authenticated path returning it to the user's refund address is required and
   is not specified. RSKIP-379's rejected-peg-in handling covers a different case: a peg-in that was
   never credited, rather than one credited and unused.

4. **Whether the auction should be enforced at all.** As specified, exclusivity is a settlement rule,
   which makes auction policy a consensus matter. The alternative is optional market infrastructure
   that a solver may bypass by settling at `minOut`, with bidders able to reclaim. This proposal
   surfaces the choice; it does not resolve it.

5. **Interaction with fork-aware consensus.** RSKIP-555 changes how validity is evaluated across
   branches. The consequences for expiry and for the consumed set must be settled before these validity
   rules are final.

6. **Consumed-set growth.** The set only grows. Pruning, lazy deletion and bounded growth need
   evaluation, alongside question 5.

7. **Parameter values.** Every entry marked "reference" in the parameter table was chosen for a test
   network. None has been justified for mainnet.

## References

\[1] [RSKIP-09: Negotiated Minimum Gas Price](https://github.com/rsksmart/RSKIPs/blob/master/IPs/RSKIP09.md) — precedent for treating a mempool resource limit as node configuration rather than consensus.

\[2] [RSKIP-176: Programmable Peg-in Addresses](https://github.com/rsksmart/RSKIPs/blob/master/IPs/RSKIP176.md) — carries the input binding into the Bitcoin deposit address.

\[3] [RSKIP-379: Bridge peg-out and migration transactions index](https://github.com/rsksmart/RSKIPs/blob/master/IPs/RSKIP379.md) — the REGISTER, REFUND and NO_REFUND peg-in outcomes. Covers a rejected peg-in, not a credited but unused one.

\[4] [RSKIP-543: Typed Transactions](https://github.com/rsksmart/RSKIPs/blob/master/IPs/RSKIP543.md) — defines the `0x02 || rsk-tx-type` namespace this proposal uses. Required.

\[5] [RSKIP-545: EIP-7702 Account Abstraction](https://github.com/rsksmart/RSKIPs/blob/master/IPs/RSKIP545.md) — required.

\[6] [RSKIP-546: Type 1 and Type 2 envelope encoding](https://github.com/rsksmart/RSKIPs/blob/master/IPs/RSKIP546.md) — required.

\[7] [RSKIP-555: Fork-Aware Consensus module](https://github.com/rsksmart/RSKIPs/blob/master/IPs/RSKIP555.md) — interaction unresolved, see Open questions.

\[8] [EIP-155: Simple replay attack protection](https://eips.ethereum.org/EIPS/eip-155) — the signing scheme.

\[9] [EIP-150: Gas cost changes](https://eips.ethereum.org/EIPS/eip-150) — the 63/64 gas forwarding rule, relevant to the auction's execution gas floor.

\[10] [ERC-4337: Account Abstraction using alt mempool](https://eips.ethereum.org/EIPS/eip-4337) — obtains a similar result through a separate, off-protocol mempool.

## Copyright

Copyright and related rights waived via [CC0](https://creativecommons.org/publicdomain/zero/1.0/).
