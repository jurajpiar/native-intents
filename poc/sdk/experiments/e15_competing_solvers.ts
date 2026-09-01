/**
 * E15 — Competing solvers + bonding (productionization C).
 *
 * Two bonded solvers race to settle the SAME intent. Settlement is atomic and records H in the consumed
 * set, so first-valid-inclusion wins: exactly one settle lands, the other reverts on the already-consumed
 * H. The user is paid once, the winner claims the input spread, the loser's output is refunded by its own
 * revert. Bonding is the market-structure backdrop — both solvers have staked capital at risk — but it is
 * NOT on the settlement path (settle never checks the bond; entry stays permissionless). A slash by the
 * arbiter shows misbehaving stake can be burned.
 *
 * Falsifier: both settles succeed (H double-spent, user paid twice), neither lands, the loser also
 * delivers output, or the winner doesn't claim the input.
 *
 * Standalone. Run after `up` (waits for the RSKIPINTENT activation). No rebuild needed — the bond is a
 * plain SDK-deployed contract and the race uses the existing settle path.
 */
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { Solver } from "../src/solver.js";
import { depositForPegin } from "../src/settlement.js";
import { deployBond, bond, bondUp, isBonded, bondOf, slash, MIN_BOND } from "../src/bond.js";
import { Report, preflight, requireSettlement, rpcA, fundAccount, waitReceipt, succeeded, reverted } from "./_harness.js";
import { RBTC } from "../src/config.js";
import { getBytes, hexlify, randomBytes, Wallet } from "ethers";

const INPUT = 10_000_000_000_000_000n;   // 1e16 wei RBTC — the pegged-in input the winner claims
const MINOUT = 1_000_000_000_000_000_000n / 1_000n; // 1e15 wei RBTC — the output delivered to the user
const GAS_BOUND = 2_000_000_000_000n;    // 2e12 wei — loose gas bound for the deltas
const SOLVER2_FUNDING = MIN_BOND + 2n * INPUT; // bond + output(attached) + gas headroom

async function main(): Promise<number> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  const r = new Report("E15 competing solvers", "two bonded solvers race one intent; first-valid-inclusion wins, user paid once");

  // --- bonding: deploy the bond and stake two solvers (cow is arbiter) ---
  const bondAddr = await deployBond(rpcA.url);
  const solver1 = new Solver(rpcA.url);                       // cow
  const s2key = Wallet.createRandom().privateKey;
  await waitReceipt(rpcA, await fundAccount(new Wallet(s2key).address, SOLVER2_FUNDING));
  const solver2 = new Solver(rpcA.url, s2key);

  await waitReceipt(rpcA, await bondUp(bond(rpcA.url, bondAddr), MIN_BOND));            // solver1 (cow)
  await waitReceipt(rpcA, await bondUp(bond(rpcA.url, bondAddr, s2key), MIN_BOND));     // solver2
  r.check("solver1 bonded", await isBonded(bond(rpcA.url, bondAddr), solver1.payer));
  r.check("solver2 bonded", await isBonded(bond(rpcA.url, bondAddr), solver2.payer));

  // --- one profitable intent (RBTC output; input escrowed for the winner to claim) ---
  const btcTxid = getBytes(randomBytes(32));
  await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btcTxid), INPUT));
  const user = freshWallet();
  const H = randomH();
  const height = await rpcA.blockNumber();
  const intent = buildIntent(user, { H, btcTxid, expiry: height + 95, minOut: MINOUT, outputToken: RBTC });
  await rpcA.sendRaw(intent.rawHex);

  // --- the race: both solvers fire settle for the same intent, attaching the RBTC output ---
  const s1Before = BigInt(await rpcA.getBalance(solver1.payer));
  const s2Before = BigInt(await rpcA.getBalance(solver2.payer));
  const userBefore = BigInt(await rpcA.getBalance(user.address));
  const [h1, h2] = await Promise.all([solver1.solve(intent.rawHex, MINOUT), solver2.solve(intent.rawHex, MINOUT)]);
  const [r1, r2] = await Promise.all([waitReceipt(rpcA, h1), waitReceipt(rpcA, h2)]);

  // exactly one wins; the other reverts on the already-consumed H
  const oneWon = succeeded(r1) !== succeeded(r2);
  r.check("exactly one settle succeeded (first-valid-inclusion)", oneWon, `s1=${r1?.status} s2=${r2?.status}`);
  r.check("the loser reverted (not merely dropped)", reverted(r1) || reverted(r2), `s1=${r1?.status} s2=${r2?.status}`);

  const winnerIsS1 = succeeded(r1);
  const winnerBefore = winnerIsS1 ? s1Before : s2Before;
  const loserBefore = winnerIsS1 ? s2Before : s1Before;
  const winnerAddr = winnerIsS1 ? solver1.payer : solver2.payer;
  const loserAddr = winnerIsS1 ? solver2.payer : solver1.payer;
  const winnerDelta = BigInt(await rpcA.getBalance(winnerAddr)) - winnerBefore;
  const loserDelta = BigInt(await rpcA.getBalance(loserAddr)) - loserBefore;

  // user paid exactly once; winner claimed the spread; loser only paid gas (its output was refunded)
  r.check("user received minOut exactly once (not doubled)", BigInt(await rpcA.getBalance(user.address)) - userBefore === MINOUT, `delta=${BigInt(await rpcA.getBalance(user.address)) - userBefore}`);
  r.check("winner claimed the input spread (delta > 0)", winnerDelta > 0n && winnerDelta > INPUT - MINOUT - GAS_BOUND, `delta=${winnerDelta}`);
  r.check("loser refunded its output (only gas spent)", loserDelta <= 0n && loserDelta > -GAS_BOUND, `delta=${loserDelta}`);
  r.check("H consumed", await isConsumed((to, d) => rpcA.ethCall(to, d), H));

  // --- slashing: the arbiter (cow) can burn a misbehaving solver's stake ---
  const before = await bondOf(bond(rpcA.url, bondAddr), loserAddr);
  await waitReceipt(rpcA, await slash(bond(rpcA.url, bondAddr), loserAddr, MIN_BOND / 2n));
  const after = await bondOf(bond(rpcA.url, bondAddr), loserAddr);
  r.check("arbiter slashed a solver's bond", after === before - MIN_BOND / 2n, `${before} -> ${after}`);

  console.log(`\nwinner=${winnerAddr} claimed input spread; loser=${loserAddr} reverted on consumed H. Bonding is off-consensus (settle never checks it).`);
  return r.done();
}

main().then((c) => process.exit(c));
