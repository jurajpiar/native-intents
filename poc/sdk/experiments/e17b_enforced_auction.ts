/**
 * E17b — Enforced auction (genesis Auction at 0x..01000022). Settlement now consults the genesis
 * auction: while an OPEN auction exists for H (bid upon, not yet executed/reclaimed), settle() rejects
 * every caller but the auction — including after the bidding deadline, so a bypasser cannot front-run
 * the permissionless execute(). Enforcement engages only once someone bids: bid-free intents settle
 * directly exactly as before (regression-checked here).
 *
 * This closes E17's bypass at the cost of making the auction a protocol feature (a Settlement rule)
 * rather than pure market structure. Griefing bound: opening the lock requires escrowing a bid > minOut,
 * so the user always nets more than their ask.
 *
 * Falsifier: a direct settle succeeds while an auction is open (bypass survives), execute fails, the
 * user doesn't receive the best bid, or a bid-free intent can no longer settle directly (regression).
 *
 * Needs the rebuilt genesis (auction contract + settlement with the lock check): down -v + build.
 */
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { Solver } from "../src/solver.js";
import { depositForPegin, bindingOf } from "../src/settlement.js";
import { auction, placeBid, executeAuction, bidOf, withdrawCredit } from "../src/auction.js";
import { Report, preflight, requireSettlement, rpcA, fundAccount, waitReceipt, succeeded, reverted } from "./_harness.js";
import { AUCTION_ADDR, RBTC } from "../src/config.js";
import { waitFor } from "../src/client.js";
import { getBytes, hexlify, randomBytes, Wallet } from "ethers";

const INPUT = 10_000_000_000_000_000n;
const MINOUT = 1_000_000_000_000_000n;
const BID = MINOUT + 400_000_000_000_000n; // 1.4e15
const GAS_BOUND = 3_000_000_000_000n;

async function main(): Promise<number> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  const code = await rpcA.getCode(AUCTION_ADDR).catch(() => "0x");
  if (!code || code === "0x") {
    console.error(
      `\nGenesis auction not deployed at ${AUCTION_ADDR} — this build predates E17b.\n` +
      `Rebuild with wiped volumes (from the repo root):\n` +
      `  docker-compose -f poc/stack/podman-compose.yml down -v && docker-compose -f poc/stack/podman-compose.yml up -d --build\n`
    );
    process.exit(2);
  }
  // generation check: the token-escrow auction's Bid struct has 6 fields; an older genesis (5 fields)
  // decodes as BAD_DATA. Probe with the zero H so a stale chain fails HERE, with instructions.
  try { await bidOf(auction(rpcA.url), "0x" + "0".repeat(64)); }
  catch {
    console.error(
      `\nGenesis auction at ${AUCTION_ADDR} is a STALE generation (pre-token-escrow Bid struct).\n` +
      `The chain predates the current Auction.sol. Rebuild with wiped volumes (from the repo root):\n` +
      `  docker-compose -f poc/stack/podman-compose.yml down -v && docker-compose -f poc/stack/podman-compose.yml up -d --build\n`
    );
    process.exit(2);
  }
  const r = new Report("E17b enforced auction", "once bid upon, an intent is only settleable through the genesis auction — the minOut bypass is closed; bid-free intents are unaffected");

  const s2key = Wallet.createRandom().privateKey;
  await waitReceipt(rpcA, await fundAccount(new Wallet(s2key).address, INPUT));
  const a1 = auction(rpcA.url);              // cow, genesis instance
  const solver2 = new Solver(rpcA.url, s2key);

  // --- an intent with an open auction: direct settles must fail, execute must win ---
  const btcTxid = getBytes(randomBytes(32));
  const user = freshWallet();
  const H = randomH();
  await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btcTxid), INPUT, bindingOf(H, user.address)));
  const intent = buildIntent(user, { H, btcTxid, expiry: (await rpcA.blockNumber()) + 90, minOut: MINOUT, outputToken: RBTC });
  await rpcA.sendRaw(intent.rawHex);

  r.check("bid placed on the genesis auction", succeeded(await waitReceipt(rpcA, await placeBid(a1, intent.rawHex, BID))));
  const { deadline } = await bidOf(a1, H);

  const inWindow = await waitReceipt(rpcA, await solver2.solve(intent.rawHex, MINOUT));
  r.check("direct settle DURING the window reverts", reverted(inWindow), inWindow ? inWindow.status : "no receipt");

  await waitFor(async () => BigInt(await rpcA.blockNumber()) >= deadline, 40000, 1000);
  const postWindow = await waitReceipt(rpcA, await solver2.solve(intent.rawHex, MINOUT));
  r.check("direct settle AFTER the window (pre-execute) still reverts — no execute front-run", reverted(postWindow), postWindow ? postWindow.status : "no receipt");
  r.check("H untouched by the rejected bypasses", !(await isConsumed((to, d) => rpcA.ethCall(to, d), H)));

  const solver1 = new Solver(rpcA.url); // cow — the bidder; execute() pays it the claimed input
  const cowBefore = BigInt(await rpcA.getBalance(solver1.payer));
  const exec = await waitReceipt(rpcA, await executeAuction(a1, intent.rawHex));
  r.check("execute settles through the auction", succeeded(exec), exec ? exec.status : "no receipt");
  r.check("user received the best bid", BigInt(await rpcA.getBalance(user.address)) === BID, `got=${await rpcA.getBalance(user.address)}`);
  // pull-payment: execute() credits the winner; the input arrives via withdraw()
  r.check("winning bidder withdraws its credited input", succeeded(await waitReceipt(rpcA, await withdrawCredit(a1))));
  const cowDelta = BigInt(await rpcA.getBalance(solver1.payer)) - cowBefore;
  r.check("winning bidder received the claimed input", cowDelta > INPUT - GAS_BOUND * 2n, `delta=${cowDelta}`);
  r.check("H consumed", await isConsumed((to, d) => rpcA.ethCall(to, d), H));

  // --- regression: a bid-free intent settles directly exactly as before ---
  const btcTxid2 = getBytes(randomBytes(32));
  const user2 = freshWallet();
  const H2 = randomH();
  await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btcTxid2), INPUT, bindingOf(H2, user2.address)));
  const intent2 = buildIntent(user2, { H: H2, btcTxid: btcTxid2, expiry: (await rpcA.blockNumber()) + 90, minOut: MINOUT, outputToken: RBTC });
  await rpcA.sendRaw(intent2.rawHex);
  const plain = await waitReceipt(rpcA, await solver2.solve(intent2.rawHex, MINOUT));
  r.check("regression: bid-free intent settles directly", succeeded(plain) && BigInt(await rpcA.getBalance(user2.address)) === MINOUT, plain ? plain.status : "no receipt");

  console.log(`\nthe bypass E17 demonstrated is closed: with an open auction, only execute() can settle — the user nets the best bid (${BID}), not minOut (${MINOUT}).`);
  return r.done();
}

main().then((c) => process.exit(c));
