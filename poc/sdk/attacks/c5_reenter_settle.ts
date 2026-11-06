/**
 * C5 — REENTER settle FROM A PAYEE'S CALLBACK.
 *
 * settle hands control to a payee twice: the excess refund and the input release, both to msg.sender.
 * If the settler is a contract, its receive() runs while the settlement is still on the stack. That is
 * the textbook reentrancy setup, and the first version of this attack pointed straight at it.
 *
 * IT IS NOT REACHABLE, and the reason is worth more than the attack was. Both of those pushes go
 * through `_pay`, which caps them at PUSH_GAS = 30,000 — a cap added for a completely different
 * reason (an unpayable payee must not be able to revert a settlement, F1-F4). 30,000 gas does not buy
 * one SSTORE (20,000) plus the cold SLOADs before it, so a contract solver's receive() cannot execute
 * any logic at all on the settle path: it runs out of gas, the push fails, and the money becomes a
 * withdrawable credit. The pull-payment hardening closed the reentrancy surface as a side effect.
 *
 * `withdraw()`, by contrast, is deliberately UNCAPPED — it must deliver the full credit — so that is
 * where reentrancy is genuinely reachable, and where the interesting questions get answered:
 *
 *   part 1  the settle-path callbacks cannot reenter, because they cannot run. Assert the callback
 *           never fires, nothing is pushed, and the whole amount lands as credit.
 *   part 2  reenter from withdraw() into settle for the SAME H. Effects-first ordering — sstore(H)
 *           before any external call — should make this revert on the consumed check.
 *   part 3  reenter from withdraw() into settle for a DIFFERENT funded intent. This SHOULD work: it
 *           is an ordinary settlement that happens to be nested. Confirming it is not blocked matters
 *           as much as part 2 — a blanket reentrancy guard would break nesting for no gain.
 *
 * One structural note that shapes all of it: a contract cannot SIGN an intent (the user is recovered
 * from the signature), so the user is always an EOA and the user-side delivery is not a reentrancy
 * surface at all. Every reachable callback belongs to the solver.
 *
 * Falsifier: the settle-path callback DOES execute (the cap is not what we think), a same-H reentry
 * succeeds (double payment, or one escrow claimed twice), a legitimate nested settlement is refused,
 * or the ledger ends inconsistent — an escrow emptied without its H consumed, or a user paid twice.
 */
import { Contract, ContractFactory, Interface, JsonRpcProvider, Network, Wallet, getBytes, hexlify, randomBytes } from "ethers";
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { depositForPegin, peginOf, settlementCreditOf, bindingOf } from "../src/settlement.js";
import { Solver } from "../src/solver.js";
import { CHAIN_ID, COW_KEY, SETTLEMENT_ADDR } from "../src/config.js";
import { fundAccount, preflight, requireSettlement, rpcA, waitReceipt } from "../experiments/_harness.js";
import settlementAbi from "../src/abi/Settlement.json" with { type: "json" };
import reentererArtifact from "../src/abi/Reenterer.json" with { type: "json" };
import { Attack } from "./_forensics.js";
import { AttackSpec, Outcome } from "./registry.js";

const INPUT = 10_000_000_000_000_000n;
const MINOUT = 1_000_000_000_000_000n;
const EXCESS = 200_000_000_000_000n;   // overpay, so a refund push is attempted
const PUSH_GAS = 30_000n;              // Settlement._pay's stipend — the thing this attack measures
const ov = { gasLimit: 3_000_000, gasPrice: 1_000_000, type: 0, chainId: CHAIN_ID } as const;

export async function run(spec: AttackSpec): Promise<number> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  const a = new Attack(spec, rpcA);
  const provider = new JsonRpcProvider(rpcA.url, new Network("rsk-regtest", CHAIN_ID), { staticNetwork: true });
  const cow = new Wallet(COW_KEY, provider);
  const iface = new Interface(settlementAbi as import("ethers").InterfaceAbi);
  const solver = new Solver(rpcA.url, COW_KEY);

  a.note("a contract cannot sign an intent, so the USER is always an EOA — the user-side delivery is");
  a.note("not a reentrancy surface. Every reachable callback belongs to the SOLVER.");

  a.step("deploy a Reenterer to act as the SOLVER, so settle's callbacks hand it control");
  const factory = new ContractFactory(reentererArtifact.abi, reentererArtifact.bytecode, cow);
  const dep = await factory.deploy({ ...ov, gasLimit: 1_500_000 });
  await dep.waitForDeployment();
  const evilAddr = await dep.getAddress();
  const evil = new Contract(evilAddr, reentererArtifact.abi, cow);
  a.check("reenterer deployed", (await rpcA.getCode(evilAddr)) !== "0x", evilAddr);
  await waitReceipt(rpcA, await fundAccount(evilAddr, (MINOUT + EXCESS) * 8n));

  /** a fresh RBTC-output intent with its escrow bound and funded */
  async function funded() {
    const btcTxid = getBytes(randomBytes(32));
    const H = randomH();
    const user = freshWallet();
    await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btcTxid), INPUT, bindingOf(H, user.address)));
    const intent = buildIntent(user, { H, btcTxid, expiry: (await rpcA.blockNumber()) + 90, minOut: MINOUT });
    await rpcA.sendRaw(intent.rawHex);
    return { H, btcTxid, user, intent };
  }

  // Every party must be watched BEFORE the first mark(): a watch registered later has no baseline,
  // and a missing baseline reads as a zero delta — which a "gained nothing" check would score as a
  // pass. So all three intents are staged up front and their users watched together.
  a.step("stage three funded intents and register every party before taking the baseline");
  const p1 = await funded();
  const p2 = await funded();
  const p3 = await funded();
  a.watch("evil solver", evilAddr);
  a.watch("honest solver", solver.payer);
  a.watch("user 1", p1.user.address);
  a.watch("user 2", p2.user.address);
  a.watch("user 3", p3.user.address);
  await a.mark();

  // ---- part 1: the settle-path callbacks cannot reenter, because they cannot RUN ---------------
  a.step("part 1 — arm receive() with settle(SAME intent) and settle overpaid, so both pushes fire");
  const settleP1 = iface.encodeFunctionData("settle", [p1.intent.rawHex]);
  await waitReceipt(rpcA, (await evil.arm(SETTLEMENT_ADDR, settleP1, 2, MINOUT, ov)).hash);
  await waitReceipt(rpcA, (await evil.setAccept(true, ov)).hash); // willing to receive; the cap is the limit

  const outer = await a.tx((await evil.exec(SETTLEMENT_ADDR, settleP1, { ...ov, value: MINOUT + EXCESS })).hash);
  a.check("the outer settle succeeded", outer.ok, outer.reason ?? "");
  const attempts1: bigint = await evil.reenters();
  a.check("the callback NEVER FIRED — the push is gas-capped below any useful work", attempts1 === 0n,
    `${attempts1} attempt(s) with a ${PUSH_GAS}-gas stipend (one SSTORE is 20,000)`);
  const owed = await settlementCreditOf(rpcA.url, evilAddr);
  a.check("so both payouts took the credit fallback instead of reaching the contract",
    owed === INPUT + EXCESS, `${owed} wei credited`);
  a.check("H consumed exactly once", await isConsumed((to, d) => rpcA.ethCall(to, d), p1.H));
  a.check("escrow emptied exactly once", (await peginOf(rpcA.url, hexlify(p1.btcTxid))) === 0n);
  const d1 = await a.deltas();
  // Net ZERO, not a loss: Reenterer.exec forwards msg.value, so the settle was funded by the EOA
  // calling exec and merely passed through the contract. What the contract is owed sits in `credit`,
  // which is the whole point — the push that would have paid it could not execute.
  a.check("nothing was PUSHED to the evil solver — its balance did not move at all",
    (d1.get("evil solver") ?? 0n) === 0n,
    `${d1.get("evil solver")} — exec forwarded the caller's ${MINOUT + EXCESS} straight through`);
  a.check("user paid exactly minOut, not twice", (d1.get("user 1") ?? 0n) === MINOUT, `${d1.get("user 1")}`);
  a.note("the F1-F4 pull-payment cap was added so an unpayable payee cannot revert a settlement;");
  a.note("it also means a contract solver can run NO code on the settle path. Two defences, one line.");

  // ---- part 2: withdraw() is uncapped, so reenter from THERE into the same H -------------------
  a.step("part 2 — reenter from the UNCAPPED withdraw() into settle for the SAME (now consumed) H");
  await waitReceipt(rpcA, (await evil.arm(SETTLEMENT_ADDR, settleP1, 2, MINOUT, ov)).hash);
  const wdCall = iface.encodeFunctionData("withdraw", []);
  const wd = await a.tx((await evil.exec(SETTLEMENT_ADDR, wdCall, ov)).hash);
  a.check("the outer withdraw succeeded", wd.ok, wd.reason ?? "");
  const attempts2: bigint = await evil.reenters();
  const won2: bigint = await evil.succeeded();
  a.check("HERE the callback fires — withdraw sends with full gas", attempts2 > 0n, `${attempts2} attempt(s)`);
  a.check("every same-H reentry was REFUSED", won2 === 0n, `${won2} of ${attempts2} succeeded`);
  const err: string = await evil.lastError();
  a.check("refused with a revert payload, not silently", err.length > 2, `payload ${err.slice(0, 26)}…`);
  a.check("H still consumed exactly once", await isConsumed((to, d) => rpcA.ethCall(to, d), p1.H));
  a.check("ledger zeroed — the credit was paid once", (await settlementCreditOf(rpcA.url, evilAddr)) === 0n);
  const d2 = await a.deltas();
  a.check("it collected exactly its credit, not a wei more", (d2.get("evil solver") ?? 0n) === owed,
    `${d2.get("evil solver")} == ${owed}`);
  a.note("effects-first is what does it: sstore(H) commits before any external call, so the nested");
  a.note("settle meets a consumed H — closed by ORDERING, with no reentrancy guard anywhere");

  // ---- part 3: a nested settle of a DIFFERENT intent must be ALLOWED --------------------------
  a.step("part 3 — accrue credit again, then reenter withdraw() into a settle for a DIFFERENT intent");
  const settleP2 = iface.encodeFunctionData("settle", [p2.intent.rawHex]);
  // Disarming is NOT enough to accrue credit here: with armedData empty, receive() returns after two
  // SLOADs, which fits inside the 30,000-gas stipend, so the push SUCCEEDS and nothing is credited.
  // Rejecting outright is what forces the credit fallback — then receive() goes back on for the
  // withdraw, whose push is uncapped and must actually land.
  await waitReceipt(rpcA, (await evil.setAccept(false, ov)).hash);
  const stage = await a.tx((await evil.exec(SETTLEMENT_ADDR, settleP2, { ...ov, value: MINOUT + EXCESS })).hash);
  a.check("second settle succeeded, crediting the evil solver again", stage.ok, stage.reason ?? "");
  const owed2 = await settlementCreditOf(rpcA.url, evilAddr);
  a.check("credit accrued for the withdraw that will carry the reentry", owed2 === INPUT + EXCESS, `${owed2} wei`);

  const settleP3 = iface.encodeFunctionData("settle", [p3.intent.rawHex]);
  await waitReceipt(rpcA, (await evil.setAccept(true, ov)).hash);
  await waitReceipt(rpcA, (await evil.arm(SETTLEMENT_ADDR, settleP3, 1, MINOUT, ov)).hash);
  const wd2 = await a.tx((await evil.exec(SETTLEMENT_ADDR, wdCall, ov)).hash);
  a.check("the outer withdraw succeeded", wd2.ok, wd2.reason ?? "");
  const won3: bigint = await evil.succeeded();
  a.check("the NESTED settle of a different intent was ALLOWED", won3 > 0n,
    `${won3} nested settlement(s) — no blanket reentrancy guard`);
  a.check("both intents consumed",
    (await isConsumed((to, d) => rpcA.ethCall(to, d), p2.H)) && (await isConsumed((to, d) => rpcA.ethCall(to, d), p3.H)));
  a.check("both escrows emptied",
    (await peginOf(rpcA.url, hexlify(p2.btcTxid))) === 0n && (await peginOf(rpcA.url, hexlify(p3.btcTxid))) === 0n);
  const d3 = await a.deltas();
  a.check("user 2 paid exactly minOut", (d3.get("user 2") ?? 0n) === MINOUT, `${d3.get("user 2")}`);
  a.check("user 3 paid exactly minOut by the NESTED call", (d3.get("user 3") ?? 0n) === MINOUT, `${d3.get("user 3")}`);

  a.note("so: unreachable on the settle path (gas-capped), reachable but harmless from withdraw");
  a.note("(same H reverts on the consumed set), and a genuinely different intent is simply settled.");
  a.note("Every escrow/consumed pair stays one-to-one throughout.");

  // The attack is blocked if no same-H reentry ever succeeded. Part 3 succeeding is the CONTROL —
  // it must not be counted as the attack landing, or a correct design would score as a failure.
  const observed: Outcome = won2 > 0n ? "succeeds" : "blocked";
  return a.finish(observed);
}
