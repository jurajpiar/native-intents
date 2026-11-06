# Claims and the evidence for them

**TL;DR** — every load-bearing claim in the RSKIP, and what actually backs it. The column that matters
is *Evidence*: `measured` means a number exists in `poc/measurements/`, `demonstrated` means an
experiment or attack observed it on a node, `source` means it was read out of rskj or a contract,
and **`asserted` means nobody has checked it**. This file exists to make that last category visible,
not to defend it. Ordered by how much weight the claim carries, not by where it appears in the spec.

## How to read this

- A claim is listed in the form the RSKIP actually makes it, not a friendlier paraphrase.
- Evidence is a citation, not a description. If a row cannot cite something runnable or readable, it
  says `asserted`.
- `demonstrated` is weaker than it sounds: it means the behaviour was observed in one environment,
  usually regtest with three-confirmation peg-ins. Where that environment differs from mainnet in a
  way that matters, the row says so.
- **Nothing here upgrades itself.** A row moves from `asserted` only when someone adds the run.

## The three kinds of artefact, and what each can and cannot settle

| | Question it answers | Output | Cannot tell you |
|---|---|---|---|
| `sdk/experiments/` | Is this claim false? | pass / fail | how much anything costs |
| `sdk/attacks/` | Does this adversary win? | blocked / contained / succeeds | how much anything costs |
| `sdk/measure/` | How much? | distributions, in `measurements/*.jsonl` | whether the amount is acceptable |

The third one is deliberately verdict-free. Turning a number into "acceptable" is a judgement, and it
belongs in this file with the number cited beside it, so the judgement can be revisited when the
number changes.

---

## Load-bearing claims

| # | Claim | Evidence | Where |
|---|---|---|---|
| 1 | A signed intent from a zero-balance account is admitted and gossiped | demonstrated | `e1`, `e1b` |
| 2 | An expired or consumed intent is rejected before inclusion, costing nothing | demonstrated | `e2`, `e3` |
| 3 | A solver can discover an intent in the pool and settle it with no channel to the user | demonstrated | `e24` |
| 4 | Settlement delivers `minOut` and consumes `H` atomically, or neither | demonstrated | `e7`, `e11` |
| 5 | Escrow answers only to the `(H, signer)` pair it was deposited for | demonstrated | `b1`, `b5`, `e23` |
| 6 | The anti-spam ticket bounds entry, not volume — one peg-in admits unlimited intents | measured (41 intents, 1 ticket) | `a6` |
| 6b | A chosen `H` cannot write into the settlement contract's own storage | **demonstrated, after a fix** — the attack landed first, then was closed by moving the consumed set to a precompile | `b6` |
| 7 | Rejection is cheap enough that free admission is not a DoS surface | measured on the p2p path, verdict **not drawn**: see [M02](#m02-the-peer-to-peer-path) | `m01`, `m02` |
| 8 | Verifying a Bitcoin merkle branch at admission would be marginal next to work already done per intent | denominator **measured**, numerator **asserted** | `m01` run 2026-09-04T07-40-30Z |
| 9 | The mempool gives *common* discovery, so no single dApp becomes the liveness provider | **asserted** | no multi-solver-over-gossip run exists |
| 10 | Contracts cannot provide payer-less admission or pre-inclusion invalidity | **asserted** | ERC-4337 is a counter-case the spec names but does not measure against |

## Quantities the spec states

| # | Quantity | Value stated | Evidence | Where |
|---|---|---|---|---|
| 11 | Mainnet peg-in confirmations | 100 | source | `BridgeMainNetConstants:22` |
| 12 | Peg-in wait, mean and spread | 16.7 h, σ 100 min | derived from 11 (Gamma) | arithmetic, not observed |
| 13 | `maxExpirySpan` reference value | 100 blocks | source | `IntentConstants:68` |
| 14 | A fixed `E` lands in the admission window ~1 time in 5 | — | derived from 11–13 | **never simulated** |
| 15 | Block timestamp future allowance | 540 s | source | `Constants.java:61` |
| 16 | `PUSH_GAS` stipend | 30 000 | source | `Settlement.sol` |
| 17 | `MIN_EXECUTE_GAS` floor | 500 000 | source | `Auction.sol` |
| 18 | Intent envelope size | 262 bytes | measured | `a6`, `e24` |
| 19 | Proposed proof-carrying envelope size | ~1 KB | **asserted** | never built |

## Measured

From `measurements/m01_admission_staircase.2026-09-04T07-40-30-283Z.jsonl`, 400 interleaved rounds per
variant, regtest, over JSON-RPC from the host. Medians, with 95% bootstrap intervals on differences.

| What | Run A | Run B | Run C (ticket ON) | Reading |
|---|---|---|---|---|
| RPC round trip, no transaction | 1.715 ms | 1.759 ms | 2.594 ms | the floor every other number sits on |
| Refuse at the signature component check | +79 µs [31, 148] | +95 µs [33, 154] | below resolution | decode, range-check `r`/`s`, stop |
| **Signature validation through to the admission path** | **+530 µs [460, 581]** | **+539 µs [472, 597]** | **+589 µs [475, 702]** | the per-intent cryptographic cost |
| Each pure admission rule (2, 3, 4) | below resolution | below resolution | below resolution | intervals span zero at ±~70–180 µs |
| Rule 5, first storage read | below resolution | not run | not run | interval [−105, +27] µs |
| **Rule 6, second storage read** | not run | not run | **below resolution** | interval [−125, +127] µs |
| **Accepting rather than rejecting at rule 4** | not usable | **+200 µs [121, 250]** | not usable | pool insert plus gossip |

Three runs: `…07-40-30-283Z`, `…07-49-46-447Z`, `…07-55-48-392Z`. The headline figure reproduced across
all three — 530, 539, 589 µs — which is the main reason to trust it. Run C was a noisier machine
(control p50 2.59 ms against 1.72 ms), and its wider intervals swallowed the signature-check row that
the quieter runs resolved. Same instrument, same code, different day: that is the resolution floor
moving, and it is why single-run numbers from this harness should not be quoted.

**Every one of the six admission rules is individually below this method's resolution**, storage reads
included. Only two admission-side costs are resolvable at all: the ~540 µs of per-intent cryptography,
and the ~200 µs to accept rather than reject.

The 530 µs figure is the one claim 8 needed. `sig_undecodable` is refused inside
`acceptTransactionSignature` on `s >= SECP256K1N_HALF`, a BigInteger comparison that happens **before**
any elliptic-curve work, while `len_161` carries a valid signature and so pays full sender recovery
before reaching `IntentAdmission`. The gap between them is therefore dominated by ECDSA recovery. A
Bitcoin merkle branch is roughly a dozen double-SHA256 operations, which is single-digit microseconds
— about two orders of magnitude below what the node already spends per intent. **That comparison is
still one-sided**: the numerator has not been measured, and it must include the Bridge header read,
not just the hashing. Row 25 stays open.

Three findings that were not the point of the run:

- **The pure rules are invisible from outside.** Rules 2, 3, 4 and even the rule-5 storage read all sit
  under this method's ~70 µs resolution. More samples will not fix that — the transport is the limit.
  These are precisely the rows that justify phase-two instrumentation, and nothing else does.
- **rskj reports a low-`s` signature as `"Invalid chainId: 33"`.** `checkInvalidChain` raises that
  message whenever `acceptTransactionSignature` returns false, whatever the actual cause. Worth knowing
  before debugging a signer against it.
- **Rule 6 is not measurably cheap — it is measurably invisible, and so is everything it might be
  replaced by.** The argument for keeping the processed-peg-in check has an implicit premise: that a
  storage read is cheap and a carried SPV proof would be expensive. The storage read does not resolve
  above noise, and neither would a dozen SHA-256 operations. What this rules out is the *asymmetry*,
  not either side's cost. Deciding rule 6's replacement on admission CPU alone is choosing between two
  quantities this instrument cannot separate, against a fixed ~540 µs of cryptography both pay anyway.
  The real costs of that swap are elsewhere — envelope size, the federation-derivation hazard, and the
  header read — and none of those is a latency question.
- **Acceptance costs about 200 µs more than rejection**, and that gap — pool insert plus gossip — is
  larger than every individual rule and is the only admission-side cost this method can resolve at
  all. Rejecting an intent is cheaper than accepting one, which is the direction the pre-inclusion
  argument wants, though the margin is smaller than the transport it rides on.
- **Pool insertion showed no trend from 150 to 550 pending intents.** Binning run B's `accepted`
  samples by round and differencing against a rejection row in the same bin — which cancels drift
  common to both — gives 140, 242, 188, 206, 191, 33, 238, 254 µs across the run. That scatter is
  larger than any trend in it. Within this range and resolution insertion looks flat; it is not
  evidence of O(1), because 550 entries is a small pool and the noise is ±100 µs. Row 23, partially.

### M02: the peer-to-peer path

Source: `measurements/m02_p2p_flood.staircase.2026-11-06T17-41-18-762Z.jsonl`,
`measurements/m02_p2p_flood.cost.2026-11-06T18-08-13-904Z.jsonl`, and node B's log for each
(`measurements/m02-rskj-b-staircase.log`, `m02-rskj-b-cost.log`). Regtest, two nodes; intents are sent
to node A over RPC, which admits them and gossips them to node B; B is measured. B runs a narrower
expiry horizon than A (30 against 100 blocks), so A relays intents B must refuse. Container CPU of B,
read from its cgroup. Harness: `poc/sdk/measure/m02_p2p_flood.ts`, whose header records the two
attempts that did not measure what they were built for, and why.

| What | Value | How |
|---|---|---|
| B's CPU per intent refused at admission (rule 4) | **2.3 ms** (2.15, 2.28, 2.32) | cost mode, 3 rounds × 3,000 intents at 50/s, idle subtracted |
| B's CPU per intent admitted | **2.8 ms** (2.64, 2.83, 2.91) | same |
| B's p2p processing rate when backlogged | 75–100 intents/s | B's log timestamps, two bursts of 1,500 |
| rskj's default per-peer limit | 1,000 messages a minute | source: `peer.messageQueue.thresholdPerMinutePerPeer`, `Stats.update`, `NodeMessageHandler.allowByScore` |
| Rate through one relaying peer at which B starts muting it | between 15 and 20 intents/s | staircase: lag ≤ 1 block at 5, 10, 15/s; 11, 28, 43 blocks at 20, 30, 60/s |
| Pool residency of an admitted intent on a default node | 10 blocks | source: `transaction.outdated.threshold`; cost mode pool plateau 443–470 at 50/s |

**What it shows.**

- **A relaying peer is muted, not overloaded.** Above 1,000 messages in a calendar minute, rskj gives the
  sending peer score −1 and drops every message from it for the rest of the minute, blocks included.
  A relays each RPC-submitted intent as its own message, so about 17 intents/s through one honest node
  is enough. B's log shows block imports stopping for 12, 28 and 44 s and resuming exactly on minute
  boundaries, and B accepting just under 1,000 intents per minute. The limit is rskj's general
  defence, not intent-specific; what is intent-specific is that the flood costs the sender nothing.
- **Per-intent cost on the receiving node is ~2.3 ms of CPU**, about four times the RPC path's 0.54 ms
  of signature work (M01). It is container CPU for everything B does per received intent: message
  handling, peer scoring, the per-account quota (each intent's fresh key creates a quota entry), admission
  and DEBUG-level file logging. It is not admission alone, and logging may be a large share of it.
- **Admitting costs ~0.5 ms more than refusing**, the direction the pre-inclusion argument wants.
- **An admitted intent leaves a default node's pool after 10 blocks**, whatever its `E`. On mainnet that
  is about five minutes, against an expiry horizon of up to 100 blocks.

**What it cannot show.** A is the attacker's entry point, so rates are what an RPC-only attacker gets
through one honest node. A wire-protocol flooder could batch intents per message, which changes how fast
the per-peer message limit is reached. B had one peer; a real node with many loses only the muted
peer's blocks. The 2.3 ms comes from one machine (Apple M4 Pro, podman) and three rounds. Whether these
costs make free admission acceptable is the judgement this file leaves to a person, on the record.

**Unexplained.** In the staircase run, B imported no blocks for 85 s ending 17:29:02, between an aborted
attempt and the rerun, outside any measured step. In the first burst-mode cost attempt, a canary sent
after the burst was not visible at B within 30 s although B's log shows the burst arriving.

## Costs nobody has measured

These are the rows that prompted this file. Each is a number the argument needs and does not have.

| # | What | Why it matters | Measurement |
|---|---|---|---|
| 20 | Marginal cost of each admission rule | decides whether rule 6 can be replaced by a proof check | `m01` — run three times, and **all six rules came back below resolution**. Needs instrumentation, or the question needs to move off latency |
| 21 | Cost of signature recovery per intent | the denominator for claim 8 | **done** — 530 µs, see Measured |
| 22 | Sustained rejection throughput, one client | the actual DoS question behind claim 7 | not written |
| 23 | Mempool insert cost as the pool grows | free objects accumulate — is insertion linear? | **partial** — no trend 150→550 pending (see Measured). Needs a far larger pool to say anything |
| 24 | Gossip bandwidth per intent, and at 4× envelope size | the cost of proof-carrying admission | not written |
| 25 | Merkle-branch verification cost against a Bridge header | the numerator for claim 8 | not written — needs the header read too |
| 26 | Storage-read cost from the admission path under load | rules 5 and 6 are both state reads on a hot path | not written |

## Closed by evidence

- **B6 — the consumed set aliased the contract's mappings.** The spec said the set was "ordinary
  storage, using `H` as the slot key" with "admission reads that slot directly". Since Solidity puts
  `someMapping[k]` at `keccak256(abi.encode(k, declarationIndex))` — a public formula over public
  inputs — an attacker could compute a mapping entry's address, sign an intent with that `H`, and
  settle: `claimedPegin[victimTxid]` flipped to true with no peg-in ever claimed, and a poisoned
  `peginIntent[txid]` left that escrow unfundable for good, since `depositForPegin` refuses any
  binding that does not match what is stored. Confirmed on a node, then fixed by moving the set to a
  precompile at `0x…24` under a domain tag. `b6` is now the regression test and asserts a pair —
  `isConsumed(H)` true *and* `legacyIsConsumed(H)` false — because either half alone would also pass
  if the settlement had silently done nothing.
- **A spec defect, not a PoC artefact.** The RSKIP specified the broken layout, so the fix belongs in
  *Parser and consumed set*, and the proposal's own analogy — that the consumed set "plays the same
  role for intents that account nonces play for ordinary transactions" — argues for node state. Its
  concession that every node must already agree on the settlement bytecode means a precompile
  relocates consensus surface rather than adding it.
- **An implementation constraint nobody had written down.** A stateful precompile must extend `Bridge`,
  `RemascContract` or `NativeContract`: `Program.callToPrecompiledAddress` calls `init()` only for
  those three, so anything else receives no repository and fails as a bare `ok=false` with no message.
  The first version of the fix hit this exactly. Recorded in
  [IMPLEMENTATION-MAP.md](IMPLEMENTATION-MAP.md).

## Open decisions this evidence should inform

- **Rule 6's replacement.** Claims 6, 7, 8 and rows 20–26 all bear on whether the processed-peg-in
  check can be swapped for a carried SPV proof at shallow depth. Right now the argument for it rests
  on row 8, which is asserted.
- **`E` selection.** Row 14 is arithmetic that has never been run against a simulated Bitcoin
  inter-block distribution. It is the basis for a proposed spec change and should not stay derived.
- **Escrow-keyed admission versus early broadcast.** These pull opposite ways. The trade is currently
  argued qualitatively, and rows 20–26 are what would let it be argued with numbers.

## Rules for this file

1. A claim entering the RSKIP gets a row here in the same change.
2. A row citing a measurement cites the `measurements/*.jsonl` run, not a remembered figure.
3. `asserted` is a legitimate state. Silently upgrading it to `demonstrated` because the claim seems
   obviously true is the failure this file is built to prevent.
4. When a measurement contradicts a claim, the claim changes. Not the row.
