/**
 * E18 — Failure containment after a solver wins (pull-payments + lock decay).
 *
 * Hardens the post-win revert paths the atlas calls S4/S5:
 *  part 1: an UNPAYABLE WINNER (contract with no receive) can no longer brick the intent —
 *          execute() succeeds, the user is paid in full, and the winner's input becomes a
 *          pull-payment credit it can never claim (its loss alone). Pre-fix: every execute()
 *          reverted "winner pay failed" until the intent died at expiry.
 *  part 2: an UNPAYABLE OUTBID BIDDER can no longer block price discovery — a higher bid
 *          succeeds and the refund downgrades to a credit. Pre-fix: bid() reverted
 *          "outbid refund failed", freezing the auction at the griefer's price.
 *  part 3: EXCLUSIVITY DOES NOT DECAY ON TIME — GRACE blocks past the deadline with nothing
 *          having failed, the lock still holds and a direct settle at minOut is still refused, so a
 *          producer cannot take an auctioned intent at the floor simply by withholding execute().
 *  part 4: BUT THE SAFETY VALVE REMAINS — once execute() is actually attempted and the settlement
 *          inside it reverts, that failure is RECORDED (execute returns rather than reverting, or
 *          the record would roll back with it) and exclusivity ends GRACE blocks later.
 *
 * Falsifier: execute() reverts with an unpayable winner (the brick survives), an unpayable
 * outbid bidder blocks higher bids, a failed withdraw corrupts or drains the credit ledger,
 * the lock decays with nothing having failed (the M3 squeeze reopens), or a demonstrated
 * failure never releases the intent (the S4 brick returns).
 *
 * Needs the hardened genesis auction (pull-payments + GRACE): down -v + rebuild if stale.
 */
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { Solver } from "../src/solver.js";
import { depositForPegin, bindingOf } from "../src/settlement.js";
import { auction, placeBid, executeAuction, reclaimBid, bidOf, withdrawCredit, creditOf, lockedUntil, failedAtOf } from "../src/auction.js";
import { Report, preflight, requireSettlement, rpcA, fundAccount, waitReceipt, succeeded, reverted } from "./_harness.js";
import { AUCTION_ADDR, CHAIN_ID, COW_KEY, RBTC } from "../src/config.js";
import { waitFor } from "../src/client.js";
import { Contract, ContractFactory, JsonRpcProvider, Network, Wallet, getBytes, hexlify, randomBytes } from "ethers";
import grieferArtifact from "../src/abi/Griefer.json" with { type: "json" };

const INPUT = 10_000_000_000_000_000n;
const MINOUT = 1_000_000_000_000_000n;
const BID = MINOUT + 400_000_000_000_000n;      // 1.4e15
const BID_HIGH = MINOUT + 600_000_000_000_000n; // 1.6e15
const GAS_BOUND = 3_000_000_000_000n;
const ov = { gasLimit: 900_000, gasPrice: 1_000_000, type: 0, chainId: CHAIN_ID } as const;

type Artifact = { abi: import("ethers").InterfaceAbi; bytecode: string };
const art = grieferArtifact as Artifact;

function cowWallet(rpcUrl: string): Wallet {
  const provider = new JsonRpcProvider(rpcUrl, new Network("rsk-regtest", CHAIN_ID), { staticNetwork: true });
  return new Wallet(COW_KEY, provider);
}

/**
 * A fresh intent with its peg-in escrow deposited and the raw tx broadcast.
 *
 * `expirySpan` is a parameter because part 4 needs an intent that can be allowed to EXPIRE within a
 * test's patience: letting it die is the cheapest way to make the settlement inside execute() revert
 * for real, which is what exclusivity now decays from. The auction requires WINDOW < span, so the
 * short form still has to leave room for a full bidding window.
 */
async function freshIntent(expirySpan = 90) {
  const btcTxid = getBytes(randomBytes(32));
  const user = freshWallet();
  const H = randomH();
  await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btcTxid), INPUT, bindingOf(H, user.address)));
  const expiry = (await rpcA.blockNumber()) + expirySpan;
  const intent = buildIntent(user, { H, btcTxid, expiry, minOut: MINOUT, outputToken: RBTC });
  await rpcA.sendRaw(intent.rawHex);
  return { user, H, intent, expiry };
}

async function main(): Promise<number> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  const a1 = auction(rpcA.url); // cow, genesis instance
  const grace: bigint = await (a1 as Contract).GRACE().catch(() => -1n);
  if (grace < 0n) {
    console.error(
      `\nGenesis auction at ${AUCTION_ADDR} predates the failure-containment patch (no GRACE()).\n` +
      `Rebuild with wiped volumes (from the repo root):\n` +
      `  docker-compose -f poc/stack/podman-compose.yml down -v && docker-compose -f poc/stack/podman-compose.yml up -d --build\n`
    );
    process.exit(2);
  }
  const r = new Report(
    "E18 failure containment",
    "an unpayable winner or outbid bidder loses alone (pull-payment credits), and exclusivity decays GRACE blocks after execute() is SEEN TO FAIL — never on elapsed time alone, which would hand the intent to whoever withholds execute()"
  );

  const cow = cowWallet(rpcA.url);
  const factory = new ContractFactory(art.abi, art.bytecode, cow);
  const deployed = await factory.deploy({ gasLimit: 1_500_000, gasPrice: 1_000_000, type: 0, chainId: CHAIN_ID });
  await deployed.waitForDeployment();
  const grieferAddr = await deployed.getAddress();
  const griefer = new Contract(grieferAddr, art.abi, cow);
  r.check("griefer (contract with no receive) deployed", (await rpcA.getCode(grieferAddr)) !== "0x");

  // ---- part 1: unpayable WINNER cannot brick the intent (the former S5 "winner pay failed") ----
  const p1 = await freshIntent();
  r.check("griefer's bid lands via its contract", succeeded(await waitReceipt(rpcA, (await griefer.doBid(AUCTION_ADDR, p1.intent.rawHex, { ...ov, value: BID })).hash)));
  const bid1 = await bidOf(a1, p1.H);
  r.check("griefer is the standing winner", bid1.bidder === grieferAddr, `bidder=${bid1.bidder}`);
  await waitFor(async () => BigInt(await rpcA.blockNumber()) >= bid1.deadline, 60000, 1000);

  const exec1 = await waitReceipt(rpcA, await executeAuction(a1, p1.intent.rawHex));
  r.check("execute SUCCEEDS despite the unpayable winner (pre-fix: 'winner pay failed' brick)", succeeded(exec1), exec1 ? exec1.status : "no receipt");
  r.check("user still paid in full (best bid)", BigInt(await rpcA.getBalance(p1.user.address)) === BID, `got=${await rpcA.getBalance(p1.user.address)}`);
  r.check("H consumed — settlement final", await isConsumed((to, d) => rpcA.ethCall(to, d), p1.H));
  const cred1 = await creditOf(a1, grieferAddr);
  r.check("winner's input credited, not pushed", cred1 === INPUT, `credit=${cred1}`);

  // withdraw isolation: the griefer's own claim fails (it rejects RBTC) and damages nothing
  const wd = await waitReceipt(rpcA, (await griefer.doWithdraw(AUCTION_ADDR, ov)).hash).catch(() => null);
  r.check("griefer's withdraw fails in its OWN tx only", wd === null || reverted(wd), wd ? wd.status : "not mined");
  r.check("credit ledger untouched by the failed withdraw", (await creditOf(a1, grieferAddr)) === INPUT);

  // ---- part 2: unpayable OUTBID bidder cannot block price discovery ----
  const p2 = await freshIntent();
  await waitReceipt(rpcA, (await griefer.doBid(AUCTION_ADDR, p2.intent.rawHex, { ...ov, value: BID })).hash);
  const credBefore = await creditOf(a1, grieferAddr);
  const s2key = Wallet.createRandom().privateKey;
  await waitReceipt(rpcA, await fundAccount(new Wallet(s2key).address, INPUT));
  const a2 = auction(rpcA.url, s2key);
  const outbid = await waitReceipt(rpcA, await placeBid(a2, p2.intent.rawHex, BID_HIGH));
  r.check("higher bid lands over the unpayable bidder (pre-fix: 'outbid refund failed')", succeeded(outbid), outbid ? outbid.status : "no receipt");
  r.check("griefer's refund downgraded to a credit", (await creditOf(a1, grieferAddr)) - credBefore === BID, `delta=${(await creditOf(a1, grieferAddr)) - credBefore}`);

  const bid2 = await bidOf(a1, p2.H);
  await waitFor(async () => BigInt(await rpcA.blockNumber()) >= bid2.deadline, 60000, 1000);
  const s2before = BigInt(await rpcA.getBalance(new Wallet(s2key).address));
  r.check("execute settles at the honest bid", succeeded(await waitReceipt(rpcA, await executeAuction(a1, p2.intent.rawHex))));
  r.check("user received the honest best bid", BigInt(await rpcA.getBalance(p2.user.address)) === BID_HIGH);
  r.check("honest winner withdraws its credited input", succeeded(await waitReceipt(rpcA, await withdrawCredit(a2))));
  const s2delta = BigInt(await rpcA.getBalance(new Wallet(s2key).address)) - s2before;
  r.check("honest winner made whole (input, net of gas)", s2delta > INPUT - GAS_BOUND * 2n, `delta=${s2delta}`);

  // ---- part 3: exclusivity decays on DEMONSTRATED FAILURE, not on elapsed time ----------------
  //
  // This part used to assert the opposite: wait GRACE blocks past the deadline and a direct settle
  // reopens at minOut. That rule handed every auctioned intent to whoever controlled block
  // production — decline to include execute(), wait, then settle at the floor around a higher bid
  // (attack M3). And for an RBTC intent it had no legitimate use at all: the auction holds the
  // winning bid, so the settle inside execute() cannot fail for want of funds. The only party who
  // ever reached a time-based decay was one who chose not to execute.
  const p3 = await freshIntent();
  await waitReceipt(rpcA, await placeBid(a1, p3.intent.rawHex, BID));
  const bid3 = await bidOf(a1, p3.H);
  const solver2 = new Solver(rpcA.url, s2key);

  await waitFor(async () => BigInt(await rpcA.blockNumber()) >= bid3.deadline, 60000, 1000);
  const inGrace = await waitReceipt(rpcA, await solver2.solve(p3.intent.rawHex, MINOUT));
  r.check("past the deadline, the lock still holds (no execute front-run)", reverted(inGrace), inGrace ? inGrace.status : "no receipt");

  await waitFor(async () => BigInt(await rpcA.blockNumber()) >= bid3.deadline + grace, 90000, 1000);
  r.check("GRACE blocks later the lock STILL holds — nothing has failed", (await lockedUntil(a1, p3.H)) === bid3.deadline,
    `lockedUntil=${await lockedUntil(a1, p3.H)} (was 0 under the old time-based rule)`);
  const late = await waitReceipt(rpcA, await solver2.solve(p3.intent.rawHex, MINOUT));
  r.check("so a direct settle at minOut is still REFUSED — the M3 decay squeeze is closed", reverted(late), late ? late.status : "no receipt");
  r.check("no failure has been recorded, because none happened", (await failedAtOf(a1, p3.H)) === 0n);

  const userBefore3 = BigInt(await rpcA.getBalance(p3.user.address));
  r.check("and the auction still executes, paying the BEST BID rather than the floor",
    succeeded(await waitReceipt(rpcA, await executeAuction(a1, p3.intent.rawHex))));
  r.check("user received the best bid, not minOut", BigInt(await rpcA.getBalance(p3.user.address)) - userBefore3 === BID,
    `delta=${BigInt(await rpcA.getBalance(p3.user.address)) - userBefore3}`);

  // ---- part 4: the safety valve still exists, but a real failure has to be shown -------------
  //
  // Letting the intent EXPIRE is the cheapest way to make the settle inside execute() genuinely
  // revert, which is what the decay now keys on. The intent is worthless by then, so this tests the
  // MECHANISM (record → GRACE → release) rather than a scenario worth rescuing.
  const p4 = await freshIntent(20); // short-lived on purpose: expiry is the cheap way to wedge it
  await waitReceipt(rpcA, await placeBid(a1, p4.intent.rawHex, BID));
  console.log(`p4: waiting for the intent to expire at block ${p4.expiry} so execute() genuinely fails…`);
  await waitFor(async () => BigInt(await rpcA.blockNumber()) >= BigInt(p4.expiry), 180000, 1000);

  const failedExec = await waitReceipt(rpcA, await executeAuction(a1, p4.intent.rawHex));
  r.check("execute() on a wedged auction does NOT revert — it records the failure", succeeded(failedExec),
    failedExec ? failedExec.status : "no receipt");
  const noted = await failedAtOf(a1, p4.H);
  r.check("the failure is on record (a revert would have rolled it back)", noted > 0n, `failedAt=${noted}`);
  r.check("the auction stayed open for a retry, not closed", (await lockedUntil(a1, p4.H)) !== 0n);
  await waitFor(async () => BigInt(await rpcA.blockNumber()) >= noted + grace, 90000, 1000);
  r.check("GRACE blocks after the recorded failure, exclusivity decays", (await lockedUntil(a1, p4.H)) === 0n);

  const cowBefore = BigInt(await rpcA.getBalance(cow.address));
  r.check("stale bidder reclaims its full escrow", succeeded(await waitReceipt(rpcA, await reclaimBid(a1, p4.H))));
  const reclaimed = BigInt(await rpcA.getBalance(cow.address)) - cowBefore;
  r.check("reclaim returned the bid (minus gas)", reclaimed > BID - GAS_BOUND, `delta=${reclaimed}`);

  console.log("\nfailure is contained: unpayable payees lose alone, and exclusivity ends when execute() is");
  console.log("SEEN to fail rather than when a timer expires — so withholding execute() no longer wins the intent.");
  return r.done();
}

main().then((c) => process.exit(c));
