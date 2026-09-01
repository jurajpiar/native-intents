#!/usr/bin/env bash
# Initialise the regtest BTC chain: create a wallet and mine enough blocks to have spendable coins.
# Run from the host after `podman-compose up -d`.  (fish users: this is bash on purpose — run `bash bootstrap-btc.sh`.)
set -euo pipefail
CLI=("podman" "exec" "-i" "stack_bitcoind_1" "bitcoin-cli" "-regtest" "-rpcuser=rsk" "-rpcpassword=rsk")

# container name differs by compose implementation; override with BTC_CTR=... if needed
if [ -n "${BTC_CTR:-}" ]; then
  CLI=("podman" "exec" "-i" "${BTC_CTR}" "bitcoin-cli" "-regtest" "-rpcuser=rsk" "-rpcpassword=rsk")
fi

echo "creating wallet 'poc'..."
"${CLI[@]}" createwallet poc >/dev/null 2>&1 || "${CLI[@]}" loadwallet poc >/dev/null 2>&1 || true
ADDR="$("${CLI[@]}" getnewaddress)"
echo "mining 101 blocks to ${ADDR} (coinbase maturity)..."
"${CLI[@]}" generatetoaddress 101 "${ADDR}" >/dev/null
echo "balance: $("${CLI[@]}" getbalance) BTC"
echo "done. RPC: http://localhost:18443 (rsk/rsk)"
