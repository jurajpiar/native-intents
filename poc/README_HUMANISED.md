# Native-intent proof of concept

This directory contains a runnable proof of concept for the native-intent transaction type and a set
of experiments designed to break its claims. It began as a milestone-1 admission test and now covers
atomic settlement, token outputs, visible reverts, solver repayment, and activation gating.

For the design and its unresolved pressure points, start with
[`../native-intent-design-sketch.md`](../native-intent-design-sketch.md). This directory contains the
implementation and test harness.

## What the PoC does

An intent is a Rootstock typed transaction with the envelope `0x02 || 0x49 || legacy-body`. Its signed
`data` field contains five constraints: a pipeline commitment `H`, a Bitcoin transaction ID, an expiry
height `E`, a minimum output, and an output-token address.

The intent itself is admitted to the mempool and gossiped, but never mined. Its purpose is to prove two
pre-inclusion properties:

- **Payer-less mempool access:** a signed intent from a new, zero-balance account can be admitted and
  relayed because active intents have zero transaction cost.
- **Rejection before inclusion:** an expired, consumed, or ticketless intent is rejected before it can
  enter a block, so it consumes no gas and leaves no on-chain trace.

Settlement is a normal solver-paid EVM transaction. It calls a fixed-address settlement contract,
which authenticates the raw intent through a stateless parsing precompile. The contract delivers at
least `minOut` of RBTC or an ERC-20 to the user, releases the modelled peg-in escrow to the solver, and
records `H` as consumed. Any failure reverts the whole call visibly.

The `RSKIPINTENT` rule gates the zero-cost path, admission checks, and parser. Regtest activates it at
block 40 so the test harness can observe behaviour on both sides of the fork.

## Directory layout

```
poc/
  rskj-patch/        patcher and new Java sources for the rskj branch
  contracts/         Settlement.sol, TestToken.sol, and the compile script
  stack/             bitcoind regtest and two patched rskj nodes
  sdk/               TypeScript codec, toy solver, and experiment drivers
  experiments/       methodology and experiment-to-claim mapping
```

## Quick start

You need Podman with Compose support and Node.js 20 or newer. The first rskj image build is large and
needs access to GitHub, Gradle, Maven, and `deps.rsklabs.io`.

Run the following from `poc/`:

```sh
# Build the patched rskj image. The poc directory is the build context.
podman build -f stack/Containerfile.rskj -t rskj-intent:poc .

# Start bitcoind and the two rskj nodes.
podman-compose -f stack/podman-compose.yml up -d

# Run the codec test and the default experiment suite.
cd sdk
npm install
npm test
npm run all
```

Node A listens on `http://localhost:4444` and node B on `http://localhost:4445`. Set `RPC_A` and
`RPC_B` to override them.

The default suite runs with Bitcoin-ticket enforcement disabled. E8 and E8+ need
`INTENT_REQUIRE_TICKET=true` and the peg-in driver described in
[`stack/scripts/pegin.md`](stack/scripts/pegin.md).

E13 should be run immediately after starting a fresh stack because its pre-activation window lasts only
until regtest block 40:

```sh
cd sdk
npm run e13
```

E9 is also a separate run because it manipulates the local snapshot state:

```sh
npm run e9
```

## What has been verified

The current PoC has been built and run against two patched rskj regtest nodes and bitcoind. The
experiments cover:

- E1/E1b: payer-less admission and cross-node gossip;
- E2/E3: pre-inclusion expiry and replay protection;
- E6/E7: atomic settlement and rejection of under-delivery;
- E8/E8+: negative and positive Bitcoin-ticket admission;
- E9: state reversion after a dropped settlement;
- E10/E11: ERC-20 output and visible failure receipts;
- E12: solver repayment from input escrow and spread; and
- E13: activation-gated behaviour.

E1b can occasionally need a rerun immediately after recreating the stack because transaction gossip
may lag the first few blocks. The other default-suite experiments are deterministic in the current
harness.

## What remains modelled or incomplete

- **Peg-in crediting is simulated.** `depositForPegin` puts RBTC into the settlement contract, but a
  production peg-in must credit the contract directly and authenticate the binding between the Bitcoin
  transaction, user, intent, and amount.
- **Expired escrow has no production recovery path.** Once a real peg-in credits the contract, an
  unsolved intent needs a safe way to return its input to the user.
- **The settlement contract is still deployed at genesis.** Public-network deployment should happen in
  the activation-block transition and needs state-root tests.
- **The solver market is not implemented.** Discovery, reveal access, price competition, bonding,
  endorsement, and reputation remain off-consensus design work.
- **There is no consensus-level bundle.** Settlement is one atomic VM transaction. A miner-assembled
  intent-and-solution bundle is deferred until ordering, MEV, or batch settlement justifies it.
- **Reorg testing is deterministic rather than network-realistic.** E9 uses `evm_snapshot` and
  `evm_revert`, which exercise state rollback, but not a genuine two-miner partition and merge.

The goal is not to produce a demo that always passes. It is to make each failure informative enough to
show whether the implementation is wrong or the design itself needs to change.
