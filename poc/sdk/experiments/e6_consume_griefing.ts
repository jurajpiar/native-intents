/**
 * E6 — Consume griefing (a KNOWN residual, not a claim to defend).
 *
 * The design doc flags it: in milestone 1 (no atomic bundle) consume(H) is permissionless, so nothing
 * binds consumption to actually delivering min-out. This experiment demonstrates the hole rather than
 * refuting it — a "pass" here means the grief succeeded exactly as documented, which is the point:
 * it quantifies the residual and motivates the milestone-2 atomic bundle.
 *
 * Procedure: submit a genuine intent(H) -> an adversary (any funded account) calls consume(H) WITHOUT
 *            solving -> show H is now consumed and the honest intent can never be re-submitted.
 * Cost of the grief: one consume tx's gas, per H, paid by the griefer. Bound: the honest user can
 *            re-issue under a fresh H (new pipeline commitment), so the grief is per-H, not permanent
 *            denial — state that bound explicitly in doc 03.
 */
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { Solver } from "../src/solver.js";
import { Report, preflight, rpcA, errMsg } from "./_harness.js";
import { waitFor } from "../src/client.js";
import { cowWallet } from "../src/config.js";
import { hexlify } from "ethers";

async function main(): Promise<number> {
  await preflight(rpcA);
  const r = new Report("E6 consume griefing (documented residual)", "m1 residual: consume() is unbound to delivery");

  const cowBal = BigInt(await rpcA.getBalance(cowWallet().address));
  if (!r.check("griefer payer (cow) is funded", cowBal > 0n, cowBal > 0n ? `${cowBal}` : "0 — run 'npm run diag'; node likely not on rsk-dev.json genesis")) return r.done();

  const H = randomH();
  const height = await rpcA.blockNumber();
  const honest = buildIntent(freshWallet(), { H, btcTxid: new Uint8Array(32), expiry: height + 100, minOut: 1_000_000n });
  await rpcA.sendRaw(honest.rawHex);
  r.check("honest intent admitted", true, honest.hash);

  // adversary consumes without delivering anything
  const adversary = new Solver(rpcA.url);
  let griefHash = "";
  try {
    griefHash = await adversary.consume(hexlify(H));
  } catch (e) {
    r.check("grief consume submitted", false, errMsg(e));
    return r.done();
  }
  const mined = await waitFor(async () => {
    const rec = await rpcA.getReceipt(griefHash).catch(() => null);
    return rec !== null && rec.blockNumber !== null;
  }, 20000);
  r.check("grief consume mined (no delivery)", mined, griefHash);
  r.check("H now consumed", await isConsumed((to, d) => rpcA.ethCall(to, d), H));

  // honest user can no longer use this H
  const reissueSameH = buildIntent(freshWallet(), { H, btcTxid: new Uint8Array(32), expiry: height + 100, minOut: 1_000_000n });
  let blocked = false;
  try { await rpcA.sendRaw(reissueSameH.rawHex); } catch (e) { blocked = true; void errMsg(e); }
  r.check("same-H re-issue is blocked (grief succeeded, as documented)", blocked);

  // ...but a fresh H works — bounding the grief to per-H, not permanent denial
  const reissueFreshH = buildIntent(freshWallet(), { H: randomH(), btcTxid: new Uint8Array(32), expiry: height + 100, minOut: 1_000_000n });
  let freshOk = false;
  try { await rpcA.sendRaw(reissueFreshH.rawHex); freshOk = true; } catch { freshOk = false; }
  r.check("fresh-H re-issue still works (grief is per-H)", freshOk);

  console.log("\nnote: E6 'passing' confirms the residual the design already flags — fix is the m2 atomic bundle.");
  return r.done();
}

main().then((c) => process.exit(c));
