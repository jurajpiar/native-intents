# Native intents: the case, the evidence, and what is unresolved

This document holds everything that is not a consensus specification: why the change is being
proposed, what a reference implementation demonstrated, what has been measured, which decisions are
still open, and what would make the answer "no".

The specification itself is [RSKIP-native-intent-transactions.md](RSKIP-native-intent-transactions.md).
That document states what nodes must implement and deliberately makes no argument. This one makes the
argument and states its weaknesses.

Terms used below are defined in the RSKIP's Terminology section.

## 1. The problem

A person holds bitcoin and no RBTC. They want a position on Rootstock — a token, a vault share, an LP
position. Today they must first acquire RBTC to pay for gas, which means either an exchange, a faucet,
or someone sending them RBTC. The asset they hold cannot pay for the transaction that would put it to
work.

This is not a niche case. It is the default state of every new Rootstock user arriving from Bitcoin,
which is the population Rootstock exists to serve.

## 2. What the user gets

One Bitcoin transaction and one signature. No RBTC, no Rootstock transaction, no prior balance.

The value arriving from Bitcoin is converted into a chosen asset by whoever will do it cheapest, and
the user is protected by a bound they signed: they receive at least `minOut` of the asset they named,
or nothing happens.

## 3. What it costs, stated up front

Two costs are properties of the design, not of the implementation, and neither is small.

**A funded party must send one Rootstock transaction.** The peg-in has to be registered before the
intent is admissible. The user cannot do it — they have no RBTC, which is the whole premise. So the
flow is free for the *user*, not for everyone. In practice the registrant is the wallet's own backend,
which makes that backend a liveness dependency: precisely the named counterparty a payer-less design
exists to remove. A wallet that is only a key manager cannot complete the flow alone.

**Speed depends on someone choosing to take risk.** Trust-minimised settlement can release the input
only after the Bridge accepts the peg-in, which on mainnet means 100 Bitcoin confirmations — a mean of
16.7 hours. A solver may deliver earlier and accept Bitcoin reorganisation and capital-time risk. The
spread can price that risk. The protocol cannot remove it. Any claim that this is "instant" is a claim
about solver behaviour, not about the protocol.

## 4. Why this needs a consensus change

Two properties cannot come from contract code, because contract code runs only after inclusion.

**Mempool admission for an account that cannot pay.** A node must decide to hold and relay a signed
message from an account with no balance. Only the node can decide that.

**Rejection before inclusion.** An expired or already-settled intent is refused before it reaches a
block, costing no gas and consuming no block space.

**The honest state of this argument.** Both properties are real, and both were demonstrated. But
"contracts cannot do this" is a thinner claim than it first appears, in two specific ways.

ERC-4337 obtains a functionally similar result on Ethereum by running a second, off-protocol mempool
with its own relayer set. That is worse in identifiable ways — a separate network someone must
operate, a relayer set that can behave as a cartel, and no free pre-inclusion rejection — but it is not
impossible. So the accurate framing is not "impossible otherwise" but "a common, spam-bounded,
protocol-relayed channel with free rejection is worth a network upgrade". That is an
infrastructure-quality argument, and it should be made as one.

Separately, an internal parallel effort reaches a similar user outcome on existing rails, by
compensating the party that submits the transaction from within the same value flow rather than
changing the protocol. It is the relevant control experiment for whether the upgrade earns its keep,
and the two should be reconciled rather than argued independently.

**What survives as the strongest property is common discovery.** One public channel that every node
relays and any solver can watch, rather than bilateral relationships between wallets and chosen
solvers. This was measured, not assumed: a solver process given nothing but a node's RPC address, and
holding no reference to the user, the intent, or `H`, found the intent in the mempool, rebuilt its
signed bytes, and settled it. The user broadcast and stopped. Without that channel, a wallet must hand
each intent to a solver it has a relationship with, and whichever dApp holds those relationships
becomes the only liveness provider.

## 5. What was built, and what it demonstrated

A reference implementation on the rskj typed-transaction branch: 573 lines across 17 node files, two
contracts installed at activation, and a test suite that separates three questions.

| | Question | Count |
|---|---|---|
| Experiments | Is this claim false? | 25 |
| Attacks | Does this adversary win? | 37 |
| Measurements | How much? | 1 |

Demonstrated on a test network, and against a real bitcoind where the case required it:

- A zero-balance account's intent is admitted and relayed, including across two peered nodes.
- An expired intent is refused before inclusion, at no cost.
- A settled intent cannot be replayed: admission refuses it.
- Settlement is atomic for native and ERC-20 outputs, and a failed settlement fails visibly.
- Delivery, consumption and input release all revert together under single-node and two-node
  reorganisation.
- A real peg-in credits the contract, and settlement releases the amount that was actually pegged in.
- An input answers only to the intent and signing key it was deposited for.
- A solver holding only an RPC address can discover and settle an intent (section 4).

Adversarial results are recorded with their outcomes, including the ones that succeed. Of 37 cases,
20 are blocked, 6 are contained, 6 succeed, and 5 are not yet exercised. Two shaped the specification:

**One peg-in satisfies the ticket rule for any number of intents.** The rule asks only whether the
referenced Bitcoin transaction is a processed peg-in. Nothing binds it to the signer, counts uses, or
deduplicates. Forty-one intents were admitted against a single ticket before the test was stopped, each
with a fresh `H` and a fresh key. The ticket is therefore a one-time entry fee per attacker, not a cost
per message. This is the design's own anti-spam premise failing to hold.

**A chosen `H` could write into the settlement contract's storage.** The consumed set was kept at
storage slot `H`, and `H` is chosen freely by the user. Since Solidity places mapping entries at a
publicly computable address, an attacker could compute the address of a chosen entry, sign an intent
with that `H`, and settle — writing into a variable the contract believed only it could reach. A flag
guarding a peg-in claim was set with no peg-in claimed, and poisoning the binding entry for a
not-yet-registered Bitcoin transaction made that input permanently unclaimable. The exposure window was
the peg-in wait itself, because the attacker learns the transaction id from Bitcoin about a hundred
confirmations before registration can happen. Confirmed on a node, then closed by moving the consumed
set to a precompile with its own address and a domain-separated key.

The second result is worth dwelling on for a reason beyond the bug: it was a defect in the
*specification*, not in the implementation. The design said the consumed set was ordinary storage keyed
on `H` and that admission read that slot directly. Anything implementing the design as written would
have had the same hole.

## 6. What was measured

Three runs on a test network, over JSON-RPC, medians with bootstrap confidence intervals on
differences. Full data in `poc/measurements/`.

| | Figure |
|---|---|
| Per-intent cryptographic cost (signature validation and sender recovery) | **540 µs**, reproduced as 530, 539, 589 across three runs |
| Accepting an intent rather than refusing it (pool insert and relay) | **200 µs** |
| Each individual admission rule | below this method's resolution (±70–180 µs) |
| Pool insertion cost as the pool grew from 150 to 550 pending intents | no detectable trend |

Two things follow, and the second is more useful than the first.

The 540 µs figure is the denominator for any argument about adding work to admission. A Bitcoin merkle
branch check is roughly a dozen hash operations — single-digit microseconds — so it is around two
orders of magnitude below what the node already spends per intent. That comparison remains one-sided:
the numerator has not been measured, and it must include a storage read for the block header, not just
the hashing.

More usefully: **no individual admission rule is measurable from outside the node**, storage reads
included. That is a statement about the instrument, not about the rules. But it does dispose of an
implicit premise in the debate about the ticket rule — that a storage read is cheap while a carried
proof would be expensive. Neither side of that comparison resolves above noise, so the rule's
replacement cannot be decided on admission cost. The real costs are elsewhere: payload size, a
derivation that depends on the Bitcoin federation, and the header read.

What has *not* been measured is the question that matters most for a free object: sustained throughput
over the peer-to-peer path, rather than latency over JSON-RPC. An attacker does not use JSON-RPC.

## 7. What is not settled

In dependency order. These interact, and deciding any one of them in isolation is a mistake.

### 7.1 Whether an intent may be broadcast before its peg-in is registered

Everything else depends on this.

As specified, an intent is admissible only once its ticket is a processed peg-in. Three consequences
follow, and all three are unwelcome:

- **A funded registrant is required**, and becomes a liveness dependency (section 3).
- **`E` must be forecast.** It is signed before the Bitcoin transaction is broadcast, but admission
  does not test it until registration completes — roughly 2000 Rootstock blocks later, with a standard
  deviation of about 200 blocks, against a reference expiry horizon of 100. The two failure modes are
  not symmetric: an `E` too far ahead is free to retry, while an `E` already passed is fatal and leaves
  the input needing a recovery path that is not yet specified. So a wallet sets `E` late, and pays for
  it: the intent becomes admissible only near its own expiry, potentially many hours after the input
  was credited. A test network hides this entirely, because ten confirmations put the mean at 1.7 hours.
- **Fronting is impossible through the mempool.** Fronting means acting before registration. No solver
  can see the intent until after registration, by which point there is nothing left to front. The
  Motivation names fronting as the source of any fast experience, so as specified the mempool is closed
  for exactly the window that experience occupies.

Options:

| Option | Effect | Cost |
|---|---|---|
| Keep it | Status quo | The three consequences above. Fronting becomes bilateral, outside the mempool, and that must be said plainly |
| Drop the ticket, bound the pool instead | Removes all three | No cost behind a free object at all. Needs a residency bound and eviction policy to carry the whole load |
| Require a Bitcoin transaction at shallow depth, proof carried in the envelope | Removes all three, and keeps a real cost | Payload becomes variable-length and roughly 1 KB, so four times the relay volume per free object. Admission must derive an RSKIP-176 deposit address, which depends on the federation — if the federation rotates between signing and admission, honest intents start failing. Floor is one confirmation plus header-relay lag, not zero |

The third option would also close the ticket weakness from section 5, because checking that the
Bitcoin transaction pays the address derived from *this* intent's binding makes the cost one Bitcoin
transaction per intent. That is the design's own premise. The federation-derivation hazard is the part
that needs checking before it can be recommended.

### 7.2 What the ticket should bind

Only if 7.1 keeps a ticket. Checking that an escrow bound to `keccak256(H ‖ signer)` exists would fix
the weakness measured in section 5. But it makes admission strictly *later*, never earlier, so it pulls
against 7.1. Spam-bounded admission and frontable admission are in tension, and only the
proof-carrying option resolves both.

### 7.3 Recovery of an unclaimed input

If no solver acts before `E`, the input sits with the settlement contract. An authenticated path
returning it to the user's refund address is required and unspecified. This is not a corner case: 7.1
shows that a mis-forecast `E` reaches it by the normal route.

### 7.4 Whether the auction belongs in consensus

As specified, exclusivity is a settlement rule, which makes auction policy a consensus matter. The
alternative is optional infrastructure a solver may bypass by settling at `minOut`. There is a further
problem either way: an auction's bidding window is a block count, and whoever produces blocks controls
that counter. A producer can bid the floor and mine out the window so no rival enters. `minOut` still
protects the user's principal, so this costs price discovery rather than money — but price discovery is
the auction's only product. Timestamps do not fix it. Price discovery denominated in on-chain time is
capturable by whoever orders blocks, which argues for doing discovery off-chain and having the chain
enforce the floor and settle the result.

### 7.5 Everything the parameters leave open

Every value in the RSKIP's parameter table marked "reference" was chosen for a test network. The
Bitcoin confirmation depth for exits is the sharpest: the test value is 1.

## 8. Alternatives considered

**An off-protocol mempool, as ERC-4337 does.** Requires no network upgrade. Costs a separate relayer
network that someone must run and that can behave as a cartel, and gives up free pre-inclusion
rejection. This is the honest comparison for the whole proposal, not a strawman.

**Contract-only, with the user paying.** Fails the premise: the user has no RBTC.

**Bilateral solver relationships.** A wallet hands each intent to a solver it has an arrangement with.
Works today, needs nothing, and concentrates liveness in whichever dApp holds the relationships. This
is what the mempool channel exists to avoid, and it is also what the design falls back to for fronting
under 7.1.

**In-band compensation on existing rails.** Pay the submitting party from within the same value flow,
without changing the protocol. Pursued in parallel internally, and the reason the upgrade needs an
argument rather than an assumption.

**`OP_RETURN` peg-in carrying the commitment.** Considered and rejected: it needs a new per-transaction
Bridge record and still cannot carry the binding without changing the peg-in payload format or
exceeding Bitcoin's standard data-carrier limits. It would give owner-level rather than intent-level
binding.

## 9. Risks

Beyond the specification's own security considerations.

**Block producers can settle first.** A settlement transaction carries the whole authenticated intent
in its calldata, so any observer — a producer most cheaply — can settle the same intent first. The user
is unaffected, but the honest solver loses its gas and any output it pre-acquired. That taxes exactly
the participants the design needs. The auction lock mitigates it where an auction is open; bid-free
intents have no protection.

**Block producers can censor.** Transaction selection cannot be compelled, so a mining solver can
include only its own settlements. Liveness rests on "some producer will include a profitable
settlement", which is the same assumption relay markets make, but it should be stated rather than
assumed.

**Open entry is not a competitive market.** Permissionless entry is a consensus property. Profitable
participation may still require capital, inventory and reputation. The defensible claim is that entry
is open from activation, not that competition will exist.

**Solvers may simply not come.** An intent whose `minOut` leaves no positive expected spread stays
unsolved. The protocol has no answer to this beyond the recovery path of 7.3.

**The consumed set only grows**, and its interaction with fork-aware consensus is unresolved.

## 10. What would change the answer

Stated in advance so the answer is not settled by whoever argues last.

1. **If the mempool's only defensible function is common discovery, and an off-protocol pool delivers
   common discovery at acceptable cost, the upgrade is not justified.** The test is a concrete
   comparison against the in-band alternative of section 8, not a general argument.
2. **If 7.1 cannot be resolved so that solvers see intents before registration, the fast path is
   bilateral by construction.** The proposal should then drop the fronting claim and be argued purely
   on discovery and free rejection.
3. **If sustained relay throughput for free objects turns out to be a real denial-of-service surface
   at any workable spam bound**, admission cannot be free and the first of the two irreducible
   properties fails. Not yet measured (section 6).
4. **If the recovery path of 7.3 cannot be specified safely**, the design can strand user funds by its
   normal operation, which is disqualifying regardless of everything else.

## 11. Where the detail lives

- [RSKIP-native-intent-transactions.md](RSKIP-native-intent-transactions.md) — the specification.
- [IMPLEMENTATION-MAP.md](IMPLEMENTATION-MAP.md) — what exists in the reference implementation, with no
  reference to what any document claims about it.
- [ADMISSION-RULES.md](ADMISSION-RULES.md) — every point at which a node can refuse an intent, its code
  site, its exact message, and the test covering it.
- [CLAIMS.md](CLAIMS.md) — every claim and the evidence behind it, including the four that currently
  have none.
- `poc/measurements/` — raw measurement data, one file per run, with the machine recorded.
- `poc/sdk/attacks/README.md` — the adversarial board's conventions and full results.
