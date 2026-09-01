# Native-intent PoC (milestone 1)

A runnable proof-of-concept for the native-intent transaction type, plus a suite of experiments that
try to break it. Scoped to the two irreducible claims — the properties a smart contract genuinely
cannot provide — and honest about everything it does not yet cover.

Read `../native-intent-design-sketch.md` first for the idea and its pressure points. This directory is
the build.

## What milestone 1 is

An intent is a Rootstock-native typed transaction (`0x02 || 0x49 || legacy-body`) whose `data` field
carries signed constraints: a pipeline commitment H, a referenced BTC txid, an expiry height E, and a
minimum output. The user signs constraints, not calldata.

The intent is **mempool-only: admitted, gossiped, never mined**; it exists to prove the two
pre-inclusion properties. Settlement is a single EVM-atomic solver transaction that calls a
genesis-deployed **settlement contract** (`contracts/Settlement.sol`): it authenticates the intent via
a stateless parse precompile, delivers ≥ min-out of the output asset (RBTC or ERC-20) to the user, and
records H consumed — or reverts visibly (milestones 2–3). See `experiments/README.md` for status.

What that buys, precisely:

- Claim 1 — a fresh zero-balance account's signed intent becomes a gossiped mempool object. Delivered
  by treating the intent as a free transaction, so the balance and account-state gates do not reject a
  payer-less sender.
- Claim 2 — an expired or already-consumed intent is rejected at admission: never in a block, no gas,
  nothing on chain. Delivered by pre-inclusion checks over height and the consumed set.

## Layout

```
poc/
  rskj-patch/        the rskj change (base: PR #3558). apply.py + 3 new files + 7 edits + genesis deploy
  contracts/         Settlement.sol (settlement contract) + TestToken.sol, and compile.js
  stack/             podman: bitcoind regtest + two patched rskj regtest nodes
  sdk/               TypeScript: intent codec, toy solver, and the experiments
  experiments/       methodology + the map from each experiment to a claim (code is in sdk/experiments)
```

## Quickstart

Prerequisites: podman + podman-compose, and Node 20+. Build needs network egress (GitHub, gradle,
Maven, deps.rsklabs.io). The rskj image build is heavy and takes a while the first time.

```
# 1. build the patched rskj image (run from poc/, so both stack/ and rskj-patch/ are in context)
podman build -f stack/Containerfile.rskj -t rskj-intent:poc .

# 2. bring up bitcoind + two rskj nodes
podman-compose -f stack/podman-compose.yml up -d

# 3. run the harness
cd sdk
npm install
npm test          # offline: verifies the intent wire-encoding is byte-exact for rskj
npm run all       # runs E1, E1b, E2, E3, E6 against the running nodes
```

Node A RPC is on `http://localhost:4444`, node B on `http://localhost:4445`. Override with the `RPC_A` /
`RPC_B` env vars (fish: `set -x RPC_A http://localhost:4444`).

E8 (anti-spam) needs a node started with `-Dintent.requireBtcTicket=true`; the compose default is
`false` so the core claims run without any BTC setup. The positive BTC-ticket path is `stack/scripts/pegin.md`.

## The honest part

- **The rskj patch has not been compiled.** It targets a half-finished branch (the RSK-namespace encoder
  is marked incomplete upstream). Expect to iterate on build errors the first time — the SDK-side wire
  format is verified, so errors are most likely on the Java encoder. See `rskj-patch/README.md`.
- **No atomic settlement, no min-out enforcement, no reorg test, no "instant" measurement.** These are
  milestone 2 and are listed as gaps in `experiments/README.md` rather than papered over.
- **The registry is always-on and consume() is permissionless** — fine for regtest, not for shipping.
  E6 demonstrates the consume griefing this allows, which is the documented residual the atomic bundle
  is meant to close.

The goal is not a demo that passes. It is a rig where a failing experiment tells you the *design* needs
to change, not the code.
