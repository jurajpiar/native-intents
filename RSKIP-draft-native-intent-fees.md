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

The simplest binding that satisfies this: the peg-in credits the user's account as today, and the signed intent authorises the registry to transfer `I` from the user to the solver inside `solve`. The registry never custodies the input; it moves it in the same call that delivers the output.

## Settlement accounting

`solve` performs, atomically and in this order, reverting the whole call if any step fails:

1. Re-check admission at the inclusion height (unexpired, `H` unconsumed, ticket valid) — as in the companion RSKIP.
2. Verify the input `I` is present and attributable to the user (the peg-in is processed and credited).
3. Transfer `out ≥ minOut` of the output asset from the solver to the user.
4. Transfer the input `I` from the user to the solver.
5. Record `H` consumed.

The spread `value(I) − value(out)` is simply what the solver retains: it is not computed or enforced by the protocol, only permitted. Gas is paid by the solver as the transaction sender, so a failed `solve` costs the solver gas and nothing else — the intent stays unconsumed and solvable.

## Price discovery and competition

`minOut` is set by the user when signing; it is the worst rate they will accept. Any solver able to meet it may settle, and the first valid `solve` included wins — later `solve`s for the same `H` revert on the consumed-set check, so a losing solver loses only gas. This is a first-valid-inclusion race, and its liveness and censorship-resistance mirror PBS/relay markets: any bonded solver chasing a visible, positive spread will include the intent.

An optional refinement (not required for v1) lets the user leave `minOut` deliberately conservative and have solvers compete to deliver *more* than `minOut`, with the best offer winning within a short window. This is a sealed-or-open auction layered above the base first-valid-inclusion rule and can be added without a consensus change, since "deliver more than the minimum" already satisfies the base rule.

## Bonding and endorsement

The companion RSKIP notes a residual: a solver can submit a `solve` that fails, costing itself gas but also briefly occupying the intent. More importantly, a competitive set must exist from genesis or the protocol properties do not cash out. Both are addressed off-consensus:

- Solvers post a bond and may be endorsed; the bond is slashable for provable misbehaviour (e.g., griefing patterns) and signals capital at risk.
- The solver specification (message formats for the off-chain reveal, pricing, and inclusion) is published with the RSKIP so entry is genuinely permissionless from day one.

Bonding is deliberately kept out of consensus in v1: it is reputation and capital signalling, not validity. Making it a consensus gate would recreate the permissioned-LP problem the intent design exists to avoid.

## Failure and refund

If no solver settles the intent by height `E`, the input is untouched: it is simply the peg-in credit sitting in the user's account. Because the ticket is required to be an ordinary peg-in, the no-solver case is already the slow path — the user has their pegged-in funds and lost nothing but time. No explicit refund mechanism is needed. This is the resolution of pressure point 5 in the design sketch.

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

- Exact input-binding representation: peg-in-credits-user + intent-authorised transfer (above), versus a peg-in whose beneficiary is the registry (needs a Bridge change), versus a per-intent escrow.
- Whether the optional over-`minOut` auction is worth specifying in v1 or left to the solver market.
- Bond sizing and slashing conditions; whether any part of bonding must be on-consensus.
- Multi-input / partial-fill intents (one intent satisfied by several solvers), out of scope for v1.
- Fee to the network beyond gas (none proposed; noted for completeness).

# References

- RSKIP-XXX — native intent transaction type (companion).
- RSKIP-XXX implementation notes — precompile-exception propagation (required for visible `solve` reverts).
- Design sketch, pressure points 3 (instant is a solver property) and 5 (refund = ordinary peg-in).
- PBS / proposer-builder separation and relay markets — liveness analogue for the solver inclusion race.
