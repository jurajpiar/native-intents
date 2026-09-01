# Running the positive Bitcoin-ticket path (E8+)

The default experiment suite runs with Bitcoin-ticket enforcement disabled. E8+ tests the other side
of that rule: an intent backed by a peg-in that the Bridge has genuinely processed.

The driver is `sdk/experiments/pegin.ts`. It constructs and registers the peg-in, then prints the
`PEGIN_TXID` used by the positive-ticket experiment.

## Why no federation key is needed

On regtest with all forks enabled, both `receiveHeader` and `registerBtcTransaction` are public, and the
peg-in whitelist has been removed under RSKIP87. The driver can therefore:

1. read the federation peg-in address through `getFederationAddress`;
2. create the Bitcoin transaction;
3. relay the required headers; and
4. register the peg-in through the Bridge.

The remaining obstacle is the normal 300-second `receiveHeader` throttle. The rskj patch sets that
interval to zero on regtest so the driver can relay the roughly 104 headers needed to satisfy coinbase
maturity without waiting hours.

## Run E8+

Ticket enforcement is controlled when the rskj containers start. In Fish shell, run:

```fish
cd ~/github.com/jurajpiar/native-intents/poc
set -x INTENT_REQUIRE_TICKET true
podman-compose -f stack/podman-compose.yml up -d

cd sdk
npm run pegin
set -x PEGIN_TXID <txid printed by the driver>
npm run e8pos
```

The final experiment checks both directions: a fabricated transaction ID must be rejected, while an
intent referencing the processed peg-in must be admitted.

To return to the default suite:

```fish
set -e INTENT_REQUIRE_TICKET
cd ..
podman-compose -f stack/podman-compose.yml up -d
cd sdk
npm run all
```

If you use Docker Compose rather than Podman Compose, replace `podman-compose` with the equivalent
`docker compose` command for your environment.

## What this test proves—and what it does not

E8+ proves that mempool admission can recognise a processed peg-in in the Bridge's SPV-backed state.
It does not prove the production fee path. The registered peg-in follows the normal Bridge crediting
flow, whereas the PoC's fee experiment separately uses `depositForPegin` to model credit into the
settlement contract.

Those two pieces still need to be unified in production. In particular, E8+ does not validate
peg-in-to-contract escrow, ownership binding, or recovery of an unsolved escrow.

## Troubleshooting

The driver reports each stage as it runs. Common failure points are:

- **Header relay stops:** confirm that the regtest patch changed
  `minSecondsBetweenCallsReceiveHeader` to `0`. A mismatch between bitcoind's regtest genesis and the
  Bridge's stored header chain also causes this; recreate both volumes together before retrying.
- **`getBtcTxHashProcessedHeight` returns `-1`:** the Bridge did not recognise the peg-in. Check that
  the sender uses the legacy script type expected by the driver, the amount is at least 500,000 satoshi,
  and the partial Merkle tree and height match the relayed header chain.

This path is the most timing- and state-sensitive part of the harness, so a clean stack is often the
fastest way to rule out mismatched local chains.
