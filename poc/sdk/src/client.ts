/** Minimal JSON-RPC client (Node 22 global fetch). Kept tiny and explicit so experiments read clearly. */

export class RpcError extends Error {
  /** `data` carries rskj's ABI-encoded revert payload on eth_call failures (Error(string), 0x08c379a0…). */
  constructor(public code: number, message: string, public data?: string) { super(message); }
}

export class Rpc {
  private id = 1;
  constructor(public url: string) {}

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.id++, method, params }),
    });
    const json = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: string } };
    if (json.error) throw new RpcError(json.error.code, json.error.message, json.error.data);
    return json.result as T;
  }

  blockNumber = async (): Promise<number> => parseInt(await this.call<string>("eth_blockNumber"), 16);
  getBalance = (addr: string): Promise<string> => this.call<string>("eth_getBalance", [addr, "latest"]);
  getCode = (addr: string): Promise<string> => this.call<string>("eth_getCode", [addr, "latest"]);
  txCount = async (addr: string): Promise<number> => parseInt(await this.call<string>("eth_getTransactionCount", [addr, "latest"]), 16);
  sendRaw = (rawHex: string): Promise<string> => this.call<string>("eth_sendRawTransaction", [rawHex]);
  ethCall = (to: string, data: string): Promise<string> => this.call<string>("eth_call", [{ to, data }, "latest"]);
  getTx = (hash: string): Promise<TxRpc | null> => this.call<TxRpc | null>("eth_getTransactionByHash", [hash]);
  getReceipt = (hash: string): Promise<Receipt | null> => this.call<Receipt | null>("eth_getTransactionReceipt", [hash]);
  peerCount = async (): Promise<number> => parseInt(await this.call<string>("net_peerCount"), 16);
  // needed to rebuild an intent's EIP-155 v: the JSON view of a typed tx reports yParity and omits
  // chainId entirely, so the chain id has to be asked for separately (see src/reconstruct.ts).
  chainId = async (): Promise<number> => parseInt(await this.call<string>("eth_chainId"), 16);
  // evm_snapshot/evm_revert: roll the chain + state back to a prior height — used to model a reorg
  snapshot = (): Promise<string> => this.call<string>("evm_snapshot");
  revert = (id: string): Promise<boolean> => this.call<boolean>("evm_revert", [id]);

  /** rskj txpool_content -> { pending: {addr: {nonce: [tx,...]}}, queued: {...} } (nonce maps to a LIST) */
  async pendingTxs(): Promise<TxRpc[]> {
    const content = await this.call<TxPoolContent>("txpool_content");
    const out: TxRpc[] = [];
    for (const byNonce of Object.values(content.pending ?? {})) {
      for (const list of Object.values(byNonce)) {
        for (const tx of list ?? []) {
          if (tx && tx.hash) out.push(tx);
        }
      }
    }
    return out;
  }
}

/**
 * A node's JSON view of a transaction. The optional fields are optional for a real reason: the two
 * RPCs that return this shape do NOT return the same fields.
 *
 *   eth_getTransactionByHash  (TransactionResultDTO)  — everything below, including type and v/r/s,
 *                                                       and it answers for PENDING txs too.
 *   txpool_content            (fullSerializer)        — no `type`, no `v`/`r`/`s`.
 *
 * So a pool listing cannot be re-encoded into signed bytes on its own. See src/reconstruct.ts.
 */
export interface TxRpc {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  type?: string;   // "0x0249" for RSK-namespace intents — ABSENT from txpool_content
  nonce: string;
  blockNumber: string | null;
  gas?: string;
  gasPrice?: string;
  value?: string;
  v?: string;      // absent from txpool_content
  r?: string;      // absent from txpool_content
  s?: string;      // absent from txpool_content
}
export interface Receipt { status: string; blockNumber: string | null; gasUsed?: string; }
interface TxPoolContent {
  pending?: Record<string, Record<string, TxRpc[]>>;
  queued?: Record<string, Record<string, TxRpc[]>>;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** poll until predicate true or timeout; returns whether it succeeded */
export async function waitFor(pred: () => Promise<boolean>, timeoutMs = 20000, everyMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await sleep(everyMs);
  }
  return false;
}
