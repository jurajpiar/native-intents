/**
 * E14 — Real peg-in binding (productionization A). Retires the depositForPegin stand-in.
 *
 * A genuine RSKIP170 v1 peg-in credits the settlement contract (its OP_RETURN names the contract as the
 * RSK destination). The Bridge records (destination, amount) per txid; on settle the contract reads it,
 * verifies the destination is itself, and releases the ACTUAL pegged-in RBTC to the solver — the fully
 * faithful cross-asset flagship (user pegs in BTC, receives a token; solver claims the BTC-anchored RBTC).
 *
 * Falsifier: the Bridge doesn't record the contract as destination, the recorded amount is wrong, the
 * solver doesn't receive the real input, or the user isn't paid the output.
 *
 * Standalone + slow (relays real BTC headers). Run after `up` (waits for the RSKIPINTENT activation).
 */
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { Solver } from "../src/solver.js";
import { deployToken, token, mint, approve, balanceOf } from "../src/token.js";
import { Bridge } from "../src/bridge.js";
import { BtcRpc } from "../src/btcrpc.js";
import { Report, preflight, requireSettlement, rpcA, waitReceipt, succeeded } from "./_harness.js";
import { cowWallet, SETTLEMENT_ADDR } from "../src/config.js";
import { getBytes } from "ethers";

const PEGIN_BTC = 0.01;                        // 1e6 sat
const INPUT_WEIS = 10_000_000_000_000_000n;    // = 0.01 RBTC (1:1 peg)
const MINOUT = 1_000_000_000_000_000_000n;     // 1e18 token output
const CONFIRMATIONS = 3;
const GAS_BOUND = 2_000_000_000_000n;

async function main(): Promise<number> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  const r = new Report("E14 real peg-in binding", "a real peg-in credits the contract; settle releases the actual pegged-in input");
  const btc = new BtcRpc();
  const bridge = new Bridge(rpcA);

  // 1. real v1 peg-in crediting the settlement contract
  const fed = await bridge.getFederationAddress();
  await btc.ensureWallet();
  const legacy = await btc.getNewAddress("", "legacy");
  if ((await btc.getBlockCount()) < 101) await btc.generateToAddress(101 - (await btc.getBlockCount()), legacy);
  const contractBefore = BigInt(await rpcA.getBalance(SETTLEMENT_ADDR));
  const peginTxid = await btc.peginToRskAddress(fed, SETTLEMENT_ADDR, PEGIN_BTC);
  await btc.generateToAddress(1, legacy);
  const peginHeight = await btc.getBlockCount();
  await btc.generateToAddress(CONFIRMATIONS - 1, legacy);
  const btcBest = await btc.getBlockCount();
  console.log(`peg-in ${peginTxid} at btc height ${peginHeight}`);

  // 2. relay headers + register so the Bridge processes the peg-in
  const start = await bridge.bestChainHeight();
  console.log(`relaying btc headers ${start + 1}..${btcBest}...`);
  for (let h = start + 1; h <= btcBest; h++) {
    await waitReceipt(rpcA, await bridge.receiveHeader(await btc.getBlockHeaderRaw(await btc.getBlockHash(h))));
  }
  const rawTx = await btc.getRawTransaction(peginTxid);
  const pmt = (await btc.getTxOutProof([peginTxid])).slice(160);
  await waitReceipt(rpcA, await bridge.registerBtcTransaction(rawTx, peginHeight, pmt));

  // 3a. the peg-in credited the settlement contract (works even if getPeginInfo isn't in this build)
  const contractDelta = BigInt(await rpcA.getBalance(SETTLEMENT_ADDR)) - contractBefore;
  r.check("peg-in credited the settlement contract", contractDelta === INPUT_WEIS, `delta=${contractDelta}`);

  // 3b. Bridge recorded (destination = settlement contract, amount = input)
  const info = await bridge.getPeginInfo("0x" + peginTxid);
  if (info === null) console.error("getPeginInfo returned nothing — is the node built with milestone A? (down -v && build)");
  r.check("Bridge recorded pegin -> settlement contract", info !== null && info.dest.toLowerCase() === SETTLEMENT_ADDR.toLowerCase(), info ? info.dest : "none");
  r.check("recorded amount == pegged-in input", info !== null && info.amount === INPUT_WEIS, info ? `${info.amount}` : "none");

  // 4. token output setup (solver provides the token)
  const tokenAddr = await deployToken(rpcA.url);
  const cowToken = token(rpcA.url, tokenAddr);
  await waitReceipt(rpcA, await mint(cowToken, cowWallet().address, MINOUT * 10n));
  await waitReceipt(rpcA, await approve(cowToken, SETTLEMENT_ADDR, MINOUT * 10n));

  // 5. user signs an intent referencing the real peg-in; solver settles
  const user = freshWallet();
  const H = randomH();
  const height = await rpcA.blockNumber();
  const intent = buildIntent(user, { H, btcTxid: getBytes("0x" + peginTxid), expiry: height + 90, minOut: MINOUT, outputToken: tokenAddr });
  await rpcA.sendRaw(intent.rawHex);
  const solver = new Solver(rpcA.url);
  const solverBefore = BigInt(await rpcA.getBalance(solver.payer));
  const rec = await waitReceipt(rpcA, await solver.solve(intent.rawHex, 0n));
  r.check("settle succeeded", succeeded(rec), rec ? rec.status : "no receipt");

  // 6. user got the token; solver claimed the REAL pegged-in RBTC
  r.check("user received minOut token", (await balanceOf(cowToken, user.address)) >= MINOUT);
  const solverDelta = BigInt(await rpcA.getBalance(solver.payer)) - solverBefore;
  r.check("solver claimed the real peg-in input (~INPUT_WEIS)", solverDelta > INPUT_WEIS - GAS_BOUND, `delta=${solverDelta}`);
  r.check("H consumed", await isConsumed((to, d) => rpcA.ethCall(to, d), H));
  return r.done();
}

main().then((c) => process.exit(c));
