# Mempool admission rules — the canonical list

**TL;DR** — the eight points at which a node can refuse an intent, in the order it actually reaches
them, each tied to its code site, its exact rejection string, the test that covers it, and the M01
variant that times it. This file exists because three different lists of these rules were in
circulation and none of them matched the implementation. Where the RSKIP disagrees with the code, the
disagreement is recorded at the bottom rather than quietly reconciled.

## The rules, in execution order

The first three happen outside `IntentAdmission.check` — worth knowing, because "the admission rules"
is often used to mean only that file, and two of the most commonly hit refusals are not in it.

| # | Refuses when | Code | Exact message | Spec | Covered by | M01 |
|---|---|---|---|---|---|---|
| A1 | the intent rule is not active at this height | `TransactionPoolImpl:264` | `native intents are not active yet` | rule 1 | `e13`, `a1` | — |
| A2 | `signature == null`, `r`/`s`/`v` out of range, **or `s >= N/2`**, or the chain id genuinely mismatches | `Transaction:682` via `acceptTransactionSignature` | `Invalid chainId: 33` | rule 2, partly | thin — see gaps | `sig_undecodable` |
| A3 | the payload is not exactly 160 bytes | `IntentAdmission:41` | `intent: data must be exactly 160 bytes (H\|btcTxid\|E\|minOut\|outputToken)` | rule 3 | `a5` | `len_161` |
| A4 | `E` needs more than 63 bits | `IntentAdmission:48` | `intent: expiry E out of range` | **absent** | **nothing** | `expiry_overflow` |
| A5 | `bestBlockNumber >= E` | `IntentAdmission:54` | `intent: expired (height H >= E N)` | rule 4, first half | `e2`, `a5` | `expired` |
| A6 | `E - best > maxExpirySpan` | `IntentAdmission:57` | `intent: expiry too far ahead (E-height N > max M)` | rule 4, second half | **nothing** | `too_far_ahead` |
| A7 | `H` is in the consumed set — **first storage read** | `IntentAdmission:63` | `intent: H already consumed` | rule 5 | `e3`, `b6` | `h_consumed` |
| A8 | `btcTxid` is not a processed peg-in — **second storage read**, only when `requireBtcTicket` | `IntentAdmission:71` | `intent: BTC ticket not visible in Bridge SPV view (txid …)` | rule 6 | `e8`, `e8pos`, `a2`, `a6` | `no_ticket` |

Everything after A8 is acceptance: pool insert and gossip.

**Where A7 reads.** Not the settlement contract. Since attack B6 the consumed set lives at the
consumed-set precompile (`0x…24`) under `keccak256("intentConsumed-" ‖ hex(H))`, and admission reads
it there. It used to be raw storage at slot number `H` inside Settlement, which shared an address
space with that contract's six mappings — and `H` is chosen by the user, so a crafted `H` could write
into them. `IntentConstants.consumedKeyForH` is now the single derivation that the node and the
precompile must agree on forever: a divergence would make admission read a permanently empty slot and
stop refusing consumed intents, silently. `e3` is the canary for exactly that, and it is the reason
this rule now cites two tests rather than one.

## What each one costs

Measured in `m01`, three runs, over JSON-RPC. See [CLAIMS.md](CLAIMS.md) for the runs and intervals.

Only two costs on this path resolve above the measurement noise:

- **~540 µs** — reaching A3 from A2, i.e. validating the signature and recovering the sender. Every
  intent that gets past A2 pays this, whichever rule eventually refuses it.
- **~200 µs** — accepting rather than refusing at A6: pool insert plus gossip.

**A3 through A8 are individually below this method's resolution**, the two storage reads included.
That is a statement about the instrument, not about the rules: a difference smaller than ~70–180 µs
of transport noise cannot be seen from outside the node. It does not mean any of them is free.

## Where the RSKIP disagrees with the implementation

Four discrepancies. None is resolved here — each needs a decision about which side is wrong.

1. **A4 is not in the spec at all.** The RSKIP lists six rules; the implementation has eight refusal
   points, and the `E`-out-of-range check has no corresponding rule. It exists to stop a 256-bit `E`
   overflowing a `long`, so it is probably load-bearing — but "probably" is not a specification.
2. **The spec merges A5 and A6 into one bullet.** They are separate short-circuits with different
   messages, and the difference matters: A5 is fatal to an intent while A6 is recoverable by waiting.
   That asymmetry is the whole basis of the *Choosing `E` across the peg-in wait* section, which the
   rule list gives no way to see.
3. **A2 enforces more than the spec says.** The RSKIP has "the signature is valid and the chain ID
   matches". The code also requires a canonical low-`s` per EIP-2, and reports every failure — null
   signature, bad components, high `s`, wrong chain id — as `Invalid chainId`. A signer that does not
   normalise `s` is told its chain id is wrong. Neither the requirement nor the misleading message is
   documented anywhere a signer author would look.
4. **Three numberings are in circulation.** The RSKIP's 1–6, the source order inside
   `IntentAdmission.check`, and M01's header. This table's A1–A8 is intended to replace all three, and
   the other two should cite it rather than renumber.

## Coverage gaps

- **A4** — no experiment or attack. Only M01 exercises it, and a measurement is not a correctness test.
- **A6** — same. Nothing asserts that an over-distant `E` is refused, despite `maxExpirySpan` being a
  live parameter in the `E`-selection question.
- **A2** — `test/encoding.test.ts` proves the SDK signs *correctly*, and M01 shows one malformed
  signature is refused. Nothing tests that a valid-but-non-canonical (high-`s`) signature is refused,
  which is the case most likely to bite a third-party signer.
