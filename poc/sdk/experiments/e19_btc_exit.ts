/**
 * E19 — The path BACK to BTC (exit intents). The user's entire lifecycle stays on Bitcoin: they sign an
 * intent whose output is BTC delivered ON BITCOIN (H commits to their BTC address), a solver pays that
 * address from its own UTXOs, proves the payment to the settlement contract by SPV against the Bridge's
 * header chain (RSKIP122 getBtcTransactionConfirmations) plus an on-chain parse of the raw payout tx,
 * and claims the escrowed RSK-side input. The mirror image of the peg-in flow.
 *
 * Falsifier: the user's BTC address isn't actually paid, a payment to the WRONG address settles, the
 * solver doesn't receive the input, or one payout output settles two intents (replay).
 *
 * Standalone + slow-ish (relays real BTC headers to the Bridge). Needs the E19 genesis (settlement with
 * settleBtcOut) and bitcoind. The exit input is modelled with depositForPegin (the user's RSK-side value
 * held for exit); pulling live positions (e.g. vault shares) without a user RSK tx is a documented gap
 * (native permit — see PRODUCTIONIZATION).
 */
import { buildIntent, freshWallet, isConsumed, btcOutH } from "../src/intent.js";
import { depositForPegin, settleBtcOut, btcOutClaimed, reserveExit, exitBondFor, exitReservationOf } from "../src/settlement.js";
import { branchFromTxOutProof } from "../src/merkle.js";
import { Bridge } from "../src/bridge.js";
import { BtcRpc } from "../src/btcrpc.js";
import { Report, preflight, requireSettlement, rpcA, waitReceipt, succeeded, reverted } from "./_harness.js";
import { BTC_OUT, COW_KEY } from "../src/config.js";
import { getBytes, hexlify, randomBytes, Wallet } from "ethers";

const INPUT = 10_000_000_000_000_000n;  // 1e16 wei — the user's RSK-side value, escrowed for exit
const PAY_BTC = 0.009;                  // what the solver pays the user on Bitcoin
const MIN_SATS = 900_000n;              // = 0.009 BTC — the intent's ask (minOut in SATS for exits)

async function main(): Promise<number> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  // generation probe: the exit leg ships with claimedBtcOut AND exitReservations (the race fix)
  try { await btcOutClaimed(rpcA.url, "0x" + "0".repeat(64), 0); await exitReservationOf(rpcA.url, "0x" + "0".repeat(64)); }
  catch {
    console.error(`\nSettlement predates the exit leg (no claimedBtcOut). Rebuild from the repo root:\n` +
      `  docker-compose -f poc/stack/podman-compose.yml down -v && docker-compose -f poc/stack/podman-compose.yml up -d --build\n`);
    process.exit(2);
  }
  const r = new Report("E19 BTC exit", "a solver's real BTC payment to the user's address, SPV-proven, settles the exit intent and releases the input");
  const btc = new BtcRpc();
  const bridge = new Bridge(rpcA);

  // --- BTC-side setup: user's receiving address; solver's funded BTC address ---
  await btc.ensureWallet();
  const faucet = await btc.getNewAddress("e19-faucet", "legacy");
  if ((await btc.getBlockCount()) < 101 || (await btc.getBalance()) < 1) await btc.generateToAddress(101, faucet);
  const userBtcAddr = await btc.getNewAddress("e19-user", "legacy");
  const userDest = await btc.hash160Of(userBtcAddr);
  const solverBtcAddr = await btc.getNewAddress("e19-solver", "legacy");
  await btc.sendToAddress(solverBtcAddr, 0.05);
  await btc.generateToAddress(1, faucet);

  /**
   * Sync the Bridge's SPV view to the BTC tip: one receiveHeader tx per header, sent back-to-back
   * (sequential nonces) with a single receipt wait at the end. Doing this BEFORE the intent exists is
   * essential on a fresh chain (~100-header backlog): the first E19 run relayed inside the intent's
   * lifetime with a per-header receipt wait, burned ~104 RSK blocks, and the intent EXPIRED before
   * settlement — 5 checks failed on "expired", not on the mechanism under test.
   */
  async function relayTo(target: number): Promise<void> {
    const from = await bridge.bestChainHeight();
    if (from >= target) return;
    bridge.resetNonce(); // cow signs through other paths between batches — re-sync before batch-sending
    let last: string | null = null;
    for (let h = from + 1; h <= target; h++) {
      last = await bridge.receiveHeader(await btc.getBlockHeaderRaw(await btc.getBlockHash(h)));
    }
    if (last) await waitReceipt(rpcA, last);
  }
  console.log(`syncing the Bridge to the BTC tip before any intent exists…`);
  await relayTo(await btc.getBlockCount());

  // --- the exit intent: output = BTC to the user's address, committed in H ---
  const user = freshWallet();
  const salt = getBytes(randomBytes(32));
  const H = btcOutH(userDest, salt);
  const btcTxid = getBytes(randomBytes(32));            // the exit input's escrow key
  await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btcTxid), INPUT));
  const height = await rpcA.blockNumber();
  const intent = buildIntent(user, { H, btcTxid, expiry: height + 90, minOut: MIN_SATS, outputToken: BTC_OUT });
  await rpcA.sendRaw(intent.rawHex);
  r.check("exit intent admitted (payer-less, BTC-denominated ask)", true, `H=${hexlify(H).slice(0, 10)}…`);

  // --- the race fix: the solver RESERVES before paying a single satoshi ---
  const bond = exitBondFor(MIN_SATS);
  r.check("solver reserves the exit (bond posted) before paying BTC",
    succeeded(await waitReceipt(rpcA, await reserveExit(rpcA.url, intent.rawHex, bond))));
  const resv = await exitReservationOf(rpcA.url, H);
  r.check("reservation recorded for the solver", resv.solver.toLowerCase() === new Wallet(COW_KEY).address.toLowerCase(), `until blk ${resv.until}`);
  const s2key = Wallet.createRandom().privateKey;
  const { fundAccount } = await import("./_harness.js");
  await waitReceipt(rpcA, await fundAccount(new Wallet(s2key).address, 10_000_000_000_000_000n));

  // --- the solver pays the user REAL BTC and proves it ---
  const userBtcBefore = (await btc.listUnspent([userBtcAddr])).reduce((s, u) => s + u.amount, 0);
  const { txid: payTxid, rawHex: payRaw } = await btc.payToAddress(solverBtcAddr, userBtcAddr, PAY_BTC);
  await btc.generateToAddress(2, faucet);               // confirm the payout (+1 spare)
  const payHeight = (await btc.getRawTransactionVerbose(payTxid)).confirmations
    ? await btc.getBlockCount() - ((await btc.getRawTransactionVerbose(payTxid)).confirmations! - 1) : 0;
  const payBlockHash = await btc.getBlockHash(payHeight);
  console.log(`payout ${payTxid} at btc height ${payHeight}; relaying the 2 new headers…`);
  await relayTo(await btc.getBlockCount());
  const branch = branchFromTxOutProof(await btc.getTxOutProof([payTxid]), payTxid);

  // negative: a DIFFERENT solver with a perfectly VALID proof cannot settle a reserved exit
  const poached = await waitReceipt(rpcA, await settleBtcOut(rpcA.url, {
    rawIntentTx: intent.rawHex, salt, btcDest: userDest,
    rawBtcTx: payRaw, btcBlockHash: "0x" + payBlockHash, merklePath: branch.path, merkleHashes: branch.hashes,
  }, s2key));
  r.check("another solver cannot settle a RESERVED exit (even with a valid proof)", reverted(poached), poached ? poached.status : "no receipt");

  // negative FIRST: an intent committing a DIFFERENT destination cannot claim this payout
  const mallory = freshWallet();
  const wrongDest = await btc.hash160Of(await btc.getNewAddress("e19-wrong", "legacy"));
  const salt2 = getBytes(randomBytes(32));
  const btcTxid2 = getBytes(randomBytes(32));
  await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btcTxid2), INPUT));
  const wrongIntent = buildIntent(mallory, { H: btcOutH(wrongDest, salt2), btcTxid: btcTxid2, expiry: (await rpcA.blockNumber()) + 90, minOut: MIN_SATS, outputToken: BTC_OUT });
  const wrong = await waitReceipt(rpcA, await settleBtcOut(rpcA.url, {
    rawIntentTx: wrongIntent.rawHex, salt: salt2, btcDest: wrongDest,
    rawBtcTx: payRaw, btcBlockHash: "0x" + payBlockHash, merklePath: branch.path, merkleHashes: branch.hashes,
  }));
  r.check("payment to the WRONG destination cannot settle", reverted(wrong), wrong ? wrong.status : "no receipt");

  // the real settle: solver (cow) proves its payment and claims the input
  const cowBefore = BigInt(await rpcA.getBalance(new Wallet(COW_KEY).address));
  const rec = await waitReceipt(rpcA, await settleBtcOut(rpcA.url, {
    rawIntentTx: intent.rawHex, salt, btcDest: userDest,
    rawBtcTx: payRaw, btcBlockHash: "0x" + payBlockHash, merklePath: branch.path, merkleHashes: branch.hashes,
  }));
  r.check("settleBtcOut succeeded (SPV + payout parse)", succeeded(rec), rec ? rec.status : "no receipt");
  const userBtcAfter = (await btc.listUnspent([userBtcAddr])).reduce((s, u) => s + u.amount, 0);
  r.check("user's REAL BTC balance grew by the payout", Math.abs(userBtcAfter - userBtcBefore - PAY_BTC) < 1e-8, `+${(userBtcAfter - userBtcBefore).toFixed(4)} BTC`);
  const cowDelta = BigInt(await rpcA.getBalance(new Wallet(COW_KEY).address)) - cowBefore;
  r.check("solver claimed the escrowed input", cowDelta > INPUT - 3_000_000_000_000n, `delta=${cowDelta}`);
  r.check("H consumed", await isConsumed((to, d) => rpcA.ethCall(to, d), H));
  r.check("payout output marked claimed", await btcOutClaimed(rpcA.url, "0x" + payTxid, 0));

  // replay: a SECOND exit intent to the same destination cannot reuse the same payout output
  const salt3 = getBytes(randomBytes(32));
  const btcTxid3 = getBytes(randomBytes(32));
  await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btcTxid3), INPUT));
  const replayIntent = buildIntent(freshWallet(), { H: btcOutH(userDest, salt3), btcTxid: btcTxid3, expiry: (await rpcA.blockNumber()) + 90, minOut: MIN_SATS, outputToken: BTC_OUT });
  const replay = await waitReceipt(rpcA, await settleBtcOut(rpcA.url, {
    rawIntentTx: replayIntent.rawHex, salt: salt3, btcDest: userDest,
    rawBtcTx: payRaw, btcBlockHash: "0x" + payBlockHash, merklePath: branch.path, merkleHashes: branch.hashes,
  }));
  r.check("one payout output cannot settle a second intent", reverted(replay), replay ? replay.status : "no receipt");

  // --- squatting is priced: a reservation that lapses unsettled forfeits its bond into the escrow ---
  const salt4 = getBytes(randomBytes(32));
  const btcTxid4 = getBytes(randomBytes(32));
  await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btcTxid4), INPUT));
  const lapseIntent = buildIntent(freshWallet(), { H: btcOutH(userDest, salt4), btcTxid: btcTxid4, expiry: (await rpcA.blockNumber()) + 90, minOut: MIN_SATS, outputToken: BTC_OUT });
  await rpcA.sendRaw(lapseIntent.rawHex);
  r.check("squatter reserves (and will never pay)", succeeded(await waitReceipt(rpcA, await reserveExit(rpcA.url, lapseIntent.rawHex, bond, s2key))));
  const squat = await exitReservationOf(rpcA.url, btcOutH(userDest, salt4));
  console.log(`waiting for the reservation to lapse (block ${squat.until})…`);
  const { waitFor } = await import("../src/client.js");
  await waitFor(async () => BigInt(await rpcA.blockNumber()) >= squat.until, 60000, 1000);

  const { txid: payTxid2, rawHex: payRaw2 } = await btc.payToAddress(solverBtcAddr, userBtcAddr, PAY_BTC);
  await btc.generateToAddress(2, faucet);
  const v2 = await btc.getRawTransactionVerbose(payTxid2);
  const payHeight2 = (await btc.getBlockCount()) - ((v2.confirmations ?? 1) - 1);
  await relayTo(await btc.getBlockCount());
  const branch2 = branchFromTxOutProof(await btc.getTxOutProof([payTxid2]), payTxid2);
  const cowBefore2 = BigInt(await rpcA.getBalance(new Wallet(COW_KEY).address));
  const rec2 = await waitReceipt(rpcA, await settleBtcOut(rpcA.url, {
    rawIntentTx: lapseIntent.rawHex, salt: salt4, btcDest: userDest,
    rawBtcTx: payRaw2, btcBlockHash: "0x" + (await btc.getBlockHash(payHeight2)), merklePath: branch2.path, merkleHashes: branch2.hashes,
  }));
  r.check("after the lapse, a paying solver settles freely", succeeded(rec2), rec2 ? rec2.status : "no receipt");
  const cowDelta2 = BigInt(await rpcA.getBalance(new Wallet(COW_KEY).address)) - cowBefore2;
  r.check("squatter's forfeited bond sweetened the release (input + bond)", cowDelta2 > INPUT + bond - 3_000_000_000_000n, `delta=${cowDelta2} (bond=${bond})`);

  console.log(`\nfull circle: BTC in (peg-in), BTC out (solver payout, SPV-proven) — the user never sent a Rootstock transaction.`);
  console.log(`and the race is safe: reservations make losing cost gas, squatting cost the bond, and stale exits self-sweeten.`);
  return r.done();
}

main().then((c) => process.exit(c));
