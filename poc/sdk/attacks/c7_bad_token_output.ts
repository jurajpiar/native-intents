/**
 * C7 — A MISBEHAVING ERC-20 AS THE OUTPUT ASSET.
 *
 * For a token output, settle must move `minOut` of an arbitrary contract's tokens to the user. The
 * obvious implementation checks what the token SAYS — `require(transferFrom(...))` — and that is what
 * this attack was written against. It found the gap it was looking for: a fee-on-transfer token moved
 * 90% and returned true, an outright liar moved nothing and returned true, and in both cases the
 * settlement succeeded with H consumed and the input released while the user was short-changed.
 * `minOut` meant "asked", not "arrived".
 *
 * Settlement now measures the user's balance either side of the call and requires the DELTA to reach
 * minOut, so this attack is a REGRESSION TEST for that fix. One deployable token, four behaviours:
 *
 *   FEE_ON_TRANSFER  moves 90% and returns true  -> must REVERT on the delta, nothing consumed
 *   LIAR             moves nothing, returns true -> must REVERT on the delta, nothing consumed
 *   NO_RETURN        transfers fine, returns no data (the pre-EIP-20 style many real tokens use)
 *                    -> must now SUCCEED. It used to revert, because Solidity cannot decode a missing
 *                       bool, which locked out perfectly good tokens. Empty returndata is accepted,
 *                       and the delta check is what makes accepting it safe.
 *   HONEST           the control
 *
 * What is still NOT defended, and cannot be: a token whose issuer claws the balance back afterwards.
 * No on-chain check survives an adversarial issuer. That is why the output asset being the USER'S OWN
 * signed choice matters — nobody else picks it, so this stays a wallet-safety rule (never offer
 * arbitrary tokens as outputs) on top of the delta check, not instead of it.
 *
 * Falsifier: a short or absent delivery settles anyway (the delta check is not doing its job), a
 * return-less but honest token is still refused, or a failed delivery leaves H consumed or the escrow
 * drained — the loss landing anywhere other than the failed transaction itself.
 */
import { Contract, ContractFactory, JsonRpcProvider, Network, Wallet, getBytes, hexlify, randomBytes } from "ethers";
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { depositForPegin, peginOf, bindingOf } from "../src/settlement.js";
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
    await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btcTxid), INPUT, bindingOf(H, user.address)));
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
  a.check("settle REVERTED — the token's `true` does not survive a balance check", !s1.ok, s1.reason ?? "no reason");
  a.check("refused on the DELTA, not on the return value", /under-delivered/.test(s1.reason ?? ""), s1.reason ?? "");
  a.check("the user received nothing, because nothing settled",
    (await token.balanceOf(p1.user.address)) === 0n);
  a.check("H untouched — the intent is still solvable with a token that works",
    !(await isConsumed((to, d) => rpcA.ethCall(to, d), p1.H)));
  a.check("escrow untouched", (await peginOf(rpcA.url, hexlify(p1.btcTxid))) === INPUT);
  a.note("before the fix this SETTLED: the user got 90% of their minOut, H consumed, input released.");
  a.note("`minOut` now means 'arrived' — the only reading under which it guarantees anything.");

  // ---- case 2: outright liar ----------------------------------------------------------------
  a.step("case 2 — LIAR: transferFrom moves nothing at all and returns true");
  await waitReceipt(rpcA, (await token.setMode(MODE.LIAR, ov)).hash);
  const p2 = await stage();
  const s2 = await a.tx(solver.solve(p2.intent.rawHex, 0n));
  a.check("settle REVERTED with zero delivered", !s2.ok, s2.reason ?? "no reason");
  a.check("refused on the delta", /under-delivered/.test(s2.reason ?? ""), s2.reason ?? "");
  a.check("the user received NOTHING — and lost nothing", (await token.balanceOf(p2.user.address)) === 0n);
  a.check("H untouched", !(await isConsumed((to, d) => rpcA.ethCall(to, d), p2.H)));
  a.check("the input was NOT released", (await peginOf(rpcA.url, hexlify(p2.btcTxid))) === INPUT);
  a.note("the failure is now confined to the solver's own reverted transaction: it pays gas, the user");
  a.note("keeps a solvable intent, and the escrow is still there for a solver with a working token");

  // ---- case 3: no return data ---------------------------------------------------------------
  a.step("case 3 — NO_RETURN: a pre-EIP-20 token that transfers fine but returns no data");
  await waitReceipt(rpcA, (await token.setMode(MODE.NO_RETURN, ov)).hash);
  const p3 = await stage();
  const s3 = await a.tx(solver.solve(p3.intent.rawHex, 0n));
  a.check("settle SUCCEEDED — empty returndata is accepted, not decoded as a failure", s3.ok, s3.reason ?? "");
  a.check("the user was paid in full", (await token.balanceOf(p3.user.address)) === MINOUT);
  a.check("H consumed", await isConsumed((to, d) => rpcA.ethCall(to, d), p3.H));
  a.check("escrow released", (await peginOf(rpcA.url, hexlify(p3.btcTxid))) === 0n);
  a.note("this case REVERSED with the fix: return-less tokens used to be unusable as outputs because");
  a.note("Solidity cannot decode a missing bool. Accepting silence is only safe BECAUSE of the delta");
  a.note("check — a non-token address also returns empty, and fails on the delta instead.");

  // ---- control: the same token, behaving ----------------------------------------------------
  a.step("control — HONEST mode: the same token pays in full");
  await waitReceipt(rpcA, (await token.setMode(MODE.HONEST, ov)).hash);
  const p4 = await stage();
  const s4 = await a.tx(solver.solve(p4.intent.rawHex, 0n));
  a.check("settle succeeded", s4.ok, s4.reason ?? "");
  a.check("user received the full minOut", (await token.balanceOf(p4.user.address)) === MINOUT);
  await a.deltas();

  // The attack works only if a SHORT or ABSENT delivery settled. Case 3 succeeding is the
  // compatibility control — a token behaving correctly must not be counted as the attack landing.
  const observed: Outcome = s1.ok || s2.ok ? "succeeds" : "blocked";
  return a.finish(observed);
}
