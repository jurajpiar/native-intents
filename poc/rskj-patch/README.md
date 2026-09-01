# rskj patch — native intent, milestone 1

Adds the native-intent transaction subtype and its consumed-set registry to rskj, scoped to what the
two irreducible claims need: pre-inclusion admission and a world-state consumed set. Intents are
**mempool-only, never mined** in this milestone.

## Base branch

This patches **PR #3558** (`rsksmart/rskj`, the RSKIP543/545/546 typed-transaction branch), head
`8d7b0918f7a3b3eaeacbe432b26d985fb22cb4f9`. That branch already ships the `0x02 || subtype` RSK
namespace, active on regtest at height 0 — so the intent needs no new parser/encoder/record: the
subtype byte lives in the prefix, the constraints live in the `data` field. Master has no typed-tx
support at all; do not use it.

## What it changes

Three new files under `co.rsk.intent` (copied in by the patcher):
- `IntentConstants` — subtype byte `0x49`, registry address `0x…01000020`, the intent `data` layout
  (`H | btcTxid | E | minOut`, four 32-byte words), and the Bridge processed-peg-in storage key.
- `IntentRegistryContract` — the consumed-set precompile. `consume(bytes32)`, `isConsumed`,
  `consumedHeight`. Writes go to the tx execution track, so H is recorded only if the solver's tx
  succeeds — consume-on-success for free.
- `IntentAdmission` — the pre-inclusion checks: not expired, H unconsumed, BTC ticket visible. Plain
  storage reads against the current snapshot; no BridgeSupport construction.

Six anchored edits to existing files (see `apply.py`):
1. `Transaction.isNativeIntent()` — `0x02 || 0x49`.
2. `Transaction.transactionCost()` → 0 for intents. This is what makes a zero-balance sender admissible
   (claim 1). Because intents are never mined, this has no consensus surface in m1 — it is mempool policy.
3. `TransactionPoolImpl.internalAddTransaction` → run `IntentAdmission.check` (claim 2).
4. `MinerUtils.getAllTransactions` → drop intents from block building (never mined standalone).
5. `PrecompiledContracts.getContractForAddress` → register the registry.
6. `PrecompiledContracts.GENESIS_ADDRESSES` → add the registry address so existence checks are consistent.

## Apply

```
python3 apply.py /path/to/rskj            # idempotent; --check for a dry run
```

The patcher copies the new files, then applies each edit only if its marker is absent, and fails loudly
if an anchor does not match exactly once (which would mean the base branch moved). Verified against the
head above: all six anchors match, and a second run is a no-op.

## Honest caveats (read before trusting this)

- **Not compiled.** It was written against a read of the pr3558 source; it has not been built. The base
  branch itself is half-finished for RSK-namespace txs: `Type2RSKTransactionEncoder` is marked
  "incomplete", and commit `974c917` reverted a yParity-validation fix. The first build on your machine
  may surface type errors — paste them back and they get fixed fast. The SDK side of the wire format
  *is* verified (`sdk/test/encoding.test.ts`), so mismatches are most likely on the Java encoder, not
  the bytes the SDK produces.
- **Admission does a Bridge storage read on the pool's synchronized path.** Cheap (one `getStorageBytes`),
  but it is on the p2p ingress hot path; a production version wants this measured and possibly cached.
- **The registry is always-on at genesis** rather than behind a new RSKIP activation gate. Concretely:
  adding its address to `GENESIS_ADDRESSES` means `BlockExecutor.maintainPrecompiledContractStorageRoots`
  sets up its storage at the RSKIP126 activation block, which changes the state root there. On a fresh
  regtest genesis (all forks at height 0) every node runs identical code and agrees — fine. But a node
  with this patch **cannot re-sync mainnet/testnet history**, and shipping needs a proper activation gate.
- **Milestone 2 (atomic solve) is applied.** The registry's `solve(rawIntentTx)` authenticates the
  intent, re-checks admission at inclusion height, delivers ≥ minOut from solver to user, and records H
  consumed — all in one EVM-atomic transaction. The permissionless m1 `consume()` is removed, so H can
  only be consumed by satisfying the intent (this closes the m1 grief vector; E6 now passes by the grief
  failing). Output is modelled as RBTC; solver repayment/spread is a future companion RSKIP.
