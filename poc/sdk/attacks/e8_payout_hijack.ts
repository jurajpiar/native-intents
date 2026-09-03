/**
 * E8 — BURN A SOLVER'S PAYOUT WITH A DUST INTENT (payout hijack).
 *
 * FIXED (settler commitment). settleBtcOut used to take the payout as CALLDATA and never ask who paid
 * it: the reservation gate keys on H, so it stopped another solver settling the intent you reserved,
 * but not anyone settling a DIFFERENT intent with your bytes. The payout now MUST carry an OP_RETURN
 * "RSKX" || <settler RSK address>, and settleBtcOut requires msg.sender to match it — the entitlement
 * travels with the payment instead of with whoever holds the (public) proof. This experiment now runs
 * the original hijack against the fix and asserts it is refused.
 *
 * That is the gap. A Bitcoin payout is public the moment it is broadcast, and it names the user's
 * address in the clear. An attacker reads that address off the mempool, builds its own exit intent
 * committing the same destination with a one-satoshi ask, escrows dust against it, and presents the
 * honest solver's proof. The claimed set does its job perfectly: the output settles exactly one
 * intent — the attacker's. The paying solver's Bitcoin is gone, irreversibly, and the user it was
 * meant for is no better off.
 *
 * The change output cannot absorb the attack: _findPayment only matches outputs paying the committed
 * destination, so the attacker's scan finds the payout and nothing else.
 *
 * Procedure: victim exit intent -> solver RESERVES it (the documented protection) and pays real BTC
 *            -> attacker reads dest off the payout, builds a 1-sat intent on the same dest, and
 *            settles it with the solver's proof -> the solver's own settle now finds nothing.
 * Falsifier: the reservation blocks the attacker, or the solver can still settle afterwards.
 */
import { hexlify, Wallet } from "ethers";
import { isConsumed } from "../src/intent.js";
import { btcOutClaimed, exitBondFor, peginOf, reserveExit, settleBtcOut } from "../src/settlement.js";
import { COW_KEY } from "../src/config.js";
import { fundAccount, preflight, requireSettlement, rpcA, waitReceipt } from "../experiments/_harness.js";
import { freshWallet } from "../src/intent.js";
import { Attack } from "./_forensics.js";
import { AttackSpec, Outcome } from "./registry.js";
import { confirmAndProve, freshExitIntent, payMulti, SATS, setupExitEnv } from "./_btc.js";

const ASK = 0.009;
const ASK_SATS = BigInt(Math.round(ASK * SATS));
const GAS_MONEY = 100_000_000_000_000n;

export async function run(spec: AttackSpec): Promise<number> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  const a = new Attack(spec, rpcA);
  const env = await setupExitEnv(a);
  const userAddr = await env.btc.getNewAddress("atk-e8-user", "legacy");
  const dest = await env.btc.hash160Of(userAddr);

  const attacker = freshWallet();
  await waitReceipt(rpcA, await fundAccount(attacker.address, GAS_MONEY));
  a.watch("attacker", attacker.address);
  a.watch("solver", new Wallet(COW_KEY).address);
  await a.mark();

  // --- step 1: an honest exit, reserved exactly as the docs instruct -------------------------
  a.step("victim signs an exit; the solver RESERVES it before paying a satoshi");
  const V = await freshExitIntent({ destHash160: dest, minSats: ASK_SATS });
  const bond = exitBondFor(ASK_SATS);
  const resv = await a.tx(reserveExit(rpcA.url, V.intent.rawHex, bond));
  a.check("reservation posted (the documented protection against losing real BTC)", resv.ok, `bond ${bond} wei`);

  // --- step 2: the solver pays real Bitcoin -------------------------------------------------
  a.step("solver pays the user's Bitcoin address for real");
  const btcBefore = (await env.btc.listUnspent([userAddr])).reduce((s, u) => s + u.amount, 0);
  const pay = await payMulti(env, env.solverLegacy, [{ addr: userAddr, btc: ASK }], 0.0005, new Wallet(COW_KEY).address);
  const proof = await confirmAndProve(env, pay.txid);
  const btcAfter = (await env.btc.listUnspent([userAddr])).reduce((s, u) => s + u.amount, 0);
  a.check("the user's BTC really arrived", Math.abs(btcAfter - btcBefore - ASK) < 1e-8, `+${(btcAfter - btcBefore).toFixed(8)} BTC`);
  a.note(`payout ${pay.txid.slice(0, 16)}… is public and names the user's address in the clear — but it also commits to its settler`);

  // --- step 3: the attacker points its own dust intent at the same destination ---------------
  a.step("attacker reads dest off the payout and builds a 1-satoshi intent on it");
  const X = await freshExitIntent({ destHash160: dest, minSats: 1n, inputWei: 1n });
  a.check("attacker's intent commits the VICTIM's destination", true, `H=${hexlify(X.H).slice(0, 12)}… ask=1 sat`);
  a.check("attacker holds no reservation on its own intent", true, "none needed — the gate is per-H");

  a.step("attacker settles ITS intent with the SOLVER's proof");
  const hijack = await a.tx(settleBtcOut(rpcA.url, {
    rawIntentTx: X.intent.rawHex, salt: X.salt, btcDest: dest,
    rawBtcTx: pay.rawHex, btcBlockHash: proof.blockHash,
    merklePath: proof.branch.path, merkleHashes: proof.branch.hashes,
  }, attacker.privateKey));
  a.check("hijack REFUSED — the payout commits to its settler, not to whoever holds the proof",
    !hijack.ok, hijack.reason ?? "no reason");
  a.check("refused on the commitment, not incidentally",
    (hijack.reason ?? "").includes("payout not committed to this settler"), hijack.reason ?? "");
  a.check("the payout output is still unclaimed", !(await btcOutClaimed(rpcA.url, "0x" + pay.txid, 0)));
  a.check("attacker's H unconsumed — its dust 'exit' settled nothing",
    !(await isConsumed((to, d) => rpcA.ethCall(to, d), X.H)));
  await a.deltas();

  // --- step 4: the paying solver settles, exactly as intended --------------------------------
  a.step("the solver that actually paid settles the intent it reserved");
  const legit = await a.tx(settleBtcOut(rpcA.url, {
    rawIntentTx: V.intent.rawHex, salt: V.salt, btcDest: dest,
    rawBtcTx: pay.rawHex, btcBlockHash: proof.blockHash,
    merklePath: proof.branch.path, merkleHashes: proof.branch.hashes,
  }));
  a.check("solver's settle SUCCEEDED", legit.ok, legit.reason ?? "");
  a.check("its payout is now claimed by it", await btcOutClaimed(rpcA.url, "0x" + pay.txid, 0));
  a.check("victim's H consumed — the exit completed once", await isConsumed((to, d) => rpcA.ethCall(to, d), V.H));
  a.check("victim's escrow released (the solver was repaid)",
    (await peginOf(rpcA.url, hexlify(V.btcTxid))) === 0n);
  await a.deltas();
  a.note("the solver keeps its bitcoin's worth: entitlement travelled with the payment, not with the proof");

  // --- step 5: an UNCOMMITTED payout is unclaimable by anyone --------------------------------
  a.step("regression: a payout built without the commitment cannot be settled at all");
  const V2 = await freshExitIntent({ destHash160: dest, minSats: ASK_SATS });
  await a.tx(reserveExit(rpcA.url, V2.intent.rawHex, bond));
  const bare = await payMulti(env, env.solverLegacy, [{ addr: userAddr, btc: ASK }]); // no settler arg
  const bareProof = await confirmAndProve(env, bare.txid);
  const bareSettle = await a.tx(settleBtcOut(rpcA.url, {
    rawIntentTx: V2.intent.rawHex, salt: V2.salt, btcDest: dest,
    rawBtcTx: bare.rawHex, btcBlockHash: bareProof.blockHash,
    merklePath: bareProof.branch.path, merkleHashes: bareProof.branch.hashes,
  }));
  a.check("uncommitted payout refused", !bareSettle.ok, bareSettle.reason ?? "");
  a.check("refused for the right reason", (bareSettle.reason ?? "").includes("no settler commitment"), bareSettle.reason ?? "");
  a.note("the commitment is mandatory by design: an optional one would just be harvested when omitted");

  const observed: Outcome = hijack.ok && !legit.ok ? "succeeds" : "blocked";
  // (pre-fix this returned "succeeds": the hijack landed and the paying solver's settle reverted)
  return a.finish(observed);
}
