# Invalidation experiments

The point of the PoC is not to show the design works. It is to try to break it. Each experiment is a
falsification attempt: a claim, a procedure, and the observation that would prove the claim false. The
runnable scripts live in `../sdk/experiments/`; this file is the methodology and the map from each
experiment back to a claim in the design sketch.

## What we are actually testing

Two claims are irreducible — impossible for a smart contract, because contracts run after inclusion and
these are pre-inclusion properties. Everything else the design offers is quality-of-implementation and
is not worth a consensus change on its own. So the experiments weight those two heavily.

Claim 1 — a payer-less account's signed intent becomes a gossiped mempool object.
Claim 2 — an expired or consumed intent never enters a block and costs nothing.

The rest of the suite probes the design's own admitted soft spots (the pressure points in
`../../native-intent-design-sketch.md`), because that is where it is most likely to be wrong.

## The experiments

| # | Tests | Hypothesis | Falsified if | Needs |
|---|-------|-----------|-------------|-------|
| E1 | Claim 1 | A fresh zero-balance account's intent is admitted to the mempool | send is rejected, or tx never appears in the pool | 1 node, ticket off |
| E1b | Claim 1 (gossip) | That intent propagates to a second, peered node | it never reaches node B while peered | 2 nodes, ticket off |
| E2 | Claim 2 | An expired intent is rejected at admission, leaving nothing on chain | it is accepted, or leaves a receipt / consumes gas | 1 node |
| E3 | Consumed-set | After an intent is solved, the same H cannot be re-submitted | the replay is admitted, or isConsumed stays false | 1 node, ticket off |
| E7 | Settlement (m2) | solve delivers ≥ minOut to the user and consumes H atomically | user isn't credited ≥ minOut, or H consumed without payment | 1 node, ticket off |
| E6 | m1 residual closed (m2) | an under-delivering solve reverts and leaves H intact | a solve consumes H without paying, or a failed solve strands H | 1 node, ticket off |
| E8 | Anti-spam (negative) | Without a confirmed BTC peg-in ticket, an intent is rejected | it is accepted with a bogus btcTxid | 1 node, ticket **on** |
| E8+ | Anti-spam (positive) | An intent referencing a real processed peg-in is admitted | the valid-ticket intent is rejected | ticket **on** + `npm run pegin` |
| E9 | Reorg | A reorg that drops the solve reverts H + delivery; the intent is re-solvable | H stays consumed, delivery kept, or not re-solvable | 1 node (evm_snapshot/revert) |
| E10 | Token output (m3) | Settlement delivers an ERC-20 output to the user and consumes H | user isn't credited the token, or H consumed without delivery | 1 node, ticket off |
| E11 | Visible revert (m3) | A failed solve reverts visibly (status 0x0) and leaves H intact | it reports success, consumes H, or pays the user | 1 node, ticket off |

## Status (2026-09-01)

Milestones 1 and 2 both verified against the patched pr3558 node (docker-compose, two rskj regtest
nodes + bitcoind). E1, E1b, E2 (m1: the two irreducible claims), E3, E7, and E6 (m2: replay,
atomic settlement, grief closed) all pass. E8 (negative and positive) also passes: the `pegin` driver
registers a real regtest peg-in via the public receiveHeader/registerBtcTransaction path, and
E8-positive confirms a valid-ticket intent is admitted while a bogus one is rejected (run with
`INTENT_REQUIRE_TICKET=true` per `../stack/scripts/pegin.md`). The full v1 story is now demonstrated
end to end on a patched rskj build.

E6 changed meaning in m2. In milestone 1 it demonstrated the griefing hole (consume was unbound to
delivery). Milestone 2's atomic solve closes it: E6 now passes when the grief *fails* — an
under-delivering solve has no effect and H stays intact, so the honest solver can still serve the intent.

Milestone 3 moved settlement into a VM contract (`Settlement.sol`, genesis-deployed): it delivers RBTC
or ERC-20 output and records H, and — because it runs in the VM — a failed solve now reverts *visibly*
(status 0x0), fixing the m2 caveat where a throwing raw precompile reported success. E10 exercises an
ERC-20 output; E11 confirms visible reverts. Experiments assert on receipt status again, plus effects.

## What the PoC does not yet test (honest gaps)

These are real and belong in the write-up, not buried:

- Solver repayment and spread. Milestone 2's atomic solve now binds consumption to delivering ≥ minOut
  (E7, E6), but the solver is not repaid or paid a spread — it simply delivers minOut and pays gas. The
  fee mechanics (how a solver profits) are a planned companion RSKIP, untested here.
- Consensus-level bundle. Settlement is one atomic solve transaction (now a VM contract call), not a
  miner-assembled intent+solution bundle; MEV/ordering concerns of a true bundle are untested.
- Non-fresh-chain peg-in. The `pegin` driver relays from the Bridge's SPV genesis, so it assumes a
  fresh chain (`docker-compose down -v` if bitcoind and rskj ever diverge). Re-running against an
  already-populated Bridge is untested.
- Reorgs under real p2p. E9 exercises the reorg story deterministically via evm_snapshot/evm_revert
  (state reversion is the same code path a real reorg takes), but a genuine two-miner partition/merge
  under p2p is not tested — deferred as higher-cost, lower-marginal-value since the consumed set is
  ordinary world state.
- "Instant". The design's own pressure point 3 — admission is gated on the Bridge SPV view, so protocol
  latency is BTC confirmation + header registration, not instant. No experiment yet drives the Bridge
  header cadence to measure it; it needs the peg-in path first.

## Reading a result

Exit code 0 means the run behaved as predicted (for E1–E3, E8: the claim survived; for E6: the residual
reproduced). Non-zero means either the claim was falsified or the harness hit a bug — the printed checks
say which. A falsified claim is the valuable outcome: it means the design, not the code, needs to change.
