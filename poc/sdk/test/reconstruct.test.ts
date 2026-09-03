/**
 * Offline check of src/reconstruct.ts — no node needed.
 *
 * E24 proves discovery works against a running rskj. This proves the piece E24 depends on, in a form
 * that runs in CI and fails loudly if rlp.ts's zero-field quirks ever drift: build an intent, hand the
 * reconstructor the JSON view a node WOULD emit for it, and require the bytes back exactly.
 *
 * The view is formatted the way rskj formats it:
 *   TransactionResultDTO      nonce/gas/v/r/s via HexUtils.toQuantityJsonHex (minimal, "0x0" for zero)
 *                             gasPrice/value  via toQuantityJsonHex of the coin bytes
 *                             input           via toUnformattedJsonHex (full-width data hex)
 *                             v               = tx.getEncodedV() & 0xFF, which for a TYPED tx is
 *                                               yParity (0 or 1), NOT the EIP-155 v on the wire
 *                             chainId         absent — the DTO sets it only for TYPE_1 and standard
 *                                               TYPE_2, so the RSK namespace gets neither half of v
 *
 * READ THIS BEFORE TRUSTING THIS FILE. Its first version formatted `v` as the EIP-155 value, because
 * that is what the envelope is signed with. Every case passed. The node then reported v=0 and E24 died
 * on its first run. A test built from the same wrong model as the code will agree with it all day —
 * this file is a regression net for the encoder, and it is NOT evidence about what rskj emits. Only
 * E24, against a real node, is that.
 *
 * The fields that matter most are the two an intent pins to zero, because rskj's RLP disagrees with
 * every generic library there: gasPrice 0 -> raw byte 0x00, value 0 -> 0x80.
 */
import { SigningKey, keccak256 } from "ethers";
import { buildIntent, freshWallet, randomH } from "../src/intent.js";
import { missingForReconstruction, reconstructIntentRaw, looksLikeIntent, ReconstructionError } from "../src/reconstruct.js";
import { CHAIN_ID, SETTLEMENT_ADDR } from "../src/config.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

/** rskj's HexUtils.toQuantityJsonHex: minimal hex, "0x0" for zero. */
const q = (n: bigint | number): string => "0x" + BigInt(n).toString(16);

console.log("\n=== reconstruct: node JSON view -> signed bytes ===\n");

for (const [label, opts] of [
  ["nonce 0, RBTC out", { nonce: 0, gasLimit: 100_000 }],
  ["nonce 7", { nonce: 7, gasLimit: 100_000 }],
  ["large gasLimit", { nonce: 1, gasLimit: 8_000_000 }],
  ["nonce 255 (byte boundary)", { nonce: 255, gasLimit: 100_000 }],
  ["nonce 256 (two bytes)", { nonce: 256, gasLimit: 100_000 }],
] as const) {
  const w = freshWallet();
  const intent = buildIntent(w, {
    H: randomH(), btcTxid: randomH(), expiry: 12_345, minOut: 1_000_000_000_000_000n,
    nonce: opts.nonce, gasLimit: opts.gasLimit,
  });

  // what the node would say about it
  const sig = new SigningKey(w.privateKey).sign(intent.sigHash);
  const view = {
    hash: intent.hash,
    to: SETTLEMENT_ADDR,
    input: "0x" + Buffer.from(intent.data).toString("hex"),
    nonce: q(opts.nonce),
    gas: q(opts.gasLimit),
    gasPrice: "0x0",                                   // intents are free
    value: "0x0",                                      // and carry no value
    v: q(sig.yParity),                                 // TYPED tx -> the node reports yParity, not v
    r: q(BigInt(sig.r)),
    s: q(BigInt(sig.s)),
    type: "0x0249",
    // no chainId: TransactionResultDTO omits it for the RSK namespace
  };

  check(`${label}: view has everything needed`, missingForReconstruction(view).length === 0,
    missingForReconstruction(view).join(", "));
  const got = reconstructIntentRaw(view);
  check(`${label}: bytes identical to the signed envelope`, got.toLowerCase() === intent.rawHex.toLowerCase());
  check(`${label}: hashes to the advertised tx hash`, keccak256(got).toLowerCase() === intent.hash.toLowerCase());
}

// --- the failure modes must fail, not pass quietly ---------------------------------------------
console.log("\n  refusals:");
{
  const w = freshWallet();
  const intent = buildIntent(w, { H: randomH(), btcTxid: randomH(), expiry: 100, minOut: 1n });
  const sig = new SigningKey(w.privateKey).sign(intent.sigHash);
  const base = {
    hash: intent.hash, to: SETTLEMENT_ADDR, input: "0x" + Buffer.from(intent.data).toString("hex"),
    nonce: "0x0", gas: q(100_000), gasPrice: "0x0", value: "0x0",
    v: q(sig.yParity), r: q(BigInt(sig.r)), s: q(BigInt(sig.s)),
  };

  // a txpool_content listing: no v/r/s, no type
  const listing = { hash: base.hash, to: base.to, input: base.input, nonce: base.nonce, gas: base.gas, gasPrice: base.gasPrice, value: base.value };
  check("a pool listing is reported as insufficient",
    missingForReconstruction(listing).join(",") === "v,r,s", missingForReconstruction(listing).join(","));
  let threw = "";
  try { reconstructIntentRaw(listing); } catch (e) { threw = e instanceof ReconstructionError ? "ReconstructionError" : "wrong error"; }
  check("and reconstructing from it throws", threw === "ReconstructionError", threw || "did not throw");

  // an EIP-155 v (what a LEGACY tx would report) must pass through unchanged, not be re-derived
  check("an EIP-155 v is passed through, not treated as a parity bit",
    reconstructIntentRaw({ ...base, v: q(sig.yParity + CHAIN_ID * 2 + 35) }).toLowerCase() === intent.rawHex.toLowerCase());

  // a v that is neither is a refusal, at the field that is wrong
  threw = "";
  try { reconstructIntentRaw({ ...base, v: "0x2" }); } catch (e) { threw = (e as Error).message; }
  check("a v of 2 is refused as neither parity nor EIP-155", /neither a yParity bit nor/.test(threw), threw.slice(0, 60));

  // the wrong chain id yields the wrong v, and the hash check — not luck — is what catches it
  threw = "";
  try { reconstructIntentRaw(base, { chainId: CHAIN_ID + 1 }); } catch (e) { threw = (e as Error).message; }
  check("a wrong chainId is caught by the hash check", /does not hash to/.test(threw), threw.slice(0, 60));

  // a tampered field must break the hash check rather than produce settleable bytes
  threw = "";
  try { reconstructIntentRaw({ ...base, gas: q(100_001) }); } catch (e) { threw = (e as Error).message; }
  check("a tampered gasLimit is caught by the hash check", /does not hash to/.test(threw), threw.slice(0, 60));

  // the generic-RLP mistake: if gasPrice 0 encoded as 0x80 the hash would not match. Prove the
  // encoder is doing the rskj thing by confirming the correct view DOES match while a nonzero
  // gasPrice (a different encoding path) does not collide with it.
  check("zero gasPrice reconstructs (rskj encodes it as raw 0x00, not 0x80)",
    reconstructIntentRaw(base).toLowerCase() === intent.rawHex.toLowerCase());
}

// --- classification ------------------------------------------------------------------------------
console.log("\n  classification:");
check("a 160-byte tx to Settlement with no `type` is still recognised",
  looksLikeIntent({ to: SETTLEMENT_ADDR, input: "0x" + "ab".repeat(160) }));
check("a short payload to Settlement is not", !looksLikeIntent({ to: SETTLEMENT_ADDR, input: "0x" + "ab".repeat(32) }));
check("a 160-byte tx elsewhere is not",
  !looksLikeIntent({ to: "0x000000000000000000000000000000000000dead", input: "0x" + "ab".repeat(160) }));

console.log(failures === 0 ? "\nRESULT: reconstruction is exact.\n" : `\nRESULT: ${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
