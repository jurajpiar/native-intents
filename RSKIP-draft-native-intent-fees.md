|RSKIP|YYY|
| --- | --- |
|**Title**|Native intent fee mechanics|
|**Created**|2026-09-01|
|**Author**|juraj@rootstocklabs.com|
|**Purpose**|Usability, Interoperability|
|**Layer**|Core|
|**Complexity**|2|
|**Status**|Draft|

Companion to RSKIP-XXX (native intent transaction type). That document specifies how an intent is expressed, admitted, and settled; it deliberately leaves out how a solver is paid. This one specifies the value flow that makes solving worthwhile, so that "entry is permissionless" becomes "solving is profitable for a competitive set of solvers".

# Abstract

An intent converts an input the user controls into at least a minimum amount of an output the user wants. A solver supplies the output and takes the input; its profit is the spread between them, minus the gas it pays. This document defines that accounting, how the input is bound to the intent and claimed atomically on settlement, how price is discovered among competing solvers, how solvers are bonded against griefing, and what happens to the input when no solver acts. It does not change the intent transaction type; it constrains the settlement path (`solve`).

# Motivation

As specified in the companion RSKIP, `solve` delivers at least `minOut` to the user and records the intent consumed — but nothing repays the solver, which delivered `minOut` and paid gas for no return. Without a payment path there is no solver, and the protocol's pre-inclusion properties (which only matter if some solver eventually includes the intent) never cash out. The missing half is: the solver must be able to claim the user's input, and keep the difference.

The design is deliberately minimal on protocol-enforced value flow. The protocol enforces one thing that a contract cannot: that the input moves to the solver *only* in the same atomic step that the output reaches the user. Everything else — how solvers price, compete, and bond — is market structure layered on top, specified here as expected behaviour rather than consensus rules where possible.

# The value flow

An intent names an input `I` (asset and amount) and an output requirement `minOut` (asset and amount). On a successful `solve`:

- User: loses `I`, gains `out` where `out ≥ minOut`.
- Solver: gains `I`, loses `out`, pays gas `g`.
- Solver profit: `value(I) − value(out) − g`.

A solver participates only when `value(I) − value(minOut) − g > 0`. That inequality is the **spread**: the user prices `minOut` below the market value of their input by at least the solver's cost and margin, and in exchange receives the output atomically, in the asset they want, without holding gas. The spread is the user's fee, paid in kind. It is not a protocol parameter; it emerges from what `minOut` the user is willing to sign and which solver is willing to meet it.

Value is conserved: the protocol neither mints nor burns. The input the user gives up equals the input the solver receives; the output the solver gives up equals the output the user receives. Gas is the only external cost, paid by the solver to the network.

# Specification

## Input binding

The input must be identified by the intent and claimable by the solver only through `solve`. In the flagship Bitcoin-anchored flow the input is a peg-in: the intent's `btcTxid` references a confirmed peg-in, whose RBTC credit is the input `I`. Two properties are required:

1. The credited amount and its current holder are determinable from chain state at settlement (so `solve` can move exactly `I`).
2. The user's signature over the intent authorises moving `I` to the solver conditional on delivery of `out ≥ minOut` — and on nothing else.

A finding from implementing this: **native RBTC cannot be pulled from an account** without that account's own transaction, so the input cannot sit in the user's balance waiting to be claimed by `solve`. The workable binding is escrow: the peg-in credits the settlement contract, earmarked for the intent's `btcTxid`, and `solve` releases it to the solver in the same call that delivers the output. The contract custodies the input only between the peg-in and settlement, and only ever pays it to the solver that satisfies the intent. (An ERC-20 input could instead be pulled via a prior `approve` from the user; native RBTC requires the escrow route, which is also the natural shape of a peg-in that names the contract as its RSK recipient.)

This binding is implemented and verified two ways. In the PoC's own mechanism (E14): a genuine RSKIP170 v1 peg-in whose OP_RETURN names the settlement contract credits it directly, the Bridge records the (destination, amount) pair per txid and exposes it via a `getPeginInfo` view, and `settle` verifies the record and releases the actual pegged-in amount. In production, the same shape can ride Flyover's Programmable Peg-in Addresses (RSKIP176) — an audited, shipped mechanism by which the Bridge refunds a contract keyed by a derivation hash — with the settlement contract and `H` in the derivation, avoiding a new Bridge change.

## Settlement accounting

`solve` performs, atomically and in this order, reverting the whole call if any step fails:

1. Re-check admission at the inclusion height (unexpired, `H` unconsumed, ticket valid) — as in the companion RSKIP.
2. Verify the input `I` is present and attributable to the user (the peg-in is processed and credited).
3. Transfer `out ≥ minOut` of the output asset from the solver to the user.
4. Release the escrowed input `I` (the peg-in credited to the contract) to the solver.
5. Record `H` consumed.

The spread `value(I) − value(out)` is simply what the solver retains: it is not computed or enforced by the protocol, only permitted. Gas is paid by the solver as the transaction sender, so a failed `solve` costs the solver gas and nothing else — the intent stays unconsumed and solvable.

## Price discovery and competition

`minOut` is set by the user when signing; it is the worst rate they will accept. Any solver able to meet it may settle, and the first valid `solve` included wins — later `solve`s for the same `H` revert on the consumed-set check, so a losing solver loses only gas. This is a first-valid-inclusion race, and its liveness and censorship-resistance mirror PBS/relay markets: any bonded solver chasing a visible, positive spread will include the intent.

The refinement that hands the user most of the spread back is the **above-`minOut` auction**, implemented and verified in two shapes that disagree on a real trade-off (E17/E17b). Bids are denominated in the intent's own output asset — native RBTC escrowed by value, ERC-20s (vault shares, LP tokens) escrowed via `transferFrom` — so for compound intents solvers compete on route quality: a better route mints more of the terminal asset per input and can bid higher, with the auction knowing nothing about routes. The off-consensus shape is a plain contract anyone deploys; it is bypassable at `minOut` under the base rule (demonstrated honestly, with the stranded bidder reclaiming its escrow). The enforced shape deploys the same contract at a designated address that `settle` consults: while an open auction exists for `H`, only the auction can settle — including after the bidding deadline, so the permissionless `execute()` cannot be front-run. Enforcement engages only once someone bids (bid-free intents settle exactly as before), a lock requires escrowing a bid above `minOut` (the user always nets above their ask), exclusivity decays after a grace period so a wedged auction releases the intent, and payouts are pull-based so an unpayable party cannot brick execution. The choice between shapes is a governance decision this RSKIP surfaces rather than makes: enforcement closes the bypass at the cost of making the auction a settlement rule instead of pure market structure.

## Bonding and endorsement

The companion RSKIP notes a residual: a solver can submit a `solve` that fails, costing itself gas but also briefly occupying the intent. More importantly, a competitive set must exist from genesis or the protocol properties do not cash out. Both are addressed off-consensus:

- Solvers post a bond and may be endorsed; the bond is slashable for provable misbehaviour (e.g., griefing patterns) and signals capital at risk.
- The solver specification (message formats for the off-chain reveal, pricing, and inclusion) is published with the RSKIP so entry is genuinely permissionless from day one.

Bonding is deliberately kept out of consensus in v1: it is reputation and capital signalling, not validity. Making it a consensus gate would recreate the permissioned-LP problem the intent design exists to avoid. (Implemented and verified: a bond contract solvers stake into, with arbiter slashing, exercised in E15 alongside the first-valid-inclusion race — the bond is never read by `settle`. Flyover's LBC, where LPs post collateral and quotes carry penalty fees, is the production precedent for sizing.)

## The exit path: output delivered on Bitcoin

An exit intent's output is BTC at the user's own address (the `outputToken` sentinel; destination committed in `H`). The value flow mirrors the entry: the solver pays the user's Bitcoin address from its own UTXOs, then proves the payment on Rootstock — SPV inclusion against the Bridge's header chain (RSKIP122 `getBtcTransactionConfirmations`) plus an on-chain parse of the raw payout transaction showing an unclaimed output of ≥ `minOut` satoshis to the committed destination — and claims the escrowed input in the same call (`settleBtcOut`). The claim guard is per payout *output*, not per transaction, so one Bitcoin transaction paying N users settles N exit intents: batched exits amortise Bitcoin fees across fills. Flyover's `refundPegOut` is the production-proven relative of this exact mechanism.

Exits change the race economics fundamentally: a Bitcoin payment is irreversible, so if two solvers raced an exit, both would have paid the user (who is paid twice) and only one is repaid — nobody competes under that rule. The implemented fix is a **bonded reservation** (`reserveExit`): before paying, a solver posts a bond (10% of the payout in the PoC) for exclusive settlement rights over a reservation window sized to pay, confirm, and prove. The race moves to the Rootstock leg, where losing costs gas, never bitcoin. Squatting is priced: a lapsed reservation's bond is forfeited *into the input escrow*, so a stalled exit becomes strictly more profitable for the next solver — the mechanism heals its own delays, and the compensation stays on the Rootstock side where it is useful (the BTC-only user is made whole in BTC by whoever fills). Reservation is opt-in — an unreserved exit remains first-valid — but a rational solver always reserves. All of this is verified in E19, including the exclusivity (a valid proof from a non-reserver reverts), the wrong-destination rejection, the per-output replay guard, and the lapse-forfeit accounting.

Risk allocation: `MIN_BTC_CONF` (the payout depth required before settlement) protects the **user** — a payout reorged away after settlement leaves `H` consumed and the user unpaid — so production sets it materially above the PoC's regtest value and backs the residual with the solver's bond. The intent's expiry must budget for those confirmations plus the proof work, and the reservation window must fit inside the expiry: three coupled parameters, sized together.

## Failure and refund

If no solver settles an entry intent by height `E`, the pegged-in value is not lost — but with the escrow binding (the peg-in credits the settlement contract, not the user) the contract must expose a recovery path for the user after expiry: release to the user's RSK address derived from the peg-in, per RSKIP170's refund semantics. For exit intents the same applies to the escrowed input, and Flyover's `refundUserPegOut` is the model. Both recovery paths are specification requirements acknowledged as gaps in the PoC (which strands expired escrows); they are bookkeeping, not new trust assumptions — the funds sit in the settlement contract attributable to the intent that escrowed them.

# Rationale

**Why the solver claims the input rather than being paid a fee.** A separate fee would need a funding source; the user has none on Rootstock yet (that is the whole point — value is arriving from Bitcoin). Letting the solver take the input and deliver the output is self-funding: the user pays in the asset they are giving up anyway, and the fee is the spread.

**Why settlement is trustless only post-confirmation.** `solve` can move the input to the solver only once the input exists on chain — i.e., after the peg-in is processed. So the trustless path is: peg-in confirms, then `solve` atomically swaps input for output. A truly instant experience requires the solver to deliver the output *before* the peg-in confirms, taking on Bitcoin double-spend risk. That fronting is off-protocol risk-taking the protocol cannot make trustless; it is priced into the spread. The honest framing, consistent with the design sketch: the protocol delivers trust-minimised settlement of fronted flows, and "instant" is a solver service, not a protocol guarantee.

**Why the solver pays gas.** It aligns cost with the party that profits and keeps the user gas-free (a required property — the user may have no RBTC). A failed `solve` is the solver's cost, which is the correct incentive: solvers simulate and price before submitting.

**Why the spread is not a protocol parameter.** Fixing a fee would misprice risk that varies by asset, size, volatility, and confirmation depth. Letting `minOut` and solver competition set it lets the market price each intent.

# Interaction with the intent RSKIP

This document adds steps 2 and 4 (input verification and claim) to the `solve` specified in the companion RSKIP, which currently performs only steps 1, 3, and 5. It requires no change to the intent transaction type, admission, or the consumed set. Making a failed `solve` revert visibly is a settlement-path concern discussed in the companion RSKIP's implementation notes — the recommended route is a thin VM contract wrapping the registry (the VM path already reverts and fails the receipt on a failed call), rather than changing the shared precompile path used by Bridge and Remasc. Without it, a failed `solve` still has no state effect but reports success.

# Security considerations

- **Solver default between fronting and claim.** Only relevant in the off-protocol instant variant; the on-protocol path settles atomically, so there is no window.
- **User double-spend of the peg-in.** Handled by requiring the peg-in to be processed (confirmed) before `solve` can claim the input; the confirmation depth is the Bridge's, not a new parameter.
- **Griefing a specific `H`.** Closed by the atomic `solve`: an attacker cannot consume `H` without delivering `minOut`; a failed attempt costs the attacker gas and leaves the intent solvable.
- **Price manipulation / MEV.** The first-valid-inclusion race is MEV-exposed like any inclusion market; a consensus-level intent+solution bundle (future work) would give ordering control. In v1 the exposure is bounded by the user's `minOut` — the user cannot receive less than they signed for.
- **Spread extraction vs the user.** The user is protected by `minOut`: whatever the solver's spread, the user receives at least what they signed for. A user signing an unrealistic `minOut` simply goes unsolved.

# Open questions

- Input binding in production: the PoC's OP_RETURN + Bridge record (E14) versus reusing RSKIP176 Programmable Peg-in Addresses — the latter avoids a new Bridge change and is the recommended direction, pending confirmation that the derivation scheme accommodates `H`.
- Enforced vs off-consensus auction: both are built; which ships is governance.
- Bond and reservation sizing for mainnet: the reservation window must cover `MIN_BTC_CONF` Bitcoin blocks (hours), which makes the bond's opportunity cost material — size the bond as a function of window length, not just payout.
- A native permit for exiting live positions (vault shares, LP) without a user Rootstock transaction.
- Expired-exit escrow recovery (`refundUserPegOut` analogue).
- Multi-input / partial-fill intents (one intent satisfied by several solvers), out of scope for v1.
- Fee to the network beyond gas (none proposed; noted for completeness).

# Implementation status

Everything specified above is implemented in the PoC and verified by experiment: the escrowed input claim and spread (E12, cross-asset), the real peg-in→contract crediting via RSKIP170 OP_RETURN + a Bridge record (E14; RSKIP176 noted as the production alternative), first-valid-inclusion with bonded competing solvers (E15), the above-`minOut` auction in both off-consensus and enforced shapes with token-denominated bids, pull-payments and lock decay (E17/E17b), and the exit path — SPV-verified solver payouts, per-output claims enabling batching, and bonded reservations with lapse-forfeit (E19, all checks green, including the negatives). Checks-effects-interactions ordering throughout; outcomes in race experiments are judged by each actor's own transaction receipt.

Not implemented, deliberately: the off-chain reveal protocol and endorsement/reputation (published as specification with the RSKIPs), recovery of an expired exit's escrowed input (Flyover's `refundUserPegOut` is the model — an acknowledged gap), and the consensus-level bundle.

# References

- RSKIP-XXX — native intent transaction type (companion).
- RSKIP122 — `getBtcTransactionConfirmations`; the SPV primitive behind `settleBtcOut`.
- RSKIP170 — peg-in version 1 (OP_RETURN destination); the implemented input binding (E14).
- RSKIP176 — Programmable Peg-in Addresses (Flyover); the production input-binding alternative.
- Flyover / Liquidity Bridge Contract — `refundPegOut` (the exit mechanism's production relative), LP collateral and penalties (bond precedent), `refundUserPegOut` (the expired-escrow recovery model). See `PRODUCTIONIZATION.md`, "Relationship to Flyover".
- Design sketch, pressure points 3 (instant is a solver property) and 5 (refund/slow path).
- PBS / proposer-builder separation and relay markets — liveness analogue for the solver inclusion race.
