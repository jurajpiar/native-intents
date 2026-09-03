|RSKIP|XXX|
| --- | --- |
|**Title**|Native intent transactions|
|**Description**|A mempool-only transaction type in which the user signs constraints instead of calldata; solvers compete to satisfy them and are paid from the spread|
|**Created**|2026-09-01|
|**Author**|Juraj Piar (@jurajpiar)|
|**Purpose**|Usa|
|**Layer**|Core|
|**Complexity**|2|
|**Status**|Draft|

# Abstract

This proposal introduces a Rootstock-specific transaction type in the RSK typed-transaction namespace (`0x02 || rsk-tx-type`, per RSKIP-543/545/546) in which the user signs *constraints* — a hash-committed payload, a minimum output, an output asset, an expiry height, and an anti-spam reference — instead of exact calldata. The intent is a free, mempool-only object: consensus enforces its validity *before* inclusion, it is gossiped like any transaction, and it is never mined standalone. A solver satisfies it with an ordinary gas-paying transaction that delivers at least the minimum output to the user and, in the same atomic step, claims the intent's escrowed input — the difference is the solver's fee, and the intent is recorded consumed. The proposal specifies the type, its admission rules, the consumed set, the settlement contract's full behaviour (input binding, the above-minimum auction, and the exit path whose output is BTC delivered on Bitcoin), and the activation gate. Together these enable gas-less, near-instant, Bitcoin-anchored flows: a user whose only asset is arriving from Bitcoin can transact on Rootstock — in and back out — without ever holding RBTC or sending a Rootstock transaction.

# Motivation

Most advertised benefits of "intents" are things smart contracts do worse, not things they cannot do. This proposal rests on two properties that are impossible in contract-land, because contracts execute after inclusion and these are pre-inclusion properties.

First, **mempool citizenship for an account that cannot pay**. Admission and validity are decided before the EVM runs, so a zero-balance, zero-history account's signed message can become a gossiped mempool object. A contract cannot make that happen; ERC-4337 built an off-protocol alternative mempool precisely because it could not do this in contracts.

Second, **invalidity before inclusion**. A contract-level expiry or replay check runs on-chain: it spends block space, burns gas, and produces a revert that is visible and can be griefed. Protocol validity means an expired or already-consumed intent never enters a block and costs nothing.

Everything else — constraint checking, honest signing UX, commit/reveal, output bounds — is quality of implementation and does not by itself justify a consensus change. The specification below is shaped so that these two properties are the load-bearing ones. But the properties only matter if someone actually settles intents, so the proposal also specifies the value flow that makes solving worthwhile: the solver must be able to claim the user's input and keep the difference, and that claim must be possible *only* in the same atomic step that pays the user. That one guarantee — input moves to the solver if and only if the output reaches the user — is the second thing a contract alone cannot deliver end-to-end for native RBTC, and it is what turns "entry is permissionless" into "solving is profitable for a competitive set of solvers".

The flagship application is near-instant, Bitcoin-anchored execution on Rootstock: value arriving from Bitcoin, with a solver fronting the result on Rootstock against a Bitcoin event, settled trust-minimally once the event is visible to the Bridge.

# Specification

## Transaction envelope

An intent is an RSK-namespace typed transaction:

```
0x02 || rsk-tx-type || rlp([nonce, gasPrice, gasLimit, to, value, data, v, r, s])
```

`0x02` is the RSK namespace prefix (RSKIP-543) and `rsk-tx-type` selects the intent subtype (`0x49` proposed; final value assigned on acceptance). The payload is the legacy nine-field list; the signed constraints live in `data`. This reuses the RSKIP-543/545/546 typed-transaction machinery unchanged, so no new parser or encoder is required.

The signing hash follows the RSK-namespace scheme for a non-zero chain id: `keccak256(0x02 || rsk-tx-type || rlp([nonce, gasPrice, gasLimit, to, value, data, chainId, "", ""]))`, with EIP-155 `v = yParity + chainId*2 + 35`. The chain id MUST be non-zero.

`to` is the settlement contract address (below). `gasPrice` and `value` MUST be zero; the intent is a free mempool object (see admission). The sender is recovered from the signature; a wallet SHOULD derive a fresh address per intent so that intent uniqueness is keyed by the payload commitment rather than by an account nonce.

**Encoding note (normative).** rskj serialises a zero `gasPrice` as the raw byte `0x00`, whereas a zero `value` and a zero `nonce` serialise as the RLP empty scalar `0x80`. A signer MUST match this canonical encoding; a signer that does not computes a different signing hash and the node recovers a different (wrong) sender.

## Intent constraints (the `data` field)

`data` is exactly 160 bytes, five 32-byte words:

```
data = H (32) || btcTxid (32) || expiryHeight E (32) || minOut (32) || outputToken (32)
```

- `H` is a commitment to the full pipeline the user wants executed (`H = keccak256(pipeline)`); the pipeline itself is revealed off-chain to a solver at solve time.
- `btcTxid` references the confirmed Bitcoin transaction that serves as the anti-spam ticket and keys the input escrow.
- `E` is the absolute Rootstock height at which the intent expires.
- `minOut` is the minimum acceptable output, enforced at settlement.
- `outputToken` names the output asset: the zero address for native RBTC; an ERC-20 address for tokens (vault shares and LP tokens included — settlement is outcome-based, so any pipeline whose terminal step tokenises is expressible); or a reserved sentinel address meaning *BTC delivered on Bitcoin* (an exit intent). For exit intents `minOut` is denominated in satoshis and `H` additionally commits to the user's Bitcoin destination, `H = keccak256("BTCOUT" || hash160 || salt)`, verified on-chain at settlement without the format growing a field.

## Mempool admission (pre-inclusion validity)

An intent is admitted to the mempool — and therefore gossiped — only if all of the following hold:

1. The signature is valid and the chain id matches.
2. The intent is not expired: current best height `<` `E`. A node also rejects intents whose `E` is more than a bounded number of blocks ahead, to bound the consumed-set window.
3. `H` is not already in the consumed set.
4. The anti-spam ticket is valid: `btcTxid` is visible in the Bridge SPV view (v1: it is a processed peg-in).

The intent's transaction cost is defined to be zero, so the balance and account-existence checks that normally gate a payer-less sender do not apply — this delivers the first motivating property. Checks 2–4 deliver the second: an intent that fails them is rejected at admission, never enters a block, and costs nothing. Checks 3 and 4 are storage reads against current state (the settlement contract's consumed set and the Bridge's processed-peg-in set respectively).

Block producers exclude intents from candidate blocks; an intent transaction never appears in a block, so block validity rules, proof of work, and merged mining are untouched by this proposal.

## Parse precompile and the consumed set

Two fixed, protocol-designated addresses split the work (concrete values assigned at activation):

- **Parse precompile**: stateless. Given the raw signed intent bytes it reconstructs the RSK-namespace signing hash, recovers the user, and returns the decoded fields `(user, H, btcTxid, E, minOut, outputToken)` — the one step impractical in Solidity. Any contract may staticcall it, so settlement-layer contracts authenticate intents without duplicating signature logic.
- **Settlement contract** (deployed at activation): owns the consumed set as ordinary contract storage at slot `== H`, readable by `eth_call`, provable by storage proof, and read directly by mempool admission. `isConsumed(bytes32 H) → bool` is the public view. Because admission reads this contract's storage and every node must agree on its bytecode at the fork, the settlement contract's behaviour — specified in the rest of this section — is part of this proposal's consensus content even though it is expressed in ordinary contract code.

`H` is recorded only on successful settlement: the write commits only if the settling transaction succeeds, so consumption is bound to delivery by construction. Reorg handling is ordinary state reversion: a settlement orphaned by a reorg reverts both the delivery and the consumed-set entry, and the intent becomes solvable again on the new chain. The mental model: the consumed set is to intents what the nonce is to accounts.

## The value flow

An intent names an input `I` (the pegged-in value) and an output requirement `minOut`. On a successful settlement the user loses `I` and gains `out ≥ minOut`; the solver gains `I`, loses `out`, and pays gas `g`. A solver participates only when `value(I) − value(minOut) − g > 0`. That inequality is the **spread**: the user prices `minOut` below the market value of their input by at least the solver's cost and margin, and in exchange receives the output atomically, in the asset they want, without holding gas. The spread is the user's fee, paid in kind. It is not a protocol parameter; it emerges from what `minOut` the user is willing to sign and which solver is willing to meet it. Value is conserved — the protocol neither mints nor burns — and gas is the only external cost, paid by the solver to the network.

## Input binding

The input must be identified by the intent and claimable by the solver only through settlement. Native RBTC cannot be pulled from an account without that account's own transaction, so the input cannot sit in the user's balance waiting to be claimed. The workable binding is escrow: the peg-in credits the settlement contract, and settlement releases it to the solver in the same call that delivers the output. The contract custodies the input only between the peg-in and settlement, and only ever pays it to the solver that satisfies the intent.

The escrow must additionally be bound to the *specific intent*, not merely to the txid — otherwise the escrow belongs to whichever intent names the txid first, and an attacker who observes a settlement-destined peg-in can capture its input with a rival intent carrying a dust `minOut`. The specified mechanism is **RSKIP-176 Programmable Peg-in Addresses**: the user signs the intent first (fixing `H`), then pegs in to a deposit address derived from (federation, settlement contract, `H`, user refund address). The Bridge's flyover registration credits the settlement contract keyed by that derivation — the settlement contract registers the peg-in itself, acting as its own liquidity-bridge-contract, with `H` in the `derivationArgumentsHash` slot. The binding is carried by *where the coins went*: unforgeable and unstrippable by construction, with nothing intent-shaped on Bitcoin's wire, and requiring no Bridge change — the registration path is shipped, audited, and in production use by Flyover.

A rejected alternative, for the record: routing an ordinary RSKIP-170 OP_RETURN peg-in to the settlement contract and adding a per-txid Bridge record. That route requires a new Bridge change yet still cannot reach intent-level binding — the OP_RETURN has no room for `H` without breaking v1 payload parsing or Bitcoin's data-carrier standardness, so the strongest binding it could deliver is owner-level (recording the peg-in's lock-sender and requiring the intent's signer to match). Weaker binding at higher consensus cost.

## Settlement

An intent is satisfied by a single solver transaction that calls the settlement contract's `settle(rawIntentTx)`. Atomically, and in this order — reverting the whole call if any step fails:

1. Authenticate the intent via the parse precompile and re-check admission at the inclusion height (unexpired, `H` unconsumed).
2. Verify the input `I` is present and bound to this intent (the peg-in is registered and its escrow answers to this `H`).
3. Deliver `out ≥ minOut` of the output asset from the solver to the user (native RBTC, or an ERC-20 via `transferFrom`). For token outputs the delivery MUST be verified by the user's **balance delta** across the transfer, not by the transfer's return value: a fee-on-transfer token moves less than it reports and a non-conforming token may report success having moved nothing, and in either case a return-value check would let the settlement consume `H` and release the input while the user received less than the minimum they signed. Implementations SHOULD additionally accept an empty return from the transfer, since tokens predating the finalised ERC-20 return no data and would otherwise be unusable as outputs; the delta check is what makes accepting that safe, because an address that is not a token returns empty and moves nothing, and so fails on the delta. The same rule applies wherever the settlement layer escrows an output asset — an auction pulling a token bid must verify the amount that arrived, or it will record a bid larger than it holds.
4. Release the escrowed input `I` to the solver.
5. Record `H` consumed.

Transaction atomicity is the all-or-nothing guarantee: if any bound fails — delivery short of `minOut`, expired, already consumed, escrow bound elsewhere — the whole call reverts, `H` is not consumed, the intent remains solvable until `E`, and the solver forfeits the gas. This binds consumption to delivery: the only way to consume an intent's `H` is to satisfy it. The spread is simply what the solver retains — never computed or enforced by the protocol, only permitted.

Settlement runs in the VM (a contract deployed at activation), so failures revert visibly with a failed receipt; this is deliberate — routing settlement through a raw precompile would not, because a precompiled contract's exception is not propagated to the receipt in the current executor (the Bridge and Remasc are written around the same behaviour). No block-construction change is required: the solver transaction carries the signed intent bytes, so it is self-contained, and EVM transaction atomicity supplies the bundle semantics. A consensus-level bundle object (block-producer-assembled intent+solution, for MEV and ordering control) remains a possible future refinement.

Solver-side payouts (the input release, refunds of excess, auction and reservation payouts below) MUST NOT be reverting pushes: a payee that cannot receive native currency must not be able to revert a settlement whose delivery succeeded, block an auction, or strand an intent. Such payouts are push-with-credit-fallback — a failed transfer becomes a balance withdrawable by its owner. Delivery of `minOut` to the user remains a hard requirement: paying the user is the settlement's core promise.

## Price discovery: the above-`minOut` auction

`minOut` is the worst rate the user will accept. Any solver able to meet it may settle, and the first valid settlement included wins — later attempts for the same `H` revert on the consumed-set check, so a losing solver loses only gas. This first-valid-inclusion race is the base rule; its liveness and censorship-resistance mirror proposer-builder separation and relay markets.

The refinement that hands the user most of the spread back is the auction, specified in two shapes that disagree on a real trade-off. Bids are denominated in the intent's own output asset — native RBTC escrowed by value, ERC-20s escrowed via `transferFrom` — so for compound intents solvers compete on route quality: a better route mints more of the terminal asset per input and can bid higher, with the auction knowing nothing about routes. The *off-consensus* shape is a plain contract anyone deploys; it is bypassable at `minOut` under the base rule (the stranded bidder reclaims its escrow). The *enforced* shape deploys the same contract at a designated address that `settle` consults: while an open auction exists for `H`, only the auction can settle — including after the bidding deadline, so the permissionless `execute()` cannot be front-run. Enforcement engages only once someone bids (bid-free intents settle exactly as before), a lock requires escrowing a bid above `minOut` (the user always nets above their ask), exclusivity decays after a grace period so a wedged auction releases the intent back to open competition, and payouts follow the credit-fallback rule above so an unpayable party cannot brick execution. The choice between shapes is a governance decision this proposal surfaces rather than makes: enforcement closes the bypass at the cost of making the auction a settlement rule instead of pure market structure.

## The exit path: output delivered on Bitcoin

An exit intent's output is BTC at the user's own address (the `outputToken` sentinel; destination committed in `H`). The value flow mirrors the entry: the solver pays the user's Bitcoin address from its own UTXOs, then proves the payment on Rootstock — SPV inclusion against the Bridge's header chain (RSKIP-122 `getBtcTransactionConfirmations`) plus an on-chain parse of the raw payout transaction showing an unclaimed output of ≥ `minOut` satoshis to the committed destination — and claims the escrowed input in the same call (`settleBtcOut`). The claim guard is per payout *output*, not per transaction, so one Bitcoin transaction paying N users settles N exit intents: batched exits amortise Bitcoin fees across fills, up to a bounded maximum output count (an unbounded parse would let a wide payout exceed any gas limit, making it unsettleable). Flyover's `refundPegOut` is the production-proven relative of this exact mechanism.

The payout MUST also carry a **settler commitment**: an `OP_RETURN` output holding a fixed tag and the RSK address entitled to settle with it, which `settleBtcOut` requires the caller to match. Without it the SPV proof is a bearer object — public bytes naming the user's address — and anyone could present another solver's payout against their own dust-`minOut` intent on the same destination; the per-output claim would then consume the payment and the paying solver's bitcoin would be lost irreversibly. The reservation cannot close this, because it keys on `H` and the hijacker brings a different `H`. Committing the *settler* rather than the intent keeps batching intact: one output protects every payment in the transaction. This payload binding is legitimate here for the reason it is not on entry — the solver builds this transaction and wants to be repaid, so omitting the commitment costs only the omitter — and the commitment is mandatory, since an optional one would simply be harvested whenever it was omitted.

Exits change the race economics fundamentally: a Bitcoin payment is irreversible, so if two solvers raced an exit, both would have paid the user (who is paid twice) and only one is repaid — nobody competes under that rule. The fix is a **bonded reservation** (`reserveExit`): before paying, a solver posts a bond (a fixed fraction of the payout) for exclusive settlement rights over a reservation window sized to pay, confirm, and prove; the window must fit inside the intent's remaining lifetime or the reservation is rejected. The race moves to the Rootstock leg, where losing costs gas, never bitcoin. Squatting is priced: a lapsed reservation's bond is forfeited *into the input escrow*, so a stalled exit becomes strictly more profitable for the next solver — the mechanism heals its own delays, and the compensation stays on the Rootstock side where it is useful (the BTC-only user is made whole in BTC by whoever fills). A reservation that outlives its intent forfeits the bond to the user, so an exit cannot be squatted to death for free. Reservation is opt-in — an unreserved exit remains first-valid — but a rational solver always reserves.

Risk allocation: the payout confirmation depth required before settlement protects the **user** — a payout reorged away after settlement leaves `H` consumed and the user unpaid — so production sets it materially above test-network values and backs the residual with the solver's bond. The intent's expiry must budget for those confirmations plus the proof work, and the reservation window must fit inside the expiry: three coupled parameters, sized together.

## Failure and refund

If no solver settles an entry intent by height `E`, the pegged-in value is not lost — but with the escrow binding (the peg-in credits the settlement contract, not the user) the contract must expose a recovery path for the user after expiry: release to the user's refund address, per RSKIP-170's refund semantics. For exit intents the same applies to the escrowed input, and Flyover's `refundUserPegOut` is the model. Both recovery paths are specification requirements; they are bookkeeping, not new trust assumptions — the funds sit in the settlement contract attributable to the intent that escrowed them.

The Bridge machinery these paths lean on already ships: since RSKIP-379 (Arrowhead 6.0.0 — mainnet block 6,223,700, testnet 4,927,100), peg-in processing runs a formalised evaluation pipeline (REGISTER / REFUND / NO_REFUND) in which a rejected peg-in with a recoverable sender is *automatically* refunded to the RSKIP-170 refund address — and the RSKIP-176 route bakes the user refund address into the deposit-address derivation itself. So the *rejected-peg-in* half of the refund story is existing consensus behaviour; only the *expired-intent* half (escrow already credited, no solver settled by `E`) needs new specification.

## Expiry, replay, and reorg

Expiry is height-absolute with a bounded maximum span from the current height. On a reorg, an intent on the new branch is either still includable or expired, and a dropped settlement reverts with its block; the consumed set follows ordinary state reversion. Interaction with fork-aware consensus (RSKIP-555, Draft) must be settled before the validity rules are finalized.

## Anti-spam ticket (v1: Bitcoin-event-backed)

v1 intents require a confirmed Bitcoin transaction, referenced by `btcTxid` and checked against the Bridge SPV view at admission. Requiring this to be an ordinary peg-in has a useful consequence: when no solver ever satisfies the intent and it expires, the Bitcoin funds are recoverable by the refund path above, so the no-solver case degrades to the slow path. General-purpose ticketless intents are out of scope for v1.

## Bonding and endorsement (non-consensus)

A competitive solver set must exist from genesis or the protocol properties do not cash out. This is addressed off-consensus, deliberately: solvers post a slashable bond and may be endorsed — capital at risk and reputation, not validity. Making bonding a consensus gate would recreate the permissioned-LP problem the intent design exists to avoid. The solver specification (message formats for the off-chain reveal, pricing, and settlement) is published alongside this RSKIP so entry is genuinely permissionless from day one. Flyover's liquidity bridge contract, where LPs post collateral and quotes carry penalty fees, is the production precedent for sizing. Nothing in this subsection is enforced by consensus; it is included so the market-structure assumptions the design leans on are stated rather than implied.

## Activation

Everything in this proposal is gated by its own consensus rule: the zero-cost admission path, the parse precompile's availability, and the settlement/auction contract deployments all activate at the fork height and are inert before it. Block height at which activated is TBD.

# Implementation

A reference implementation exists as a set of patches on top of the rskj typed-transactions branch (PR #3558 — which implements RSKIP-545/546 and does not itself contain any of this proposal): the subtype recognizer, the zero-cost admission path, the four admission checks, block-producer exclusion, the parse precompile, the settlement and auction contracts (including the escrowed intent-bound input claim, both auction shapes with credit-fallback payouts and lock decay, and the exit path with SPV-verified payouts, per-output claims, and bonded reservations), together with a TypeScript SDK and a falsification-style test suite run against patched regtest nodes and a real bitcoind — covering payer-less admission and gossip, free expiry rejection, replay protection, settlement atomicity, reorg reversion on one node and under a genuine two-node partition/merge, ERC-20 outputs, visible reverts, activation gating, real peg-in input binding, escrow-capture rejection, competing-solver races, and the exit-path negatives.

# Rationale

**Separation of submission, signing, and paying.** The user signs constraints; a solver pays at settle time; anyone holding the bytes may broadcast. The submitter cannot modify (the intent is self-authenticating), cannot forge, and can only delay, since anyone can re-broadcast. This contrasts with the router-contract path, where a specific liquidity provider is the transaction sender and their withdrawal halts the flow.

**Why the solver claims the input rather than being paid a fee.** A separate fee would need a funding source; the user has none on Rootstock yet (that is the whole point — value is arriving from Bitcoin). Letting the solver take the input and deliver the output is self-funding: the user pays in the asset they are giving up anyway, and the fee is the spread. Fixing a fee as a protocol parameter would misprice risk that varies by asset, size, volatility, and confirmation depth; letting `minOut` and solver competition set it lets the market price each intent.

**Why the solver pays gas.** It aligns cost with the party that profits and keeps the user gas-free (a required property — the user may have no RBTC). A failed settlement is the solver's cost, which is the correct incentive: solvers simulate and price before submitting.

**Why settlement is trustless only post-confirmation.** Settlement can move the input to the solver only once the input exists on chain — after the peg-in is registered. A truly instant experience requires the solver to deliver *before* that, taking on Bitcoin double-spend risk. That fronting is off-protocol risk-taking the protocol cannot make trustless; it is priced into the spread. The honest framing: the protocol delivers trust-minimised settlement of fronted flows, and "instant" is a solver service, not a protocol guarantee.

**Liveness.** Inclusion via a solver-paid transaction means censorship resistance is "any bonded solver chasing visible profit", not "block producers include it". Commit/reveal is front-running protection, not privacy: the counterparty solver must see the payload off-chain to price it, so `H` hides it from third parties only.

**An honest qualification.** Protocol properties only cash out with a competitive solver set; the bonding subsection makes the market-structure assumption explicit, and the claim is "entry is permissionless from genesis", not a promise of competition.

# Backward compatibility

This change is a hard fork and all full nodes must be updated. The type is additive: it lives behind the RSKIP-543/545/546 typed-transaction activation and its own consensus rule, and existing transaction types are unaffected. Because intents never appear in blocks, SPV light clients do not need to be updated.

# Test cases

Provided with the reference implementation as falsification experiments, one per claim: each states the claim, the procedure, and the observation that would prove the claim false.

# Security considerations

- **User double-spend of the peg-in.** Handled by requiring the peg-in to be registered (confirmed) before settlement can claim the input; the confirmation depth is the Bridge's, not a new parameter.
- **Escrow capture by a rival intent.** Closed by the derivation binding: a rival intent naming the same txid derives a different deposit address holding no coins, so it commands no input, and an attempted settlement reverts.
- **Griefing a specific `H`.** Closed by atomic settlement: an attacker cannot consume `H` without delivering `minOut`; a failed attempt costs the attacker gas and leaves the intent solvable.
- **Hostile output tokens.** The output asset is named in the user's own signed intent, so no third party can choose it; the balance-delta rule above bounds what a misbehaving token can do *during* settlement. It cannot bound what the token's issuer does afterwards — a token whose issuer can freeze or claw back balances defeats any on-chain check — so wallets composing intents on a user's behalf SHOULD restrict output assets to a vetted set rather than accepting an arbitrary address.
- **Unpayable participants.** Push payments to solvers, bidders, or reservers cannot revert settlements, block auctions, or strand intents; credit-fallback payouts confine a broken payee's failure to itself. Such a push SHOULD carry a bounded gas stipend rather than forwarding the remaining gas, for two reasons: it bounds what a hostile payee can spend of the settler's gas, and — because a useful stipend is far below the cost of a single storage write — it also means a contract payee cannot execute logic while a settlement is still on the stack, removing the settlement-path reentrancy surface entirely. The withdrawal path cannot be capped, since it must deliver in full; there the ordering rule (record consumption before any external call) is what makes a reentrant settlement meet an already-consumed commitment.
- **Exit races.** A Bitcoin payment is irreversible; bonded reservations move the race onto Rootstock where losing costs gas. Squatting forfeits the bond into the escrow (lapse) or to the user (intent expiry).
- **Payout hijack.** An SPV proof is a bearer object, so entitlement must travel with the payment rather than with the proof: the settler commitment binds each payout to the party that made it, and an uncommitted payout is unclaimable by anyone. Reservations alone do not suffice — they protect the intent, not the payment.
- **Unbounded payout parsing.** The output scan is paid for by the settler, so the output count is capped; an over-wide payout is refused by name rather than exhausting the caller's gas, and the safe batch size is a stated constant instead of an implicit gas ceiling.
- **Solver default between fronting and claim.** Only relevant in the off-protocol instant variant; the on-protocol path settles atomically, so there is no window.
- **Price manipulation / MEV.** The first-valid-inclusion race is MEV-exposed like any inclusion market; a consensus-level intent+solution bundle (future work) would give ordering control. Exposure is bounded by the user's `minOut` — the user cannot receive less than they signed for. A user signing an unrealistic `minOut` simply goes unsolved.
- **Block-producer front-running.** A settle transaction carries the whole authenticated intent in its calldata, so any observer — a block producer most cheaply of all — can settle the same intent first. The user is unaffected (`minOut` still binds), but the honest solver forfeits its gas and any output it pre-acquired, which is a tax on exactly the participants the design needs. The mitigation the design already contains is the auction lock: once an intent is bid upon, a front-run must be expressed as a higher bid, which pays the surplus to the user. Bid-free intents have no such protection, so wallets or brokers SHOULD open an auction on submission if front-running pressure is material.
- **Block-producer censorship.** Transaction selection cannot be compelled, so a mining solver can include only its own settlements. Liveness rests on "some producer will include a profitable settle", not on any particular one; this is the same assumption relay markets make, and it is stated rather than assumed away.
- **Block-denominated deadlines are not clocks for a block producer.** Both auction limits — the bidding window and the decay of exclusivity — are block counts, which behave as elapsed time for ordinary participants and as a controllable counter for whoever produces blocks. A producer can therefore close a bidding window in no wall-clock time (bid the floor, mine the window out, and rivals never enter the auction at all), or decline to include `execute()` until exclusivity decays and then settle directly at `minOut` around a higher standing bid. `minOut` still binds, the consumed set still admits one settlement, and an outbid participant still reclaims its escrow, so this costs price discovery rather than principal — but price discovery is the auction's entire product. The decay is a deliberate trade: it is what stops a wedged auction stranding an intent, and it is simultaneously a permissionless route to the floor price. Denominating the window in timestamps instead does not fix this and should not be presented as if it did: a block's timestamp must exceed its parent's but may run up to the network's future-time allowance ahead of real time (540 seconds on Rootstock), so a producer can still close any practical window instantly, simply not repeatedly — it is a rate limit, not a defence. The structural answer is that price discovery denominated in on-chain time is capturable by whoever orders blocks: discovery belongs off-chain, with the chain enforcing the floor and settling the result. This proposal specifies block heights, and records the consequence rather than implying a parameter choice resolves it.

Exclusivity decay is specified with the same reasoning. A settlement contract that releases an auctioned intent purely because a grace period has elapsed hands that intent to whoever withholds the auction's execution: wait out the period, then settle at the floor around a higher standing bid. Worse, for a native-currency output the elapsed-time form has no legitimate trigger at all, since an auction holding the winning bid cannot fail to fund the settlement it wraps. Decay MUST therefore key on an execution that was OBSERVED to fail, not on elapsed time — the execution attempt catches the failure, records it, and returns rather than reverting, since a revert would roll back the very record the decay reads. The attempt MUST also require a gas floor comfortably above a settlement's cost before making the call, or EIP-150's 63/64 forwarding rule would let anyone under-gas the attempt so the inner settlement dies while the recording still runs, decaying a healthy auction on demand.

# Open questions

- Envelope: whether the intent is signed by a user EVM key (wallet-derived) or by a signature recoverable from the Bitcoin input, dissolving the submission step further. Packing constraints into the peg-in's OP_RETURN is ruled out (it conflicts with RSKIP-170 v1 parsing and Bitcoin data-carrier standardness); the derivation route already carries the commitment without wire data.
- Admission latency is Bridge-bound: either admission tolerates "not yet visible" with a retry window (weakening the spam filter) or the wallet waits for Bridge registration (adding latency).
- Fronting as a first-class cost: with derivation-bound escrows a solver can deliver before Bridge registration against a reliable receivable, pricing capital time-value and reorg risk into its bid — confirmation depth becomes a market variable. Requires settlement with deferred input release and an admission stance on unripe tickets.
- Exit intents couple three parameters that must be sized together: expiry must budget for the solver's Bitcoin confirmations plus proof work, the reservation window must fit inside the expiry, and the payout confirmation depth allocates the payout-reorg risk. Test-network values do not transfer to mainnet; the reservation window covering hours of Bitcoin confirmations also makes the bond's opportunity cost material — size the bond as a function of window length, not just payout.
- A native permit: exiting a live position (vault shares, LP tokens) without any user Rootstock transaction requires the intent itself to carry a transfer authorisation the settlement contract can exercise. EIP-2612 covers permit-aware tokens; the protocol-level generalisation is open.
- Recovery of an expired intent's escrowed input (Flyover's `refundUserPegOut` is the model) — the one refund half not already covered by shipped Bridge behaviour.
- Consumed-set pruning (lazy prune vs periodic sweep vs bounded growth) and RSKIP-555 interaction.
- Enforced vs off-consensus auction: a governance decision this proposal surfaces rather than makes.
- Multi-input / partial-fill intents (one intent satisfied by several solvers), out of scope for v1.
- Fee to the network beyond gas (none proposed; noted for completeness).

# References

- [RSKIP-36](https://github.com/rsksmart/RSKIPs/blob/master/IPs/RSKIP36.md) — EXECUTE opcode (2017), sponsorship-only prior work.
- [RSKIP-138](https://github.com/rsksmart/RSKIPs/blob/master/IPs/RSKIP138.md) — multi-signed enveloping (2019), sponsorship-only prior work.
- RSKIP-543 / RSKIP-545 / RSKIP-546 — typed transactions and the `0x02` RSK namespace. rskj [PR #3558](https://github.com/rsksmart/rskj/pull/3558) implements RSKIP-545/546 and is the base branch for this proposal's reference implementation.
- RSKIP-122 — Bitcoin transaction confirmations query (`getBtcTransactionConfirmations`); the SPV primitive the exit path builds on.
- RSKIP-170 — peg-in transaction version 1 (OP_RETURN destination and refund semantics).
- RSKIP-176 — Programmable Peg-in Addresses (Flyover); the specified input-binding mechanism.
- RSKIP-379 — peg-in processing pipeline (Arrowhead 6.0.0): REGISTER/REFUND/NO_REFUND evaluation with automatic rejection refunds; the shipped Bridge half of the refund path.
- [Flyover / Liquidity Bridge Contract](https://github.com/rsksmart/liquidity-bridge-contract) — the closest production relative: `refundPegOut` is shape-for-shape this proposal's `settleBtcOut`, `refundUserPegOut` the expired-escrow recovery model, and its LP collateral/penalty model the precedent for solver bonds.
- RSKIP-555 (Draft) — fork-aware consensus.
- [EIP-155](https://eips.ethereum.org/EIPS/eip-155) — replay-protected transaction signing.
- [EIP-2718](https://eips.ethereum.org/EIPS/eip-2718) — typed transaction envelope.
- [ERC-4337](https://eips.ethereum.org/EIPS/eip-4337) — off-protocol account abstraction and its alternative mempool.
- [RIP-7560](https://github.com/ethereum/RIPs/blob/master/RIPS/rip-7560.md) — native account abstraction direction on Ethereum (divergence to track).
- PBS / proposer-builder separation and relay markets — liveness analogue for the solver inclusion race.

# Copyright

Copyright and related rights waived via [CC0](https://creativecommons.org/publicdomain/zero/1.0/).
