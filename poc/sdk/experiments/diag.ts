/**
 * One-shot diagnostic. Prints the node facts the experiments depend on, so we can see exactly why
 * something failed instead of guessing. Run: npm run diag
 */
import { Interface } from "ethers";
import { Rpc } from "../src/client.js";
import { buildIntent, freshWallet, randomH } from "../src/intent.js";
import { RPC_A, REGISTRY_ADDR, SETTLEMENT_ADDR, CONSUMED_SET_ADDR, cowWallet } from "../src/config.js";
import { isIntentTx } from "../src/solver.js";
import settlementAbi from "../src/abi/Settlement.json" with { type: "json" };
import { preflight } from "./_harness.js";

/**
 * Ask Settlement what it sees when it calls the consumed-set precompile.
 *
 * Probing 0x…24 with eth_call directly cannot answer this: a MISSING precompile and a THROWING one
 * both come back as `0x`, which cost a diagnosis round. From inside the contract the low-level
 * staticcall's success flag and return length separate all three cases.
 */
async function probeConsumedSet(rpc: Rpc): Promise<void> {
  const iface = new Interface(settlementAbi as import("ethers").InterfaceAbi);
  console.log(`consumed set ${CONSUMED_SET_ADDR}`);
  if (!iface.hasFunction("consumedSetProbe")) {
    console.log(`  (this Settlement build has no consumedSetProbe — recompile to include it)`);
    return;
  }
  const data = iface.encodeFunctionData("consumedSetProbe", ["0x" + "aa".repeat(32)]);
  try {
    const out = await rpc.ethCall(SETTLEMENT_ADDR, data);
    const [ok, len, value] = iface.decodeFunctionResult("consumedSetProbe", out);
    const verdict = ok && len === 32n ? "REGISTERED and answering ✓"
      : !ok ? "registered but it REJECTED the call — execute()/init() is throwing"
      : "NOT REGISTERED at this address — getContractForAddress returned null";
    console.log(`  staticcall        ok=${ok} len=${len} value=${value}`);
    console.log(`  verdict           ${verdict}`);
  } catch (e) {
    console.log(`  probe FAILED      ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  const rpc = new Rpc(RPC_A);
  // Waits for the node to answer AND for the intent rule to activate, so this can be run straight
  // after `stack:reset` without a hand-rolled polling loop.
  await preflight(rpc);
  console.log(`\n=== node diagnostic (${RPC_A}) ===`);

  const height = await rpc.blockNumber();
  console.log(`block height        ${height}`);

  const cow = cowWallet().address;
  const cowBal = BigInt(await rpc.getBalance(cow));
  console.log(`cow ${cow}`);
  console.log(`  balance           ${cowBal}  ${cowBal > 0n ? "(funded ✓)" : "(NOT FUNDED — genesis/rsk-dev.json not loaded)"}`);
  console.log(`  nonce             ${await rpc.txCount(cow)}`);

  const regCode = await rpc.getCode(REGISTRY_ADDR).catch((e) => `error: ${(e as Error).message}`);
  console.log(`parse precompile ${REGISTRY_ADDR}`);
  console.log(`  eth_getCode       ${regCode === "0x" ? "0x (precompiles have no code — expected)" : regCode}`);

  const settleCode = await rpc.getCode(SETTLEMENT_ADDR).catch((e) => `error: ${(e as Error).message}`);
  const settleLen = settleCode.startsWith("0x") ? (settleCode.length - 2) / 2 : 0;
  console.log(`settlement ${SETTLEMENT_ADDR}`);
  console.log(`  eth_getCode       ${settleLen} bytes  ${settleLen > 0 ? "(deployed ✓)" : "(NOT DEPLOYED — recreate with `down -v` to apply the m3 genesis)"}`);

  await probeConsumedSet(rpc);

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
