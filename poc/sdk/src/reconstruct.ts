/**
 * Rebuild the signed bytes of a native-intent transaction from what a node will tell you ABOUT it.
 *
 * WHY THIS HAS TO EXIST. The whole case for a mempool-only transaction type is that a solver can find
 * work in the public pool rather than being handed it by the user. `settle` takes the raw signed
 * envelope as calldata, so a solver that discovers an intent needs those exact bytes back. rskj has no
 * `eth_getRawTransactionByHash` (checked against the clone in ../../rskj — the method does not exist),
 * so "get the bytes" means "re-encode them from the JSON view". If that is impossible, discovery over
 * JSON-RPC is impossible, and the design's central claim rests on a p2p-level solver nobody has built.
 *
 * WHAT THE TWO RPCs ACTUALLY GIVE YOU — they are not the same, and the difference matters:
 *
 *   txpool_content   TxPoolModuleImpl.fullSerializer: blockHash, blockNumber, transactionIndex, from,
 *                    gas, gasPrice, hash, input, nonce, to, value.
 *                    NO `type`, and NO `v`/`r`/`s`. You cannot reconstruct from this alone.
 *   eth_getTx…Hash   TransactionResultDTO: adds `type` (0x0249) and `v`, `r`, `s`, and falls back to
 *                    the pending list when the tx is not mined (Web3Impl:798-806), so it answers for a
 *                    pool entry. This is the one that carries a signature.
 *
 * So discovery is a TWO-STEP: list the pool, then fetch each candidate by hash. `isIntentTx`'s
 * `type === "0x0249"` fast path cannot fire on a pool listing, because that serializer omits `type`
 * entirely — the 160-byte-to-Settlement fallback is doing all the work there. That is load-bearing by
 * accident, which is worth knowing.
 *
 * THE V FIELD DOES NOT ROUND-TRIP, AND THIS COST E24 ITS FIRST RUN. The envelope signs an EIP-155 v
 * (yParity + chainId*2 + 35, per Type2RSKTransactionEncoder), but the JSON view reports yParity:
 *
 *     Transaction.getEncodedV()  ->  if (typePrefix.type().isTyped()) return signature.getV() - 27
 *
 * which is correct EIP-2718 behaviour and still lossy here, because the RSK namespace puts the
 * EIP-155 value on the wire. Worse, TransactionResultDTO populates `chainId` only for TYPE_1 and
 * STANDARD Type 2 (`isType1OrStandardType2`), so the view drops the one number needed to rebuild what
 * it just downgraded. A solver therefore has to pair the parity with `eth_chainId` — obtainable, but
 * an extra dependency nobody had written down.
 *
 * HOW THE RESULT IS VERIFIED WITHOUT THE ORIGINAL. The RSK tx hash is keccak256 of the signed bytes.
 * So a reconstruction that hashes to the hash the node advertised is byte-exact, and the check needs
 * nothing from whoever built the intent. `reconstructIntentRaw` performs it and throws on mismatch —
 * a solver must never hand `settle` bytes it cannot prove are the ones that were signed. It is also
 * what makes recovering v safe: the parity is combined with a chain id and the hash either confirms
 * the pair or rejects it, so nothing is guessed into calldata.
 */
import { keccak256 } from "ethers";
import {
  cat, encAddress, encByte, encData, encElem, encGasLimit, encGasPrice, encList, encNonce, encValue,
  minimalBE,
} from "./rlp.js";
import { CHAIN_ID, INTENT_SUBTYPE, INTENT_DATA_LEN, SETTLEMENT_ADDR } from "./config.js";
import { getBytes } from "ethers";

const PREFIX = new Uint8Array([0x02, INTENT_SUBTYPE]);

/** The fields of `eth_getTransactionByHash` this needs. Everything is a JSON quantity/data hex. */
export interface SignedTxView {
  hash: string;
  to: string | null;
  input: string;
  nonce: string;
  gas?: string;
  gasPrice?: string;
  value?: string;
  v?: string;
  r?: string;
  s?: string;
  type?: string;
}

export class ReconstructionError extends Error {}

/**
 * Turn whatever the node put in `v` back into the EIP-155 value the envelope was signed with.
 *
 * A typed transaction reports yParity (0 or 1) — see getEncodedV above — so the chain id has to come
 * back from somewhere else, in practice `eth_chainId`. A legacy-shaped v (>= 35) is passed through
 * unchanged so this stays correct if rskj ever reports the encoded value here. Anything else is a
 * refusal rather than a repair: the hash check downstream would catch it, but failing at the field
 * that is actually wrong gives a far better error than "bytes do not hash".
 */
export function eip155V(reported: bigint, chainId: number): number {
  if (reported === 0n || reported === 1n) return Number(reported) + chainId * 2 + 35;
  if (reported >= 35n) return Number(reported);
  throw new ReconstructionError(
    `v=${reported} is neither a yParity bit nor an EIP-155 v (expected 0, 1, ` +
    `${chainId * 2 + 35} or ${chainId * 2 + 36} for chainId ${chainId})`);
}

/** Which fields a view is missing for reconstruction — empty means it has everything. */
export function missingForReconstruction(tx: SignedTxView): string[] {
  const need: (keyof SignedTxView)[] = ["nonce", "gas", "gasPrice", "value", "input", "to", "v", "r", "s"];
  return need.filter((k) => tx[k] === undefined || tx[k] === null).map(String);
}

/**
 * Re-encode `0x02 || 0x49 || rlp([nonce, gasPrice, gasLimit, to, value, data, v, r, s])` from a node's
 * JSON view, and prove it byte-exact by hashing it against the node's own tx hash.
 *
 * The field encoders are the same ones the SDK signs with (see rlp.ts), because rskj's RLP disagrees
 * with generic libraries on exactly the fields an intent pins to zero: gasPrice 0 encodes as the raw
 * byte 0x00, value 0 as 0x80. A generic encoder produces different bytes, a different hash, and a
 * `settle` that parses to a different signer.
 */
export function reconstructIntentRaw(tx: SignedTxView, opts: { chainId?: number } = {}): string {
  const chainId = opts.chainId ?? CHAIN_ID;
  const missing = missingForReconstruction(tx);
  if (missing.length) {
    throw new ReconstructionError(
      `the node's view of ${tx.hash} is missing ${missing.join(", ")} — ` +
      `txpool_content omits v/r/s and type, so fetch the tx by hash before reconstructing`);
  }

  const v = eip155V(BigInt(tx.v!), chainId);

  const raw = cat([PREFIX, encList([
    encNonce(BigInt(tx.nonce)),
    encGasPrice(BigInt(tx.gasPrice!)),          // 0 -> raw 0x00, per rskj's encodeCoinNonNullZero
    encGasLimit(BigInt(tx.gas!)),
    encAddress(tx.to!),
    encValue(BigInt(tx.value!)),                // 0 -> 0x80, per rskj's encodeCoinNullZero
    encData(getBytes(tx.input)),
    encByte(v),
    encElem(minimalBE(BigInt(tx.r!))),          // rskj signs r/s as unsigned big-endian, no leading zeros
    encElem(minimalBE(BigInt(tx.s!))),
  ])]);

  const hex = "0x" + Buffer.from(raw).toString("hex");
  const got = keccak256(raw);
  if (got.toLowerCase() !== tx.hash.toLowerCase()) {
    throw new ReconstructionError(
      `reconstruction does not hash to the node's tx hash (got ${got}, node says ${tx.hash}) — ` +
      `the re-encoding differs from the signed bytes somewhere, so these are NOT settleable. ` +
      `If v was reported as a parity bit, chainId ${chainId} is the assumption most likely to be wrong`);
  }
  return hex;
}

/**
 * Does this pool entry look like an intent? Deliberately does NOT trust `type`: the pool listing has
 * no such field, so a check on it silently never fires and the shape test carries the classification.
 */
export function looksLikeIntent(tx: { to?: string | null; input?: string; type?: string }): boolean {
  if (tx.type === "0x0249") return true;
  const to = tx.to?.toLowerCase();
  const bytes = tx.input ? (tx.input.length - 2) / 2 : 0;
  return to === SETTLEMENT_ADDR.toLowerCase() && bytes === INTENT_DATA_LEN;
}
