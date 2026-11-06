/**
 * E22 — The reservation cannot outlive the intent, and a dead intent's bond compensates its user.
 *
 * Before this hardening an expired-while-reserved exit STRANDED the bond forever: reserveExit and
 * settleBtcOut both require an unexpired intent, and forfeiture only ran inside those two paths —
 * so squatting an exit to death was FREE (bond stuck, but so was everyone else's remedy). Now:
 *  part 1: a reservation whose window would outlive the intent is rejected outright
 *          ("window would outlive intent" — the Auction.sol:91 precedent applied to exits).
 *  part 2: forfeiting a live reservation is impossible; once the intent EXPIRES, anyone may forfeit
 *          the bond TO THE USER (the party the dead exit harmed), the reservation clears, and a
 *          second forfeit finds nothing.
 *
 * Falsifier: a near-expiry reservation is accepted (the honest-reserver trap returns), a live
 * reservation can be forfeited, the bond fails to reach the user, it can be forfeited twice, or an
 * expired-while-reserved bond remains stuck.
 *
 * 1 node, NO bitcoind (nothing is ever paid or proven — the intent dies unreserved-in-time by design).
 * Needs the E21+ genesis (forfeitExpiredExitBond): down -v + rebuild if the probe fails.
 */
import { buildIntent, freshWallet, btcOutH } from "../src/intent.js";
import { depositForPegin, reserveExit, exitBondFor, exitReservationOf, forfeitExpiredExitBond, settlementCreditOf, bindingOf } from "../src/settlement.js";
import { Report, preflight, requireSettlement, rpcA, fundAccount, waitReceipt, succeeded, reverted } from "./_harness.js";
import { BTC_OUT } from "../src/config.js";
import { waitFor } from "../src/client.js";
import { Wallet, getBytes, hexlify, randomBytes } from "ethers";

const INPUT = 10_000_000_000_000_000n;
const MIN_SATS = 900_000n;

async function main(): Promise<number> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  try { await settlementCreditOf(rpcA.url, "0x" + "0".repeat(40)); }
  catch {
    console.error(`\nSettlement predates the exit hardening (no credit ledger / forfeitExpiredExitBond). Rebuild:\n` +
      `  docker-compose -f poc/stack/podman-compose.yml down -v && docker-compose -f poc/stack/podman-compose.yml up -d --build\n`);
    process.exit(2);
  }
  const r = new Report("E22 exit bond expiry",
    "a reservation can never outlive its intent unnoticed: near-expiry reservations are rejected, and an expired-while-reserved bond forfeits to the user instead of stranding");

  const dest = hexlify(randomBytes(20)); // no BTC side needed — this exit is never paid
  const bond = exitBondFor(MIN_SATS);

  async function freshExit(expiryBlocks: number) {
    const salt = getBytes(randomBytes(32));
    const H = btcOutH(dest, salt);
    const btcTxid = getBytes(randomBytes(32));
    // The signer has to exist BEFORE the escrow, because the binding commits to it. That is the real
    // ordering the RSKIP now states: commit (H, signer) first, derive the deposit from both.
    const user = freshWallet();
    await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btcTxid), INPUT, bindingOf(H, user.address)));
    const intent = buildIntent(user, { H, btcTxid, expiry: (await rpcA.blockNumber()) + expiryBlocks, minOut: MIN_SATS, outputToken: BTC_OUT });
    await rpcA.sendRaw(intent.rawHex);
    return { user, salt, H, btcTxid, intent };
  }

  // ---- part 1: the reservation window must fit inside the intent's lifetime ----
  const tight = await freshExit(20); // RESERVE_WINDOW = 30 > 20 — must be rejected
  const tightRes = await waitReceipt(rpcA, await reserveExit(rpcA.url, tight.intent.rawHex, bond).catch(() => "0x" + "0".repeat(64)));
  r.check("near-expiry reservation rejected ('window would outlive intent')", tightRes === null || reverted(tightRes), tightRes ? tightRes.status : "not mined");

  // ---- part 2: expiry forfeits the bond to the user; nothing strands, nothing double-pays ----
  const p2 = await freshExit(45);
  const s2key = Wallet.createRandom().privateKey;
  const squatter = new Wallet(s2key).address;
  await waitReceipt(rpcA, await fundAccount(squatter, INPUT));
  r.check("squatter reserves (and never pays)", succeeded(await waitReceipt(rpcA, await reserveExit(rpcA.url, p2.intent.rawHex, bond, s2key))));

  const live = await waitReceipt(rpcA, await forfeitExpiredExitBond(rpcA.url, p2.intent.rawHex).catch(() => "0x" + "0".repeat(64)));
  r.check("a LIVE reservation cannot be forfeited ('intent still live')", live === null || reverted(live), live ? live.status : "not mined");

  const resv = await exitReservationOf(rpcA.url, p2.H);
  r.check("reservation recorded for the squatter", resv.solver.toLowerCase() === squatter.toLowerCase(), `until blk ${resv.until}`);
  console.log(`waiting for the INTENT to expire (~45 blocks; the reservation lapsed earlier and nobody re-reserved)…`);
  const head0 = await rpcA.blockNumber();
  await waitFor(async () => (await rpcA.blockNumber()) >= head0 + 46, 180000, 1000);

  const userBefore = BigInt(await rpcA.getBalance(p2.user.address));
  const forf = await waitReceipt(rpcA, await forfeitExpiredExitBond(rpcA.url, p2.intent.rawHex));
  r.check("anyone forfeits the expired reservation", succeeded(forf), forf ? forf.status : "no receipt");
  r.check("the bond went to the USER the dead exit harmed", BigInt(await rpcA.getBalance(p2.user.address)) - userBefore === bond, `user +${BigInt(await rpcA.getBalance(p2.user.address)) - userBefore}`);
  r.check("reservation cleared", (await exitReservationOf(rpcA.url, p2.H)).solver === "0x" + "0".repeat(40));
  const again = await waitReceipt(rpcA, await forfeitExpiredExitBond(rpcA.url, p2.intent.rawHex).catch(() => "0x" + "0".repeat(64)));
  r.check("no double forfeit ('no reservation')", again === null || reverted(again), again ? again.status : "not mined");

  console.log("\nsquatting an exit to death now costs the full bond — and it goes to the user, not into a stuck slot.");
  return r.done();
}

main().then((c) => process.exit(c));
