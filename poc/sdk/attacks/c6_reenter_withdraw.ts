/**
 * C6 — REENTER withdraw() TO DRAIN THE CREDIT LEDGER.
 *
 * The pull-payment hardening (Settlement and Auction both) pays a failed push into a `credit` ledger
 * that its owner withdraws later. withdraw() sends native RBTC with a plain call, so a contract payee
 * gets control mid-withdrawal — the textbook drain setup.
 *
 * The defence is ordering, not a guard: the credit is zeroed BEFORE the transfer, so a nested
 * withdraw() finds nothing and reverts on "nothing to withdraw". The whole call then unwinds, which
 * restores the credit — so the attacker's own re-entry costs it the withdrawal it was making. Worth
 * exercising because the failure mode is silent: an implementation that transferred first and zeroed
 * after would drain to zero here and pass every other test in the suite.
 *
 * Run against BOTH ledgers, because they are separate code: Settlement.withdraw (exit bonds, input
 * releases, excess refunds) and Auction.withdraw (winner inputs, outbid refunds).
 *
 * Procedure: make a Reenterer accrue credit by being an unpayable payee -> arm its receive() with
 *            withdraw() -> let it withdraw -> count nested attempts, and reconcile what left the
 *            contract against what the ledger said it was owed.
 * Falsifier: the contract extracts MORE than its credit, the ledger goes negative/underflows, or a
 *            nested withdraw succeeds.
 */
import { Contract, ContractFactory, Interface, JsonRpcProvider, Network, Wallet, getBytes, hexlify, randomBytes } from "ethers";
import { buildIntent, freshWallet, randomH } from "../src/intent.js";
import { depositForPegin, settlementCreditOf } from "../src/settlement.js";
import { auction, creditOf, executeAuction, bidOf } from "../src/auction.js";
import { AUCTION_ADDR, CHAIN_ID, COW_KEY, SETTLEMENT_ADDR } from "../src/config.js";
import { fundAccount, preflight, requireSettlement, rpcA, waitReceipt } from "../experiments/_harness.js";
import { waitFor } from "../src/client.js";
import settlementAbi from "../src/abi/Settlement.json" with { type: "json" };
import auctionArtifact from "../src/abi/Auction.json" with { type: "json" };
import reentererArtifact from "../src/abi/Reenterer.json" with { type: "json" };
import { Attack } from "./_forensics.js";
import { AttackSpec, Outcome } from "./registry.js";

const INPUT = 10_000_000_000_000_000n;
const MINOUT = 1_000_000_000_000_000n;
const EXCESS = 300_000_000_000_000n;
const BID = MINOUT + 400_000_000_000_000n;
const ov = { gasLimit: 3_000_000, gasPrice: 1_000_000, type: 0, chainId: CHAIN_ID } as const;

export async function run(spec: AttackSpec): Promise<number> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  const a = new Attack(spec, rpcA);
  const provider = new JsonRpcProvider(rpcA.url, new Network("rsk-regtest", CHAIN_ID), { staticNetwork: true });
  const cow = new Wallet(COW_KEY, provider);
  const settleIface = new Interface(settlementAbi as import("ethers").InterfaceAbi);
  const auctionIface = new Interface(auctionArtifact.abi as import("ethers").InterfaceAbi);

  a.step("deploy a Reenterer that will accrue credit and then reenter withdraw()");
  const factory = new ContractFactory(reentererArtifact.abi, reentererArtifact.bytecode, cow);
  const dep = await factory.deploy({ ...ov, gasLimit: 1_500_000 });
  await dep.waitForDeployment();
  const evilAddr = await dep.getAddress();
  const evil = new Contract(evilAddr, reentererArtifact.abi, cow);
  a.check("reenterer deployed", (await rpcA.getCode(evilAddr)) !== "0x", evilAddr);
  a.watch("evil payee", evilAddr);
  await waitReceipt(rpcA, await fundAccount(evilAddr, (MINOUT + EXCESS + BID) * 4n));
  await a.mark(); // deltas() needs a baseline; watch() must all be registered before this

  // ================= ledger 1: Settlement =================
  a.step("Settlement: settle as an UNPAYABLE solver so the input + excess become credit");
  const btcTxid = getBytes(randomBytes(32));
  const H = randomH();
  const user = freshWallet();
  await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btcTxid), INPUT, hexlify(H)));
  const intent = buildIntent(user, { H, btcTxid, expiry: (await rpcA.blockNumber()) + 90, minOut: MINOUT });
  await rpcA.sendRaw(intent.rawHex);

  await waitReceipt(rpcA, (await evil.setAccept(false, ov)).hash); // reject pushes -> they credit
  const settled = await a.tx((await evil.exec(SETTLEMENT_ADDR,
    settleIface.encodeFunctionData("settle", [intent.rawHex]), { ...ov, value: MINOUT + EXCESS })).hash);
  a.check("settle succeeded despite the unpayable solver", settled.ok, settled.reason ?? "");
  const owed = await settlementCreditOf(rpcA.url, evilAddr);
  a.check("credit accrued (input + excess)", owed === INPUT + EXCESS, `${owed} wei`);

  a.step("arm receive() with withdraw(), turn receive() back on, and withdraw");
  const wdCall = settleIface.encodeFunctionData("withdraw", []);
  await waitReceipt(rpcA, (await evil.arm(SETTLEMENT_ADDR, wdCall, 4, 0n, ov)).hash);
  await waitReceipt(rpcA, (await evil.setAccept(true, ov)).hash);
  const balBefore = BigInt(await rpcA.getBalance(evilAddr));
  const wd = await a.tx((await evil.exec(SETTLEMENT_ADDR, wdCall, ov)).hash);
  a.check("the outer withdraw succeeded", wd.ok, wd.reason ?? "");
  const attempts: bigint = await evil.reenters();
  const won: bigint = await evil.succeeded();
  a.check("receive() fired and attempted nested withdraw()s", attempts > 0n, `${attempts} attempt(s)`);
  a.check("every nested withdraw was REFUSED", won === 0n, `${won} of ${attempts} succeeded`);
  const err: string = await evil.lastError();
  a.check("refused because the credit was already zeroed (effects-first)", err.length > 2, `payload ${err.slice(0, 26)}…`);
  const gained = BigInt(await rpcA.getBalance(evilAddr)) - balBefore;
  a.check("it extracted EXACTLY its credit, not a wei more", gained === owed, `${gained} == ${owed}`);
  a.check("ledger now zero", (await settlementCreditOf(rpcA.url, evilAddr)) === 0n);
  await a.deltas();

  // ================= ledger 2: Auction =================
  a.step("Auction: win an auction as the unpayable bidder so the input becomes creditToken-side credit");
  const btcTxid2 = getBytes(randomBytes(32));
  const H2 = randomH();
  const user2 = freshWallet();
  await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btcTxid2), INPUT, hexlify(H2)));
  const intent2 = buildIntent(user2, { H: H2, btcTxid: btcTxid2, expiry: (await rpcA.blockNumber()) + 90, minOut: MINOUT });
  await rpcA.sendRaw(intent2.rawHex);

  await waitReceipt(rpcA, (await evil.setAccept(false, ov)).hash);
  await waitReceipt(rpcA, (await evil.exec(AUCTION_ADDR,
    auctionIface.encodeFunctionData("bid", [intent2.rawHex]), { ...ov, value: BID })).hash);
  const a1 = auction(rpcA.url);
  const b = await bidOf(a1, H2);
  a.check("the unpayable contract is the standing winner", b.bidder.toLowerCase() === evilAddr.toLowerCase());
  await waitFor(async () => BigInt(await rpcA.blockNumber()) >= b.deadline, 90000, 1000);
  const exec = await a.tx(executeAuction(a1, intent2.rawHex));
  a.check("execute succeeded (pull-payments)", exec.ok, exec.reason ?? "");
  const owedA = await creditOf(a1, evilAddr);
  a.check("auction credit accrued", owedA > 0n, `${owedA} wei`);

  a.step("arm receive() with the AUCTION's withdraw() and drain-attempt it");
  const wdA = auctionIface.encodeFunctionData("withdraw", []);
  await waitReceipt(rpcA, (await evil.arm(AUCTION_ADDR, wdA, 4, 0n, ov)).hash);
  await waitReceipt(rpcA, (await evil.setAccept(true, ov)).hash);
  const balBefore2 = BigInt(await rpcA.getBalance(evilAddr));
  const wd2 = await a.tx((await evil.exec(AUCTION_ADDR, wdA, ov)).hash);
  a.check("the outer auction withdraw succeeded", wd2.ok, wd2.reason ?? "");
  const won2: bigint = await evil.succeeded();
  a.check("no nested auction withdraw succeeded either", won2 === 0n, `${won2} succeeded`);
  const gained2 = BigInt(await rpcA.getBalance(evilAddr)) - balBefore2;
  a.check("extracted exactly its auction credit", gained2 === owedA, `${gained2} == ${owedA}`);
  a.check("auction ledger now zero", (await creditOf(a1, evilAddr)) === 0n);
  await a.deltas();

  a.note("both ledgers zero the balance before transferring, so a nested withdraw finds nothing —");
  a.note("and because the revert unwinds the whole call, re-entering costs the attacker the attempt.");

  const observed: Outcome = won > 0n || won2 > 0n ? "succeeds" : "blocked";
  return a.finish(observed);
}
