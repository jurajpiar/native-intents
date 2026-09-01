# Invalidation experiments

The PoC is meant to challenge the design, not merely demonstrate a happy path. Every experiment starts
with a claim, defines an observable test, and states what result would disprove it. The scripts live in
`../sdk/experiments/`; this document explains the methodology and maps each script back to the design.

## What matters most

Two claims carry most of the weight because they concern pre-inclusion behaviour that a smart contract
cannot provide:

1. a signed intent from a payer-less account can become a gossiped public-mempool object; and
2. an expired or consumed intent can be rejected before entering a block, using no gas and leaving no
   on-chain trace.

The rest of the suite tests the design's known pressure points: atomic delivery, ticket enforcement,
replay, state reversion, output assets, visible failures, solver repayment, and activation.

## Experiment matrix

| ID | Area | Hypothesis | Falsified if | Environment |
|---|---|---|---|---|
| E1 | Payer-less admission | A fresh zero-balance account's intent enters the mempool | Submission is rejected or never appears in the pool | One node, ticket off |
| E1b | Gossip | The admitted intent propagates to a peered node | It never reaches node B while the peer connection is healthy | Two nodes, ticket off |
| E2 | Pre-inclusion expiry | An expired intent is rejected without an on-chain effect | It is admitted, receives a receipt, or consumes gas | One node |
| E3 | Replay protection | A settled `H` cannot be admitted again | The replay enters the pool or `H` remains unconsumed | One node, ticket off |
| E6 | Under-delivery | An under-delivering settlement reverts and leaves `H` available | `H` is consumed, funds move incorrectly, or the intent is stranded | One node, ticket off |
| E7 | Atomic settlement | Settlement delivers at least `minOut` and consumes `H` atomically | Delivery is too small or `H` is consumed without delivery | One node, ticket off |
| E8 | Ticket rejection | A fabricated Bitcoin ticket is rejected | An intent with a bogus `btcTxid` is admitted | One node, ticket on |
| E8+ | Ticket acceptance | A processed regtest peg-in is accepted as a ticket | The valid-ticket intent is rejected | Ticket on, after `npm run pegin` |
| E9 | Reorganisation | Removing settlement state removes delivery and consumption | Delivery or consumption survives, or the intent cannot be solved again | One node using snapshot/revert |
| E10 | ERC-20 output | Settlement delivers an ERC-20 and consumes `H` | Token delivery is short or `H` is consumed without it | One node, ticket off |
| E11 | Visible failure | A failed settlement has receipt status `0x0` and leaves `H` untouched | It reports success or changes delivery/consumption state | One node, ticket off |
| E12 | Fee mechanics | The solver delivers the output, receives the escrowed input, and keeps the spread | Output is missing, input is not released, or escrow remains uncleared | One node, ticket off |
| E13 | Activation | Intents are rejected before `RSKIPINTENT` and admitted after it | Pre-activation admission succeeds or post-activation admission fails | One fresh node; run immediately after startup |

## Current results — 1 September 2026

The experiments have been run against patched rskj regtest nodes with bitcoind. The observed results
support the following claims:

- E1, E1b, and E2 demonstrate payer-less admission, gossip, and rejection before inclusion.
- E3 confirms replay protection after settlement.
- E6 and E7 confirm that delivery and consumption are atomic. E6 originally exposed the milestone-1
  griefing hole; after contract settlement was added, it passes only when the attempted grief fails.
- E8 and E8+ reject a bogus ticket and accept a real peg-in registered through the Bridge's public
  `receiveHeader` and `registerBtcTransaction` path.
- E9 restores delivery and solvability when the settlement state is reverted.
- E10 and E11 confirm ERC-20 output and normal VM failure receipts.
- E12 confirms the modelled input claim and spread.
- E13 confirms the regtest activation gate around block 40.

E1b is timing-sensitive just after a clean stack restart because transaction gossip can lag the first
blocks. It may need a rerun even when the underlying one-node admission claim in E1 is working.

The default `npm run all` suite covers E1, E1b, E2, E3, E6, E7, E10, E11, and E12. Other experiments
have specialised setup:

- E8/E8+ require ticket enforcement and the peg-in driver.
- E9 deliberately changes local snapshot state.
- E13 must start before the short pre-activation window closes.

## Remaining gaps

The suite does not establish production readiness. In particular:

- **Production peg-in escrow:** E12 uses `depositForPegin`; it does not test a Bridge-authenticated
  credit into the settlement contract or bind the user, intent, amount, and `btcTxid` as one event.
- **Expired-escrow recovery:** there is no test because the production recovery mechanism has not been
  designed.
- **Fork-block contract deployment:** E13 gates the parser, free-cost rule, and admission, while the
  settlement contract remains in regtest genesis. A public-network fork transition and its state root
  are not covered.
- **Real network reorg:** E9 exercises the relevant state rollback through `evm_snapshot` and
  `evm_revert`, not through a two-miner partition and merge.
- **Existing Bridge history:** the peg-in driver begins from the Bridge's SPV genesis and assumes a
  clean local chain. Behaviour against a populated Bridge view is not tested.
- **Solver market:** the toy solver does not test discovery fairness, payload reveal, price competition,
  bonding, endorsement, or reputation.
- **Consensus bundle:** settlement is a single VM transaction, not a miner-assembled intent-and-solution
  unit, so bundle-specific ordering and MEV claims remain untested.
- **Latency:** no experiment demonstrates “instant” execution. Protocol admission waits for Bitcoin
  confirmation and Bridge header registration; anything faster would be solver fronting outside the
  protocol.

## Interpreting a run

Exit code `0` means the observed behaviour matched the experiment's stated hypothesis. A non-zero exit
means either the claim was falsified or the harness failed; the printed checks distinguish the two.

For E6, success now means the old griefing attempt was rejected and `H` remained available. Older notes
that describe a successful E6 run as reproducing the residual refer to milestone 1 and are no longer
accurate.

A falsified claim is a useful result. It means the next step is to decide whether the harness is wrong,
the implementation is wrong, or the design needs to change.
