# Native intent transaction type on Rootstock

A proposed Rootstock-native transaction type in which the user signs *constraints* — a hash-committed
pipeline, a minimum output, an expiry, and an anti-spam reference — instead of exact calldata, and
consensus enforces validity before inclusion. Independent solvers compete to satisfy the constraints and
are paid from the spread. This repository holds the design, two draft RSKIPs, and a working proof of
concept that has been built and run end to end on a patched rskj regtest node.

Status: RD&I initiative, Idea stage. Everything here is a proposal for discussion, not committed design.

## Why it needs to be native

Most advertised benefits of "intents" are things smart contracts do worse, not things they cannot do.
Only two are impossible in contract-land, because contracts run *after* inclusion and these are
*pre-inclusion* properties. The whole proposal rests on these two:

1. **Mempool citizenship for an account that cannot pay.** Admission and validity are decided before the
   EVM runs, so a zero-balance, zero-history account's signed message can become a gossiped mempool
   object. ERC-4337 built an off-protocol alt-mempool precisely because it could not do this in contracts.
2. **Invalidity before inclusion.** A contract-level expiry or replay check runs on-chain: block space
   spent, gas burned, a griefable revert. Protocol validity means an expired or consumed intent never
   enters a block and costs nothing.

Everything else — constraint checking, honest signing UX, commit/reveal, output bounds — is quality of
implementation and does not by itself justify a consensus change. The documents are written to keep those
two claims load-bearing.

## Documents

- [`native-intent-design-sketch.md`](native-intent-design-sketch.md) — the idea, the decisions taken
  (each revisitable), and the pressure points where the design is most likely wrong.
- [`native-intent-sequence.mermaid`](native-intent-sequence.mermaid) — the interaction as a sequence
  diagram.
- [`RSKIP-draft-native-intent-tx.md`](RSKIP-draft-native-intent-tx.md) — the draft RSKIP for the
  transaction type: envelope, admission, consumed set, settlement, expiry/reorg, anti-spam ticket, plus
  an implementation-status section reporting what the PoC verified.
- [`RSKIP-draft-native-intent-fees.md`](RSKIP-draft-native-intent-fees.md) — the companion RSKIP for the
  fee mechanics: how the solver is paid (claims the input, keeps the spread).
- [`PRODUCTIONIZATION.md`](PRODUCTIONIZATION.md) — what it would take to remove the PoC's three shortcuts:
  real peg-in→contract crediting, an activation gate, and the solver market.
- [`poc/`](poc/) — the proof of concept (rskj patch, podman stack, TypeScript harness, experiments).
- [`poc/BEYOND-V1.md`](poc/BEYOND-V1.md) — design notes for the settlement-contract turn and the
  consensus-level bundle.

## The proof of concept

The PoC is an rskj fork (on the RSKIP543/545/546 typed-transaction branch, PR #3558) plus a toy solver,
run as two rskj regtest nodes and a bitcoind under docker/podman. Each experiment is a falsification
attempt against a claim. All of the following pass on a real build (see [`poc/README.md`](poc/README.md)
to reproduce):

There is also a narrated **live demo**: with the stack up, `cd poc/sdk && npm run demo` serves a real-time
dashboard at `http://localhost:8666` (mempool intents on both nodes, actor balances, auction state, event
feed — all chain-derived) and plays the full lifecycle against it: payer-less admission and gossip, a free
rejection of an expired intent, a two-solver race with the replay blocked, and the auction bid war ending
with the user paid the best bid. The driver proxies the nodes' JSON-RPC same-origin because rskj rejects
cross-origin browser calls (no OPTIONS preflight handling, JSON-only content types).

For hands-on exploration there is also an interactive **playground**: `npm run playground` serves
`http://localhost:8667`, where you spawn payer-less users, compose intents of several types (vault
shares, native RBTC swap, ERC-20 output — optionally auction-routed via a broker seed bid that engages
the settlement lock from block one), and spawn solvers with a strategy (fast / picky / auction) and a
margin floor. Each solver's decision loop — see, simulate, price, decide, act — streams into its own log,
so races, lost-the-race reverts, auction folds and outbids are all visible as they happen, alongside
per-solver PnL and a full decode of every intent.

| # | What it tests | Result |
|---|---|---|
| E1, E1b | A payer-less account's intent is admitted to the mempool and gossips to a second node (claim 1) | ✓ |
| E2 | An expired intent is rejected at admission, leaving nothing on chain (claim 2) | ✓ |
| E3 | Once an intent is settled, the same commitment `H` cannot be re-submitted (consumed set) | ✓ |
| E8, E8+ | Without a confirmed BTC peg-in ticket an intent is rejected; with a real peg-in it is admitted (anti-spam) | ✓ |
| E9 | A reorg that drops the settlement reverts the delivery and the consumed set; the intent is solvable again | ✓ |
| E7, E6 | Settlement delivers ≥ min-out atomically; an under-delivering solve reverts and leaves `H` intact | ✓ |
| E10, E11 | The output can be an ERC-20; a failed solve reverts visibly | ✓ |
| E12 | The solver claims the escrowed input (the peg-in) and keeps the spread; the user gets the output | ✓ |

(E1b, the cross-node gossip variant, is timing-sensitive right after a fresh recreate — transaction
relay can lag the first blocks — so it occasionally needs a re-run; E1 proves the same claim on a single
node. Everything else is deterministic.)

Architecturally: an intent is a mempool-only typed transaction (`0x02 || 0x49`); admission is mempool
policy (a zero-cost, pre-inclusion check); settlement is a genesis-deployed VM contract that authenticates
the intent via a stateless parse precompile, delivers the output, releases the escrowed input to the
solver, and records `H` — reverting visibly on any failure.

## Findings surfaced by building it

These are recorded in the RSKIPs and are worth carrying into any real implementation:

- **Zero-`gasPrice` RLP canonicalisation.** rskj serialises a zero `gasPrice` as a raw `0x00` byte while
  a zero `value`/`nonce` serialise as `0x80`; a signer that does not match this recovers the wrong sender.
- **Precompile exceptions do not revert visibly.** A throwing precompile reports success and commits its
  writes in the current executor — which is why settlement is a VM contract, not a raw precompile.
- **Native RBTC cannot be pulled from the user.** So the input must be escrowed in the settlement
  contract (a peg-in crediting the contract), not authorised for transfer from the user's balance.

## Where it stands

Built and verified: the two irreducible claims, gossip, replay protection, the anti-spam ticket backed by
a real peg-in, reorg reversion (both deterministically on one node via E9 and under a genuine two-node
p2p partition/merge via E16), atomic contract settlement, ERC-20 outputs, visible reverts, and the fee
mechanics (solver input-claim + spread). Both RSKIP drafts are current.

Also built and verified beyond the core claims, taking the PoC's three deliberate shortcuts to production
shape (see `PRODUCTIONIZATION.md`): the **activation gate** (a `RSKIPINTENT` consensus rule instead of
always-on genesis; E13), **real peg-in binding** (a genuine RSKIP170 peg-in credits the settlement
contract and the Bridge records its destination + amount, which `settle` releases to the solver; E14),
and the **solver market** (a `Bond` contract solvers stake into, off the settle path, plus a competing-
solvers race showing first-valid-inclusion — one settle wins, the user is paid once; E15).

The above-`minOut` auction is built in both shapes (E17/E17b): an off-consensus auction contract —
bids above the ask, best bid delivered to the user, honestly shown to be bypassable under
first-valid-inclusion — and an enforced genesis variant where a bid locks the intent to the auction,
closing the bypass at the cost of making the auction a settlement rule. The trade-off is left explicit
in `PRODUCTIONIZATION.md` as a governance decision.

The enforced auction's post-win failure modes are hardened and tested (E18): payouts are pull-payments
(an unpayable winner or outbid bidder loses alone — no more "winner pay failed" bricking an intent to
expiry), and exclusivity decays `GRACE` blocks after the bidding deadline, so a persistently failing
execute degrades to open competition at `minOut` instead of holding the intent hostage. The documented
residual: a contract *user* whose delivery reverts can still force failed settles (bounded by decay,
then expiry), and the decay path forfeits the auction surplus.

Not built (by design): a consensus-level intent+solution bundle — deferred until MEV/ordering or
batch-solving is a real requirement, since the single-transaction contract model already delivers every
property above. Left as specification in `PRODUCTIONIZATION.md`: the off-chain solver reveal/pipeline
protocol and endorsement/reputation.
