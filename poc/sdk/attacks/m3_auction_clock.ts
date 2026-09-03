/**
 * M3 — STARVE AN AUCTION BY CONTROLLING THE CLOCK, THEN TAKE IT AT THE FLOOR.
 *
 * The auction's two time limits are both measured in BLOCKS: `WINDOW` blocks of bidding after the
 * first bid, and exclusivity decaying `GRACE` blocks after that deadline. Denominating a deadline in
 * blocks is the normal thing to do, and against ordinary users it behaves like a clock. Against a
 * MINER it is not a clock at all: it is a counter the adversary increments.
 *
 * That turns both limits into instruments. Two attacks, one per limit:
 *
 *   WINDOW SQUEEZE   Bid the floor, then mine the entire bidding window in a single burst. Rivals do
 *                    not lose the auction — they never get to enter it, because by the time a human or
 *                    a bot can react, ten blocks have passed. The window is real in blocks and zero in
 *                    wall-clock time.
 *   DECAY SQUEEZE    Let a rival win the auction honestly, then simply decline to mine execute() until
 *                    exclusivity decays, and settle directly at minOut. FIXED — this half is now a
 *                    regression test: exclusivity decays GRACE blocks after execute() is SEEN to
 *                    fail, not GRACE blocks after the deadline, so withholding execute() releases
 *                    nothing and the direct settle is still refused.
 *
 * The second one was the more uncomfortable finding, because the decay was OUR OWN FIX: GRACE was
 * added so an auction whose execute() reverts forever cannot brick an intent (S4), and it doubled as
 * a permissionless route to the floor price for whoever produces blocks. Worse, for an RBTC intent it
 * had no legitimate trigger at all — the auction holds the winning bid, so the settle inside execute()
 * cannot fail for want of funds, and the only party who ever reached a time-based decay was one who
 * chose not to execute. Keying the decay on demonstrated failure keeps the safety valve and removes
 * the lever.
 *
 * Note what is NOT at risk in either case: minOut is honoured, H is consumed exactly once, and the
 * outbid rival can reclaim its stake. The loss is the SURPLUS the auction exists to discover — a
 * competition harm, not a theft. `contained` would be too generous, though: the user is measurably
 * worse off than the mechanism promises, so the honest verdict is that it succeeds.
 *
 * Needs on-demand mining, so it declares the reorg stack. The attack is not about reorgs — it is about
 * being the party who decides when a block happens, which is the only stack that can express that.
 *
 * Falsifier: rivals can still bid after the window is mined out (a wall-clock component exists after
 * all), the post-decay direct settle is refused, minOut is not honoured, or a reclaim fails.
 */
import { Contract, JsonRpcProvider, Network, NonceManager, Wallet, getBytes, hexlify, randomBytes } from "ethers";
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { depositForPegin, peginOf, bindingOf } from "../src/settlement.js";
import { auction, placeBid, bidOf, executeAuction, lockedUntil, failedAtOf } from "../src/auction.js";
import { Solver } from "../src/solver.js";
import { AUCTION_ADDR, CHAIN_ID, COW_KEY } from "../src/config.js";
import auctionArtifact from "../src/abi/Auction.json" with { type: "json" };
import { fundAccount, waitReceipt } from "../experiments/_harness.js";
import { Attack } from "./_forensics.js";
import { AttackSpec, Outcome } from "./registry.js";
import { StackCtx } from "./_stacks.js";

const INPUT = 10_000_000_000_000_000n;      // 0.01 rbtc of escrowed peg-in input
const MINOUT = 1_000_000_000_000_000n;      // the floor the user signed for
const FLOOR_BID = MINOUT + 1n;              // the least a bid may legally be
const RIVAL_BID = MINOUT + 800_000_000_000_000n; // what real competition would have paid
const GAS_MONEY = 80_000_000_000_000_000n;

export async function run(spec: AttackSpec, ctx: StackCtx): Promise<number> {
  const a = new Attack(spec, ctx.rpc);
  const rpc = ctx.rpc;

  a.note("both auction limits — WINDOW and GRACE — are block counts, and a miner decides when a block");
  a.note("happens. So this attack does not race anyone: it just moves the clock.");

  // No genesis probe here any more: ensureStack compares BOTH contracts' deployed bytecode against
  // the compiled runtime before an attack starts, which subsumes the WINDOW() probe this used to do —
  // and catches what that probe missed, since WINDOW() survived the rewrite of the decay rule.

  // A rival solver with its own money, so "who was outbid" is a balance fact and not a bookkeeping one.
  const rivalKey = Wallet.createRandom().privateKey;
  const rival = new Wallet(rivalKey);
  await waitReceipt(rpc, await fundAccount(rival.address, GAS_MONEY, rpc.url));
  const attackerAuction = auction(rpc.url, COW_KEY);          // the mining solver
  const attackerSolver = new Solver(rpc.url, COW_KEY);

  /**
   * The rival signs through a NonceManager (LOCAL nonce tracking) rather than a plain Wallet.
   *
   * A plain wallet asks the node for its nonce on every send, and rskj's transaction count lags a tx
   * it has only just executed — so the rival's third bid was assigned a nonce it had already spent
   * and came back NONCE_EXPIRED. This is the same lag that forced the Bridge header relay onto a
   * NonceManager. It bites here and not for the attacker because the rival's second send is a
   * deliberate REVERT: a reverted tx still consumes its nonce, which is exactly the case where
   * "what has this account spent" and "what state has the node published" drift apart.
   */
  const rivalProvider = new JsonRpcProvider(rpc.url, new Network("rsk-regtest", CHAIN_ID), { staticNetwork: true });
  const rivalSigner = new NonceManager(new Wallet(rivalKey, rivalProvider));
  const rivalAuction = new Contract(AUCTION_ADDR, auctionArtifact.abi, rivalSigner);

  const WINDOW = Number(await attackerAuction.WINDOW());
  const GRACE = Number(await attackerAuction.GRACE());
  a.check("read the auction's own limits from the contract", WINDOW > 0 && GRACE > 0, `WINDOW ${WINDOW} · GRACE ${GRACE} blocks`);

  /**
   * Send, mine it in, and only then wait for the receipt.
   *
   * With the ticker off, nothing confirms unless this attack says so — so `a.tx(send())` would sit
   * waiting for a receipt that can never arrive and report a perfectly good transaction as NOT MINED.
   * A rejected send is re-thrown into a.tx() unchanged, which is what decodes an admission-time or
   * estimate-time revert reason (the late rival bid never reaches a block at all).
   */
  async function mined(sent: Promise<string>, label: string) {
    let hash: string;
    try {
      hash = await sent;
    } catch (e) {
      return a.tx(Promise.reject(e), label);
    }
    await ctx.mine(1);
    return a.tx(hash, label);
  }

  /** a funded RBTC-output intent with plenty of expiry headroom for the blocks this attack mines */
  async function funded() {
    const btcTxid = getBytes(randomBytes(32));
    const H = randomH();
    const user = freshWallet();
    await waitReceipt(rpc, await depositForPegin(rpc.url, hexlify(btcTxid), INPUT, bindingOf(H, user.address)));
    const intent = buildIntent(user, {
      H, btcTxid, expiry: (await rpc.blockNumber()) + 4 * (WINDOW + GRACE), minOut: MINOUT,
    });
    await rpc.sendRaw(intent.rawHex);
    return { H, btcTxid, user, intent };
  }

  // Staging needs blocks to confirm, so mine on a ticker while setting up; the attack itself runs with
  // the ticker OFF, which is the whole point — the attacker chooses when blocks happen.
  ctx.autoMine.start();
  const p1 = await funded();
  const p2 = await funded();
  const p3 = await funded();
  a.watch("rival solver", rival.address);
  a.watch("user 1 (control)", p1.user.address);
  a.watch("user 2 (window squeeze)", p2.user.address);
  a.watch("user 3 (decay squeeze)", p3.user.address);
  await a.mark();

  // ---- control: the mechanism works when nobody owns the clock --------------------------------
  a.step("control — an ordinary contested auction, blocks arriving on a ticker");
  await a.tx(placeBid(attackerAuction, p1.intent.rawHex, FLOOR_BID), "attacker floor bid");
  const rivalWin = await a.tx(placeBid(rivalAuction, p1.intent.rawHex, RIVAL_BID), "rival outbids");
  a.check("the rival's higher bid was accepted", rivalWin.ok, rivalWin.reason ?? "");
  const b1 = await bidOf(attackerAuction, p1.H);
  a.check("the rival is the standing winner", b1.bidder.toLowerCase() === rival.address.toLowerCase(), `${b1.amount} wei`);
  await ctx.mineTo(Number(b1.deadline));
  const exec1 = await a.tx(executeAuction(attackerAuction, p1.intent.rawHex), "execute");
  a.check("execute settled the contested auction", exec1.ok, exec1.reason ?? "");
  const d0 = await a.deltas();
  const controlPaid = d0.get("user 1 (control)") ?? 0n;
  a.check("the user received the COMPETITIVE price, above their floor", controlPaid === RIVAL_BID,
    `${controlPaid} wei (floor was ${MINOUT})`);
  a.note("this is what the mechanism promises: the surplus over minOut goes to the user");

  // ---- attack 1: mine the whole bidding window before anyone can bid --------------------------
  a.step("window squeeze — stop mining, bid the floor, then mine the ENTIRE window in one burst");
  await ctx.autoMine.stop();
  const opened = await mined(placeBid(attackerAuction, p2.intent.rawHex, FLOOR_BID), "attacker floor bid");
  a.check("the attacker's floor bid opened the window", opened.ok, opened.reason ?? "");
  const b2 = await bidOf(attackerAuction, p2.H);
  const head = await rpc.blockNumber();
  a.check("a bidding window is now open, measured in blocks", b2.deadline > BigInt(head),
    `deadline block ${b2.deadline}, head ${head} — ${Number(b2.deadline) - head} blocks of "time"`);

  await ctx.mineTo(Number(b2.deadline));
  a.check("the whole window is now in the past, in no wall-clock time at all",
    (await rpc.blockNumber()) >= Number(b2.deadline), `head is now ${await rpc.blockNumber()}`);

  a.step("the rival now tries to bid — as promptly as any real bot could have");
  const late = await mined(placeBid(rivalAuction, p2.intent.rawHex, RIVAL_BID), "rival's higher bid");
  a.check("the rival's higher bid is REFUSED", !late.ok, late.reason ?? "no reason");
  a.check("refused because the window closed, not because the bid was bad",
    /bidding closed/.test(late.reason ?? ""), late.reason ?? "");
  const exec2 = await mined(executeAuction(attackerAuction, p2.intent.rawHex), "execute at the floor");
  a.check("the attacker executes its own uncontested floor bid", exec2.ok, exec2.reason ?? "");
  const d1 = await a.deltas();
  const squeezed = d1.get("user 2 (window squeeze)") ?? 0n;
  a.check("the user got the FLOOR, not the competitive price", squeezed === FLOOR_BID, `${squeezed} wei`);
  a.check("minOut was still honoured — this costs surplus, not principal", squeezed >= MINOUT);
  a.check("H consumed exactly once", await isConsumed((to, d) => rpc.ethCall(to, d), p2.H));
  a.check("the escrowed input went to the attacker", (await peginOf(rpc.url, hexlify(p2.btcTxid))) === 0n);
  a.note(`the user is worse off by ${controlPaid - squeezed} wei — the surplus the auction existed to find`);

  // ---- attack 2: let the rival win, then wait out our own GRACE decay -------------------------
  a.step("decay squeeze — let the rival WIN honestly, then decline to mine execute()");
  ctx.autoMine.start();
  const honest = await a.tx(placeBid(rivalAuction, p3.intent.rawHex, RIVAL_BID), "rival wins the auction");
  a.check("the rival holds the winning bid", honest.ok, honest.reason ?? "");
  const b3 = await bidOf(attackerAuction, p3.H);
  a.check("the rival is the winner of record", b3.bidder.toLowerCase() === rival.address.toLowerCase(),
    `${b3.amount} wei owed to the user if execute() ever lands`);

  /**
   * HARD PRECONDITION, not a check. Everything below compares what the user got against a HIGHER
   * STANDING BID, so with no bid in place the comparisons are vacuously true: `lockedUntil` returns 0
   * for an auction that never opened, and "paid minOut, not the winning bid" reads as a pass against
   * a winning bid of zero. The first run of this attack did exactly that — the rival's bid failed on
   * a nonce, and three green checks certified a decay squeeze that never happened. A phantom pass is
   * worse than a failure, because nothing about it looks wrong.
   */
  if (b3.amount <= MINOUT || b3.deadline === 0n) {
    a.skip("decay squeeze", `no standing bid above minOut (bid ${b3.amount}, deadline ${b3.deadline}) — ` +
      `the remaining checks would compare against nothing and pass vacuously, so they are not run`);
    a.note("the window squeeze above stands on its own; the decay half is UNVERIFIED in this run");
    await ctx.autoMine.stop();
    return a.finish(squeezed < controlPaid ? "succeeds" : "blocked");
  }
  await ctx.autoMine.stop();

  a.step(`mine past the deadline AND the ${GRACE}-block grace, without ever including execute()`);
  await ctx.mineTo(Number(b3.deadline) + GRACE);
  a.check("exclusivity did NOT decay — nothing has been shown to fail",
    (await lockedUntil(attackerAuction, p3.H)) === b3.deadline,
    `lockedUntil == ${await lockedUntil(attackerAuction, p3.H)} at block ${await rpc.blockNumber()} (0 would mean decayed)`);
  a.check("and no execute failure is on record", (await failedAtOf(attackerAuction, p3.H)) === 0n);

  a.step("try to settle directly at minOut anyway, going around the higher bid");
  const direct = await mined(attackerSolver.solve(p3.intent.rawHex, MINOUT), "direct settle at the floor");
  a.check("the direct settle was REFUSED — the auction still owns the intent", !direct.ok, direct.reason ?? "no reason");
  a.check("refused because the auction owns it, not incidentally",
    /auction owns this intent/.test(direct.reason ?? ""), direct.reason ?? "");
  a.check("H untouched", !(await isConsumed((to, d) => rpc.ethCall(to, d), p3.H)));

  a.step("so the price the auction found is the price the user gets: execute it");
  const exec3 = await mined(executeAuction(attackerAuction, p3.intent.rawHex), "execute");
  a.check("execute succeeded long after the window closed", exec3.ok, exec3.reason ?? "");
  const d2 = await a.deltas();
  const decayed = d2.get("user 3 (decay squeeze)") ?? 0n;
  a.check("the user was paid the WINNING BID, not the floor", decayed === b3.amount,
    `${decayed} wei — withholding execute() bought the attacker nothing`);

  a.note("the decay squeeze is CLOSED: exclusivity now ends GRACE blocks after execute() is SEEN to");
  a.note("fail, not GRACE blocks after the deadline, so declining to include execute() decays nothing.");
  a.note("The S4 safety valve survives — a genuinely wedged auction still releases the intent — but it");
  a.note("takes one transaction to demonstrate the failure, which any solver wanting the intent will send.");
  a.note("What the trade costs: the user's old 'minOut after GRACE whatever happens' fallback is now");
  a.note("'the best bid, or nothing until expiry'. Worth it only because withholding now gains nobody anything.");

  // Stop the ticker: an attack owns block production only while it runs. Leaving it on used to hang
  // the process after the board finished, since a live setInterval keeps Node's event loop alive.
  // Anything that runs next starts its own.
  await ctx.autoMine.stop();
  a.check("both halves of the attack were actually exercised, not assumed",
    controlPaid === RIVAL_BID && squeezed === FLOOR_BID && b3.amount === RIVAL_BID,
    `control ${controlPaid} · squeezed ${squeezed} · standing bid ${b3.amount}`);
  // The WINDOW squeeze still lands, so the attack as a whole still works — only its second half is
  // closed. Scoring it "blocked" because one of two levers was removed would overstate the fix.
  const observed: Outcome = squeezed < controlPaid || decayed < b3.amount ? "succeeds" : "blocked";
  return a.finish(observed);
}
