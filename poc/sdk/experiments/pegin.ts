/**
 * Peg-in driver — registers a real regtest BTC peg-in in the Bridge SPV view so its txid becomes a
 * valid anti-spam "ticket" for an intent. Run once before E8-positive:  npm run pegin
 *
 * Flow (all Bridge calls are public on regtest; needs the throttle patch minSecondsBetweenCallsReceiveHeader=0):
 *   1. read the federation peg-in address from the Bridge
 *   2. bitcoind: fund a legacy address to maturity, send a peg-in to the federation, confirm it
 *   3. relay every BTC header the Bridge is missing, in order, via receiveHeader
 *   4. registerBtcTransaction with the raw tx + height + partial-merkle-tree proof
 *   5. verify getBtcTxHashProcessedHeight >= 0, and print PEGIN_TXID for E8
 *
 * It prints each step; if it stalls, the last successful line says where.
 */
import { Rpc, waitFor } from "../src/client.js";
import { RPC_A } from "../src/config.js";
import { BtcRpc } from "../src/btcrpc.js";
import { Bridge } from "../src/bridge.js";
import { waitReceipt } from "./_harness.js";

const PEGIN_BTC = 0.01; // 1,000,000 sat, above the 500,000 minimum
const CONFIRMATIONS = 3;

async function main(): Promise<void> {
  const rpc = new Rpc(RPC_A);
  const btc = new BtcRpc();
  const bridge = new Bridge(rpc);
  console.log(`\n=== peg-in driver (rsk ${RPC_A}, btc ${btc.base}) ===`);

  // 1. federation peg-in address
  const fedAddr = await bridge.getFederationAddress();
  console.log(`federation address   ${fedAddr}`);

  // 2. bitcoind: mature coins on a legacy address (legacy sender => peg-in sender is detectable)
  await btc.ensureWallet();
  const legacy = await btc.getNewAddress("", "legacy");
  let height = await btc.getBlockCount();
  if (height < 101) {
    console.log(`mining ${101 - height} blocks to maturity...`);
    await btc.generateToAddress(101 - height, legacy);
  }
  console.log(`btc balance          ${await btc.getBalance()} BTC`);

  const peginTxid = await btc.sendToAddress(fedAddr, PEGIN_BTC);
  await btc.generateToAddress(1, legacy);                 // mine the peg-in
  const peginHeight = await btc.getBlockCount();
  await btc.generateToAddress(CONFIRMATIONS - 1, legacy); // extra confirmations
  const btcBest = await btc.getBlockCount();
  console.log(`peg-in txid          ${peginTxid}`);
  console.log(`peg-in height        ${peginHeight}, btc best ${btcBest}`);

  // 3. relay every missing header, in order
  const start = await bridge.bestChainHeight();
  console.log(`bridge SPV height    ${start}; relaying ${start + 1}..${btcBest}`);
  for (let h = start + 1; h <= btcBest; h++) {
    const hash = await btc.getBlockHash(h);
    const header = await btc.getBlockHeaderRaw(hash);
    await waitReceipt(rpc, await bridge.receiveHeader(header));
    if (h % 20 === 0 || h === btcBest) {
      console.log(`  relayed up to ${h}; bridge SPV height now ${await bridge.bestChainHeight()}`);
    }
  }
  const finalSpv = await bridge.bestChainHeight();
  if (finalSpv < btcBest) {
    console.error(`\nheader relay stalled at SPV height ${finalSpv} (< ${btcBest}). Check the throttle patch (minSecondsBetweenCallsReceiveHeader=0) and that bitcoind's genesis matches the Bridge's.`);
    process.exit(1);
  }

  // 4. register the peg-in with a merkle proof (gettxoutproof = 80-byte header || PMT)
  const rawTx = await btc.getRawTransaction(peginTxid);
  const proof = await btc.getTxOutProof([peginTxid]);
  const pmt = proof.slice(160); // strip the 80-byte (160 hex) block header
  console.log(`registering peg-in (txlen ${rawTx.length / 2}B, pmtlen ${pmt.length / 2}B)...`);
  await waitReceipt(rpc, await bridge.registerBtcTransaction(rawTx, peginHeight, pmt));

  // 5. verify
  const processedAt = await bridge.processedHeight(peginTxid);
  if (processedAt >= 0) {
    console.log(`\nOK — peg-in processed at height ${processedAt}.`);
    console.log(`\nRun E8-positive with:\n  PEGIN_TXID=${peginTxid} npm run e8pos\n`);
    process.exit(0);
  }
  console.error(`\nFAILED — getBtcTxHashProcessedHeight returned ${processedAt}. The peg-in was not recorded.\n` +
    `Likely causes: sender script type not detected (use a legacy funding address), amount below minimum, ` +
    `or the PMT/height mismatched the relayed headers.`);
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

void waitFor;
