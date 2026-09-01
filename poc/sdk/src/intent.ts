/**
 * Build, sign and encode a native-intent transaction (0x02 || 0x49 || legacy-body), plus helpers to
 * drive the consumed-set registry. The signing scheme mirrors rskj pr3558's Type2RSKTransactionEncoder
 * for chainId != 0, and is verified in poc/sdk/test/encoding.test.ts.
 */
import { getBytes, hexlify, keccak256, recoverAddress, SigningKey, Wallet, BaseWallet, concat, zeroPadValue, toBeHex, randomBytes } from "ethers";
import {
  cat, encByte, encElem, encList, encNonce, encGasPrice, encValue, encGasLimit, encAddress, encData,
  stripLeadingZeros,
} from "./rlp.js";
import { CHAIN_ID, INTENT_SUBTYPE, REGISTRY_ADDR, SEL_SOLVE, SEL_IS_CONSUMED, SEL_CONSUMED_HEIGHT, INTENT_DATA_LEN } from "./config.js";

const PREFIX = new Uint8Array([0x02, INTENT_SUBTYPE]);
const word = (n: number | bigint): Uint8Array => getBytes(zeroPadValue(toBeHex(BigInt(n)), 32));

export interface IntentParams {
  /** 32-byte commitment to the pipeline (any bytes32). */
  H: Uint8Array;
  /** BTC txid as 32 big-endian display bytes (as bitcoind reports it). Zeros when ticket disabled. */
  btcTxid: Uint8Array;
  /** height-relative expiry E (absolute block height). */
  expiry: number;
  /** minimum output (carried for the solver; not enforced pre-inclusion in m1). */
  minOut: bigint;
  /** gasLimit; any value works since intents are free, but keep it sane. */
  gasLimit?: number;
  nonce?: number;
}

export interface BuiltIntent {
  rawHex: string;       // ready for eth_sendRawTransaction
  hash: string;         // keccak256(signed tx) — the RSK tx hash
  sender: string;       // address RECOVERED from the signature over sigHash (what rskj will recover)
  sigHash: string;      // the prefixed EIP-155 signing hash
  H: Uint8Array;
  data: Uint8Array;
}

/** Encode the intent data field: H | btcTxid | E | minOut (128 bytes). */
export function encodeIntentData(p: IntentParams): Uint8Array {
  const data = cat([p.H, p.btcTxid, word(p.expiry), word(p.minOut)]);
  if (data.length !== INTENT_DATA_LEN) throw new Error(`intent data must be ${INTENT_DATA_LEN} bytes, got ${data.length}`);
  return data;
}

/** Build and sign an intent with a fresh key (SDK derives a new address per intent — see README). */
export function buildIntent(signer: SigningKey | BaseWallet, p: IntentParams): BuiltIntent {
  const sk = signer instanceof SigningKey ? signer : new SigningKey(signer.privateKey);
  const nonce = p.nonce ?? 0;
  const gasLimit = p.gasLimit ?? 100_000;
  const data = encodeIntentData(p);

  const fields = [
    encNonce(nonce),
    encGasPrice(0),               // free
    encGasLimit(gasLimit),
    encAddress(REGISTRY_ADDR),    // addressed to the registry
    encValue(0n),
    encData(data),
  ];

  // signing preimage (chainId != 0): prefix || rlp([...fields, chainId, "", ""])
  const sigList = encList([...fields, encByte(CHAIN_ID), encElem(), encElem()]);
  const sigHash = keccak256(cat([PREFIX, sigList]));

  const sig = sk.sign(sigHash);
  const v = sig.yParity + CHAIN_ID * 2 + 35; // EIP-155
  const signedBody = encList([
    ...fields,
    encByte(v),
    encElem(stripLeadingZeros(getBytes(sig.r))),
    encElem(stripLeadingZeros(getBytes(sig.s))),
  ]);
  const signed = cat([PREFIX, signedBody]);
  const rawHex = hexlify(signed);

  // Recover from the signature (not from the privkey) so `sender` reflects exactly what rskj's
  // verify() will recover. If the encoding were wrong, this would not equal the signer.
  const sender = recoverAddress(sigHash, { r: sig.r, s: sig.s, yParity: sig.yParity });
  return { rawHex, hash: keccak256(signed), sender, sigHash, H: p.H, data };
}

// --- registry helpers ---

/** calldata for solve(bytes rawIntentTx) — m2 atomic settle+consume; call from a funded solver tx. */
export const solveCalldata = (rawIntentTxHex: string): string => concat([SEL_SOLVE, rawIntentTxHex]);

/** eth_call isConsumed(bytes32) -> boolean */
export async function isConsumed(ethCall: (to: string, data: string) => Promise<string>, H: Uint8Array): Promise<boolean> {
  const out = await ethCall(REGISTRY_ADDR, concat([SEL_IS_CONSUMED, H]));
  return BigInt(out) === 1n;
}

/** eth_call consumedHeight(bytes32) -> number (0 if not consumed; stored height+1 internally, we return the raw word) */
export async function consumedHeight(ethCall: (to: string, data: string) => Promise<string>, H: Uint8Array): Promise<number> {
  const out = await ethCall(REGISTRY_ADDR, concat([SEL_CONSUMED_HEIGHT, H]));
  const raw = BigInt(out);
  return raw === 0n ? 0 : Number(raw) - 1; // registry stores height+1 so height 0 is a non-empty marker
}

export const randomH = (): Uint8Array => getBytes(randomBytes(32));
export const freshWallet = () => Wallet.createRandom();
