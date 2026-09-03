# Red team

The experiments in `../experiments/` are filed by the order they were invented — E1 through E23. That
is the wrong axis for red-teaming: the numbering tells you nothing about which part of the surface is
covered, and more than half of those experiments already *are* attacks (E6, E18, E20, E21, E22, E23).

This directory re-files the same work by the surface it attacks, adds the forensics an attack needs
that a claim does not, and — the part that matters most — makes the **gaps visible**. An attack surface
with nothing written against it appears in the menu marked `UNTESTED`, not absent from it.

```
npm run attack                 interactive menu
npm run attacks                run the whole board (CI form)
npm run attacks -- list        print the board and exit
npm run attacks -- E           one threat class (bare class letter)
npm run attacks -- e8          one attack (bare id)
npm run attacks -- e8 b2 E     several, de-duplicated, in the order given
```

Exit codes, because "it failed" hides three different things:

| code | meaning |
|---|---|
| 0 | every attack that ran behaved as `registry.ts` predicts |
| 1 | a **DEVIATION** — the system did something its own documentation does not claim. The result worth acting on |
| 3 | no deviations, but the board is **incomplete**: something was broken, skipped, partly exercised, or untested |

A run that reports "attack SUCCEEDED, as predicted" is a pass. A run that reports a deviation is the
finding. A run that reports `experiment broken` or `wrong stack` told you nothing — those lines are
unverified, not passed, and the summary says so rather than counting them as clean.

`PARTLY exercised` is the fourth of those. An attack that cannot establish a precondition calls
`a.skip(name, why)` and `finish()` then returns 3 instead of 0, so half a run cannot be filed as a
pass. **The reason this matters is a phantom pass, not a failure.** M3's first run lost the rival's
bid to a nonce collision, which left its second attack comparing the user's payout against a standing
bid of *zero*: `lockedUntil` returns 0 for an auction that never opened, and "paid minOut, not the
winning bid" is trivially true when the winning bid is nothing. Three green checks certified a decay
squeeze that never happened. Nothing about that output looks wrong, which is what makes it worse than
a failure — so preconditions whose absence would make later checks vacuous are now hard gates that
skip the rest, never checks that quietly pass.

Three things are deliberately kept apart:

- `deviation` — checks genuinely failed
- `broken` — the script threw before printing its `RESULT:` line (a stale experiment)
- `wrong stack` — it needs a node flag or stack the default compose does not provide

Full-board runs SKIP attacks marked `notInAll` rather than reporting a guaranteed failure as a finding
(`../experiments/run_all.ts` excludes E8 for the same reason); `--id=<id>` still runs them.

## The registry is the point

`registry.ts` holds one record per attack: the surface it targets (with a `file:line` you can go
read), the attacker's premise, the **expected outcome declared up front**, the defence that produces
that outcome, and the severity if the defence were absent. A run agrees or disagrees with the record.

Three kinds of entry:

| kind | meaning |
|---|---|
| `native` | written against `_forensics.ts` — full step / revert-reason / balance-delta reporting |
| `wrapped` | an existing experiment already performs this attack; the runner shells out and streams it |
| `untested` | no attack written yet, with the reason. Listed so the gap cannot hide |

Outcomes are three-valued, because "it reverted" and "it landed but only hurt the attacker" are
different results: `blocked`, `contained`, `succeeds`.

## What the forensics add

`Report` in `../experiments/_harness.ts` answers *did the claim survive*. An attack has to answer
*what exactly did the attacker get away with*, so every step records:

- the attacker's transaction hash, and the **revert reason** decoded from rskj's `error.data`
  (receipts carry only a status, so the harness replays the transaction as an `eth_call` at its own
  block — end-of-block state, which is what reproduces reverts caused by a rival transaction ordered
  ahead of it)
- gas actually burnt, which is how you price a griefing attack
- balance deltas for every watched party, per step

## Findings so far

Attacks that changed what we believe, rather than confirming it:

- **M1 — a settle transaction publishes the intent it is settling.** `rawIntentTx` travels in the
  settle's calldata, in the clear, in the public mempool. Anyone watching can decode it and settle
  the same intent; a miner wins that race for free by ordering its own block, and a non-miner wins it
  by outbidding on gas. The user is unharmed (they still get `minOut`) — the loss falls on the honest
  solver, which forfeits its gas and, for a compound intent, the inventory it pre-acquired. The
  design's own answer is the auction lock: once bid upon, a front-run must become a *bid*, which pays
  the surplus to the user instead of the front-runner. So the exposure is specifically **bid-free
  intents**, and an always-on seed bid (what the playground's broker does) is the practical
  mitigation. Nothing in the board covered miner-level behaviour before this class existed.

- **M3 — GRACE cuts both ways, and a block-height deadline is not a clock.** Both auction limits are
  block counts, so a block producer does not race the auction, it *moves* it: bid the floor and mine
  the whole window out and rivals never get to enter; or let a rival win honestly, decline to include
  `execute()` until exclusivity decays, and settle directly at `minOut` around the higher standing
  bid. The second half is the uncomfortable one, because the decay is **our own fix** — GRACE was
  added so a persistently reverting `execute()` cannot brick an intent (S4), and it is simultaneously
  a documented, permissionless route to the floor price. Nothing is stolen: `minOut` binds, `H` is
  consumed once, the outbid rival reclaims its stake. What is lost is price discovery, which is the
  whole product of an auction. Both halves of that trade now sit in the RSKIP rather than only in the
  fix's commit message.

- **C7 — `minOut` means "asked", not "arrived".** The token branch checks `transferFrom`'s return
  value, never a balance delta, so a fee-on-transfer token short-changes the user and an outright
  liar delivers nothing — in both cases `H` is consumed and the input released. The loss falls
  entirely on the user who *named that token in their own signed intent*, so it is a wallet-safety
  rule (never offer arbitrary tokens as outputs) rather than a third-party exploit. Return-less
  (pre-EIP-20) tokens are simply unusable as outputs, and fail in the safe direction.
- **C5 — the pull-payment cap closed a reentrancy surface it was not written for.** `PUSH_GAS =
  30_000` was added to `_pay` so an unpayable payee could not revert a settlement (F1-F4). Because
  30,000 gas does not cover one `SSTORE` (20,000) plus the cold `SLOAD`s before it, a contract
  solver's `receive()` cannot execute **any** logic on the settle path — it runs out of gas and the
  payout falls back to credit. The first version of this attack aimed squarely at those callbacks and
  reported a DEVIATION precisely because the callback never fired: 0 attempts, balance unmoved, the
  whole amount credited. The reachable surface is `withdraw()`, which is uncapped by necessity, and
  there the defence is the ordering rather than the cap — a same-H reentry meets a consumed `H`. A
  nested settle of a *different* intent stays permitted, which is correct: a blanket reentrancy guard
  would break nesting for no gain. Two independent defences, and the interesting one was accidental.

- **C5 (structural) — the user side is not a reentrancy surface at all.** A contract cannot *sign* an intent, so
  the user is always an EOA; the reachable callbacks are the solver's (excess refund, input release).
  Reentry there is real but worthless — effects-first ordering means a nested settle for the same `H`
  meets a consumed `H` — and a nested settle of a *different* funded intent is correctly permitted,
  which a blanket reentrancy guard would have broken for no gain.

- **E8 — payout hijack (FOUND, then FIXED).** `reserveExit` is documented as the protection against
  "losing an UNRESERVED exit race costs real bitcoin". It is keyed by `H`, so it protected the
  *intent*, not the *payment*. An attacker read the user's address off the public payout, pointed a
  one-satoshi intent of its own at the same destination, and settled it with the honest solver's
  proof: the paying solver's BTC gone irreversibly, the attacker out one wei and gas, repeatable per
  payout. **Fix:** the payout must carry an `OP_RETURN` settler commitment (`"RSKX" || settler`) and
  `settleBtcOut` requires `msg.sender` to match — entitlement travels with the payment, not with the
  (public, replayable) proof. Committing the settler rather than `H` keeps batching. E8 now runs the
  same hijack against the fix and asserts the refusal, that the paying solver settles normally, and
  that an uncommitted payout is unclaimable by anyone. The general rule, which fronting will need on
  the entry side too: *entitlement is recorded at the moment of the irreversible act, by the actor
  performing it* — free on RSK (`msg.sender`), needs carrying into the act itself on Bitcoin.
- **B2 — binding front-run.** B1's fix bound each escrow to the intent it was deposited for, closing
  theft. Because the binding arrives as a *call argument*, it opens denial instead: bind a victim's
  `btcTxid` to your own `H` for one wei and their intent is unsettleable forever — `_releaseInput`
  consults the binding only when the escrow is non-zero, so one wei promotes it from skipped to fatal.
  A PoC-model artefact (production derives the binding from the deposit address) but it is the model
  every other B-class experiment runs on.
- **E5 — the segwit guard is dead code.** `require(t[4] != 0x00, "segwit payout unsupported")` never
  fires for a real witness serialisation: the SPV check runs first, and `sha256d` of witness bytes is
  the *wtxid*, which no block's merkle tree commits to. Strip the witness and the same payout settles
  normally. "Legacy payout transactions only" describes the bytes the parser accepts, not the payments.
- **E5 — the output scan was unbounded and the settler paid (FIXED).** A 254-output payout with the
  payment last cost 1,504,768 gas — 4,768 more than the limit `settleBtcOut` sends — and past roughly
  1,400 outputs no gas limit was enough, with the safe batch size written down nowhere. Fixed
  alongside E8: `MAX_PAYOUT_OUTPUTS` bounds the scan, so an over-wide payout is refused cheaply and by
  name, and the batch ceiling is a constant a solver can read.
- **E20 had never run.** Not a design finding, but the board surfaced it: `e20_exit_containment.ts`
  asked for a 150-block expiry against an admission cap of 100, so it threw before its first check and
  E7's containment claim was unverified the whole time. Fixed to `+90` (the widest part needs ~67,
  because its takeover reserve must still clear `RESERVE_WINDOW`); all 15 checks now pass.
- **The header relay was broken in four more places.** rskj's pool rejects a nonce more than ~20 ahead
  of the mined one, so batch-relaying a fresh bitcoind's ~100-header backlog dies mid-way. E19, E20 and
  both playground sites had the unchunked form; the playground's startup case was worse, because the
  throw was swallowed by a `catch` that reported "bitcoind unreachable" and left the server running
  with a silently un-synced Bridge. All five now share `syncHeadersTo` in `src/bridge.ts`.
- **B3 — verified benign.** `depositForPegin`'s binding check sits inside `if (h != 0)`, so a zero `H`
  skips it and anyone can top up somebody else's bound escrow. It cannot be turned against the holder
  (the binding decides who claims, so the attacker is donating). Kept in the suite precisely because
  it looks exploitable.

## Known gaps in the board

**A2** (mempool flood) is the only entry that cannot run on the default stack, which pins
`requireBtcTicket=false`. It has been verified against a throwaway ticket-on node, which leaves a
populated stack alone — no bitcoind, no recreated containers, ~40s to mine past activation:

```
docker run --rm -d --name rskj-ticket -p 4464:4444 \
  -e RSK_CONF=/config/node-a.conf -e JVM_OPTS=-Xmx2g \
  -e INTENT_OPTS="-Dintent.requireBtcTicket=true -Dintent.maxExpirySpan=100" \
  -v "$PWD/stack/config:/config:ro" rskj-intent:poc
( cd sdk && RPC_A=http://localhost:4464 INTENT_REQUIRE_TICKET=true npm run attacks -- a2 )
docker rm -f rskj-ticket
```

It rejects with *"BTC ticket not visible in Bridge SPV view"*. `INTENT_REQUIRE_TICKET=true` is not
decoration: an admitted intent means either the rule is off (nothing tested) or the rule was defeated
(the finding), and the node's response is byte-identical either way, so the operator has to say which
world the run is in. Without the assertion `e8` exits 2 rather than claiming a falsification it cannot
support.

## An attack can declare the stack it needs

Some attacks are untestable on the default stack for a structural reason, not a difficulty one: the
default stack mines on a **timer**. Anything about block *contents* — ordering, censorship, a
block-height window, a deliberate reorg — cannot be expressed where blocks arrive on their own
schedule. Left there, "needs another stack" quietly converts a real gap in the analysis into a
permanent one.

So a registry entry may name its infrastructure with `stack:`, and the runner brings it up:

```
npm run attacks -- --provision m3     # provision whatever m3 declares, run it, leave it up
npm run attacks -- --provision --teardown m3
npm run stack:reorg:up                # or bring it up yourself and just run `-- m3`
```

`_stacks.ts` declares each stack (compose file, host ports, container names) and hands the attack a
context: `ctx.rpc` / `ctx.rpc2`, `ctx.mine(n)`, `ctx.mineTo(h)`, `ctx.partition(0|1)` / `ctx.heal(…)`,
and `ctx.autoMine`. Three properties are deliberate:

- **Provisioning is opt-in and idempotent.** A stack that already answers is reused as-is and never
  torn down — it may be your working stack with state you care about. `down -v` destroys volumes, so
  teardown happens only for a stack the run itself started, and only when asked.
- **`autoMine` is what makes on-demand mining usable.** Nothing confirms unless someone mines, so
  every ordinary SDK call would hang. A background ticker mines during *setup*, and the attack stops
  it only for the critical section it needs to control. Without it, each of these attacks would have
  to be rewritten around manual mining.
- **A missing stack is an `environment` result, never a defence result.** Reporting "blocked" because
  nothing was running would be a false pass — the failure mode the whole board exists to avoid. This
  extends to *stale* stacks: `requireContracts(ctx, …)` probes each genesis contract an attack needs,
  and probes a **getter** on it rather than just its code size, because genesis is baked into the
  image and older bytecode is indistinguishable from correct bytecode until you call it. M3 hit this
  on its first run — the reorg stack had been built for E16, which never touches the auction, so its
  volumes held a chain from before the Auction account existed and the first contract read came back
  as an undecodable `0x`. A `StackUnavailable` thrown from inside a running attack is classified
  `environment` too: "your containers are stale" and "this attack is broken" point the reader at
  completely different places.

Genesis lives in the image and applies only to a **fresh** chain, so after the contracts change, a
stack whose volumes predate them needs wiping, not restarting:

```
cd poc
docker-compose -f stack/podman-compose.yml build
docker-compose -f stack/docker-compose.reorg.yml down -v
docker-compose -f stack/docker-compose.reorg.yml up -d
```

Wrapped experiments need no changes to move: they read `RPC_A`/`RPC_B` from the environment, and the
runner sets those to the declared stack's URLs.

**What is left untested, and why.** Four of the five remaining `untested` entries need machinery the
board does not have yet; one is a deliberate non-goal. Keeping them listed is the point — an
unexercised surface should be visible, not absent:

| id | needs | nature |
|---|---|---|
| `a4` | a settle submitted at exactly `expiry-1` with deterministic block timing | on-demand mining stack (as E16 uses) |
| `d4` | block-exact submission at `lockedUntil+GRACE` and ±1 | same — boundary races need mining control |
| `b4` | E14's real-peg-in driver re-run with a rival intent naming the same txid | superseded in part by the RSKIP-176 milestone, which removes the surface |
| `f3` | bitcoind `invalidateblock` past `MIN_BTC_CONF` plus a Bridge header re-relay | the one that could falsify the SPV assumption — highest value of the four |
| `e6` | — | **non-goal**: an attack on keccak256 preimage resistance. Listed so the assumption is explicit, not to be attempted |
| `m2` | a patched `MinerUtils` in the rskj clone that drops a chosen sender | on-demand mining now exists, but *persistent exclusion* does not: `evm_mine` includes whatever the pool holds. Withholding the tx by partitioning instead would demonstrate a network split, not censorship |
| `m4` | an on-demand-mining stack **with bitcoind** — the reorg stack deliberately has none | no new attack logic needed: E16's partition already orphans a settle, and an exit settle needs a real BTC payment and header proof. Wants a third compose file |

`m3` was in this table until it wasn't: it needed only on-demand mining, which the stack layer now
provides, so it is written and runs. `a4` and `d4` are the next two in the same position — both are
block-boundary races, both now expressible, neither yet written.

**Shared-script attribution.** Some attacks wrap the same experiment (`e1` and `e2` both wrap E19), and
a board run executes it once and reuses the outcome. Both ids therefore inherit E19's *aggregate*
verdict, so a failure in either marks both. Splitting E19's assertions per attack — or pointing the two
ids at separate scripts — is the real fix; the cache scoping is not it.

## Adding an attack

Write a module exporting `run(spec: AttackSpec, ctx: StackCtx): Promise<number>`, build an `Attack`
from the spec (`new Attack(spec, ctx.rpc)`), and return `a.finish(observed)`. Then add the registry
entry — including the expected outcome, before you run it. Predicting first is what makes a deviation
mean something.

The `ctx` parameter is optional in practice: an attack that only needs the everyday stack can keep the
one-argument `run(spec)` signature and use the harness's `rpcA`, as most of the board does. Take `ctx`
when the attack needs to control block production, and set `stack:` in its registry entry.

Two harness rules the forensics enforce with a throw rather than a wrong number: register every
`watch()` **before** the first `mark()`, and `mark()` before any `deltas()`. A late watch has no
baseline, and a missing baseline reads as a zero delta — which a check written as "the attacker gained
nothing" would score as a **pass**. Four attacks were caught by exactly this.

`_btc.ts` carries the Bitcoin-side scaffolding the exit attacks need: chunked Bridge header relay
(rskj's pool rejects a nonce more than ~20 ahead, so the whole-backlog batch E19 uses dies on a fresh
bitcoind), hand-serialised payouts with arbitrary outputs (`createrawtransaction` refuses a duplicated
address, so it cannot express paying one destination twice), and witness stripping.
