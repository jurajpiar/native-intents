/**
 * Thin helpers over the RSK Bridge precompile for the peg-in driver.
 * Reads go via eth_call; state changes (receiveHeader, registerBtcTransaction) are sent from a funded
 * account. All three write/read methods used here are public on regtest (all forks active).
 */
import { Interface, JsonRpcProvider, Network, NonceManager, Wallet, getBytes } from "ethers";
import { Rpc, waitFor } from "./client.js";
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
  private signer: NonceManager;
  constructor(private rpc: Rpc, payerKey: string = COW_KEY) {
    this.provider = new JsonRpcProvider(rpc.url, new Network("rsk-regtest", CHAIN_ID), { staticNetwork: true });
    // NonceManager tracks the nonce LOCALLY across sends: header relays batch-send many txs without
    // waiting for receipts, and rskj's pending count does not reflect a just-submitted tx quickly
    // enough — two provider-fetched nonces collide and rskj rejects the second with -32010
    // ("gas price not enough to bump transaction", i.e. an underpriced same-nonce replacement).
    this.signer = new NonceManager(new Wallet(payerKey, this.provider));
  }

  /**
   * Re-sync the local nonce with the chain. Call at the START of a batch if this key has sent
   * transactions through OTHER signers since the last batch (the local count would be stale).
   */
  resetNonce(): void {
    this.signer.reset();
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
    const tx = await this.signer.sendTransaction({
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

/** The slice of a BTC client syncHeadersTo needs — structural, so bridge.ts stays free of btcrpc. */
export interface HeaderSource {
  getBlockHash(height: number): Promise<string>;
  getBlockHeaderRaw(hash: string): Promise<string>;
}

/**
 * Bring the Bridge's SPV view up to `target` BTC height, relaying headers in CHUNKS and draining
 * each chunk before queuing the next.
 *
 * The obvious implementation batch-sends the whole backlog on one nonce run and waits for the last
 * receipt. That works for the two or three headers a warm chain needs, which is why it survived, but
 * not for the ~100 a fresh bitcoind needs: rskj's pool rejects a transaction whose nonce is more than
 * roughly twenty ahead of the account's mined one (-32010 "transaction nonce too high"), so the batch
 * dies mid-relay and the caller is left with a half-synced Bridge. Every caller in the repo shares
 * this helper so the fix cannot drift back apart.
 *
 * Call it BEFORE the intent under test exists: on a fresh chain the relay burns ~100 RSK blocks, and
 * inside an intent's lifetime that expires it (the mistake E19's header comment records).
 */
export async function syncHeadersTo(
  rpc: Rpc, bridge: Bridge, btc: HeaderSource, target: number,
  opts: { chunk?: number; timeoutMs?: number; onChunk?: (to: number) => void } = {},
): Promise<void> {
  const chunk = opts.chunk ?? 10;
  const timeoutMs = opts.timeoutMs ?? 60000;
  for (;;) {
    const from = await bridge.bestChainHeight();
    if (from >= target) return;
    const to = Math.min(from + chunk, target);
    bridge.resetNonce(); // this key signs through other paths between chunks — re-sync each time
    let last: string | null = null;
    for (let h = from + 1; h <= to; h++) {
      last = await bridge.receiveHeader(await btc.getBlockHeaderRaw(await btc.getBlockHash(h)));
    }
    if (!last) return;
    await waitFor(async () => {
      const r = await rpc.getReceipt(last as string).catch(() => null);
      return r !== null && r.blockNumber !== null;
    }, timeoutMs, 500);
    // A silent stall here is worse than a throw: the caller would go on to build a proof the Bridge
    // cannot verify, and fail on "btc payout not confirmed" far from the real cause.
    if ((await bridge.bestChainHeight()) <= from) throw new Error(`header relay stalled at btc height ${from} (target ${target})`);
    opts.onChunk?.(to);
  }
}
