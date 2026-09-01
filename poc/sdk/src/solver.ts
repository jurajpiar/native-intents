/**
 * Toy solver (milestone 3). Settles intents through the settlement contract, which delivers the output
 * (RBTC or ERC-20) and records H atomically — and reverts visibly on failure (unlike the m1/m2 raw
 * precompile). A real solver would fetch the payload off-chain, simulate, and price first; here it just
 * settles, which is enough to exercise settlement, the closed grief vector, and token delivery.
 */
import { Contract, JsonRpcProvider, Network, Wallet } from "ethers";
import settlementAbi from "./abi/Settlement.json" with { type: "json" };
import { Rpc, TxRpc } from "./client.js";
import { CHAIN_ID, COW_KEY, SETTLEMENT_ADDR } from "./config.js";

export function isIntentTx(tx: TxRpc): boolean {
  if (tx.type === "0x0249") return true;                       // RSK namespace 0x02||0x49
  return tx.to?.toLowerCase() === SETTLEMENT_ADDR.toLowerCase() && (tx.input.length - 2) / 2 === 160;
}

export function intentH(tx: TxRpc): string {
  return "0x" + tx.input.slice(2, 2 + 64); // first 32 bytes of data
}

export class Solver {
  readonly rpc: Rpc;
  private provider: JsonRpcProvider;
  private wallet: Wallet;
  private settlement: Contract;

  constructor(rpcUrl: string, payerKey: string = COW_KEY) {
    this.rpc = new Rpc(rpcUrl);
    this.provider = new JsonRpcProvider(rpcUrl, new Network("rsk-regtest", CHAIN_ID), { staticNetwork: true });
    this.wallet = new Wallet(payerKey, this.provider);
    this.settlement = new Contract(SETTLEMENT_ADDR, settlementAbi as import("ethers").InterfaceAbi, this.wallet);
  }

  get payer(): string {
    return this.wallet.address;
  }

  /**
   * Settle an intent atomically. For RBTC output, pass valueWei = minOut (the contract forwards it and
   * refunds any excess). For an ERC-20 output, pass 0 after the solver has approved the settlement
   * contract for minOut of the token. Returns the settle tx hash.
   */
  async solve(rawIntentTxHex: string, valueWei: bigint = 0n): Promise<string> {
    const tx = await this.settlement.settle(rawIntentTxHex, {
      value: valueWei,
      gasLimit: 600_000,
      gasPrice: 1_000_000, // non-zero: rskj encodes zero gasPrice differently (see README)
      type: 0,
      chainId: CHAIN_ID,
    });
    return tx.hash;
  }
}
