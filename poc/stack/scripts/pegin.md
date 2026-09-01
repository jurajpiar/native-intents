# The BTC-ticket positive path (E8)

The core experiments (E1–E7) run with the ticket check off. This is the *positive* anti-spam path: an
intent backed by a genuinely processed peg-in. It is implemented by the `pegin` driver
(`sdk/experiments/pegin.ts`) and exercised by E8-positive.

## Why it works without a federation key

On regtest with all forks active, `receiveHeader` (singular) and `registerBtcTransaction` are both
**public**, and the peg-in whitelist is gone (RSKIP87). So the driver relays headers and registers the
peg-in itself, and reads the federation peg-in address from the Bridge (`getFederationAddress`). The
only obstacle is `receiveHeader`'s 300s throttle, which the patch drops to 0 on regtest so the ~104
headers coinbase maturity forces can be relayed quickly.

## Run it

The peg-in and E8 need the node enforcing tickets. Recreate with the flag on (no rebuild needed — it's
an env toggle), then drive the peg-in and run E8:

```fish
cd ~/github.com/jurajpiar/native-intents/poc
set -x INTENT_REQUIRE_TICKET true
docker-compose -f stack/podman-compose.yml up -d      # recreates nodes with ticket enforcement ON
cd sdk
npm run pegin                                          # registers a real peg-in; prints PEGIN_TXID=...
set -x PEGIN_TXID <the txid it printed>
npm run e8pos                                          # bogus txid rejected; valid-ticket intent admitted
```

To go back to the main suite, clear the flag and recreate:

```fish
set -e INTENT_REQUIRE_TICKET
docker-compose -f stack/podman-compose.yml up -d
cd sdk; npm run all
```

## The refund story this validates

Because the ticket is required to be an ordinary peg-in, the no-solver case degrades to a normal peg-in
credit with no extra mechanism — pressure point 5 in the design sketch. The driver's peg-in is exactly
such a credit.

## If it stalls

The driver prints each step. Common failure points (all untested here — this is the fiddliest part):
- header relay stalls → the throttle patch didn't apply (check `minSecondsBetweenCallsReceiveHeader=0`),
  or bitcoind's regtest genesis differs from the Bridge's (start from a fresh `docker-compose down -v`).
- `getBtcTxHashProcessedHeight` returns -1 → the peg-in wasn't recognized: sender script type not
  detected (the driver funds a *legacy* address for this reason), amount below 500,000 sat, or the
  PMT/height didn't match the relayed headers.
