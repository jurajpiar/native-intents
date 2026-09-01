/**
 * Deterministic encoding checks — no node required. Guards the one thing that must be byte-exact:
 * the RSK-namespace intent signing/encoding, so the produced tx is one rskj will actually accept.
 * Run: npm test
 */
import { getBytes, hexlify, keccak256, decodeRlp, Wallet } from "ethers";
import { buildIntent, encodeIntentData } from "../src/intent.js";
import { CHAIN_ID } from "../src/config.js";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
}

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const wallet = new Wallet(KEY);

const H = getBytes(keccak256(getBytes("0xdeadbeef")));
const btcTxid = new Uint8Array(32);
const built = buildIntent(wallet, { H, btcTxid, expiry: 1000, minOut: 0n });

const data = encodeIntentData({ H, btcTxid, expiry: 1000, minOut: 0n });
check("data is 160 bytes (H|btcTxid|E|minOut|outputToken)", data.length === 160, `${data.length}`);
check("data[0:32] == H", hexlify(data.slice(0, 32)) === hexlify(H));
check("outputToken word defaults to zero (RBTC)", hexlify(data.slice(128, 160)) === "0x" + "00".repeat(32));

check("wire prefix 0x0249", built.rawHex.startsWith("0x0249"));

const body = "0x" + built.rawHex.slice(6);
const dec = decodeRlp(body) as string[];
check("9 legacy fields", dec.length === 9, `${dec.length}`);

// canonicalisation quirks that generic RLP gets wrong
check("gasPrice 0 -> 0x00 (raw zero byte)", dec[1] === "0x00", dec[1]);
check("value 0 -> 0x (empty string)", dec[4] === "0x", dec[4]);

const v = Number(BigInt(dec[6]));
check("v is EIP-155 (101 or 102)", v === 101 || v === 102, `${v}`);
check("chainId recovers to 33", Math.floor((v - 35) / 2) === CHAIN_ID);

// the decisive check: sender recovered from the signature over the prefixed hash == signer
check("signature recovers signer", built.sender.toLowerCase() === wallet.address.toLowerCase(), built.sender);

console.log(`\nsample rawTx: ${built.rawHex.slice(0, 52)}...`);
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
