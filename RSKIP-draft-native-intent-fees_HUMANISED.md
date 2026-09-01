| RSKIP | YYY |
|---|---|
| **Title** | Native intent fee mechanics |
| **Created** | 2026-09-01 |
| **Author** | juraj@rootstocklabs.com |
| **Purpose** | Usability, Interoperability |
| **Layer** | Core |
| **Complexity** | 2 |
| **Status** | Draft |

This is the companion to RSKIP-XXX, which defines how an intent is signed, admitted, and settled. The
missing question is economic: why would a solver fulfil it? This RSKIP defines the input claim and
spread that make solving worthwhile.

# Abstract

An intent asks to exchange an input controlled by the user for at least a specified amount of an output
asset. A solver supplies the output, receives the input, and keeps the difference after paying gas.

This document defines that value flow, the binding between an intent and its input, atomic settlement,
price competition, bonding, and the no-solver case. It does not change the intent envelope. Most of the
mechanism belongs in the settlement contract and solver protocol rather than in consensus.

# Motivation

The transaction RSKIP requires `settle` to deliver at least `minOut` and to record the intent as
consumed. Without an input claim, however, the solver would supply the output and pay gas without being
repaid. No rational solver market can form on those terms.

The economic half of the design is therefore simple: when settlement succeeds, the solver receives the
user's input and keeps any spread between that input and the output it delivered.

Atomic value exchange is a contract property, not a unique reason for changing consensus. The native
transaction type supplies the pre-inclusion properties described in the companion RSKIP; the settlement
contract ensures that input and output move together. Pricing, competition, reputation, and bonding sit
on top as market structure.

# Value flow

Let `I` be the input asset and amount, `out` the output delivered, and `g` the gas cost. On successful
settlement:

- the user gives up `I` and receives `out`, where `out ≥ minOut`;
- the solver receives `I`, supplies `out`, and pays `g`; and
- the solver's profit is `value(I) − value(out) − g`.

A solver participates only when it expects that result to be positive. The user effectively sets the
maximum fee through `minOut`: they accept an output worth less than the input by enough to cover the
solver's costs, risk, and margin. The difference is the spread, paid in the asset the user is already
exchanging rather than as a separate gas token.

The protocol does not mint or burn value. The solver receives the same input the user relinquishes and
the user receives the output the solver supplies. Gas is the only external cost.

# Specification

## Binding the input

The intent must identify an input that can be claimed only as part of successful settlement. In the
Bitcoin-anchored flow, `btcTxid` identifies both the processed peg-in and the corresponding RBTC input.
At settlement time, the contract must be able to determine the input amount, its intended user, and the
intent to which it belongs.

Implementation work exposed an important constraint: native RBTC cannot be pulled from a user's account
without a transaction from that account. The input therefore cannot sit in the user's balance while a
solver waits to claim it. It must be escrowed in the settlement contract.

The intended production flow is:

1. the peg-in credits the settlement contract directly;
2. the Bridge or callback binds the credited amount to `btcTxid`, the intent commitment, and the user;
3. the contract releases that amount only to a solver that satisfies the signed intent; and
4. if the intent expires unsolved, an authenticated recovery path returns the escrow to the user.

The PoC's `depositForPegin(btcTxid)` models only the credit into escrow. Production binding requires a
Bridge change or an equivalently secure mechanism. An arbitrary caller must not be able to choose the
identity or ownership of a real peg-in by depositing funds against a transaction ID.

An ERC-20 input could instead use an allowance, but native RBTC requires escrow and is the main use case
for this RSKIP.

## Settlement accounting

`settle` must perform the following actions atomically. Any failed check or transfer reverts the whole
call:

1. authenticate the raw intent and confirm that it has not expired or been consumed;
2. verify that the escrowed input exists and is bound to the signed user and intent;
3. deliver at least `minOut` of the selected output asset from the solver to the user;
4. release the complete escrowed input to the solver; and
5. record `H` as consumed.

The implementation may record `H` before external transfers to prevent re-entrancy, provided the write
is on the same execution track and therefore rolls back on any later failure.

The contract does not need to calculate the spread. Whatever remains after the solver delivers the
accepted output and pays gas is the solver's return. A failed settlement costs the solver gas but does
not consume the intent or release the input.

## Price discovery and competition

The user signs `minOut`, the least favourable output they will accept. Any solver able to meet that
bound may settle, and the first valid settlement included wins. A later transaction for the same `H`
reverts because the intent has already been consumed, so competing solvers must account for the risk of
losing the race and paying gas.

This base design guarantees only the user's floor, not the best available price. A later market layer
could ask solvers to bid above `minOut` during a short window. The winner would deliver the best offer,
while the settlement contract would continue to enforce the signed minimum. Such an auction does not
require a consensus change.

Liveness depends on more than a nominally open market. Solvers need access to the payload reveal, a way
to observe opportunities, and enough confidence to price them. Those requirements belong in a
published solver specification.

## Bonding and endorsement

Solvers may post a bond and receive endorsements. A bond can put capital at risk for behaviour that is
both undesirable and provable; endorsements can contribute to reputation and routing decisions.

Bonding should remain outside consensus in v1. Making a bond a validity requirement would turn an open
solver market into another permissioned liquidity-provider set. It also does not solve every form of
griefing: a failed transaction is slashable only when the misbehaviour can be proved under clear,
objective rules.

The solver protocol should be published with the RSKIP so a new participant can discover intents,
obtain reveals, simulate them, price them, and submit settlement without private integration.

## Expiry and recovery

The no-solver case must follow the location of the funds. If a conventional peg-in credits the user,
expiry naturally leaves the RBTC in the user's account—but that design cannot support a solver claim of
native RBTC without another user transaction.

In the proposed escrow design, the settlement contract holds the funds. Expiry therefore requires an
explicit recovery path. That path must establish who is entitled to the escrow, prevent a solver from
claiming it after recovery, and remain correct across reorgs. The exact mechanism is still open and is a
production blocker.

An ordinary peg-in is not, by itself, a refund when its beneficiary is the settlement contract. The
earlier statement that “no explicit refund is needed” applies only to the incompatible design in which
the user is credited directly.

# Rationale

**Why give the solver the input?** A separate fee needs separate funding, but the user may have no RBTC
on Rootstock yet. Paying through the spread makes the exchange self-funding: the user pays with part of
the value they are already moving.

**Why is trustless settlement post-confirmation?** The contract can release the input only after the
peg-in is processed and the escrow exists. A solver may deliver before that point, but then it accepts
Bitcoin confirmation and double-spend risk off-protocol. That risk can be priced into the spread; it
cannot be removed by the intent type. The protocol provides trust-minimised settlement of a fronted
flow, while the solver provides any “instant” experience.

**Why does the solver pay gas?** The solver is the party seeking profit and is able to price execution
costs before submitting. Charging it keeps the user gas-free and creates the right incentive to
simulate carefully.

**Why not fix the spread in the protocol?** Risk depends on the asset, amount, volatility, confirmation
depth, competition, and current gas market. A fixed fee would misprice at least some of those cases.
`minOut` and solver competition let the market price each intent separately.

# Interaction with the transaction RSKIP

This RSKIP adds input verification and release to the atomic settlement described by the companion
transaction RSKIP. It does not change the envelope, mempool rules, or consumed-set representation.

Stateful settlement stays in a VM contract so ordinary revert semantics apply. The parsing precompile
is stateless and exists only to authenticate the RSK-namespace transaction and return its signed fields.
Changing the shared executor path for precompile exceptions would affect the Bridge and Remasc and is
not required by this design.

The normative settlement path should verify every condition on which value safety depends. In the
current PoC, the contract authenticates the raw intent, checks expiry and consumption, and handles the
transfers, but it does not itself prove that `btcTxid` is a processed Bridge peg-in. `depositForPegin`
supplies a modelled escrow. Production input binding must close that gap.

# Security considerations

- **Fronting risk:** before the peg-in is processed, a solver bears Bitcoin confirmation and double-
  spend risk. The atomic post-confirmation path has no comparable window.
- **False or misbound input:** the Bridge-to-contract credit must bind the amount, user, `btcTxid`, and
  intent. A user-supplied mapping entry is not sufficient in production.
- **Expired escrow:** a missing or ambiguous recovery path can strand funds. Recovery also needs to
  exclude later solver claims and handle reorgs.
- **Consumption griefing:** an attacker cannot consume `H` without completing all transfers. A failed
  attempt costs gas and leaves the intent available.
- **Re-entrancy:** consumption and escrow-clearing state should be updated before external calls, with
  the entire call reverting on failure.
- **MEV and losing races:** the first-valid-inclusion model exposes solvers to ordering and duplicate-
  submission risk. `minOut` protects the user from receiving less than they signed for, but it does not
  guarantee the best possible price.
- **Unrealistic `minOut`:** an intent with no positive expected spread may simply remain unsolved.

# Open questions

- What Bridge change should credit the settlement contract and authenticate the escrow metadata?
- How does the user recover an expired, unsolved escrow?
- Should the optional auction above `minOut` be specified in v1 or left entirely to solver services?
- Which behaviours are objectively slashable, and how should bonds be sized?
- Should v1 support multiple inputs or partial fills? Both are currently out of scope.
- Is any network fee needed beyond ordinary solver-paid gas? None is currently proposed.

# Implementation status

Milestone 4 implements the basic value flow in the PoC and E12 verifies it end to end. The settlement
contract holds RBTC in an escrow mapping keyed by `btcTxid`. `depositForPegin` models the production
peg-in credit. On settlement, the contract authenticates the intent, records `H` on the reversible
execution track, delivers RBTC or ERC-20 output to the user, clears the escrow, and releases the input to
the solver.

E12 covers the cross-asset case: the user supplies modelled peg-in RBTC, receives an ERC-20, and the
solver receives the RBTC input after delivering the token.

Not implemented are production Bridge crediting and binding, expired-escrow recovery, solver discovery
and reveal rules, price competition above `minOut`, or bonding. Those are not minor omissions: the
first two are required for safe custody, while the rest determine whether a competitive market can
exist.

# References

- RSKIP-XXX — native intent transaction type.
- Design sketch, especially the sections on instant execution, reveal liveness, and expiry recovery.
- PBS and relay markets — a useful, though imperfect, liveness analogy for solver inclusion.
