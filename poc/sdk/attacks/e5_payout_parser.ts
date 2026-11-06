/**
 * E5 — ABUSE THE PAYOUT PARSER.
 *
 * _findPayment is the only place in the PoC where hand-rolled Solidity walks bytes the attacker
 * chose: a raw Bitcoin transaction, length-prefixed by varints the attacker also wrote. A parser that
 * can be walked off the end of its buffer, or persuaded to read a length as a value, forges a payment
 * that never happened. So feed it serialisations it was not written for.
 *
 *  case 1: WITNESS SERIALISATION — a payout spending a segwit input, passed as bitcoind serialises it.
 *  case 2: THE SAME PAYOUT, WITNESS STRIPPED — and this is the finding. sha256d of the stripped bytes
 *          IS the txid, which is what the Bridge's merkle tree commits to, so the stripped form proves
 *          exactly what the witness form proves and sails past the segwit guard. "Legacy payout
 *          transactions only" describes the serialisation the parser accepts, not the payments it
 *          accepts — segwit solvers are not locked out, they just have to strip before they call.
 *  case 3: SPLIT PAYMENT — the ask paid across two outputs, neither of which reaches it. The parser
 *          matches per output and never sums, so the solver has paid in full and can claim nothing.
 *  case 4: PAYMENT AT A NON-ZERO INDEX — a decoy output first, so the claimed set must record vout 1.
 *  case 5: VARINT BOUNDARY — 253 outputs, forcing the 0xfd two-byte output-count varint and a long
 *          scan, with the payment last.
 *
 * Falsifier: any of these mis-parses instead of reverting — a value read from a length field, a
 * destination matched out of the wrong offset, or a claimed set entry against the wrong output.
 */
import { getBytes, hexlify, sha256, Wallet } from "ethers";
import { isConsumed } from "../src/intent.js";
import { btcOutClaimed, peginOf, settleBtcOut } from "../src/settlement.js";
import { preflight, requireSettlement, rpcA } from "../experiments/_harness.js";
import { COW_KEY } from "../src/config.js";
import { Attack } from "./_forensics.js";
import { AttackSpec, Outcome } from "./registry.js";
import { confirmAndProve, freshExitIntent, payMulti, SATS, setupExitEnv, stripWitness } from "./_btc.js";

const ASK = 0.009;
const ASK_SATS = BigInt(Math.round(ASK * SATS));
const WIDE_OUTS = 252;   // + the payment = 253 outputs, the first count needing a 0xfd varint
const DUST_BTC = 0.000006;
const SDK_GAS = 1_500_000;    // what src/settlement.ts sends by default
const WIDE_GAS = 6_000_000;   // still inside the regtest block gas limit

/** bitcoin display txid of a raw serialisation: reversed double-sha256. */
const txidOf = (rawHex: string): string =>
  hexlify(Uint8Array.from(getBytes(sha256(sha256(rawHex.startsWith("0x") ? rawHex : "0x" + rawHex)))).reverse()).slice(2);

export async function run(spec: AttackSpec): Promise<number> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  const a = new Attack(spec, rpcA);
  const env = await setupExitEnv(a);
  const userAddr = await env.btc.getNewAddress("atk-e5-user", "legacy");
  const dest = await env.btc.hash160Of(userAddr);
  const decoy = await env.btc.getNewAddress("atk-e5-decoy", "legacy");

  const settle = (it: Awaited<ReturnType<typeof freshExitIntent>>, rawBtcTx: string,
                  proof: { blockHash: string; branch: { path: number; hashes: string[] } }, gasLimit?: number) =>
    a.tx(settleBtcOut(rpcA.url, {
      rawIntentTx: it.intent.rawHex, salt: it.salt, btcDest: dest, rawBtcTx,
      btcBlockHash: proof.blockHash, merklePath: proof.branch.path, merkleHashes: proof.branch.hashes,
    }, undefined, gasLimit));

  // ---- cases 1 + 2: one segwit payout, two serialisations -------------------------------------
  a.step("case 1 — solver spends a SEGWIT input to pay the user, passed as bitcoind serialises it");
  const I1 = await freshExitIntent({ destHash160: dest, minSats: ASK_SATS });
  const I2 = await freshExitIntent({ destHash160: dest, minSats: ASK_SATS });
  const sw = await payMulti(env, env.solverSegwit, [{ addr: userAddr, btc: ASK }], 0.0005, new Wallet(COW_KEY).address);
  const swProof = await confirmAndProve(env, sw.txid);
  const rawBytes = getBytes("0x" + sw.rawHex.replace(/^0x/, ""));
  a.check("bitcoind returned a BIP144 witness serialisation", rawBytes[4] === 0x00 && rawBytes[5] === 0x01,
    `bytes 4-5 = ${hexlify(rawBytes.subarray(4, 6))}`);
  // The guard at :370 checks byte 4 for the segwit marker — but _checkAndClaimBtcPayment hashes the
  // bytes and asks the Bridge about them BEFORE _findPayment ever runs, and sha256d of a witness
  // serialisation is the WTXID, which no merkle tree in a block commits to. The proof fails first.
  a.check("witness bytes hash to the wtxid, NOT the txid the merkle tree commits to",
    txidOf(sw.rawHex) !== sw.txid, `wtxid ${txidOf(sw.rawHex).slice(0, 16)}… vs txid ${sw.txid.slice(0, 16)}…`);
  const s1 = await settle(I1, sw.rawHex, swProof);
  a.check("witness form REVERTED", !s1.ok, s1.reason ?? "no reason");
  a.check("it failed at the SPV hash check, BEFORE the segwit guard could fire",
    (s1.reason ?? "").includes("btc payout not confirmed"),
    "so `require(t[4] != 0x00, \"segwit payout unsupported\")` is unreachable for real witness bytes");

  a.step("case 2 — the SAME payout with the witness stripped");
  const stripped = stripWitness(sw.rawHex);
  a.check("stripped bytes hash to the SAME txid the merkle proof commits to",
    txidOf(stripped) === sw.txid, `${txidOf(stripped).slice(0, 16)}… vs ${sw.txid.slice(0, 16)}…`);
  a.note(`witness form ${(rawBytes.length)} bytes -> legacy form ${getBytes(stripped).length} bytes, same txid`);
  const s2 = await settle(I2, stripped, swProof);
  a.check("stripped form SETTLED — the guard is on the serialisation, not the payment", s2.ok, s2.reason ?? "");
  a.check("escrow released to the segwit solver", (await peginOf(rpcA.url, hexlify(I2.btcTxid))) === 0n);
  a.check("H consumed", await isConsumed((to, d) => rpcA.ethCall(to, d), I2.H));
  a.check("I1 remains settleable (its failed attempt claimed nothing)",
    !(await isConsumed((to, d) => rpcA.ethCall(to, d), I1.H)));

  // ---- case 3: the ask split below the threshold ---------------------------------------------
  a.step("case 3 — the ask paid in two halves, neither reaching it");
  const I3 = await freshExitIntent({ destHash160: dest, minSats: ASK_SATS });
  const split = await payMulti(env, env.solverLegacy, [
    { addr: userAddr, btc: ASK / 2 + 0.0005 }, { addr: userAddr, btc: ASK / 2 + 0.0005 },
  ], 0.0005, new Wallet(COW_KEY).address);
  const splitProof = await confirmAndProve(env, split.txid);
  a.note(`user received ${(ASK + 0.001).toFixed(6)} BTC — MORE than the ${ASK} ask, in two outputs`);
  const s3 = await settle(I3, split.rawHex, splitProof);
  a.check("split payment REVERTED", !s3.ok, s3.reason ?? "no reason");
  a.check("no output on its own reaches minOut, and the parser never sums",
    (s3.reason ?? "").includes("no unclaimed payout to dest"));
  a.check("the solver is over-paid AND unpaid: escrow untouched", (await peginOf(rpcA.url, hexlify(I3.btcTxid))) > 0n);

  // ---- case 4: the payment is not at index 0 --------------------------------------------------
  a.step("case 4 — a decoy output first, so the payment sits at vout 1");
  const I4 = await freshExitIntent({ destHash160: dest, minSats: ASK_SATS });
  const off = await payMulti(env, env.solverLegacy, [{ addr: decoy, btc: 0.001 }, { addr: userAddr, btc: ASK }], 0.0005, new Wallet(COW_KEY).address);
  const offProof = await confirmAndProve(env, off.txid);
  const s4 = await settle(I4, off.rawHex, offProof);
  a.check("settled off vout 1", s4.ok, s4.reason ?? "");
  a.check("the claimed set records vout 1", await btcOutClaimed(rpcA.url, "0x" + off.txid, 1));
  a.check("and NOT vout 0 — the decoy is untouched", !(await btcOutClaimed(rpcA.url, "0x" + off.txid, 0)));

  // ---- case 5: 253 outputs, forcing a 0xfd output-count varint --------------------------------
  a.step(`case 5 — ${WIDE_OUTS + 1} outputs, forcing the two-byte output-count varint, payment last`);
  const I5 = await freshExitIntent({ destHash160: dest, minSats: ASK_SATS });
  let wide: { txid: string; rawHex: string } | null = null;
  try {
    const outs = [...Array.from({ length: WIDE_OUTS }, () => ({ addr: decoy, btc: DUST_BTC })), { addr: userAddr, btc: ASK }];
    wide = await payMulti(env, env.solverLegacy, outs, 0.01, new Wallet(COW_KEY).address);
  } catch (e) {
    a.skip("wide payout", `bitcoind refused a ${WIDE_OUTS + 1}-output tx: ${(e as Error).message.slice(0, 80)}`);
  }
  if (wide) {
    const wideBytes = getBytes("0x" + wide.rawHex.replace(/^0x/, ""));
    // output count sits after version(4) + input varint + inputs; find it by decoding instead of guessing
    const verbose = await env.btc.getRawTransactionVerbose(wide.txid);
    const payVout = verbose.vout.findIndex((v) => v.scriptPubKey.hex === `76a914${dest.replace(/^0x/, "")}88ac`);
    a.check("bitcoind accepted the wide payout", true, `${verbose.vout.length} outputs, ${wideBytes.length} bytes`);
    a.check("output count needs a 0xfd varint", verbose.vout.length >= 0xfd, `${verbose.vout.length} >= 253`);
    a.check("the payment is the LAST matching output, so the scan runs the full length", payVout >= WIDE_OUTS, `vout ${payVout}`);
    const wideProof = await confirmAndProve(env, wide.txid);

    // FIXED: the scan is now bounded. MAX_PAYOUT_OUTPUTS caps the output count, so an over-wide payout
    // is refused CHEAPLY and by name, instead of burning the settler's whole gas limit on an O(n) walk
    // and leaving the safe batch size undocumented.
    const s5 = await settle(I5, wide.rawHex, wideProof);
    a.check("an over-wide payout is refused by the cap, not by running out of gas",
      !s5.ok && (s5.reason ?? "").includes("payout too wide"), s5.reason ?? `gasUsed=${s5.gasUsed}`);
    a.check("it fails CHEAPLY — no longer burns the full limit",
      s5.gasUsed < BigInt(SDK_GAS), `${s5.gasUsed.toLocaleString("en-GB")} of ${SDK_GAS.toLocaleString("en-GB")}`);
    a.check("H is untouched, so the failure is a liveness problem and not a loss",
      !(await isConsumed((to, d) => rpcA.ethCall(to, d), I5.H)));

    a.step(`case 5b — raising the gas limit to ${WIDE_GAS.toLocaleString("en-GB")} does NOT get around the cap`);
    const s5b = await settle(I5, wide.rawHex, wideProof, WIDE_GAS);
    a.check("still refused: the bound is a rule, not a gas accident", !s5b.ok && (s5b.reason ?? "").includes("payout too wide"), s5b.reason ?? "");
    a.check("nothing was claimed from the over-wide payout", !(await btcOutClaimed(rpcA.url, "0x" + wide.txid, payVout)));
    a.note(`the safe batch size is now a documented constant (MAX_PAYOUT_OUTPUTS), not an undocumented gas ceiling`);
    a.note(`a solver batching exits must keep the payout at or under that many outputs — including its own change and settler commitment`);
  }

  // Every malformed shape reverted with a NAMED reason rather than mis-parsing: calldata indexing in
  // Solidity 0.8 bounds-checks, so walking off the buffer is a revert, not a read of adjacent memory.
  // Nothing mis-parsed: every malformed shape reverted with a NAMED reason. What the cases DO show is
  // that the parser's two documented restrictions are not what they appear — the segwit guard is dead
  // code behind the SPV hash check, and "legacy only" is a statement about bytes, not about payments.
  const contained = !s1.ok && s2.ok && !s3.ok && s4.ok;
  const observed: Outcome = contained ? "contained" : "succeeds";
  return a.finish(observed);
}
