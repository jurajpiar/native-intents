/**
 * Toy solver. Watches a node's mempool for intent transactions and "solves" them.
 *
 * Milestone 1 is mempool-only: the intent is never mined, so solving = a paid tx that calls the
 * registry's consume(H). A real solver would first request the payload off-chain (the reveal), then
 * simulate & price the pipeline, then deliver >= minOut atomically with the consume. Those steps are
 * stubbed here — this solver just consumes, which is enough to exercise the pre-inclusion claims and
 * the replay/griefing experiments. See README.
 */
import { JsonRpcProvider, Network, Wallet } from "ethers";
import { Rpc, TxRpc } from "./client.js";
import { consumeCalldata } from "./intent.js";
import { CHAIN_ID, COW_KEY, REGISTRY_ADDR } from "./config.js";

export function isIntentTx(tx: TxRpc): boolean {
  if (tx.type === "0x0249") return true;                       // RSK namespace 0x02||0x49
  // fallback: addressed to the registry with a 128-byte data field
  return tx.to?.toLowerCase() === REGISTRY_ADDR.toLowerCase() && (tx.input.length - 2) / 2 === 128;
}

export function intentH(tx: TxRpc): string {
  return "0x" + tx.input.slice(2, 2 + 64); // first 32 bytes of data
}

export class Solver {
  readonly rpc: Rpc;
  private provider: JsonRpcProvider;
  private wallet: Wallet;

  constructor(rpcUrl: string, payerKey: string = COW_KEY) {
    this.rpc = new Rpc(rpcUrl);
    this.provider = new JsonRpcProvider(rpcUrl, new Network("rsk-regtest", CHAIN_ID), { staticNetwork: true });
    this.wallet = new Wallet(payerKey, this.provider);
  }

  /** Consume one intent hash H. Returns the solver tx hash. */
  async consume(H: string): Promise<string> {
    const tx = await this.wallet.sendTransaction({
      to: REGISTRY_ADDR,
      data: consumeCalldata(new Uint8Array(Buffer.from(H.slice(2), "hex"))),
      gasLimit: 200_000,
      // MUST be non-zero. rskj's Type0 encoder serialises gasPrice 0 as a raw 0x00 byte
      // (RLP.encodeCoinNonNullZero), while ethers serialises it as 0x80 (empty). With gasPrice 0
      // the node recomputes a different signing hash and recovers the WRONG sender ("account
      // doesn't exist"). Any positive value makes both encoders agree — and a solver pays a fee.
      gasPrice: 1_000_000,
      type: 0,
      chainId: CHAIN_ID,
    });
    return tx.hash;
  }

  /** One pass: find intents in the mempool and consume each unseen H. Returns the H's it acted on. */
  async solveOnce(seen = new Set<string>()): Promise<string[]> {
    const acted: string[] = [];
    for (const tx of await this.rpc.pendingTxs()) {
      if (!isIntentTx(tx)) continue;
      const H = intentH(tx);
      if (seen.has(H)) continue;
      seen.add(H);
      // reveal(payload) + simulate(price, minOut) would go here.
      await this.consume(H);
      acted.push(H);
    }
    return acted;
  }
}
