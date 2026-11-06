/**
 * E3 — REPLAY ONE BTC PAYOUT ACROSS SEVERAL EXITS.
 *
 * A payout proof is public and reusable bytes: once a solver's Bitcoin payment is confirmed, anyone
 * can present it. The only thing standing between that and claiming N escrows for one payment is the
 * claimed set — and its KEY is the whole question. Keyed by txid, one transaction settles once and
 * batching is impossible; keyed by (txid, vout), each output settles exactly once. It is keyed by
 * (txid, vout), checked inside the output scan itself, so this attack probes what that buys and what
 * it does not.
 *
 *  part 1: two outputs, two intents — one transaction legitimately settles both, one per output.
 *          A third intent to the same destination finds nothing unclaimed.
 *  part 2: one OVERSIZED output, two intents — the output settles exactly one, and the surplus above
 *          that intent's ask is forfeited: the claimed set is per-output, not per-satoshi.
 *
 * Falsifier: one output settles two intents, or a second output cannot settle a second intent.
 */
import { hexlify, Wallet } from "ethers";
import { isConsumed } from "../src/intent.js";
import { btcOutClaimed, peginOf, settleBtcOut } from "../src/settlement.js";
import { preflight, requireSettlement, rpcA } from "../experiments/_harness.js";
import { COW_KEY } from "../src/config.js";
import { Attack } from "./_forensics.js";
import { AttackSpec, Outcome } from "./registry.js";
import { confirmAndProve, freshExitIntent, payMulti, SATS, setupExitEnv } from "./_btc.js";

const ASK = 0.009;
const ASK_SATS = BigInt(Math.round(ASK * SATS));

export async function run(spec: AttackSpec): Promise<number> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  try { await btcOutClaimed(rpcA.url, "0x" + "0".repeat(64), 0); }
  catch {
    console.error(`\nSettlement predates the exit leg. Rebuild:\n` +
      `  docker-compose -f poc/stack/podman-compose.yml down -v && docker-compose -f poc/stack/podman-compose.yml up -d --build\n`);
    return 2;
  }
  const a = new Attack(spec, rpcA);
  const env = await setupExitEnv(a);
  const userAddr = await env.btc.getNewAddress("atk-e3-user", "legacy");
  const dest = await env.btc.hash160Of(userAddr);

  // ---- part 1: one transaction, two outputs, two obligations ---------------------------------
  a.step("solver pays the same address TWICE in one transaction (batching two exits)");
  const A = await freshExitIntent({ destHash160: dest, minSats: ASK_SATS });
  const B = await freshExitIntent({ destHash160: dest, minSats: ASK_SATS });
  const C = await freshExitIntent({ destHash160: dest, minSats: ASK_SATS });
  const pay = await payMulti(env, env.solverLegacy, [{ addr: userAddr, btc: ASK }, { addr: userAddr, btc: ASK }], 0.0005, new Wallet(COW_KEY).address);
  const proof = await confirmAndProve(env, pay.txid);
  a.note(`payout ${pay.txid.slice(0, 16)}… at btc height ${proof.height}, two ${ASK} BTC outputs to the user`);

  const settleWith = (it: typeof A, minOutOverride?: string) =>
    a.tx(settleBtcOut(rpcA.url, {
      rawIntentTx: it.intent.rawHex, salt: it.salt, btcDest: dest,
      rawBtcTx: minOutOverride ?? pay.rawHex, btcBlockHash: proof.blockHash,
      merklePath: proof.branch.path, merkleHashes: proof.branch.hashes,
    }));

  const sA = await settleWith(A, undefined);
  a.check("intent A settled off output 0", sA.ok, sA.reason ?? "");
  a.check("output 0 marked claimed", await btcOutClaimed(rpcA.url, "0x" + pay.txid, 0));
  a.check("output 1 still UNCLAIMED", !(await btcOutClaimed(rpcA.url, "0x" + pay.txid, 1)));

  const sB = await settleWith(B, undefined);
  a.check("intent B settled off output 1 — the SAME transaction, a second escrow", sB.ok, sB.reason ?? "");
  a.check("output 1 now claimed too", await btcOutClaimed(rpcA.url, "0x" + pay.txid, 1));
  a.check("both escrows released", (await peginOf(rpcA.url, hexlify(A.btcTxid))) === 0n && (await peginOf(rpcA.url, hexlify(B.btcTxid))) === 0n);
  a.check("both H consumed", (await isConsumed((to, d) => rpcA.ethCall(to, d), A.H)) && (await isConsumed((to, d) => rpcA.ethCall(to, d), B.H)));

  a.step("a THIRD intent to the same address tries the same transaction");
  const sC = await settleWith(C, undefined);
  a.check("third settle REVERTED — the transaction is exhausted", !sC.ok, sC.reason ?? "no reason");
  a.check("revert comes from the output scan", (sC.reason ?? "").includes("no unclaimed payout to dest"));
  a.check("C's escrow untouched", (await peginOf(rpcA.url, hexlify(C.btcTxid))) > 0n);
  a.check("C's H unconsumed — the user can still be served by another solver",
    !(await isConsumed((to, d) => rpcA.ethCall(to, d), C.H)));

  // ---- part 2: one oversized output is not divisible -----------------------------------------
  a.step("solver overpays: ONE output worth two asks");
  const D = await freshExitIntent({ destHash160: dest, minSats: ASK_SATS });
  const E = await freshExitIntent({ destHash160: dest, minSats: ASK_SATS });
  const big = await payMulti(env, env.solverLegacy, [{ addr: userAddr, btc: ASK * 2 }], 0.0005, new Wallet(COW_KEY).address);
  const bigProof = await confirmAndProve(env, big.txid);
  a.note(`payout ${big.txid.slice(0, 16)}… pays ${(ASK * 2).toFixed(3)} BTC in a single output`);

  const settleBig = (it: typeof D) =>
    a.tx(settleBtcOut(rpcA.url, {
      rawIntentTx: it.intent.rawHex, salt: it.salt, btcDest: dest,
      rawBtcTx: big.rawHex, btcBlockHash: bigProof.blockHash,
      merklePath: bigProof.branch.path, merkleHashes: bigProof.branch.hashes,
    }));

  const sD = await settleBig(D);
  a.check("intent D settled off the oversized output", sD.ok, sD.reason ?? "");
  const sE = await settleBig(E);
  a.check("intent E REVERTED — the output is spent as a whole, not by the satoshi", !sE.ok, sE.reason ?? "no reason");
  a.check("so the surplus ask is forfeited to the user", (sE.reason ?? "").includes("no unclaimed payout to dest"),
    `solver paid ${(ASK * 2).toFixed(3)} BTC and claimed one ${ASK} escrow`);

  const observed: Outcome = sA.ok && sB.ok && !sC.ok && sD.ok && !sE.ok ? "contained" : "succeeds";
  return a.finish(observed);
}
