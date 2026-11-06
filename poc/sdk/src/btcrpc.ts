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

/**
 * The data payload of an exit payout's SETTLER COMMITMENT: "RSKX" || 20-byte RSK address. bitcoind
 * wraps it as OP_RETURN PUSH24 <payload>, which is the 26-byte scriptPubKey Settlement looks for.
 */
export function settlerCommitmentData(rskAddress: string): string {
  return "52534b58" + rskAddress.replace(/^0x/, "").toLowerCase().padStart(40, "0").slice(-40);
}

/** The full scriptPubKey of that commitment, for callers hand-serialising a payout. */
export function settlerCommitmentScript(rskAddress: string): string {
  return "6a18" + settlerCommitmentData(rskAddress);
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
  /** Verbose decode: vout scripts (OP_RETURN asm) + confirmations (absent/0 = still in the mempool). */
  getRawTransactionVerbose = (txid: string) =>
    this.rpc<{ confirmations?: number; vout: { scriptPubKey: { asm: string; hex: string } }[] }>(
      "getrawtransaction", [txid, true], false);
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

  /** unspent outputs, optionally filtered to specific addresses (0-conf included) */
  listUnspent = (addresses?: string[]) =>
    this.rpc<{ txid: string; vout: number; address: string; amount: number; spendable: boolean }[]>(
      "listunspent", [0, 9999999, addresses ?? []], true);
  /** UTXO-set scan for an arbitrary (non-wallet) address — e.g. the federation's peg address */
  scanTxOutSet = (addr: string) =>
    this.rpc<{ total_amount: number }>("scantxoutset", ["start", [`addr(${addr})`]], false);
  /** address info (node-level): scriptPubKey hex etc. — used to extract a legacy address's hash160 */
  validateAddress = (addr: string) =>
    this.rpc<{ isvalid: boolean; scriptPubKey: string }>("validateaddress", [addr], false);

  /** hash160 (0x…, 20 bytes) of a LEGACY P2PKH address, via its canonical scriptPubKey 76a914<h160>88ac */
  async hash160Of(addr: string): Promise<string> {
    const v = await this.validateAddress(addr);
    if (!v.isvalid || !v.scriptPubKey?.startsWith("76a914") || !v.scriptPubKey.endsWith("88ac")) {
      throw new Error(`not a legacy P2PKH address: ${addr}`);
    }
    return "0x" + v.scriptPubKey.slice(6, 46);
  }

  // raw-tx flow, for building a peg-in with an OP_RETURN destination (RSKIP170 v1)
  createRawTransaction = (outputs: Record<string, unknown>[], inputs: { txid: string; vout: number }[] = []) =>
    this.rpc<string>("createrawtransaction", [inputs, outputs], false);
  fundRawTransaction = (hex: string) =>
    this.rpc<{ hex: string; fee: number; changepos: number }>("fundrawtransaction", [hex], true);
  signRawTransactionWithWallet = (hex: string) =>
    this.rpc<{ hex: string; complete: boolean }>("signrawtransactionwithwallet", [hex], true);
  sendRawTransactionBtc = (hex: string) => this.rpc<string>("sendrawtransaction", [hex], false);

  /**
   * Build, fund, sign and broadcast a peg-in that credits an RSK contract via an RSKIP170 v1 OP_RETURN.
   * Output 1: `amountBtc` to the federation address. Output 2: OP_RETURN "RSKT" || 0x01 || 20-byte RSK addr.
   * Returns the peg-in txid.
   */
  async peginToRskAddress(federationAddr: string, rskAddr20Hex: string, amountBtc: number): Promise<string> {
    const addr = rskAddr20Hex.replace(/^0x/, "").toLowerCase().padStart(40, "0").slice(-40);
    const opReturnHex = "52534b54" + "01" + addr; // "RSKT" + version 1 + 20-byte RSK destination = 25 bytes
    const raw = await this.createRawTransaction([{ [federationAddr]: amountBtc }, { data: opReturnHex }]);
    const funded = await this.fundRawTransaction(raw);
    const signed = await this.signRawTransactionWithWallet(funded.hex);
    if (!signed.complete) throw new Error("peg-in tx not fully signed");
    return this.sendRawTransactionBtc(signed.hex);
  }

  /**
   * Like peginToRskAddress, but coin-controlled: spends ONLY UTXOs held by `fromAddress`, with change
   * returned there — so the send is visibly THAT user's BTC moving (playground uses this so per-user
   * BTC balances tell the true story). Flat fee; change below dust is folded into the fee.
   */
  async peginFromAddress(federationAddr: string, rskAddr20Hex: string, amountBtc: number, fromAddress: string, extraDataHex = ""): Promise<string> {
    const FEE = 0.0002, DUST = 0.00001;
    const utxos = (await this.listUnspent([fromAddress])).filter((u) => u.spendable);
    const inputs: { txid: string; vout: number }[] = [];
    let inSum = 0;
    for (const u of utxos) { inputs.push({ txid: u.txid, vout: u.vout }); inSum += u.amount; if (inSum >= amountBtc + FEE) break; }
    if (inSum < amountBtc + FEE) throw new Error(`insufficient BTC at ${fromAddress}: have ${inSum}, need ${amountBtc + FEE}`);
    const addr = rskAddr20Hex.replace(/^0x/, "").toLowerCase().padStart(40, "0").slice(-40);
    // extraDataHex (e.g. the intent's 32-byte H) rides in the SAME OP_RETURN after the RSKIP170 v1
    // payload: 25 + 32 = 57 bytes, well under the 80-byte relay default. NOTE: trailing data makes the
    // payload non-parseable as strict RSKIP170 v1 — fine for the playground, where the RSK-side credit
    // is modelled via depositForPegin; drop it where real SPV registration must succeed (E14).
    const outputs: Record<string, unknown>[] = [
      { [federationAddr]: Number(amountBtc.toFixed(8)) },
      { data: "52534b54" + "01" + addr + extraDataHex.replace(/^0x/, "").toLowerCase() },
    ];
    const change = inSum - amountBtc - FEE;
    if (change > DUST) outputs.push({ [fromAddress]: Number(change.toFixed(8)) });
    const raw = await this.createRawTransaction(outputs, inputs);
    const signed = await this.signRawTransactionWithWallet(raw);
    if (!signed.complete) throw new Error("peg-in tx not fully signed");
    return this.sendRawTransactionBtc(signed.hex);
  }

  /**
   * Exit-leg payout (E19): a coin-controlled plain send — `amountBtc` from `fromAddress`'s UTXOs to
   * `toAddress`, change back to `fromAddress`. LEGACY inputs/outputs only (the settlement contract's
   * payout parser handles non-segwit P2PKH). Returns { txid, rawHex } — the raw bytes are what the
   * contract parses and double-sha256s.
   */
  async payToAddress(fromAddress: string, toAddress: string, amountBtc: number, settler?: string): Promise<{ txid: string; rawHex: string }> {
    const FEE = 0.0002, DUST = 0.00001;
    const utxos = (await this.listUnspent([fromAddress])).filter((u) => u.spendable);
    const inputs: { txid: string; vout: number }[] = [];
    let inSum = 0;
    for (const u of utxos) { inputs.push({ txid: u.txid, vout: u.vout }); inSum += u.amount; if (inSum >= amountBtc + FEE) break; }
    if (inSum < amountBtc + FEE) throw new Error(`insufficient BTC at ${fromAddress}: have ${inSum}, need ${amountBtc + FEE}`);
    const outputs: Record<string, unknown>[] = [{ [toAddress]: Number(amountBtc.toFixed(8)) }];
    // settler commitment (required by settleBtcOut): OP_RETURN "RSKX" || 20-byte RSK address.
    // Without it the payout is a bearer proof anyone could replay against their own intent.
    if (settler) outputs.push({ data: settlerCommitmentData(settler) });
    const change = inSum - amountBtc - FEE;
    if (change > DUST) outputs.push({ [fromAddress]: Number(change.toFixed(8)) });
    const raw = await this.createRawTransaction(outputs, inputs);
    const signed = await this.signRawTransactionWithWallet(raw);
    if (!signed.complete) throw new Error("payout tx not fully signed");
    const txid = await this.sendRawTransactionBtc(signed.hex);
    return { txid, rawHex: signed.hex };
  }
}
