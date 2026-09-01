/**
 * Thin helpers over the RSK Bridge precompile for the peg-in driver.
 * Reads go via eth_call; state changes (receiveHeader, registerBtcTransaction) are sent from a funded
 * account. All three write/read methods used here are public on regtest (all forks active).
 */
import { Interface, JsonRpcProvider, Network, Wallet, getBytes } from "ethers";
import { Rpc } from "./client.js";
import { BRIDGE_ADDR, CHAIN_ID, COW_KEY } from "./config.js";

const iface = new Interface([
  "function getFederationAddress() view returns (string)",
  "function getBtcBlockchainBestChainHeight() view returns (int256)",
  "function getBtcTxHashProcessedHeight(string hash) view returns (int64)",
  "function getPeginInfo(bytes32 btcTxid) view returns (bytes)",
  "function receiveHeader(bytes header) returns (int256)",
  "function registerBtcTransaction(bytes txBytes, int256 height, bytes pmt)",
]);

export class Bridge {
  private provider: JsonRpcProvider;
  private wallet: Wallet;
  constructor(private rpc: Rpc, payerKey: string = COW_KEY) {
    this.provider = new JsonRpcProvider(rpc.url, new Network("rsk-regtest", CHAIN_ID), { staticNetwork: true });
    this.wallet = new Wallet(payerKey, this.provider);
  }

  private async callRead<T>(fn: string, args: unknown[] = []): Promise<T> {
    const out = await this.rpc.ethCall(BRIDGE_ADDR, iface.encodeFunctionData(fn, args));
    return iface.decodeFunctionResult(fn, out)[0] as T;
  }

  getFederationAddress = () => this.callRead<string>("getFederationAddress");
  bestChainHeight = async () => Number(await this.callRead<bigint>("getBtcBlockchainBestChainHeight"));

  /** Real peg-in (destination, amount) recorded by the Bridge for a btc txid, or null if none/unavailable. */
  async getPeginInfo(btcTxidHex: string): Promise<{ dest: string; amount: bigint } | null> {
    const raw = await this.rpc.ethCall(BRIDGE_ADDR, iface.encodeFunctionData("getPeginInfo", [btcTxidHex])).catch(() => "0x");
    if (!raw || raw === "0x") return null; // method not in this build (rebuild to A?), or no record
    let infoHex: string;
    try { infoHex = iface.decodeFunctionResult("getPeginInfo", raw)[0] as string; } catch { return null; }
    if (getBytes(infoHex).length !== 64) return null;
    return { dest: "0x" + infoHex.slice(2 + 24, 2 + 64), amount: BigInt("0x" + infoHex.slice(2 + 64)) };
  }
  /** -1 if the btc txid has not been processed as a peg-in */
  processedHeight = async (txidBigEndianHex: string) =>
    Number(await this.callRead<bigint>("getBtcTxHashProcessedHeight", [txidBigEndianHex]));

  private async send(fn: string, args: unknown[]): Promise<string> {
    const tx = await this.wallet.sendTransaction({
      to: BRIDGE_ADDR,
      data: iface.encodeFunctionData(fn, args),
      gasLimit: 500_000,
      gasPrice: 1_000_000,
      type: 0,
      chainId: CHAIN_ID,
    });
    return tx.hash;
  }

  /** relay one 80-byte BTC header (hex, with or without 0x). Returns solver tx hash. */
  receiveHeader = (headerHex: string) => this.send("receiveHeader", [getBytes(headerHex.startsWith("0x") ? headerHex : "0x" + headerHex)]);

  /** register a peg-in: raw btc tx, its block height, and the partial-merkle-tree proof. */
  registerBtcTransaction = (txHex: string, height: number, pmtHex: string) =>
    this.send("registerBtcTransaction", [
      getBytes(txHex.startsWith("0x") ? txHex : "0x" + txHex),
      height,
      getBytes(pmtHex.startsWith("0x") ? pmtHex : "0x" + pmtHex),
    ]);
}
