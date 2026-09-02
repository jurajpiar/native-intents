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
 *  part 3: EXCLUSIVITY DECAYS — if execute() has not landed within GRACE blocks of the
 *          deadline, lockedUntil() returns 0 and direct settlement reopens at minOut, so a
 *          persistently failing auction cannot hold the intent hostage until expiry.
 *
 * Falsifier: execute() reverts with an unpayable winner (the brick survives), an unpayable
 * outbid bidder blocks higher bids, a failed withdraw corrupts or drains the credit ledger,
 * or the lock fails to decay (or decays while still inside the grace window).
 *
 * Needs the hardened genesis auction (pull-payments + GRACE): down -v + rebuild if stale.
 */
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { Solver } from "../src/solver.js";
import { depositForPegin } from "../src/settlement.js";
import { auction, placeBid, executeAuction, reclaimBid, bidOf, withdrawCredit, creditOf, lockedUntil } from "../src/auction.js";
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

/** A fresh intent with its peg-in escrow deposited and the raw tx broadcast. */
async function freshIntent() {
  const btcTxid = getBytes(randomBytes(32));
  await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btcTxid), INPUT));
  const user = freshWallet();
  const H = randomH();
  const intent = buildIntent(user, { H, btcTxid, expiry: (await rpcA.blockNumber()) + 90, minOut: MINOUT, outputToken: RBTC });
  await rpcA.sendRaw(intent.rawHex);
  return { user, H, intent };
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
    "an unpayable winner or outbid bidder loses alone (pull-payment credits), and exclusivity decays GRACE blocks after the deadline instead of holding the intent to expiry"
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

  // ---- part 3: exclusivity DECAYS — a never-executing auction cannot hold the intent to expiry ----
  const p3 = await freshIntent();
  await waitReceipt(rpcA, await placeBid(a1, p3.intent.rawHex, BID));
  const bid3 = await bidOf(a1, p3.H);
  const solver2 = new Solver(rpcA.url, s2key);

  await waitFor(async () => BigInt(await rpcA.blockNumber()) >= bid3.deadline, 60000, 1000);
  const inGrace = await waitReceipt(rpcA, await solver2.solve(p3.intent.rawHex, MINOUT));
  r.check("inside the grace window the lock still holds (no execute front-run)", reverted(inGrace), inGrace ? inGrace.status : "no receipt");

  await waitFor(async () => BigInt(await rpcA.blockNumber()) >= bid3.deadline + grace, 90000, 1000);
  r.check("lockedUntil reports 0 after deadline + GRACE", (await lockedUntil(a1, p3.H)) === 0n);
  const late = await waitReceipt(rpcA, await solver2.solve(p3.intent.rawHex, MINOUT));
  r.check("direct settle reopens at minOut after decay (pre-fix: hostage until expiry)", succeeded(late), late ? late.status : "no receipt");
  r.check("user received minOut (surplus forfeited — the documented decay trade-off)", BigInt(await rpcA.getBalance(p3.user.address)) === MINOUT);

  const cowBefore = BigInt(await rpcA.getBalance(cow.address));
  r.check("stale bidder reclaims its full escrow (H consumed)", succeeded(await waitReceipt(rpcA, await reclaimBid(a1, p3.H))));
  const reclaimed = BigInt(await rpcA.getBalance(cow.address)) - cowBefore;
  r.check("reclaim returned the bid (minus gas)", reclaimed > BID - GAS_BOUND, `delta=${reclaimed}`);

  console.log("\nfailure is now contained: unpayable payees lose alone, and a stuck auction degrades to open competition at minOut instead of killing the intent.");
  return r.done();
}

main().then((c) => process.exit(c));
