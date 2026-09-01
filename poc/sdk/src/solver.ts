/**
 * Toy solver (milestone 2). Watches the mempool for intents and settles them atomically.
 *
 * m2 settlement is a single EVM-atomic transaction: the solver submits solve(rawIntentTx) to the
 * registry precompile, which delivers >= minOut to the user and records H consumed — or reverts,
 * leaving H unconsumed and the solver out only the gas. A real solver would first fetch the payload
 * off-chain (the reveal), simulate, and price it; here it just settles, which is enough to exercise
 * atomic settlement and the closed grief vector. See README.
 */
import { JsonRpcProvider, Network, Wallet } from "ethers";
import { Rpc, TxRpc } from "./client.js";
import { solveCalldata } from "./intent.js";
import { CHAIN_ID, COW_KEY, REGISTRY_ADDR } from "./config.js";

export function isIntentTx(tx: TxRpc): boolean {
  if (tx.type === "0x0249") return true;                       // RSK namespace 0x02||0x49
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

  get payer(): string {
    return this.wallet.address;
  }

  /**
   * Atomically settle an intent: deliver >= minOut to the user and consume H.
   * @param rawIntentTxHex the intent's signed wire bytes (BuiltIntent.rawHex) — what the solver saw in the mempool
   * @returns the solver tx hash
   */
  async solve(rawIntentTxHex: string): Promise<string> {
    const tx = await this.wallet.sendTransaction({
      to: REGISTRY_ADDR,
      data: solveCalldata(rawIntentTxHex),
      gasLimit: 500_000,
      gasPrice: 1_000_000, // non-zero: see the RLP-canonicalisation note in the README
      type: 0,
      chainId: CHAIN_ID,
      value: 0,            // delivery is moved solver->user inside the precompile, not via tx value
    });
    return tx.hash;
  }
}
