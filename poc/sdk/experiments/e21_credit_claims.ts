/**
 * E21 — Credits are CLAIMABLE, refunds are UNGRIEFABLE, and stale auctions resolve: the credit-ledger
 * and auction edges E18/E20 record but never collect.
 *
 *  part 1: EXCESS + INPUT CREDIT (Settlement) — an unpayable contract solver direct-settles an rbtc
 *          intent overpaying minOut: delivery succeeds, and BOTH its excess refund and input release
 *          downgrade to credits (pre-fix: "refund failed" / "input claim failed" reverted delivery).
 *  part 2: CREDITS ARE MONEY — a toggleable receiver (Turncoat) accrues Settlement credit while
 *          unpayable, then flips its receive() on and withdraws: balance actually moves. A ledger
 *          nobody can collect from would be bookkeeping theatre; this closes the loop.
 *  part 3: ERC-20 REFUND CREDIT + withdrawToken (Auction) — an outbid bidder whose token transfers
 *          are blocked (PoisonToken) cannot block the higher bid; its refund becomes creditToken,
 *          recovered via withdrawToken once unblocked. The auction still executes: user gets the
 *          best bid in tokens.
 *  part 4: EXECUTE AFTER DECAY — exclusivity decay (F3) reopens direct settlement but execute()
 *          remains valid until H is consumed: a post-decay execute still pays the user the BEST BID,
 *          not minOut.
 *  part 5: RECLAIM AT EXPIRY — a bid-upon intent that expires unexecuted returns its escrow via
 *          reclaim() on the expiry condition (E17/E18 only ever exercised the H-consumed condition).
 *
 * Falsifier: delivery reverts on an unpayable solver's refund, a credited amount cannot be withdrawn
 * (or withdraws twice), a blocked-token refund blocks the outbid or vanishes, a post-decay execute
 * pays minOut instead of the bid (or reverts), or the expiry reclaim loses escrow.
 *
 * Needs the E21 genesis (Settlement credit ledger + hardened auction): down -v + rebuild if the probe fails.
 */
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { depositForPegin, settlementCreditOf } from "../src/settlement.js";
import { auction, placeBid, placeBidToken, executeAuction, reclaimBid, bidOf, lockedUntil, withdrawCredit, creditOf } from "../src/auction.js";
import { Report, preflight, requireSettlement, rpcA, fundAccount, waitReceipt, succeeded, reverted } from "./_harness.js";
import { AUCTION_ADDR, CHAIN_ID, COW_KEY, RBTC, SETTLEMENT_ADDR } from "../src/config.js";
import { waitFor } from "../src/client.js";
import settlementAbi from "../src/abi/Settlement.json" with { type: "json" };
import turncoatArtifact from "../src/abi/Turncoat.json" with { type: "json" };
import poisonArtifact from "../src/abi/PoisonToken.json" with { type: "json" };
import { Contract, ContractFactory, Interface, JsonRpcProvider, Network, Wallet, getBytes, hexlify, randomBytes } from "ethers";

const INPUT = 10_000_000_000_000_000n;
const MINOUT = 1_000_000_000_000_000n;
const EXCESS = 500_000_000_000_000n;
const GAS_BOUND = 3_000_000_000_000n;
const ov = { gasLimit: 900_000, gasPrice: 1_000_000, type: 0, chainId: CHAIN_ID } as const;

function wal(key: string = COW_KEY): Wallet {
  const provider = new JsonRpcProvider(rpcA.url, new Network("rsk-regtest", CHAIN_ID), { staticNetwork: true });
  return new Wallet(key, provider);
}

async function main(): Promise<number> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  try { await settlementCreditOf(rpcA.url, "0x" + "0".repeat(40)); }
  catch {
    console.error(`\nSettlement predates the credit ledger. Rebuild from the repo root:\n` +
      `  docker-compose -f poc/stack/podman-compose.yml down -v && docker-compose -f poc/stack/podman-compose.yml up -d --build\n`);
    process.exit(2);
  }
  const r = new Report("E21 credit claims",
    "credits recorded by the pull-payment hardening are actually collectable, token refunds cannot be griefed, and stale auctions resolve by execute-after-decay or expiry reclaim");

  const cow = wal();
  const iface = new Interface(settlementAbi as import("ethers").InterfaceAbi);

  /** fresh rbtc intent with escrow deposited and raw tx broadcast */
  async function freshRbtc(expiryBlocks: number, outputToken: string = RBTC) {
    const btcTxid = getBytes(randomBytes(32));
    await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btcTxid), INPUT));
    const user = freshWallet();
    const H = randomH();
    const intent = buildIntent(user, { H, btcTxid, expiry: (await rpcA.blockNumber()) + expiryBlocks, minOut: MINOUT, outputToken });
    await rpcA.sendRaw(intent.rawHex);
    return { user, H, intent };
  }

  // ---- part 1: unpayable direct solver — excess + input both credited, delivery unharmed ----
  const tf = new ContractFactory(turncoatArtifact.abi, turncoatArtifact.bytecode, cow);
  const tdep = await tf.deploy({ ...ov, gasLimit: 1_500_000 });
  await tdep.waitForDeployment();
  const tcAddr = await tdep.getAddress();
  const turncoat = new Contract(tcAddr, turncoatArtifact.abi, cow);
  r.check("turncoat deployed (receive() toggled OFF)", (await rpcA.getCode(tcAddr)) !== "0x");

  const p1 = await freshRbtc(80);
  const solveData = iface.encodeFunctionData("settle", [p1.intent.rawHex]);
  const rec1 = await waitReceipt(rpcA, (await turncoat.exec(SETTLEMENT_ADDR, solveData, { ...ov, value: MINOUT + EXCESS })).hash);
  r.check("p1: unpayable solver's OVERPAID settle succeeds (pre-fix: 'refund failed' reverted it)", succeeded(rec1), rec1 ? rec1.status : "no receipt");
  r.check("p1: user delivered exactly minOut", BigInt(await rpcA.getBalance(p1.user.address)) === MINOUT);
  r.check("p1: H consumed", await isConsumed((to, d) => rpcA.ethCall(to, d), p1.H));
  const cred1 = await settlementCreditOf(rpcA.url, tcAddr);
  r.check("p1: excess + input credited, not pushed", cred1 === EXCESS + INPUT, `credit=${cred1}`);

  // ---- part 2: credits are money — flip receive() on, withdraw, balance moves ----
  const wdFail = await waitReceipt(rpcA, (await turncoat.doWithdraw(SETTLEMENT_ADDR, { ...ov, gasLimit: 300_000 })).hash).catch(() => null);
  r.check("p2: withdraw fails while unpayable (isolated)", wdFail === null || reverted(wdFail), wdFail ? wdFail.status : "not mined");
  await waitReceipt(rpcA, (await turncoat.setAccept(true, ov)).hash);
  const tcBefore = BigInt(await rpcA.getBalance(tcAddr));
  const wdOk = await waitReceipt(rpcA, (await turncoat.doWithdraw(SETTLEMENT_ADDR, { ...ov, gasLimit: 300_000 })).hash);
  r.check("p2: withdraw succeeds once receivable", succeeded(wdOk), wdOk ? wdOk.status : "no receipt");
  r.check("p2: the credited RBTC actually arrived", BigInt(await rpcA.getBalance(tcAddr)) - tcBefore === EXCESS + INPUT);
  r.check("p2: ledger zeroed — no double withdraw", (await settlementCreditOf(rpcA.url, tcAddr)) === 0n);

  // ---- part 3: poisoned outbid refund -> creditToken -> withdrawToken; auction completes on top ----
  const pf = new ContractFactory(poisonArtifact.abi, poisonArtifact.bytecode, cow);
  const pdep = await pf.deploy({ ...ov, gasLimit: 1_500_000 });
  await pdep.waitForDeployment();
  const psnAddr = await pdep.getAddress();
  const poison = new Contract(psnAddr, poisonArtifact.abi, cow);
  const s2key = Wallet.createRandom().privateKey;
  const s2 = new Wallet(s2key).address;
  await waitReceipt(rpcA, await fundAccount(s2, INPUT));
  const p3 = await freshRbtc(80, psnAddr);
  const BID1 = MINOUT + 100_000_000_000_000n, BID2 = MINOUT + 200_000_000_000_000n;

  // pre-arm cow's outbid BEFORE the first bid opens the 10-block window (keeps the race comfortable)
  const a1 = auction(rpcA.url);
  await waitReceipt(rpcA, (await poison.mint(cow.address, BID2, ov)).hash);
  await waitReceipt(rpcA, (await poison.approve(AUCTION_ADDR, BID2, ov)).hash);

  // s2 acquires + bids poison tokens, then gets BLOCKED so its refund transfer must fail
  await waitReceipt(rpcA, (await poison.mint(s2, BID1, ov)).hash);
  const poisonS2 = new Contract(psnAddr, poisonArtifact.abi, wal(s2key));
  await waitReceipt(rpcA, (await poisonS2.approve(AUCTION_ADDR, BID1, ov)).hash);
  const a2 = auction(rpcA.url, s2key);
  r.check("p3: first token bid escrows", succeeded(await waitReceipt(rpcA, await placeBidToken(a2, p3.intent.rawHex, BID1))));
  await waitReceipt(rpcA, (await poison.setBlocked(s2, true, ov)).hash);

  const outbid = await waitReceipt(rpcA, await placeBidToken(a1, p3.intent.rawHex, BID2));
  r.check("p3: higher bid lands over the blocked bidder (pre-fix: 'outbid refund failed')", succeeded(outbid), outbid ? outbid.status : "no receipt");
  const tokCred = await (a1 as Contract).creditToken(psnAddr, s2);
  r.check("p3: blocked refund downgraded to creditToken", tokCred === BID1, `credit=${tokCred}`);

  await waitReceipt(rpcA, (await poison.setBlocked(s2, false, ov)).hash);
  const a2c = a2 as Contract;
  r.check("p3: withdrawToken recovers the refund once unblocked", succeeded(await waitReceipt(rpcA, (await a2c.withdrawToken(psnAddr, ov)).hash)));
  r.check("p3: tokens back with the outbid bidder", (await poison.balanceOf(s2)) === BID1);

  const b3 = await bidOf(a1, p3.H);
  await waitFor(async () => BigInt(await rpcA.blockNumber()) >= b3.deadline, 60000, 1000);
  r.check("p3: auction still executes over all of it", succeeded(await waitReceipt(rpcA, await executeAuction(a1, p3.intent.rawHex))));
  r.check("p3: user received the best bid in tokens", (await poison.balanceOf(p3.user.address)) === BID2);

  // ---- part 4: execute AFTER decay still pays the best bid ----
  const p4 = await freshRbtc(60);
  const BID = MINOUT + 300_000_000_000_000n;
  await waitReceipt(rpcA, await placeBid(a1, p4.intent.rawHex, BID));
  const b4 = await bidOf(a1, p4.H);
  const grace: bigint = await (a1 as Contract).GRACE();
  console.log(`p4: waiting past deadline + GRACE (block ${b4.deadline + grace})…`);
  await waitFor(async () => BigInt(await rpcA.blockNumber()) >= b4.deadline + grace, 90000, 1000);
  r.check("p4: lock decayed", (await lockedUntil(a1, p4.H)) === 0n);
  r.check("p4: execute still valid post-decay", succeeded(await waitReceipt(rpcA, await executeAuction(a1, p4.intent.rawHex))));
  r.check("p4: user got the BEST BID, not minOut", BigInt(await rpcA.getBalance(p4.user.address)) === BID);
  r.check("p4: winner's input credited for sweep", (await creditOf(a1, cow.address)) >= INPUT);
  await waitReceipt(rpcA, await withdrawCredit(a1)); // tidy the ledger for part 5's balance check

  // ---- part 5: reclaim on the EXPIRY condition ----
  const p5 = await freshRbtc(25); // deadline = +10, decay = +20, expiry = +25 — never executed
  await waitReceipt(rpcA, await placeBid(a1, p5.intent.rawHex, BID));
  const early = await waitReceipt(rpcA, await reclaimBid(a1, p5.H).catch(() => "0x" + "0".repeat(64)));
  r.check("p5: reclaim before expiry rejected ('auction still live')", early === null || reverted(early), early ? early.status : "not mined");
  const p5exp = (await bidOf(a1, p5.H)).deadline; // deadline known; expiry = creation + 25
  console.log(`p5: waiting for intent expiry…`);
  await waitFor(async () => !((await rpcA.blockNumber()) < Number(p5exp) + 15), 90000, 1000); // deadline+15 >= expiry
  const before5 = BigInt(await rpcA.getBalance(cow.address));
  const rec5 = await waitReceipt(rpcA, await reclaimBid(a1, p5.H));
  r.check("p5: reclaim after expiry returns the escrow", succeeded(rec5), rec5 ? rec5.status : "no receipt");
  r.check("p5: full bid recovered (minus gas)", BigInt(await rpcA.getBalance(cow.address)) - before5 > BID - GAS_BOUND);

  console.log("\nthe ledgers are real: every credit was collected, the poisoned refund could not stop the market,");
  console.log("and stale auctions end in execute-after-decay or an expiry reclaim — never stuck escrow.");
  return r.done();
}

main().then((c) => process.exit(c));
