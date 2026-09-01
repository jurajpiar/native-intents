# Advanced path: a real BTC ticket on regtest (stretch)

The core experiments (E1, E1b, E2, E3, E6) run with the BTC ticket check off
(`-Dintent.requireBtcTicket=false`), so you do not need any of this to exercise the two irreducible
claims. E8's negative case (bogus txid rejected) also needs no peg-in. This note is only for the
*positive* ticket path — an intent backed by a genuinely processed peg-in.

## Why it is fiddly

rskj has no bitcoind integration and no built-in relayer. The Bridge SPV view is populated only by
Bridge calls (`receiveHeaders`, `registerBtcTransaction`), and on regtest those are federation-gated
(all forks active ⇒ RSKIP200 active ⇒ `receiveHeaders` is not public). So to register a peg-in you must
act as a federation member.

## Sketch of the flow

1. Override the regtest federation with a key you control. Uncomment `genesis_constants.federationPublicKeys`
   in `config/node-a.conf` and set it to the BTC pubkey whose private key your harness holds. Note
   `FederationRegTestConstants` is a per-process singleton — pick the key once.
2. In bitcoind (regtest), send BTC to the federation's peg-in address; mine it to the required depth
   (`btc2RskMinimumAcceptableConfirmations = 3`).
3. As the federation member (same key derives the RSK sender), send RSK txs to the Bridge
   (`0x…01000006`): `receiveHeaders` for the block headers, then `registerBtcTransaction` with the tx,
   height, and partial-merkle-tree proof. Mind `minSecondsBetweenCallsReceiveHeader = 300` (5 min).
4. Once registered, the peg-in txid is in the processed set. An intent whose `btcTxid` equals it now
   passes the ticket check with `-Dintent.requireBtcTicket=true`.

## Why this is also the refund story

If the flagship flow requires the BTC tx to be an ordinary peg-in, the no-solver case degrades to a
normal peg-in credit with no new mechanism — which is pressure point 5 in the design sketch. Wiring this
path is therefore worth doing properly, but it is milestone-2 territory; the harness ships the hook
(`requireBtcTicket`) and this sketch, not a turnkey script.
