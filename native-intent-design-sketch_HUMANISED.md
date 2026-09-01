# Native intent transactions on Rootstock — design sketch

> **Status:** Idea stage. This began as a brainstorming hand-off and has been reorganised for review.
> Nothing here is a committed design. The companion diagram is `native-intent-sequence.mermaid`; the
> formal draft is `RSKIP-draft-native-intent-tx.md`.

A working proof of concept lives under `poc/`. As of 1 September 2026, it demonstrates mempool
admission and gossip, pre-inclusion invalidity, replay protection, atomic settlement, RBTC and ERC-20
outputs, visible reverts, solver repayment from escrow, and activation gating on patched rskj regtest
nodes.

## The idea

The proposal adds a native transaction subtype to Rootstock's typed-transaction namespace (`0x02 ||
subtype`, reserved by RSKIP543/545/546; see rskj PR #3558). Instead of signing exact calldata, the user
signs constraints: a commitment to the intended pipeline, a minimum output, an expiry height, and a
Bitcoin event used as an anti-spam ticket. A solver supplies the requested output and earns the spread.

This is intended as protocol support for two existing initiatives: “(near-)instant, Bitcoin-anchored
execution on Rootstock” and “Intent-based batching from Bitcoin”.

## The two claims that matter

Most benefits associated with native intents can also be built with contracts, although sometimes less
cleanly. Two properties cannot, because contracts run only after inclusion.

**1. A payer-less account can participate in the public mempool.** Admission happens before the EVM
runs. That makes it possible for a signed message from a new, zero-balance account to become a gossiped
mempool object. A contract cannot provide this; ERC-4337 uses an off-protocol alternative mempool for
the same reason.

**2. Invalid intents can be rejected before inclusion.** A contract-level expiry or replay check uses
block space and gas, even when it reverts. A protocol-level check can reject an expired or consumed
intent before it reaches a block, at no on-chain cost.

Everything else—constraint checks, signing UX, commit/reveal, and output bounds—is implementation
quality. Those features matter, but they do not independently justify changing consensus.

## Proposed v1 flow

The user builds a pipeline through a dApp or SDK. The resulting Bitcoin transaction carries the
pipeline commitment `H` in `OP_RETURN`, and its transaction ID becomes the anti-spam ticket. Once the
Bitcoin event is visible in the Bridge's SPV view, anyone holding the signed intent bytes can broadcast
them. Nodes admit the intent only if its signature is valid, its ticket is visible, it has not expired,
and `H` has not already been consumed.

The intent is gossiped but never mined on its own. A solver asks for the committed pipeline, simulates
it, prices the risk, and submits a settlement transaction. The settlement contract authenticates the
raw intent, delivers at least `minOut` to the user, releases the escrowed peg-in input to the solver,
and records `H` as consumed. These actions are atomic: any failure reverts the whole transaction,
leaving `H` available until the expiry height `E`.

This means the current PoC uses the mempool primarily for discovery and uniform admission, not as a
second transaction that must be mined beside the solution. A consensus-level intent-and-solution
bundle remains possible later if ordering, MEV, or batching makes it useful.

## Current design choices

Each of these choices remains open to revision.

**v1 intents are backed by Bitcoin events.** The anti-spam ticket is a processed peg-in referenced by
`btcTxid` and checked against the Bridge's SPV state. This avoids a free, unbounded mempool surface and
keeps v1 focused on the main Bitcoin-to-Rootstock flow. General-purpose ticketless intents are deferred.

**The solver pays for settlement.** The user may not hold RBTC, so the profitable party pays gas. The
most defensible liveness claim is not that miners will include intents, but that any solver able to see
a positive spread may settle one.

**Failures are charged to the solver.** If any constraint fails, settlement reverts, `H` remains
unconsumed, and the solver loses the gas. Solvers are expected to simulate before submitting and to
price failure risk into the spread. A crafted-to-fail intent can still cost each willing solver one
failed transaction before reputation catches up.

**Commit/reveal protects against third-party front-running, not against the solver.** A solver must see
the pipeline to price it. The payload is therefore hidden only from parties that have not received the
reveal.

**Expiry uses an absolute Rootstock height with a short maximum horizon.** A bounded horizon limits
state growth and gives predictable reorg behaviour. On the replacement branch, an intent is either
still valid or expired; a settlement removed by the reorg also removes delivery and consumption.
RSKIP555 must be accounted for before these rules are finalised.

**Consumption is ordinary world state.** In the current architecture, the settlement contract stores
the consumed set, while admission reads the relevant slot directly. It can be queried through
`eth_call` and proved with a storage proof. Reorg handling follows normal state reversion. The open
question is how, or whether, old entries should be pruned.

**Signing, broadcasting, and paying are separate roles.** The user signs the constraints, anyone may
broadcast the bytes, and the solver pays when settling. A broadcaster cannot alter or forge the
self-authenticating intent and can do little beyond delaying it; another party can simply rebroadcast.

## Where the design is weakest

These are challenges to the proposal, not details to be hidden in implementation notes.

### 1. A solver-paid settlement narrows the mempool claim

Because the intent is never mined by itself, the public mempool acts mainly as a discovery channel.
Solvers could discover the same opportunity elsewhere, including directly from Bitcoin. Native
mempool admission still provides uniform anti-DoS and gossip rules without a privileged relay, but that
is a narrower benefit than “native inclusion”.

The aggressive alternative deserves serious consideration: encode enough information in the Bitcoin
transaction for the intent to be derived from it. Bitcoin then becomes the discovery layer and the
separate submission step disappears.

### 2. The revealer is a liveness dependency

The phrase “any bonded solver chasing visible profit” is incomplete when the SDK controls who can see
the payload. The revealer cannot forge or modify the intent, but it can prevent some or all solvers from
pricing it. That recreates part of the liveness dependency the proposal is meant to remove.

v1 therefore needs an explicit rule: reveal to any bonded solver, use threshold-encrypted payloads, or
state plainly that the dApp remains a liveness party. The practical starting point is reveal-to-any-
bonded-solver, with threshold encryption considered later.

### 3. “Instant” is a solver service, not a protocol guarantee

Protocol admission waits until the Bitcoin event is visible to the Bridge. The minimum protocol-visible
delay is therefore Bitcoin confirmation time plus header-registration cadence. A solver may choose to
front the output sooner, but that is off-protocol risk-taking. The RSKIP should describe the result as
trust-minimised settlement of a fronted flow, not unqualified instant execution.

### 4. Reputation weakens the permissionless claim

Counterparty scoring is a practical defence against crafted failures, but reputation systems create a
barrier to profitable participation. The honest claim is: entry is permissionless, while sustained
profitability may require standing. The griefing bound should also be stated directly—at most one
inclusion fee per willing solver for each crafted intent, until expiry or until reputation information
propagates.

### 5. Escrow needs an expiry path

The production fee design requires the peg-in to credit the settlement contract because native RBTC
cannot be pulled from the user's account. That breaks the earlier assumption that an unsolved intent
automatically leaves funds in the user's balance. If no solver acts, the contract-held input needs a
clearly authorised path back to the user, or the Bridge needs to provide an equivalent slow path.

This is safety-critical: an ordinary peg-in alone is not a refund once its beneficiary is the settlement
contract. The production design must resolve this before launch.

## Open questions by workstream

- **Envelope:** should the intent use an SDK-derived EVM key, or a signature recoverable from the
  Bitcoin input? Should the Bitcoin transaction carry enough data to make the intent fully derivable?
- **Admission and propagation:** should nodes temporarily tolerate a ticket that is not yet visible,
  weakening the spam filter, or should the SDK wait for Bridge registration, adding latency?
- **Settlement:** how is the payload revealed fairly, what exactly is the crafted-failure bound, and
  how should expired escrow be recovered?
- **Expiry and reorgs:** how should consumed entries be pruned, and how does RSKIP555 affect validity?
- **Market:** what minimum solver discovery, pricing, bonding, and endorsement specification needs to
  ship with the RSKIP?

## Positioning

RSKIP36 (EXECUTE, 2017) and RSKIP138 (multi-signed enveloping, 2019) address sponsorship—who pays—but
not constraint-based execution that any solver can satisfy. Ethereum intent systems such as ERC-4337,
CoW, and Across operate outside consensus.

RIP-7560 is the most relevant direction of travel for native account abstraction. This proposal should
focus on the gap it does not directly cover: users with no Rootstock balance or history whose value is
arriving from Bitcoin. Reusing RIP-7560's vocabulary for bundles and validation phases would also make
future convergence easier.

The design becomes meaningful only with more than one viable solver. A bond and endorsement mechanism,
along with a published solver protocol, should therefore be available from launch even though neither
belongs in consensus.

## References

RSKIP36 · RSKIP138 · RSKIP543 · RSKIP545 · RSKIP546 · RSKIP555 (Draft) · rskj PR #3558 · ERC-4337 ·
RIP-7560 · internal Notion initiative entries “(near-)instant, Bitcoin-anchored execution on Rootstock”
and “Intent-based batching from Bitcoin”.
