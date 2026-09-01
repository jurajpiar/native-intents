/**
 * Minimal bitcoind JSON-RPC client for the peg-in driver (regtest). Node 22 global fetch + basic auth.
 * Wallet calls are routed to /wallet/<name>.
 */
export interface BtcRpcOpts {
  url?: string;   // default http://localhost:18443
  user?: string;  // default rsk
  pass?: string;  // default rsk
  wallet?: string; // default "poc"
}

export class BtcRpc {
  private id = 1;
  readonly base: string;
  readonly auth: string;
  readonly wallet: string;

  constructor(o: BtcRpcOpts = {}) {
    this.base = o.url ?? process.env.BTC_RPC ?? "http://localhost:18443";
    this.auth = "Basic " + Buffer.from(`${o.user ?? "rsk"}:${o.pass ?? "rsk"}`).toString("base64");
    this.wallet = o.wallet ?? "poc";
  }

  private async rpc<T>(method: string, params: unknown[], useWallet: boolean): Promise<T> {
    const url = useWallet ? `${this.base}/wallet/${this.wallet}` : this.base;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: this.auth },
      body: JSON.stringify({ jsonrpc: "1.0", id: this.id++, method, params }),
    });
    const json = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (json.error) throw new Error(`bitcoind ${method}: ${json.error.message} (code ${json.error.code})`);
    return json.result as T;
  }

  // node-level
  getBlockCount = () => this.rpc<number>("getblockcount", [], false);
  getBlockHash = (height: number) => this.rpc<string>("getblockhash", [height], false);
  /** 80-byte header hex (verbose=false) */
  getBlockHeaderRaw = (hash: string) => this.rpc<string>("getblockheader", [hash, false], false);
  getRawTransaction = (txid: string) => this.rpc<string>("getrawtransaction", [txid, false], false);
  /** serialized merkleblock (80-byte header + partial merkle tree) */
  getTxOutProof = (txids: string[]) => this.rpc<string>("gettxoutproof", [txids], false);

  // wallet-level
  async ensureWallet(): Promise<void> {
    try { await this.rpc("createwallet", [this.wallet], false); }
    catch { try { await this.rpc("loadwallet", [this.wallet], false); } catch { /* already loaded */ } }
  }
  getNewAddress = (label = "", type: "legacy" | "bech32" | "p2sh-segwit" = "legacy") =>
    this.rpc<string>("getnewaddress", [label, type], true);
  generateToAddress = (n: number, addr: string) => this.rpc<string[]>("generatetoaddress", [n, addr], true);
  sendToAddress = (addr: string, amountBtc: number) => this.rpc<string>("sendtoaddress", [addr, amountBtc], true);
  getBalance = () => this.rpc<number>("getbalance", [], true);
}
