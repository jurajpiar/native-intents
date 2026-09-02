/**
 * BIP37 partial-merkle-tree -> rskj MerkleBranch conversion (exit leg, E19).
 *
 * bitcoind's `gettxoutproof` returns a merkleblock: header(80) || nTx(4 LE) || varint nHashes ||
 * hashes(32 each, INTERNAL byte order) || varint nFlagBits/8 || flags. rskj's RSKIP122
 * getBtcTransactionConfirmations instead wants a MerkleBranch: the list of sibling hashes from the
 * leaf up (DISPLAY byte order, as Sha256Hash.wrap expects) plus a path bitmap where bit i set means
 * the current node at step i is the RIGHT child. This walks the PMT depth-first (exactly like
 * bitcoind serialised it) and collects the siblings along the target txid's path.
 */
import { createHash } from "node:crypto";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();
const sha256d = (b: Buffer) => sha256(sha256(b));

export interface MerkleBranch { path: number; hashes: string[] } // hashes: 0x…, display order

function varint(buf: Buffer, o: number): [number, number] {
  const b = buf[o];
  if (b < 0xfd) return [b, o + 1];
  if (b === 0xfd) return [buf.readUInt16LE(o + 1), o + 3];
  if (b === 0xfe) return [buf.readUInt32LE(o + 1), o + 5];
  throw new Error("varint too large");
}

export function branchFromTxOutProof(proofHex: string, txidDisplayHex: string): MerkleBranch {
  const buf = Buffer.from(proofHex.replace(/^0x/, ""), "hex");
  let o = 80; // skip the block header
  const nTx = buf.readUInt32LE(o); o += 4;
  let n: number;
  [n, o] = varint(buf, o);
  const vHash: Buffer[] = [];
  for (let i = 0; i < n; i++) { vHash.push(buf.subarray(o, o + 32)); o += 32; } // internal order
  [n, o] = varint(buf, o);
  const flags = buf.subarray(o, o + n);

  const target = Buffer.from(txidDisplayHex.replace(/^0x/, ""), "hex").reverse(); // -> internal order
  let height = 0;
  while ((1 << height) < nTx) height++;
  const width = (h: number) => Math.ceil(nTx / (1 << h));

  let bitIdx = 0, hashIdx = 0, path = 0;
  const siblings: Buffer[] = [];

  function descend(h: number, pos: number): { hash: Buffer; match: boolean } {
    const bit = (flags[bitIdx >> 3] >> (bitIdx & 7)) & 1;
    bitIdx++;
    if (h === 0 || bit === 0) {
      const hsh = vHash[hashIdx++];
      return { hash: hsh, match: h === 0 && bit === 1 && hsh.equals(target) };
    }
    const left = descend(h - 1, 2 * pos);
    const right = 2 * pos + 1 < width(h - 1) ? descend(h - 1, 2 * pos + 1) : { hash: left.hash, match: false };
    if (left.match !== right.match) {
      // this node is on the target's path; record the sibling (bitcoin duplicates the last odd node)
      if (right.match) path |= 1 << siblings.length; // target is the right child at this step
      siblings.push(right.match ? left.hash : right.hash);
    }
    return { hash: sha256d(Buffer.concat([left.hash, right.hash])), match: left.match || right.match };
  }

  const root = descend(height, 0);
  if (!root.match) throw new Error("txid not matched in the tx-out proof");
  const merkleRoot = buf.subarray(36, 68); // from the header, internal order
  if (!root.hash.equals(merkleRoot)) throw new Error("proof does not reduce to the header's merkle root");
  return { path, hashes: siblings.map((b) => "0x" + Buffer.from(b).reverse().toString("hex")) };
}
