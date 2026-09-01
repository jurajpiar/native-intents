# Native intent transactions on Rootstock

This repository explores a Rootstock-native transaction type in which users sign the outcome they want,
not the exact calldata needed to produce it. An intent contains a commitment to the execution pipeline, a
minimum output, an expiry, and an anti-spam reference. Rootstock checks those constraints before the
intent can enter the mempool, while independent solvers compete to fulfil it and earn the spread.

The repository contains the design notes, two draft RSKIPs, and a working proof of concept. The PoC has
been built and exercised end to end against patched rskj regtest nodes.

> **Status:** RD&I initiative, Idea stage. This is a proposal for discussion, not an agreed design.

## Why make intents native?

Many of the benefits attributed to native intents can already be delivered by smart contracts, even if
contracts sometimes deliver them less elegantly. This proposal depends on two narrower properties that
contracts cannot provide because they run only after a transaction has been included.

1. **Mempool access for an account that cannot pay.** A signed message from a new, zero-balance account
   can be admitted to the public mempool and gossiped between nodes. A contract cannot affect admission
   because the EVM has not run at that point. ERC-4337 works around the same limitation with a separate,
   off-protocol mempool.
2. **Invalidity before inclusion.** Expiry and replay checks in a contract consume block space and gas,
   even when they revert. At the protocol layer, an expired or consumed intent can be rejected before it
   reaches a block, leaving no on-chain trace and costing nothing.

Features such as constraint checking, commit/reveal, clear signing UX, and output bounds still matter,
but they do not justify a consensus change on their own. The proposal stands or falls on the two
pre-inclusion properties above.

## Repository guide

- [`native-intent-design-sketch.md`](native-intent-design-sketch.md) explains the idea, the current
  decisions, and the parts of the design most likely to need revision.
- [`native-intent-sequence.mermaid`](native-intent-sequence.mermaid) shows the interaction as a sequence
  diagram.
- [`RSKIP-draft-native-intent-tx.md`](RSKIP-draft-native-intent-tx.md) specifies the transaction
  envelope, admission rules, consumed set, settlement, expiry and reorg behaviour, and anti-spam ticket.
- [`RSKIP-draft-native-intent-fees.md`](RSKIP-draft-native-intent-fees.md) describes how a solver claims
  the input and earns the spread.
- [`PRODUCTIONIZATION.md`](PRODUCTIONIZATION.md) covers the remaining work: real peg-in-to-contract
  crediting, full activation handling, and the solver market.
- [`poc/`](poc/) contains the rskj patch, local stack, TypeScript harness, and experiments.
- [`poc/BEYOND-V1.md`](poc/BEYOND-V1.md) records the move to contract-based settlement and the case for
  deferring a consensus-level bundle.

## What the PoC demonstrates

The PoC combines an rskj fork based on the RSKIP543/545/546 typed-transaction branch (PR #3558), a toy
solver, two rskj regtest nodes, and bitcoind. Each experiment is framed as an attempt to disprove a
specific claim. See [`poc/README.md`](poc/README.md) for setup and reproduction steps.

| Experiment | Claim tested | Result |
|---|---|---|
| E1, E1b | A payer-less account's intent enters the mempool and is gossiped to a peer | ✓ |
| E2 | An expired intent is rejected before inclusion and leaves nothing on-chain | ✓ |
| E3 | A settled commitment `H` cannot be submitted again | ✓ |
| E8, E8+ | A bogus Bitcoin ticket is rejected and a processed peg-in ticket is accepted | ✓ |
| E9 | Reverting a settlement reverts both delivery and consumption, making the intent solvable again | ✓ |
| E7, E6 | Settlement delivers at least `minOut`; under-delivery reverts without consuming `H` | ✓ |
| E10, E11 | ERC-20 outputs work and failed settlement is visible as a revert | ✓ |
| E12 | The solver receives the escrowed input and keeps the spread after delivering the output | ✓ |
| E13 | Intent behaviour is disabled before the activation height and enabled afterwards | ✓ |

E1b is timing-sensitive just after a clean restart because transaction relay may lag the first few
blocks. It can occasionally need a second run. E1 tests the same admission claim on one node; the other
experiments are deterministic in the current harness.

Architecturally, an intent is a mempool-only typed transaction (`0x02 || 0x49`). Nodes treat admission
as a zero-cost, pre-inclusion policy check. A fixed-address VM contract performs settlement: it
authenticates the raw intent through a stateless parsing precompile, delivers the requested RBTC or
ERC-20 output, releases the escrowed input to the solver, and records `H`. Any failed check reverts the
whole transaction visibly.

## What implementation taught us

- **Zero-`gasPrice` RLP encoding is easy to get wrong.** rskj serialises a zero `gasPrice` as `0x00`,
  while zero `value` and `nonce` use `0x80`. A signer that encodes them identically derives a different
  signing hash and recovers the wrong sender.
- **A raw precompile exception is not a visible revert.** In the current executor, a throwing precompile
  reports success and commits its writes. Settlement therefore belongs in a VM contract, with the
  precompile limited to stateless parsing and authentication.
- **Native RBTC cannot be pulled from a user's balance.** The peg-in input must be escrowed in the
  settlement contract and released to the solver there. In production, the peg-in needs to credit that
  contract directly.

## Current position

The PoC covers admission, gossip, replay protection, a real peg-in-backed anti-spam ticket, state
reversion, atomic contract settlement, ERC-20 outputs, visible failures, solver repayment, the spread,
and an activation gate.

Three substantial pieces remain outside the PoC or are still modelled: production peg-in crediting,
deployment of the settlement contract at the public-network activation block, and a competitive solver
market with discovery, reveal, pricing, bonding, and reputation. A consensus-level intent-and-solution
bundle is deliberately deferred until MEV, ordering, or batch settlement makes it necessary; the
single-transaction contract design already proves the core properties.
