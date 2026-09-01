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
| E3 | Consumed-set | After a solver consumes H, the same H cannot be re-submitted | the replay is accepted, or isConsumed stays false | 1 node, ticket off |
| E6 | Pressure point 2/4 (residual) | consume(H) is unbound to delivery, so any funded party can grief one H | — (a "pass" confirms the documented hole) | 1 node, ticket off |
| E8 | Anti-spam | Without a confirmed BTC peg-in ticket, an intent is rejected | it is accepted with a bogus btcTxid | 1 node, ticket **on** |

## Status (2026-09-01)

E1, E1b, E2, E3, E6 all pass against the patched pr3558 node (built and run under docker-compose,
two rskj regtest nodes + bitcoind). Both irreducible claims are demonstrated end to end. E8 is not yet
run — it needs a node launched with `-Dintent.requireBtcTicket=true`; its positive case additionally
needs the federation-driven regtest peg-in in `../stack/scripts/pegin.md` (still stretch).

E6 is deliberately a demonstration, not a defence. It passes when the grief succeeds, quantifying the
residual the design already flags (milestone 1 has no atomic bundle binding consume to min-out
delivery). It also shows the grief is bounded: the honest user re-issues under a fresh H.

## What the PoC does not yet test (honest gaps)

These are real and belong in the write-up, not buried:

- Atomic settlement. Milestone 1 never mines the intent and never binds consume to delivering min-out.
  So min-out enforcement, the atomic intent+solution bundle, and solver repayment+spread are untested.
  That is the whole of milestone 2 and it is where the "solver actually satisfied the intent" guarantee
  lives. Until then, E3/E6 test the consumed-set mechanics, not honest settlement.
- The positive BTC path. E8 tests the negative case (no ticket → rejected) which needs no peg-in. The
  positive case (a real processed peg-in as a valid ticket) needs the federation-driven peg-in flow in
  `../stack/scripts/pegin.md`, which is fiddly on regtest and is marked stretch.
- Reorgs. Claim-2's clean reorg story (an intent on the new branch is still includable or expired; a
  dropped solve reverts with its block) is asserted in the design, not yet exercised. A reorg experiment
  needs two mining nodes and a partition; deferred.
- "Instant". The design's own pressure point 3 — admission is gated on the Bridge SPV view, so protocol
  latency is BTC confirmation + header registration, not instant. No experiment yet drives the Bridge
  header cadence to measure it; it needs the peg-in path first.

## Reading a result

Exit code 0 means the run behaved as predicted (for E1–E3, E8: the claim survived; for E6: the residual
reproduced). Non-zero means either the claim was falsified or the harness hit a bug — the printed checks
say which. A falsified claim is the valuable outcome: it means the design, not the code, needs to change.
