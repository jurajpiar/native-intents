/**
 * E17 — Above-minOut auction, off-consensus (SDK-deployed Auction instance; Settlement does not enforce
 * it, since enforcement is keyed to the genesis auction address only).
 *
 * Part 1 (the mechanism): two bonded-in-spirit solvers bid above minOut; the outbid solver's escrow is
 * refunded; after the window closes, execute() settles — the user receives the BEST BID (minOut via
 * settle + surplus from the auction), the winner claims the escrowed input.
 *
 * Part 2 (the honest caveat): the base rule is first-valid-inclusion, so a solver can BYPASS an
 * unenforced auction and settle directly at minOut. The user then gets only minOut (the auction's
 * surplus is lost) and the stranded bidder reclaims their escrow. This is why the enforced variant
 * (E17b, genesis auction) exists.
 *
 * Falsifier (part 1): outbid escrow not refunded, premature execute succeeds, user doesn't receive the
 * best bid, or the winner doesn't get the input. Falsifier (part 2): the bypass fails (which would mean
 * enforcement exists where none was deployed) or the stranded bidder can't reclaim.
 */
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { Solver } from "../src/solver.js";
import { depositForPegin } from "../src/settlement.js";
import { deployAuction, auction, placeBid, executeAuction, reclaimBid, bidOf, withdrawCredit } from "../src/auction.js";
import { Report, preflight, requireSettlement, rpcA, fundAccount, waitReceipt, succeeded, reverted } from "./_harness.js";
import { RBTC } from "../src/config.js";
import { waitFor } from "../src/client.js";
import { getBytes, hexlify, randomBytes, Wallet } from "ethers";

const INPUT = 10_000_000_000_000_000n;    // 1e16 wei escrowed input
const MINOUT = 1_000_000_000_000_000n;    // 1e15 wei RBTC output
const BID1 = MINOUT + 200_000_000_000_000n; // 1.2e15
const BID2 = MINOUT + 500_000_000_000_000n; // 1.5e15 — wins
const GAS_BOUND = 3_000_000_000_000n;

async function main(): Promise<number> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  const r = new Report("E17 off-consensus auction", "solvers bid above minOut; the user receives the best bid; but an unenforced auction is bypassable at minOut");

  const auctionAddr = await deployAuction(rpcA.url);        // cow deploys; unenforced instance
  const s2key = Wallet.createRandom().privateKey;
  await waitReceipt(rpcA, await fundAccount(new Wallet(s2key).address, INPUT));
  const a1 = auction(rpcA.url, undefined, auctionAddr);     // cow's handle
  const a2 = auction(rpcA.url, s2key, auctionAddr);
  const solver1 = new Solver(rpcA.url);                     // cow
  const solver2 = new Solver(rpcA.url, s2key);

  // --- part 1: the auction, respected ---
  const btcTxid1 = getBytes(randomBytes(32));
  const user1 = freshWallet();
  const H1 = randomH();
  await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btcTxid1), INPUT, hexlify(H1)));
  const h = await rpcA.blockNumber();
  const intent1 = buildIntent(user1, { H: H1, btcTxid: btcTxid1, expiry: h + 90, minOut: MINOUT, outputToken: RBTC });
  await rpcA.sendRaw(intent1.rawHex);

  const s1Before = BigInt(await rpcA.getBalance(solver1.payer));
  r.check("first bid opens the window", succeeded(await waitReceipt(rpcA, await placeBid(a1, intent1.rawHex, BID1))));
  const { deadline } = await bidOf(a1, H1);
  const s2Before = BigInt(await rpcA.getBalance(solver2.payer));
  r.check("higher bid replaces it", succeeded(await waitReceipt(rpcA, await placeBid(a2, intent1.rawHex, BID2))));
  const s1Mid = BigInt(await rpcA.getBalance(solver1.payer));
  r.check("outbid solver's escrow refunded (lost only gas)", s1Before - s1Mid < GAS_BOUND, `spent=${s1Before - s1Mid}`);

  const early = await waitReceipt(rpcA, await executeAuction(a1, intent1.rawHex).catch(() => "0x" + "0".repeat(64)));
  r.check("premature execute rejected", early === null || reverted(early), early ? early.status : "not mined");

  await waitFor(async () => BigInt(await rpcA.blockNumber()) >= deadline, 40000, 1000);
  const exec = await waitReceipt(rpcA, await executeAuction(a1, intent1.rawHex));
  r.check("execute after the window succeeded", succeeded(exec), exec ? exec.status : "no receipt");
  r.check("user received the BEST BID (minOut + surplus)", BigInt(await rpcA.getBalance(user1.address)) === BID2, `got=${await rpcA.getBalance(user1.address)}`);
  // pull-payment: the input is CREDITED to the winner, who withdraws in a separate tx
  r.check("winner withdraws its credited input", succeeded(await waitReceipt(rpcA, await withdrawCredit(a2))));
  const s2Delta = BigInt(await rpcA.getBalance(solver2.payer)) - s2Before;
  r.check("winner claimed the input net of its bid", s2Delta > INPUT - BID2 - GAS_BOUND * 2n, `delta=${s2Delta}`);
  r.check("H consumed via the auction", await isConsumed((to, d) => rpcA.ethCall(to, d), H1));

  // --- part 2: the bypass (unenforced instance) ---
  const btcTxid2 = getBytes(randomBytes(32));
  const user2 = freshWallet();
  const H2 = randomH();
  await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btcTxid2), INPUT, hexlify(H2)));
  const intent2 = buildIntent(user2, { H: H2, btcTxid: btcTxid2, expiry: (await rpcA.blockNumber()) + 90, minOut: MINOUT, outputToken: RBTC });
  await rpcA.sendRaw(intent2.rawHex);

  await waitReceipt(rpcA, await placeBid(a1, intent2.rawHex, BID1));       // s1 commits to the auction
  const direct = await waitReceipt(rpcA, await solver2.solve(intent2.rawHex, MINOUT)); // s2 ignores it
  r.check("bypass: direct settle at minOut succeeded despite the open auction", succeeded(direct), direct ? direct.status : "no receipt");
  r.check("bypass: user got only minOut (auction surplus lost)", BigInt(await rpcA.getBalance(user2.address)) === MINOUT);

  const s1Before2 = BigInt(await rpcA.getBalance(solver1.payer));
  r.check("stranded bidder reclaims escrow", succeeded(await waitReceipt(rpcA, await reclaimBid(a1, H2))));
  const reclaimed = BigInt(await rpcA.getBalance(solver1.payer)) - s1Before2;
  r.check("reclaim returned the full bid (minus gas)", reclaimed > BID1 - GAS_BOUND, `delta=${reclaimed}`);

  console.log(`\npart 1: user paid ${BID2} (best bid) instead of ${MINOUT}. part 2: unenforced auctions are bypassable — see E17b for the enforced variant.`);
  return r.done();
}

main().then((c) => process.exit(c));
