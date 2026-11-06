/**
 * E24 — A SOLVER THAT WAS NEVER TOLD ANYTHING.
 *
 * THE CLAIM THE WHOLE PROPOSAL RESTS ON, AND HAS NEVER TESTED. The Motivation says a signed message
 * from an account that cannot pay becomes a gossiped mempool object, and that solvers find work there.
 * Every experiment in this suite hands the solver `intent.rawHex` from an in-process variable — the
 * bytes travel through the test, not through the node. e1 shows an intent is ADMITTED, e7 shows one
 * SETTLES, and the step between them, discovery, has never happened. Something can be true of both
 * ends and false in the middle.
 *
 * The gap has a second edge. `solver.ts` says in its own header that "a real solver would fetch the
 * payload off-chain", and the RSKIP grew a `U-->>S: reveal the pipeline off-chain` arrow out of that
 * comment. But `settle` never opens H — it checks delivery of minOut and the escrow binding, nothing
 * more — so an off-chain reveal channel would be a liveness dependency the design does not need. If
 * this experiment passes, the arrow comes out of the spec. If it fails, the arrow was load-bearing all
 * along and the Motivation is in far worse shape than the reveal wording.
 *
 * WHAT MAKES THE SOLVER HERE HONEST. `solverSide` takes ONE argument: an RPC URL. Not the intent, not
 * the hash, not the wallet, not H. Anything it settles, it found. That is structural rather than
 * promised — a phantom pass would need the compiler's help.
 *
 * AND HOW IT PROVES ITS BYTES. rskj has no eth_getRawTransactionByHash, so the solver re-encodes the
 * envelope from the JSON view (src/reconstruct.ts) and checks that its reconstruction hashes to the
 * hash the node advertised. keccak256(signed bytes) IS the tx hash, so that check is decisive and
 * needs nothing from the user. Only then does it call settle.
 *
 * WHAT THE FIRST RUN FOUND. It failed on `v=0`. The envelope signs an EIP-155 v, but getEncodedV()
 * returns yParity for any typed transaction, and TransactionResultDTO omits chainId for the RSK
 * namespace — so the node's view of an intent drops both halves of the field. Recoverable, via
 * eth_chainId, and the checks below now pin that behaviour so a future rskj change is visible rather
 * than silent. The offline unit test had passed on this, because it was built from the same wrong
 * assumption as the code. That is precisely why this experiment has to touch a node.
 *
 * Falsifier: the pool never shows the intent; the two RPCs together do not carry enough to re-encode
 * it; the reconstruction does not hash to the advertised hash; or settle reverts on the reconstructed
 * bytes. Any of those breaks discovery over JSON-RPC, and with it the claim that the mempool is where
 * solvers get their work.
 */
import { hexlify, randomBytes, getBytes } from "ethers";
import { buildIntent, freshWallet, isConsumed, randomH } from "../src/intent.js";
import { Rpc } from "../src/client.js";
import { looksLikeIntent, missingForReconstruction, reconstructIntentRaw } from "../src/reconstruct.js";
import { bindingOf, depositForPegin, peginOf } from "../src/settlement.js";
import { Solver } from "../src/solver.js";
import { cowWallet } from "../src/config.js";
import { Report, errMsg, preflight, requireSettlement, rpcA, succeeded, waitReceipt } from "./_harness.js";

const INPUT = 10_000_000_000_000_000n; // what the escrow holds — the solver's take
const MINOUT = 1_000_000_000_000_000n; // what the user must be delivered

/** What the solver managed to do, told back to the experiment for checking. */
interface SolverResult {
  poolSize: number;
  candidates: number;
  poolHadType: boolean;
  poolHadSignature: boolean;
  missingFromPoolListing: string[];
  foundHash: string;
  reconstructed: string;
  settleHash: string;
  reportedV: string;
  chainIdFromNode: number;
  viewHadChainId: boolean;
}

/**
 * A solver with no relationship to anyone. It gets an RPC URL. Everything else it has to find.
 *
 * Deliberately written as the loop a real solver would run, in order: list the pool, classify by
 * shape, fetch the full view by hash, re-encode, verify against the advertised hash, settle.
 */
async function solverSide(rpcUrl: string): Promise<SolverResult> {
  const rpc = new Rpc(rpcUrl);

  // 1. what is in the pool
  const pool = await rpc.pendingTxs();
  const candidates = pool.filter(looksLikeIntent);
  if (candidates.length === 0) {
    throw new Error(`no intent-shaped tx in a pool of ${pool.length} — nothing to discover`);
  }
  const sample = candidates[0];

  // 2. record what the LISTING alone was worth, before topping it up
  const poolHadType = sample.type !== undefined;
  const poolHadSignature = sample.v !== undefined && sample.r !== undefined && sample.s !== undefined;
  const missingFromPoolListing = missingForReconstruction(sample);

  // 3. the listing is not enough — fetch the signed view by hash
  const full = await rpc.getTx(sample.hash);
  if (!full) throw new Error(`pool advertised ${sample.hash} but eth_getTransactionByHash returned null`);

  // 4. the view reports yParity for a typed tx and omits chainId, so ask the node for the chain id
  //    rather than trusting a constant compiled into this SDK — a real solver has no such constant.
  const chainIdFromNode = await rpc.chainId();

  // 5. re-encode, and refuse to proceed unless the bytes prove themselves
  const reconstructed = reconstructIntentRaw(full, { chainId: chainIdFromNode });

  // 6. settle what it found. RBTC output, so the solver attaches the delivery itself.
  const solver = new Solver(rpcUrl);
  const settleHash = await solver.solve(reconstructed, MINOUT);

  return {
    poolSize: pool.length, candidates: candidates.length, poolHadType, poolHadSignature,
    missingFromPoolListing, foundHash: sample.hash, reconstructed, settleHash,
    reportedV: full.v ?? "(absent)", chainIdFromNode, viewHadChainId: (full as { chainId?: string }).chainId !== undefined,
  };
}

async function main(): Promise<number> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  const r = new Report(
    "E24 mempool-sourced settlement",
    "a solver given only an RPC URL can find an intent in the pool, rebuild its signed bytes, and settle it");

  if (!r.check("solver payer (cow) funded", BigInt(await rpcA.getBalance(cowWallet().address)) > INPUT)) return r.done();

  // ---- the user's entire involvement, start to finish ------------------------------------------
  const user = freshWallet();
  const H = randomH();
  const btcTxid = getBytes(randomBytes(32));
  const height = await rpcA.blockNumber();

  // the funded party (a wallet backend) registers the peg-in — the user does not, and cannot
  await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btcTxid), INPUT, bindingOf(H, user.address)));
  r.check("escrow funded and bound to keccak256(H || user)", (await peginOf(rpcA.url, hexlify(btcTxid))) === INPUT);

  const intent = buildIntent(user, { H, btcTxid, expiry: height + 95, minOut: MINOUT });
  let admitted = true;
  let why = "";
  try { await rpcA.sendRaw(intent.rawHex); } catch (e) { admitted = false; why = errMsg(e); }
  if (!r.check("intent admitted to the pool", admitted, why.slice(0, 120) || intent.hash)) {
    console.error("\n  (if this refused on the ticket rule, the default stack has requireBtcTicket ON —\n" +
      "   this experiment needs a plantable or disabled ticket, see attacks/_ticket.ts)\n");
    return r.done();
  }
  r.check("user starts at zero balance", BigInt(await rpcA.getBalance(user.address)) === 0n, user.address);
  r.check("H starts unconsumed", !(await isConsumed((to, d) => rpcA.ethCall(to, d), H)));

  // From here the user is gone. Nothing below receives `intent`, `user`, or `H`.

  // ---- the solver, holding nothing but a URL ----------------------------------------------------
  let out: SolverResult;
  try {
    out = await solverSide(rpcA.url);
  } catch (e) {
    r.check("solver reconstructed and settled from the pool alone", false, errMsg(e).slice(0, 200));
    console.error("\n  DISCOVERY FAILED. This is the claim the Motivation rests on — see the header.\n");
    return r.done();
  }

  r.check("solver found an intent-shaped tx in the pool", out.candidates > 0,
    `${out.candidates} candidate(s) in a pool of ${out.poolSize}`);
  r.check("it is the user's intent", out.foundHash.toLowerCase() === intent.hash.toLowerCase(), out.foundHash);

  // ---- what the pool listing was actually worth (a finding either way) --------------------------
  r.check("txpool_content omits `type`, so the 0x0249 fast path cannot fire there", !out.poolHadType,
    out.poolHadType ? "type WAS present — rskj changed, update src/reconstruct.ts" : "classified by shape instead");
  r.check("txpool_content omits v/r/s, so the listing alone cannot be re-encoded", !out.poolHadSignature,
    `missing: ${out.missingFromPoolListing.join(", ") || "nothing"}`);

  // ---- and the signed view does not round-trip its own v ----------------------------------------
  // The envelope carries an EIP-155 v; getEncodedV() reports yParity for any typed tx; and the DTO
  // populates chainId only for TYPE_1/standard TYPE_2, so the RSK namespace loses both halves.
  r.check("the node reports v as a yParity bit, not the EIP-155 v that was signed",
    BigInt(out.reportedV) < 2n, `v = ${out.reportedV}`);
  r.check("and the view carries no chainId to rebuild it from", !out.viewHadChainId,
    out.viewHadChainId ? "chainId WAS present — rskj changed" : "so the solver must call eth_chainId");
  r.check("eth_chainId supplies the missing half", out.chainIdFromNode > 0, `chainId ${out.chainIdFromNode}`);

  // ---- the reconstruction ------------------------------------------------------------------------
  // It already proved itself against the node's hash inside the solver. This compares it to the bytes
  // the user actually signed, which the solver never saw — a second, independent confirmation.
  r.check("reconstructed bytes are IDENTICAL to what the user signed",
    out.reconstructed.toLowerCase() === intent.rawHex.toLowerCase(),
    `${(out.reconstructed.length - 2) / 2} bytes`);

  // ---- and it settles ----------------------------------------------------------------------------
  const rec = await waitReceipt(rpcA, out.settleHash);
  r.check("settle succeeded on the reconstructed bytes", succeeded(rec), out.settleHash);
  const bal = BigInt(await rpcA.getBalance(user.address));
  r.check("user was delivered >= minOut", bal >= MINOUT, `${bal}`);
  r.check("H consumed", await isConsumed((to, d) => rpcA.ethCall(to, d), H));
  r.check("escrow released to the solver", (await peginOf(rpcA.url, hexlify(btcTxid))) === 0n);

  console.log(
    "\n  The user broadcast and stopped. No reveal, no second signature, no channel to the solver.\n" +
    "  Discovery cost two RPC calls: txpool_content to find it, eth_getTransactionByHash to get a\n" +
    "  signature the listing does not carry. rskj has no eth_getRawTransactionByHash, so re-encoding\n" +
    "  is the only route — which makes rlp.ts's zero-field quirks load-bearing for SOLVERS, not just\n" +
    "  for signing.\n");

  return r.done();
}

main().then((c) => process.exit(c));
