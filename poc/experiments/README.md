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
| E12 | Fee mechanics (m4) | Solver delivers the output and claims the escrowed input (peg-in), keeping the spread | user isn't paid the output, solver doesn't get the input, or escrow not cleared | 1 node, ticket off |
| E13 | Activation gate | Intents are rejected before the RSKIPINTENT activation height and admitted after | an intent is admitted pre-activation, or rejected post | 1 node; run right after `up` |
| E14 | Real peg-in binding | A real peg-in credits the contract; settle releases the actual pegged-in input to the solver | Bridge records wrong dest/amount, or solver doesn't get the real input | 1 node + bitcoind; slow (relays headers) |
| E15 | Competing solvers + bonding | Two bonded solvers race one intent: exactly one settle lands (first-valid-inclusion), user paid once, winner claims the spread; arbiter can slash | both settles succeed (H double-spent), neither lands, or the loser also delivers | 1 node, ticket off |
| E16 | Cross-node reorg (p2p) | A competing heavier chain from node B makes node A reorg, orphaning the settle: delivery + H revert and the intent is re-solvable | A doesn't adopt B's chain, or the output/H survive the reorg, or the intent can't be re-solved | **reorg stack** (`docker-compose.reorg.yml`) + docker CLI; slow |
| E17 | Above-minOut auction (off-consensus) | Solvers bid above minOut; outbid escrow refunded; execute pays the user the best bid and the winner the input — but an unenforced auction is bypassable at minOut (shown, honestly) | escrow lost, premature execute lands, user doesn't get the best bid, or the bypass fails | 1 node, ticket off |
| E17b | Enforced auction (genesis) | Once bid upon, an intent settles only through the genesis auction (0x..22) — direct settles revert during AND after the window; bid-free intents unaffected | a direct settle lands while an auction is open, execute fails, or a bid-free intent can't settle (regression) | 1 node, **E17b genesis** (down -v + rebuild) |
| E19 | BTC exit (the path back) | A solver's REAL Bitcoin payment to the user's address, SPV-proven against the Bridge's headers, settles the exit intent and releases the input; wrong-destination and replayed payouts revert | the wrong address settles, the user's BTC doesn't arrive, the solver isn't repaid, or one payout output settles twice | 1 node + bitcoind, **E19 genesis**; relays headers |
| E20 | Exit failure containment | A late-but-unraced reserver keeps its bond; re-reserving over a lapsed squat forfeits the old bond into the escrow at reserve time and pays the taker (input + squatter's bond + own bond back); an unpayable contract reserver that has paid real BTC settles anyway — bond + input downgrade to Settlement credits, its failed withdraw is isolated, the user is paid exactly once | the unraced late settle forfeits, the takeover fails or the old bond vanishes, the unpayable reserver's settle reverts (self-brick — a double-payment window opens after the lapse), or the credit ledger mismatches input + bond | 1 node + bitcoind, **E20 genesis** (Settlement credit ledger); relays headers, two 30-block lapses |
| E18 | Failure containment (pull-payments + lock decay) | An unpayable winner cannot brick the intent (execute succeeds, its input becomes an unclaimable credit); an unpayable outbid bidder cannot block higher bids (refund downgrades to a credit); exclusivity decays GRACE blocks after the deadline, reopening direct settlement at minOut; a failed withdraw is confined to its own tx | execute reverts "winner pay failed" (the brick survives), a higher bid reverts "outbid refund failed", the credit ledger is corrupted by a failed withdraw, or the lock fails to decay / decays inside the grace window | 1 node, **hardened genesis** (down -v + rebuild) |

### Running E16 (dedicated reorg stack)

E16 is the genuine-p2p upgrade of E9 (which models a reorg on one node with `evm_snapshot`/`evm_revert`).
It needs two *mining* nodes that produce blocks on demand, so it runs on a separate stack — different host
ports (4454/4455) and containers (`rskj-a-reorg`, `rskj-b-reorg`), so it never clashes with the default
stack. It drives a real reorg by partitioning the nodes with `docker stop`/`start`: mine the settle into
A's chain, out-mine it on B, then heal so A's own fork-choice adopts B's heavier chain and orphans the
settle. From `poc/`:

```
docker-compose -f stack/podman-compose.yml build            # once, if rskj-intent:poc isn't built yet
docker-compose -f stack/docker-compose.reorg.yml up -d
( cd sdk && npm run e16 )
docker-compose -f stack/docker-compose.reorg.yml down -v
```

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

Milestone 4 added the fee mechanics: the settlement contract holds an input escrow keyed by btcTxid
(`depositForPegin` models the peg-in credit), and `settle` releases it to the solver as repayment +
spread after delivering the output. E12 exercises the cross-asset flagship — user pegs in RBTC, receives
a token; solver delivers the token and claims the RBTC input. Finding recorded in the fee RSKIP: native
RBTC can't be pulled from the user, so the input must be escrowed (a peg-in crediting the contract),
not authorised-for-transfer from the user's balance.

Productionization then took the three PoC shortcuts to production shape: the activation gate (E13,
a `RSKIPINTENT` consensus rule), real peg-in binding (E14, a genuine RSKIP170 peg-in credits the
settlement contract and the Bridge records its destination + amount for `settle` to release), and the
solver market (E15, a `Bond` contract off the settle path plus a competing-solvers race that confirms
first-valid-inclusion). E16 then closed the reorg gap with a genuine two-node p2p reorg (see below).

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
- Reorgs under real p2p. Now covered by E16: two on-demand-mining nodes are partitioned with
  `docker stop`/`start`, the settle is mined into A's chain, B builds a heavier chain without it, and on
  healing A's own fork-choice reorgs onto B — orphaning the settle so delivery + H revert and the intent
  is re-solvable. E9 remains the fast single-node version (evm_snapshot/evm_revert, the same state-
  reversion code path).
- "Instant". The design's own pressure point 3 — admission is gated on the Bridge SPV view, so protocol
  latency is BTC confirmation + header registration, not instant. No experiment yet drives the Bridge
  header cadence to measure it; it needs the peg-in path first.

## Reading a result

Exit code 0 means the run behaved as predicted (for E1–E3, E8: the claim survived; for E6: the residual
reproduced). Non-zero means either the claim was falsified or the harness hit a bug — the printed checks
say which. A falsified claim is the valuable outcome: it means the design, not the code, needs to change.
