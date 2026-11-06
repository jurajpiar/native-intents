/**
 * Build, sign and encode a native-intent transaction (0x02 || 0x49 || legacy-body), plus helpers to
 * drive the consumed-set registry. The signing scheme mirrors rskj pr3558's Type2RSKTransactionEncoder
 * for chainId != 0, and is verified in poc/sdk/test/encoding.test.ts.
 */
import { concat, getBytes, hexlify, keccak256, recoverAddress, SigningKey, Wallet, BaseWallet, Interface, toUtf8Bytes, zeroPadValue, toBeHex, randomBytes } from "ethers";
import {
  cat, encByte, encElem, encList, encNonce, encGasPrice, encValue, encGasLimit, encAddress, encData,
  stripLeadingZeros,
} from "./rlp.js";
import { CHAIN_ID, INTENT_SUBTYPE, SETTLEMENT_ADDR, RBTC, INTENT_DATA_LEN } from "./config.js";
import settlementAbi from "./abi/Settlement.json" with { type: "json" };

const PREFIX = new Uint8Array([0x02, INTENT_SUBTYPE]);
const word = (n: number | bigint): Uint8Array => getBytes(zeroPadValue(toBeHex(BigInt(n)), 32));
const addrWord = (a: string): Uint8Array => getBytes(zeroPadValue(a, 32));
const settlementIface = new Interface(settlementAbi as import("ethers").InterfaceAbi);

export interface IntentParams {
  /** 32-byte commitment to the pipeline (any bytes32). */
  H: Uint8Array;
  /** BTC txid as 32 big-endian display bytes (as bitcoind reports it). Zeros when ticket disabled. */
  btcTxid: Uint8Array;
  /** height-relative expiry E (absolute block height). */
  expiry: number;
  /** minimum output the settlement contract must deliver to the user. */
  minOut: bigint;
  /** output asset: an ERC-20 address, or omitted/zero for native RBTC. */
  outputToken?: string;
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

/** Encode the intent data field: H | btcTxid | E | minOut | outputToken (160 bytes). */
export function encodeIntentData(p: IntentParams): Uint8Array {
  const data = cat([p.H, p.btcTxid, word(p.expiry), word(p.minOut), addrWord(p.outputToken ?? RBTC)]);
  if (data.length !== INTENT_DATA_LEN) throw new Error(`intent data must be ${INTENT_DATA_LEN} bytes, got ${data.length}`);
  return data;
}

/** Build and sign an intent with a fresh key (SDK derives a new address per intent — see README). */
/**
 * Sign an intent over ARBITRARY data bytes, skipping encodeIntentData's 160-byte assert.
 *
 * Only the red-team board needs this: admission's length rule is a node-side check, and an attacker
 * hand-rolls its bytes rather than going through an SDK. Everything else about the envelope stays
 * canonical, so a rejection can only be the payload's length or content — see attacks/a5.
 */
export function buildRawIntent(signer: SigningKey | BaseWallet, data: Uint8Array, opts: { nonce?: number; gasLimit?: number } = {}): BuiltIntent {
  return buildIntentFromData(signer, data, opts.nonce ?? 0, opts.gasLimit ?? 100_000, new Uint8Array(32));
}

export function buildIntent(signer: SigningKey | BaseWallet, p: IntentParams): BuiltIntent {
  const nonce = p.nonce ?? 0;
  const gasLimit = p.gasLimit ?? 100_000;
  const data = encodeIntentData(p);
  return buildIntentFromData(signer, data, nonce, gasLimit, p.H);
}

function buildIntentFromData(
  signer: SigningKey | BaseWallet, data: Uint8Array, nonce: number, gasLimit: number, H: Uint8Array,
): BuiltIntent {
  const sk = signer instanceof SigningKey ? signer : new SigningKey(signer.privateKey);

  const fields = [
    encNonce(nonce),
    encGasPrice(0),               // free
    encGasLimit(gasLimit),
    encAddress(SETTLEMENT_ADDR),  // addressed to the settlement contract (cosmetic; intents are never mined)
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
  return { rawHex, hash: keccak256(signed), sender, sigHash, H, data };
}

// --- settlement helpers ---

/** eth_call Settlement.isConsumed(bytes32) -> boolean */
export async function isConsumed(ethCall: (to: string, data: string) => Promise<string>, H: Uint8Array): Promise<boolean> {
  const data = settlementIface.encodeFunctionData("isConsumed", [hexlify(H)]);
  const out = await ethCall(SETTLEMENT_ADDR, data);
  return settlementIface.decodeFunctionResult("isConsumed", out)[0] as boolean;
}

export const randomH = (): Uint8Array => getBytes(randomBytes(32));

/**
 * H for an EXIT intent: commits to the user's BTC destination (hash160) plus a salt, so the settlement
 * contract can verify the solver paid the RIGHT Bitcoin address without the intent format growing a
 * field — H = keccak256("BTCOUT" || dest20 || salt32), checked on-chain by settleBtcOut.
 */
export function btcOutH(destHash160Hex: string, salt: Uint8Array): Uint8Array {
  return getBytes(keccak256(concat([toUtf8Bytes("BTCOUT"), destHash160Hex, salt])));
}
export const freshWallet = () => Wallet.createRandom();
