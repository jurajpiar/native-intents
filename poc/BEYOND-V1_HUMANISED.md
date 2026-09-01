# Beyond the original v1 design

This note records two larger design decisions that emerged after the first PoC: moving settlement into
a VM contract and considering a consensus-level intent-and-solution bundle.

> **Current status:** contract-based settlement was implemented in milestone 3, adding ERC-20 outputs
> and visible reverts. Milestone 4 added the modelled peg-in escrow and solver input claim. The
> consensus-level bundle remains future work. The discussion below is retained as the reasoning behind
> those choices.

## 1. Moving settlement into a VM contract

### Why a stateful precompile was the wrong fit

The first design put settlement in `IntentRegistryContract.solve`, a raw precompile that transferred
RBTC through `Repository.transfer`. That approach did not extend cleanly to arbitrary tokens:

- ERC-20 delivery requires a call to `token.transferFrom(solver, user, minOut)`, but raw precompiles do
  not execute arbitrary user contracts through the VM.
- Verifying an ERC-20 balance change is naturally an EVM concern, especially when token behaviour is
  not uniform.
- In the current executor, an exception from a raw precompile does not produce a failed receipt. The
  transaction may report success and commit the precompile's writes.

All three issues pointed to the same conclusion: stateful settlement belongs in a VM contract. The
native component should do only the part that is impractical in Solidity—parsing the RSK-namespace
transaction and recovering its signer.

### Implemented architecture

The fixed-address settlement contract `S` receives `settle(rawIntentTx)`. The signed data layout is:

```
data = H(32) | btcTxid(32) | expiry(32) | minOut(32) | outputToken(32, low 20 bytes)
```

The zero token address means native RBTC. Any other address identifies an ERC-20.

Settlement now works as follows:

1. `S` makes a `STATICCALL` to the stateless parsing precompile, which authenticates the envelope and
   returns the sender and signed fields.
2. `S` checks expiry and confirms that `H` has not already been consumed.
3. `S` records `H` on the current execution track to block re-entrancy.
4. For an RBTC output, `S` forwards at least `minOut` from `msg.value`; for an ERC-20 output, it calls
   `transferFrom` using the solver's allowance.
5. `S` clears the RBTC escrow keyed by `btcTxid` and releases it to the solver.

Any later failure reverts the entire transaction, including the consumed marker and all transfers. The
failed receipt is visible because execution stays in the VM.

The consumed set now lives in the settlement contract's own storage, using `H` as the slot key. Mempool
admission reads the same world state directly. Reorg behaviour remains ordinary state reversion.

The remaining precompile is stateless. It reconstructs the signing hash, authenticates the intent, and
returns six ABI words. It neither settles nor stores consumption state.

### Trade-offs and remaining gaps

Contract storage and calls cost more gas than a purpose-built stateful precompile, but they also provide
normal EVM call and revert behaviour. For this path, correctness and composability outweigh the extra
gas.

The PoC deploys `S` in regtest genesis. A public network must install it at the intent activation block
and verify the resulting state root.

The PoC's `depositForPegin` models an RBTC credit to escrow. It is not a production binding between the
Bridge, `btcTxid`, user, intent, and amount. A real Bridge credit and an expired-escrow recovery path are
still required.

## 2. Consensus-level intent-and-solution bundles

The current design settles an intent with one solver transaction. EVM atomicity already guarantees the
core safety property: the intent cannot be consumed unless the required delivery and input release
succeed.

A consensus-level bundle would be a different mechanism. It would let a miner treat an intent and its
solution as one block-construction unit. That could add:

- **Ordering and MEV control:** the pair could not be separated by an intervening transaction.
- **Multi-intent settlement:** one solution could satisfy several intents atomically, supporting the
  Bitcoin batching initiative.
- **Direct inclusion semantics:** intents could become objects that miners pair and include rather than
  mempool-only discovery messages.

Those benefits come with substantial cost. rskj would need a new bundle representation, pairing and
selection logic, consensus validity rules, and explicit fee and ordering semantics. The design would
also need to account for whatever typed-transaction and native-account-abstraction direction has landed
by then. RIP-7560 provides useful vocabulary for bundle structure and validation phases.

### Recommendation

Defer the consensus bundle. The single-transaction model already demonstrates admission, atomic
delivery, replay protection, token outputs, visible failure, and solver repayment. A larger consensus
change is justified only if batch settlement, miner-controlled pairing, or MEV protection becomes a
concrete requirement.

## Suggested next steps

1. Design and review production peg-in-to-contract crediting, including authenticated ownership and
   intent binding.
2. Specify recovery of an unsolved escrow after expiry.
3. Deploy the settlement contract through an activation-block transition and add hard-fork state-root
   tests.
4. Define the solver protocol: discovery, reveal, pricing, bonding, and reputation.
5. Revisit a consensus bundle only when ordering, MEV, or multi-intent settlement provides measurable
   value that the contract design cannot deliver.
