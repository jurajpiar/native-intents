/** Settlement contract helpers for the fee mechanics (m4): model the peg-in credit and read the escrow. */
import { Contract, JsonRpcProvider, Network, Wallet } from "ethers";
import settlementAbi from "./abi/Settlement.json" with { type: "json" };
import { CHAIN_ID, COW_KEY, SETTLEMENT_ADDR } from "./config.js";

function contract(rpcUrl: string, key: string = COW_KEY): Contract {
  const provider = new JsonRpcProvider(rpcUrl, new Network("rsk-regtest", CHAIN_ID), { staticNetwork: true });
  return new Contract(SETTLEMENT_ADDR, settlementAbi as import("ethers").InterfaceAbi, new Wallet(key, provider));
}

/** Model the peg-in: escrow `valueWei` of input RBTC against a BTC txid. Returns the tx hash. */
export async function depositForPegin(rpcUrl: string, btcTxidHex: string, valueWei: bigint, key: string = COW_KEY): Promise<string> {
  const s = contract(rpcUrl, key);
  const tx = await s.depositForPegin(btcTxidHex, { value: valueWei, gasLimit: 200_000, gasPrice: 1_000_000, type: 0, chainId: CHAIN_ID });
  return tx.hash;
}

/** Read the escrowed input for a BTC txid. */
export async function peginOf(rpcUrl: string, btcTxidHex: string): Promise<bigint> {
  return contract(rpcUrl).pegin(btcTxidHex);
}
