/**
 * One-shot diagnostic. Prints the node facts the experiments depend on, so we can see exactly why
 * something failed instead of guessing. Run: npm run diag
 */
import { Rpc } from "../src/client.js";
import { buildIntent, freshWallet, randomH } from "../src/intent.js";
import { RPC_A, REGISTRY_ADDR, cowWallet } from "../src/config.js";
import { isIntentTx } from "../src/solver.js";

async function main(): Promise<void> {
  const rpc = new Rpc(RPC_A);
  console.log(`\n=== node diagnostic (${RPC_A}) ===`);

  const height = await rpc.blockNumber();
  console.log(`block height        ${height}`);

  const cow = cowWallet().address;
  const cowBal = BigInt(await rpc.getBalance(cow));
  console.log(`cow ${cow}`);
  console.log(`  balance           ${cowBal}  ${cowBal > 0n ? "(funded ✓)" : "(NOT FUNDED — genesis/rsk-dev.json not loaded)"}`);
  console.log(`  nonce             ${await rpc.txCount(cow)}`);

  const regCode = await rpc.getCode(REGISTRY_ADDR).catch((e) => `error: ${(e as Error).message}`);
  console.log(`registry ${REGISTRY_ADDR}`);
  console.log(`  eth_getCode       ${regCode === "0x" ? "0x (precompiles have no code — expected)" : regCode}`);

  // live mempool round-trip
  const intent = buildIntent(freshWallet(), { H: randomH(), btcTxid: new Uint8Array(32), expiry: height + 50, minOut: 0n });
  let sent = "";
  try {
    sent = await rpc.sendRaw(intent.rawHex);
    console.log(`\nsubmitted intent    ${sent}`);
  } catch (e) {
    console.log(`\nintent submit FAILED ${(e as Error).message}`);
  }
  if (sent) {
    const pend = await rpc.pendingTxs();
    const mine = pend.find((t) => t.hash.toLowerCase() === intent.hash.toLowerCase());
    console.log(`txpool_content size ${pend.length}`);
    console.log(`  our intent found  ${mine ? "yes" : "NO"}`);
    if (mine) console.log(`  detected as intent ${isIntentTx(mine)}  (type=${mine.type ?? "n/a"}, inputLen=${(mine.input.length - 2) / 2})`);
    const viaHash = await rpc.getTx(intent.hash).catch(() => null);
    console.log(`  eth_getTransactionByHash returns pending? ${viaHash ? "yes" : "no"} (blockNumber=${viaHash?.blockNumber ?? "n/a"})`);
  }
  console.log("");
}

main().then(() => process.exit(0));
