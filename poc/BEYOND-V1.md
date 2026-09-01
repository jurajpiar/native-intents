# Beyond v1 — token outputs and a consensus-level bundle

Design notes for the two larger items left after the v1 PoC. Both are scoped here rather than built,
because each is its own milestone and the first one changes the settlement architecture.

> Status: item 1 (the settlement-contract turn) is IMPLEMENTED as milestone 3 — token outputs and
> visible reverts both landed (experiments E10, E11). The input-claim (fee mechanics) and the
> consensus-level bundle remain future work. The rest of this note is kept as the original design record.

## 1. Non-RBTC (token) outputs — the settlement-contract turn

### Why the raw precompile is the wrong home for this

v1 settlement is a raw precompile (`IntentRegistryContract.solve`) that moves RBTC with
`Repository.transfer`. Arbitrary token outputs don't fit that shape:

- The output is an ERC-20, so delivery is `token.transferFrom(solver, user, minOut)` — an EVM call to
  an arbitrary contract. Precompiles don't invoke the VM; the Bridge never calls user contracts.
- Verifying "the user received ≥ minOut of token T" needs a before/after balance delta within the tx,
  which a precompile (seeing only current state) can't observe cleanly.
- And, separately, a raw precompile can't revert visibly (the item-2 finding): a failed `solve` reports
  success.

All three point the same way: settlement belongs in a **VM contract**, not a precompile.

### Proposed architecture

Move settlement into a settlement contract `S` (Solidity/bytecode, deployed at genesis on regtest).
The intent's `data` gains an `outputToken` field (address; the zero address means native RBTC):

```
data = H(32) | btcTxid(32) | expiry(32) | minOut(32) | outputToken(32, low 20 bytes)
```

`S.settle(rawIntentTx)` runs entirely in the VM, so ordinary revert semantics apply:

1. Recover the user and read the constraints from `rawIntentTx` (ecrecover in-contract, or via a small
   verify precompile).
2. Re-check admission at the inclusion height: unexpired, `H` unconsumed, BTC ticket present.
3. Deliver the output: `outputToken == 0` → require `msg.value ≥ minOut`, forward to the user;
   otherwise `IERC20(outputToken).transferFrom(solver, user, minOut)`.
4. Claim the input: transfer the peg-in input from the user to the solver (the fee RSKIP's step 4).
5. Mark `H` consumed.

Any failure reverts the whole call — visibly (a failed receipt), rolling back delivery and the consume.
This subsumes the item-2 "visible revert" goal: routing settlement through `S` gives correct revert
semantics for free.

### What happens to the registry precompile

It shrinks or disappears. The consumed set can simply be `S`'s own contract storage: admission reads it
with `eth_getStorageBytes` at `S`'s address exactly as it reads the precompile's storage today, and
reorg reversion still applies (ordinary world state). If a precompile is kept at all, it is only a
cheap consumed-set store with access control (`consume` callable only by `S`). Net effect: one contract
replaces the precompile, and the design gains tokens + visible reverts together.

Cost trade-off: a contract's storage writes cost more gas than the precompile's fixed cost, and it must
be deployed (genesis-deployed on regtest). Admission stays a plain storage read. This is the natural
milestone 3.

## 2. Consensus-level intent+solution bundle

v1 settles with a single solver transaction; EVM atomicity supplies the "all-or-nothing" guarantee,
which is enough for the core property (no consumption without delivery). A consensus-level bundle — a
miner-assembled unit pairing an intent with its solution — is a different, larger thing, and it buys
things the single-tx model does not:

- Ordering / MEV control: the intent and its solution are placed as a unit, so a searcher can't wedge a
  transaction between them.
- Multi-intent / batch solutions: one solution satisfying several intents atomically (the "intent-based
  batching from Bitcoin" initiative).
- A distinct mempool object for intents that miners include directly, rather than intents being pure
  discovery objects settled by a solver tx.

The cost is a block-construction/consensus change: a new bundle type, miner logic to select and pair
intents with solutions, validity rules for the pairing, and fee/ordering rules. It reuses RIP-7560's
vocabulary (bundle structure, validation-phase separation) so a future 7560 landing reads as family.

Recommendation: defer. The single-tx model demonstrates the irreducible properties and atomic
settlement; a consensus bundle is warranted only once MEV/ordering or batch-solving is a real
requirement, and it is best designed against whatever typed-tx/AA direction (RIP-7560) has landed by
then.

## Suggested order

1. Milestone 3 — the settlement contract (token outputs + visible reverts, together). This is the next
   substantive build and it retires the item-2 caveat.
2. Fee mechanics implementation — build the input-claim step (fee RSKIP) on top of the settlement
   contract, where it naturally lives.
3. Consensus bundle — only if MEV/ordering or batch-solving becomes a requirement.
