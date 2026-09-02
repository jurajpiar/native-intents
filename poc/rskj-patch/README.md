# rskj patch — native intent, milestone 1

> **RETIRED (2026-09-02): provenance only.** The rskj clone at the repo root (`rskj/`) carries all
> of these patches directly and is authoritative; the stack builds from it. Genesis contract
> bytecode is injected by `poc/contracts/compile.js` on every compile. Edit the clone directly —
> do not add new `apply.py` entries.

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

(Milestone 3 architecture. Settlement now lives in a VM contract; the precompile is a stateless parser.)

Three new files under `co.rsk.intent` (copied in by the patcher):
- `IntentConstants` — subtype byte `0x49`, parse-precompile address `0x…01000020`, settlement-contract
  address `0x…01000021`, the intent `data` layout (`H | btcTxid | E | minOut | outputToken`, five 32-byte
  words), and the Bridge processed-peg-in storage key.
- `IntentRegistryContract` — the stateless **parse precompile**: `execute(rawIntentTx)` authenticates the
  intent (`ImmutableTransaction.getSender`) and returns `abi(sender, H, btcTxid, expiry, minOut, outputToken)`.
  No state; the settlement contract STATICCALLs it.
- `IntentAdmission` — the pre-inclusion checks: not expired, H unconsumed (read from the settlement
  contract's storage at slot == H), BTC ticket visible. Plain storage reads; no BridgeSupport construction.

Seven anchored edits + a genesis injection (see `apply.py`):
1. `Transaction.isNativeIntent()` — `0x02 || 0x49`.
2. `Transaction.transactionCost()` → 0 for intents (makes a zero-balance sender admissible — claim 1; mempool policy).
3. `TransactionPoolImpl.internalAddTransaction` → run `IntentAdmission.check` (claim 2).
4. `MinerUtils.getAllTransactions` → drop intents from block building (never mined standalone).
5. `PrecompiledContracts.getContractForAddress` → register the parse precompile.
6. `PrecompiledContracts.GENESIS_ADDRESSES` → add the parse-precompile address for consistent existence checks.
7. `BridgeRegTestConstants` → `minSecondsBetweenCallsReceiveHeader = 0` (regtest, for the peg-in header relay).
8. Genesis (`rsk-dev.json`): deploy the compiled `Settlement.sol` runtime bytecode at `0x…01000021`
   (JSON-aware, idempotent; bytecode from `genesis/settlement.runtime.hex`).

The settlement contract's source is `poc/contracts/Settlement.sol` (compile with `poc/contracts/compile.js`);
re-run that to regenerate the genesis bytecode if you change the contract.

## Apply

```
python3 apply.py /path/to/rskj            # idempotent; --check for a dry run
```

The patcher copies the new files, applies each edit only if its marker is absent (failing loudly if an
anchor does not match exactly once), and injects the settlement contract into `rsk-dev.json` (skipped if
already present). Verified against the head above: all seven anchors match, the genesis inject is valid,
and a second run is a no-op.

## Honest caveats (read before trusting this)

- **Build/run status.** Milestones 1 and 2 compiled and ran end to end (all m1/m2 experiments + the BTC
  peg-in passed on a real build). The milestone-3 changes here (parse precompile, settlement contract,
  genesis deploy, 160-byte data) are typechecked/verified as far as possible off-node but **not yet run**
  end to end — expect a round or two of iteration on the contract↔precompile call and genesis deploy.
- **Admission does a Bridge storage read on the pool's synchronized path.** Cheap (one `getStorageBytes`),
  but it is on the p2p ingress hot path; a production version wants this measured and possibly cached.
- **The registry is always-on at genesis** rather than behind a new RSKIP activation gate. Concretely:
  adding its address to `GENESIS_ADDRESSES` means `BlockExecutor.maintainPrecompiledContractStorageRoots`
  sets up its storage at the RSKIP126 activation block, which changes the state root there. On a fresh
  regtest genesis (all forks at height 0) every node runs identical code and agrees — fine. But a node
  with this patch **cannot re-sync mainnet/testnet history**, and shipping needs a proper activation gate.
- **Settlement is a VM contract (m3).** `Settlement.settle(rawIntentTx)` authenticates the intent (via
  the parse precompile), re-checks admission at inclusion height, delivers ≥ minOut of the output asset
  (RBTC or ERC-20) to the user, and records H — atomically, reverting *visibly* on failure. The only way
  to consume H is to satisfy the intent (closes the m1 grief vector). Solver repayment/spread is still a
  future companion RSKIP (the solver delivers minOut and is not repaid).
