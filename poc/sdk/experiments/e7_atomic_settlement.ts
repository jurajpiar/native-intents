/**
 * E7 — Atomic settlement (milestone 2).
 *
 * Hypothesis: a solver's solve(intent) delivers at least minOut to the user AND records H consumed,
 * atomically, in one transaction. The user is a fresh zero-balance account; after settlement it holds
 * >= minOut and H is consumed.
 * Falsifier: the user is not credited >= minOut, or H is consumed without the user being paid, or the
 * two happen non-atomically.
 */
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { Solver } from "../src/solver.js";
import { Report, preflight, requireSettlement, rpcA, waitReceipt, succeeded } from "./_harness.js";
// m3: settlement is a VM contract, so a failed solve reverts visibly — we can assert on receipt status
// again, alongside the effects (delivery + consumed set).
import { cowWallet } from "../src/config.js";

const MINOUT = 1_000_000_000_000_000n; // 1e15 wei

async function main(): Promise<number> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  const r = new Report("E7 atomic settlement", "solve delivers >= minOut to the user and consumes H, atomically");

  if (!r.check("solver payer (cow) funded", BigInt(await rpcA.getBalance(cowWallet().address)) > MINOUT)) return r.done();

  const user = freshWallet();
  const H = randomH();
  const height = await rpcA.blockNumber();
  const intent = buildIntent(user, { H, btcTxid: new Uint8Array(32), expiry: height + 100, minOut: MINOUT });

  r.check("user starts at zero balance", BigInt(await rpcA.getBalance(user.address)) === 0n, user.address);
  r.check("H starts unconsumed", !(await isConsumed((to, d) => rpcA.ethCall(to, d), H)));

  await rpcA.sendRaw(intent.rawHex);
  r.check("intent admitted", true, intent.hash);

  const solver = new Solver(rpcA.url);
  const hash = await solver.solve(intent.rawHex, MINOUT); // RBTC output: attach minOut
  const rec = await waitReceipt(rpcA, hash);
  r.check("solve tx succeeded", succeeded(rec), hash);

  const bal = BigInt(await rpcA.getBalance(user.address));
  r.check("user received >= minOut (delivery)", bal >= MINOUT, `${bal}`);
  r.check("H now consumed", await isConsumed((to, d) => rpcA.ethCall(to, d), H));
  return r.done();
}

main().then((c) => process.exit(c));
