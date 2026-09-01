/**
 * Faithful port of the byte-level quirks in rskj's org.ethereum.util.RLP that matter for signing
 * an RSK-namespace transaction. Generic RLP libraries diverge on zero fields and would produce a
 * signing hash rskj does not recompute, so the signature would be rejected. Verified against the
 * pr3558 encoder in poc/rskj-patch — see README "Why hand-rolled RLP".
 *
 * The two rules that bite:
 *   - encodeCoinNonNullZero(0)  (gasPrice)  -> raw 0x00 byte
 *   - encodeCoinNullZero(0)     (value)     -> 0x80  (empty string)
 */
import { getBytes } from "ethers";

const OFFSET_SHORT_ITEM = 0x80;
const OFFSET_SHORT_LIST = 0xc0;
const SIZE_THRESHOLD = 56;

export function cat(arrs: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let i = 0;
  for (const a of arrs) { out.set(a, i); i += a.length; }
  return out;
}

const one = (...xs: number[]) => new Uint8Array(xs);

/** minimal big-endian bytes of a non-negative integer; 0 -> empty */
export function minimalBE(n: number | bigint): Uint8Array {
  const v = BigInt(n);
  if (v === 0n) return new Uint8Array(0);
  let h = v.toString(16);
  if (h.length % 2) h = "0" + h;
  return getBytes("0x" + h);
}

/** RLP.encodeElement */
export function encElem(src?: Uint8Array): Uint8Array {
  if (!src || src.length === 0) return one(OFFSET_SHORT_ITEM);
  if (src.length === 1 && src[0] === 0x00) return src;              // isSingleZero
  if (src.length === 1 && src[0] < OFFSET_SHORT_ITEM) return src;
  if (src.length < SIZE_THRESHOLD) return cat([one(OFFSET_SHORT_ITEM + src.length), src]);
  const lb = minimalBE(src.length);
  return cat([one(0xb7 + lb.length), lb, src]);
}

/** RLP.encodeByte */
export function encByte(v: number): Uint8Array {
  const u = v & 0xff;
  if (u === 0) return one(OFFSET_SHORT_ITEM);
  if (u <= 0x7f) return one(u);
  return one(OFFSET_SHORT_ITEM + 1, u);
}

/** RLP.encodeList over already-encoded elements */
export function encList(elements: Uint8Array[]): Uint8Array {
  const body = cat(elements);
  if (body.length < SIZE_THRESHOLD) return cat([one(OFFSET_SHORT_LIST + body.length), body]);
  const lb = minimalBE(body.length);
  return cat([one(0xf7 + lb.length), lb, body]);
}

// --- field encoders matching rskj's Type2RSKTransactionEncoder.encodeType0Fields ---

export const encNonce = (n: number | bigint): Uint8Array =>
  BigInt(n) === 0n ? one(OFFSET_SHORT_ITEM) : encElem(minimalBE(n));           // encodeNonce

export const encGasPrice = (x: number | bigint): Uint8Array =>
  BigInt(x) === 0n ? one(0x00) : encElem(minimalBE(x));                        // encodeCoinNonNullZero

export const encValue = (x: number | bigint): Uint8Array =>
  BigInt(x) === 0n ? one(OFFSET_SHORT_ITEM) : encElem(minimalBE(x));           // encodeCoinNullZero -> encodeByte(0)=0x80

export const encGasLimit = (x: number | bigint): Uint8Array => encElem(minimalBE(x));

export const encAddress = (addrHex: string): Uint8Array => encElem(getBytes(addrHex));

export const encData = (d: Uint8Array): Uint8Array => encElem(d);

/** strip leading zero bytes (rskj signs r/s as BigIntegers.asUnsignedByteArray) */
export function stripLeadingZeros(u: Uint8Array): Uint8Array {
  let i = 0;
  while (i < u.length - 1 && u[i] === 0) i++;
  return u.slice(i);
}
