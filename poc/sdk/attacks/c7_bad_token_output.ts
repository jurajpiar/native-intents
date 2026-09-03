/**
 * C7 — A MISBEHAVING ERC-20 AS THE OUTPUT ASSET.
 *
 * For a token output, settle does `transferFrom(solver, user, minOut)` and checks the RETURN VALUE.
 * It never measures the user's balance before and after. Three token behaviours test what that costs,
 * all in one deployable token whose mode is switchable:
 *
 *   FEE_ON_TRANSFER  moves less than asked and returns true. Does the user end up with minOut, or
 *                    with minOut minus a skim they never agreed to?
 *   LIAR             moves NOTHING and returns true. The worst case: H consumed, input released, and
 *                    the user paid zero.
 *   NO_RETURN        returns no data (the pre-EIP-20 style plenty of real tokens still use). Solidity
 *                    cannot decode a missing bool, so this asks whether such tokens are simply
 *                    unusable as outputs — a compatibility fact, not a vulnerability.
 *
 * Who bears it matters: the OUTPUT ASSET IS THE USER'S OWN CHOICE, signed into the intent. Nobody
 * else picks it, so a user who names a hostile token has attacked themselves — this is a
 * documentation question (wallets must not offer arbitrary tokens as outputs), not a hole a third
 * party can exploit. What makes it worth exercising is the size of the gap between "returns true"
 * and "the user was paid".
 *
 * Falsifier: the balance-delta check turns out to exist after all (delivery reverts on a short or
 * absent transfer), or the loss lands on someone other than the user who chose the token.
 */
import { Contract, ContractFactory, JsonRpcProvider, Network, Wallet, getBytes, hexlify, randomBytes } from "ethers";
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { depositForPegin, peginOf } from "../src/settlement.js";
import { Solver } from "../src/solver.js";
import { CHAIN_ID, COW_KEY, SETTLEMENT_ADDR } from "../src/config.js";
import { preflight, requireSettlement, rpcA, waitReceipt } from "../experiments/_harness.js";
import badArtifact from "../src/abi/BadToken.json" with { type: "json" };
import { Attack } from "./_forensics.js";
import { AttackSpec, Outcome } from "./registry.js";

const INPUT = 10_000_000_000_000_000n;
const MINOUT = 1_000_000_000_000_000_000n; // 1 token
const ov = { gasLimit: 2_000_000, gasPrice: 1_000_000, type: 0, chainId: CHAIN_ID } as const;
const MODE = { HONEST: 0, FEE: 1, LIAR: 2, NO_RETURN: 3 } as const;

export async function run(spec: AttackSpec): Promise<number> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  const a = new Attack(spec, rpcA);
  const provider = new JsonRpcProvider(rpcA.url, new Network("rsk-regtest", CHAIN_ID), { staticNetwork: true });
  const cow = new Wallet(COW_KEY, provider);
  const solver = new Solver(rpcA.url, COW_KEY);

  a.step("deploy a switchable misbehaving ERC-20 and name it as the intents' output asset");
  const factory = new ContractFactory(badArtifact.abi, badArtifact.bytecode, cow);
  const dep = await factory.deploy({ ...ov, gasLimit: 1_500_000 });
  await dep.waitForDeployment();
  const tokenAddr = await dep.getAddress();
  const token = new Contract(tokenAddr, badArtifact.abi, cow);
  a.check("bad token deployed", (await rpcA.getCode(tokenAddr)) !== "0x", tokenAddr);
  a.watch("solver", solver.payer);
  await a.mark(); // baseline for the closing deltas()

  /** a token-output intent, escrow funded, with the solver holding + approving the output */
  async function stage() {
    const btcTxid = getBytes(randomBytes(32));
    const H = randomH();
    const user = freshWallet();
    await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btcTxid), INPUT, hexlify(H)));
    const intent = buildIntent(user, {
      H, btcTxid, expiry: (await rpcA.blockNumber()) + 90, minOut: MINOUT, outputToken: tokenAddr,
    });
    await rpcA.sendRaw(intent.rawHex);
    await waitReceipt(rpcA, (await token.mint(solver.payer, MINOUT * 2n, ov)).hash);
    await waitReceipt(rpcA, (await token.approve(SETTLEMENT_ADDR, MINOUT * 2n, ov)).hash);
    return { H, btcTxid, user, intent };
  }

  // ---- case 1: fee on transfer ---------------------------------------------------------------
  a.step("case 1 — FEE_ON_TRANSFER: transferFrom moves 90% and returns true");
  await waitReceipt(rpcA, (await token.setMode(MODE.FEE, ov)).hash);
  const p1 = await stage();
  const s1 = await a.tx(solver.solve(p1.intent.rawHex, 0n));
  a.check("settle SUCCEEDED on a short delivery", s1.ok, s1.reason ?? "");
  const got1: bigint = await token.balanceOf(p1.user.address);
  a.check("the user received LESS than the minOut they signed for", got1 < MINOUT, `${got1} < ${MINOUT}`);
  a.check("the shortfall is exactly the skim", got1 === MINOUT - MINOUT / 10n, `${got1}`);
  a.check("yet H is consumed and the input released", await isConsumed((to, d) => rpcA.ethCall(to, d), p1.H));
  a.check("escrow emptied", (await peginOf(rpcA.url, hexlify(p1.btcTxid))) === 0n);
  a.note("settle checks the return value, not a balance delta — so `minOut` means 'asked', not 'arrived'");

  // ---- case 2: outright liar ----------------------------------------------------------------
  a.step("case 2 — LIAR: transferFrom moves nothing at all and returns true");
  await waitReceipt(rpcA, (await token.setMode(MODE.LIAR, ov)).hash);
  const p2 = await stage();
  const s2 = await a.tx(solver.solve(p2.intent.rawHex, 0n));
  a.check("settle SUCCEEDED with zero delivered", s2.ok, s2.reason ?? "");
  a.check("the user received NOTHING", (await token.balanceOf(p2.user.address)) === 0n);
  a.check("H consumed anyway", await isConsumed((to, d) => rpcA.ethCall(to, d), p2.H));
  a.check("and the solver still took the input", (await peginOf(rpcA.url, hexlify(p2.btcTxid))) === 0n);
  a.note("the whole loss falls on the user who NAMED this token in their own signed intent —");
  a.note("no third party can choose the output asset, so this is a wallet-safety rule, not an exploit");

  // ---- case 3: no return data ---------------------------------------------------------------
  a.step("case 3 — NO_RETURN: a pre-EIP-20 token that returns no data");
  await waitReceipt(rpcA, (await token.setMode(MODE.NO_RETURN, ov)).hash);
  const p3 = await stage();
  const s3 = await a.tx(solver.solve(p3.intent.rawHex, 0n));
  a.check("settle REVERTED — the missing bool cannot be decoded", !s3.ok, s3.reason ?? "no reason");
  a.check("H untouched, so the intent stays solvable", !(await isConsumed((to, d) => rpcA.ethCall(to, d), p3.H)));
  a.check("escrow untouched", (await peginOf(rpcA.url, hexlify(p3.btcTxid))) === INPUT);
  a.note("so return-less tokens are simply unusable as outputs: a compatibility limit to document,");
  a.note("and the safe failure direction (nothing consumed) rather than a silent zero delivery");

  // ---- control: the same token, behaving ----------------------------------------------------
  a.step("control — HONEST mode: the same token pays in full");
  await waitReceipt(rpcA, (await token.setMode(MODE.HONEST, ov)).hash);
  const p4 = await stage();
  const s4 = await a.tx(solver.solve(p4.intent.rawHex, 0n));
  a.check("settle succeeded", s4.ok, s4.reason ?? "");
  a.check("user received the full minOut", (await token.balanceOf(p4.user.address)) === MINOUT);
  await a.deltas();

  const observed: Outcome = s1.ok || s2.ok ? "succeeds" : "blocked";
  return a.finish(observed);
}
