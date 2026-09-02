# Native-intent PoC

A runnable proof-of-concept for the native-intent transaction type, plus a suite of experiments that
try to break it. Anchored on the two irreducible claims — the properties a smart contract genuinely
cannot provide — and grown from there to atomic settlement, real peg-in binding, an enforced
above-minOut auction, and hardened post-win failure modes. Honest about what remains (below).

Read `../native-intent-design-sketch.md` first for the idea and its pressure points. This directory is
the build.

## What this is

An intent is a Rootstock-native typed transaction (`0x02 || 0x49 || legacy-body`) whose `data` field
carries signed constraints: a pipeline commitment H, a referenced BTC txid, an expiry height E, and a
minimum output. The user signs constraints, not calldata.

The intent is **mempool-only: admitted, gossiped, never mined**; the two pre-inclusion properties live
there. Settlement is a single EVM-atomic solver transaction that calls a genesis-deployed
**settlement contract** (`contracts/Settlement.sol`): it authenticates the intent via a stateless
parse precompile, delivers ≥ min-out of the output asset (RBTC or ERC-20) to the user, releases the
pegged-in input to the solver, and records H consumed — or reverts visibly, leaving H intact. Once an
intent is bid upon, a genesis **auction** (`contracts/Auction.sol`) owns settlement: the user nets the
best bid, payouts are pull-payments, and exclusivity decays if the auction stalls (E17b/E18).
`experiments/README.md` maps every claim to the experiment that tries to falsify it.

What the intent type buys, precisely:

- Claim 1 — a fresh zero-balance account's signed intent becomes a gossiped mempool object. Delivered
  by treating the intent as a free transaction, so the balance and account-state gates do not reject a
  payer-less sender.
- Claim 2 — an expired or already-consumed intent is rejected at admission: never in a block, no gas,
  nothing on chain. Delivered by pre-inclusion checks over height and the consumed set.

## Layout

```
poc/
  rskj-patch/        RETIRED provenance of the rskj change (base: PR #3558) — the clone at the repo
                     root (../rskj/) carries all patches directly and is authoritative
  contracts/         Settlement.sol, Auction.sol (+ Bond, vaults, Griefer test helper), and compile.js —
                     which also injects the genesis runtime bytecode straight into ../rskj/
  stack/             podman: bitcoind regtest + two patched rskj regtest nodes (built from ../rskj/)
  sdk/               TypeScript: intent codec, toy solver, and the experiments
  experiments/       methodology + the map from each experiment to a claim (code is in sdk/experiments)
```

Changing a genesis contract is a two-step loop: edit the `.sol`, run `node compile.js` (from
`contracts/`, needs `npm i solc@0.8.19` once) — it rebuilds `build/*.json`, refreshes the SDK ABIs'
source of truth, and injects the new runtime bytecode into the rskj clone's `rsk-dev.json` — then
rebuild the stack with wiped volumes so the new genesis takes effect.

## Quickstart

Prerequisites: podman + podman-compose, and Node 20+. Build needs network egress (GitHub, gradle,
Maven, deps.rsklabs.io). The rskj image build is heavy and takes a while the first time.

```
# 1. build the patched rskj image (run from the REPO ROOT, so the rskj/ clone is in context)
podman build -f poc/stack/Containerfile.rskj -t rskj-intent:poc .

# 2. bring up bitcoind + two rskj nodes
podman-compose -f stack/podman-compose.yml up -d

# 3. run the harness
cd sdk
npm install
npm test          # offline: verifies the intent wire-encoding is byte-exact for rskj
npm run all       # runs the full suite (E1 … E18, minus E8/E9/E13/E14/E16 which need special setups)
```

Node A RPC is on `http://localhost:4444`, node B on `http://localhost:4445`. Override with the `RPC_A` /
`RPC_B` env vars (fish: `set -x RPC_A http://localhost:4444`).

E8 (anti-spam) needs a node started with `-Dintent.requireBtcTicket=true`; the compose default is
`false` so the core claims run without any BTC setup. The positive BTC-ticket path is `stack/scripts/pegin.md`.

## The honest part

The early gaps this section used to list — an uncompiled patch, no atomic settlement, no min-out
enforcement, no reorg test, an always-on registry — are closed and experiment-verified (see the root
README and `experiments/README.md`). What honestly remains:

- **The upstream base is unmerged.** The rskj clone builds and runs, but it sits on PR #3558 (the
  typed-transaction branch), not on a released rskj. If upstream reshapes that branch, the clone
  carries the rebase burden — `rskj-patch/` survives only as provenance of what was changed.
- **A contract user can still force failed settles.** Delivery to a user whose receive reverts fails
  every settle; E18's hardening bounds this (exclusivity decays after `GRACE`, then open competition
  at `minOut`, then expiry) but cannot make an undeliverable intent deliverable — and the decay path
  forfeits the auction surplus.
- **The modelled input escrow has no refund path.** `depositForPegin` funds stranded in Settlement if
  an intent expires unsettled. The production story (a real peg-in sitting in the user's own account,
  E14) doesn't have this problem; the PoC model does, and no experiment exercises the stranding.
- **Bonding is decorative.** `Bond` is off the settle path, slashing is manual and arbiter-only; bond
  sizing and slashing conditions are open in the fees RSKIP draft.
- **No mempool eviction.** Consumed/expired intents are rejected at admission but never evicted from
  a pool that already holds them.

The goal is not a demo that passes. It is a rig where a failing experiment tells you the *design* needs
to change, not the code.
