# Taking the PoC to production

The PoC proves that the core mechanics work on regtest, but it takes three deliberate shortcuts: a
contract call stands in for peg-in crediting, the intent machinery is enabled from genesis, and there
is no solver market.

This note sets out what we would need to change before taking the design into production. None of this
has been built yet, and the important caveats are called out as they arise.

## A. Crediting a real peg-in to the contract

In the main flow, the input arrives as a Bitcoin peg-in. For the fee model to work, the resulting RBTC
must be held by the settlement contract so that `settle` can release it to the solver. Because native
RBTC cannot be pulled from an account, the peg-in needs to credit the contract directly rather than
crediting the user first.

The PoC represents this with `depositForPegin(btcTxid)`. In production, the peg-in itself needs to do
that job.

Today, an RSK peg-in credits an RSK address derived from the Bitcoin sender's key; it does not call a
contract. There are three realistic options, listed from most to least faithful to the intended design.

1. **Let the peg-in name the contract and trigger a Bridge callback.** This is the recommended option,
   but it requires a Bridge change. A Bitcoin transaction whose `OP_RETURN` identifies the settlement
   contract and carries the intent commitment `H` would credit that contract, then invoke a hook such
   as `settlement.onPegin(btcTxid, H){value}` to record the escrow.

   This would bind the anti-spam ticket, the input, and the intent to a single Bitcoin transaction. The
   peg-in would act as both the ticket and the escrowed input. It could also remove the need for the
   separate `0x02||0x49` intent transaction, since that transaction could be derived from the Bitcoin
   transaction. This is the “aggressive variant” described in document 01 of the design sketch.

   The trade-off is significant: this needs a Bridge or consensus change, and peg-in callbacks would be
   a new Bridge capability requiring a dedicated security review. In particular, we would need to
   examine re-entrancy from the Bridge into a contract and define gas accounting during peg-in
   processing.

2. **Credit the user, then have a relayer deposit into the contract.** This keeps the Bridge unchanged.
   The peg-in would credit the user's derived address, after which a relayer — the dApp, SDK, or solver
   — would move the RBTC into escrow.

   The problem is that someone must take an on-chain action while controlling the user's funds. If the
   user does it, the flow is no longer payer-less. If someone else does it, the design gains a trusted
   relayer. This is the weakest option and is useful only as a temporary step towards a Bridge change.

3. **Make the settlement contract a federation-recognised peg-in destination.** This is a middle ground.
   The federation would credit the settlement contract directly, while the intent association would be
   handled out of band using `btcTxid` as the key. It is less tightly coupled than a full callback, but
   the link between the escrow and the intent would only be as reliable as that off-chain association.

**Recommendation:** pursue option 1 through a companion Bridge RSKIP. It is the only option that keeps
the flow both trustless and payer-less, and it provides a natural way to unify the ticket and input into
one peg-in. Until that exists, `depositForPegin` is a reasonable stand-in, but it should be labelled
clearly as one.

## B. Add an activation gate

The PoC enables everything at genesis. The parsing precompile is included in `GENESIS_ADDRESSES`, the
settlement contract is part of the genesis allocation, and the free-transaction cost, subtype
admission, and miner exclusion rules are unconditional.

That works for a new regtest chain, but not for an existing network. Adding the precompile to
`GENESIS_ADDRESSES` changes the state root at the RSKIP126 activation block, which would prevent a
patched node from re-syncing mainnet or testnet history.

For production, the whole intent surface should be enabled by one network upgrade at a defined
activation height:

- Add a new `ConsensusRule`, such as `RSKIPnnn`, to a `NetworkUpgrade`, and gate every related change
  behind it.
- Register the parsing precompile through `CONSENSUS_ENABLED_ADDRESSES`, which is activation-gated,
  rather than through `GENESIS_ADDRESSES`. This avoids the state-root problem.
- Gate the zero `Transaction.transactionCost` for the intent subtype, the
  `TxPendingValidator`/transaction-pool admission rule, and miner exclusion on the same consensus rule.
- Deploy the settlement contract at the activation block, following the way RSK introduces system
  contracts at forks, rather than including it in the genesis allocation. The fork transition should
  create the account and install its code. Its address must be fixed in advance so the gated admission
  check can read it.
- Require the typed-transaction changes from RSKIP543, RSKIP545, and RSKIP546 to be active first.

The consumed set lives in the settlement contract's own storage, so it does not need a separate
activation mechanism. Tests should cover both the pre-activation path, where an intent is treated as a
normal unsupported typed transaction and rejected, and the state root at the activation block. The
existing RSKIP546 hard-fork tests provide the right model.

## C. Define the solver market and bonding model

The protocol provides admission before inclusion and atomic settlement tied to delivery. It does not
provide a solver. Those guarantees are useful only if there is a competitive set of solvers, and that
is a market-design problem rather than a consensus rule.

Two non-consensus components should ship alongside the RSKIP.

### Solver specification

The RSKIP should include a specification for the off-chain protocol a solver is expected to implement:

- **Discovery:** explain how solvers learn about an intent, either through public mempool gossip for the
  `0x02||0x49` transaction or by watching Bitcoin directly in the aggressive variant.
- **Reveal:** define how a solver gets the pipeline preimage committed to by `H` from the dApp or SDK.
  This is pressure point 2 in the design: the party controlling the reveal becomes a liveness
  dependency, much like the liquidity provider the design was intended to remove.

  The specification needs to make the choice explicit. It could require the payload to be revealed to
  any bonded solver, use threshold-encrypted payloads that bonded solvers can decrypt, or acknowledge
  that the dApp remains a liveness dependency in version 1. The recommended starting point is to reveal
  to any bonded solver in version 1 and consider threshold encryption later.
- **Pricing and submission:** document how a solver simulates the intent, prices `minOut` against the
  input, and constructs the `settle` transaction, including ERC-20 approval when the output is a token.

### Bonding and endorsement

A separate, off-consensus contract should let solvers stake a bond that can be slashed for provable
misbehaviour, with optional endorsement to support reputation.

This should stay outside consensus. Turning the bond into a validity requirement would recreate the
permissioned-liquidity-provider problem that intents are meant to avoid. Instead, bonding and
endorsement address two practical risks:

- **Crafted-to-fail griefing:** a malicious intent can cause a solver to spend gas on a transaction
  designed to revert. The damage is limited to one gas cost per willing solver for each intent.
  Reputation can discourage this behaviour, and a bond can help where the offending pattern is
  provable on-chain.
- **The reality of launch:** a system that launches with one liquidity provider does not yet have a
  competitive solver set. The defensible claim is therefore that entry is permissionless from genesis,
  while profitable participation still requires standing. The bond and endorsement mechanism should
  be available from day one so that this more limited claim is true from the outset.

Later, and without a consensus change, the market could add a short competition window in which solvers
bid to deliver more than `minOut`. That would sit on top of the basic first-valid-inclusion rule.

## Cross-cutting issue: executor reverts

The PoC routes settlement through a VM contract because a raw precompile cannot currently report a
revert correctly through the executor: a precompile exception is reported as a success and its changes
are committed.

Production should therefore keep settlement in a contract unless the executor is changed to propagate
precompile exceptions into the receipt. Changing the executor would affect shared code paths used by
the Bridge and Remasc, so it would require the full test suite. Keeping settlement in a contract is the
lower-risk option and matches the current PoC.

## References

- `RSKIP-draft-native-intent-tx.md` and `RSKIP-draft-native-intent-fees.md` in this repository.
- Design sketch: pressure point 2 (reveal liveness), 3 (instant execution is a solver property), 4
  (permissionless softens to “entry”), and 5 (refund equals peg-in).
- RSKIP543, RSKIP545, and RSKIP546 (typed transactions); RSKIP126 (precompiled-contract storage roots);
  RSKIP199 and RSKIP200 (peg-in/`receiveHeader` publicity); and RSKIP87 (whitelist removal).
- RIP-7560 (native account-abstraction direction to track) and ERC-4337 (off-protocol precedent).
