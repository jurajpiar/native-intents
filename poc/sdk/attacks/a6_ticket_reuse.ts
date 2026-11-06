/**
 * A6 — ONE VALID TICKET, UNLIMITED INTENTS.
 *
 * The anti-spam rule replaces "the sender can pay" with "the intent names a Bitcoin peg-in the Bridge
 * has processed". The claim it is supposed to support is that free mempool admission has a real cost
 * behind it, because a confirmed Bitcoin transaction cannot be minted from a keyboard.
 *
 * This attack asks what that cost actually bounds. `IntentAdmission.check` does exactly one thing with
 * `btcTxid`: it looks up whether the Bridge has a processed peg-in under it. There is no counter, no
 * dedup, no binding to the sender. So the ticket looks like a cost per INTENT while behaving like a
 * cost per ATTACKER: pay once, then reuse the same txid across as many intents as you like, each with
 * a fresh `H` (thirty-two bytes nobody checks the provenance of) and a fresh key (which sidesteps any
 * per-account pool limit).
 *
 * A2 does not cover this. It floods with BOGUS txids and is correctly refused, which tests that the
 * rule exists — not that it bounds anything. The two attacks agree with each other and still leave the
 * interesting case untested, which is why this one is separate.
 *
 * HOW A VALID TICKET EXISTS ON A NODE WITH NO BITCOIN. Admission reads the Bridge's processed-peg-in
 * map with `getStorageBytes`, and genesis `contract.data` writes to that same store, so the ticket is
 * planted in the node's genesis (see ./_ticket.ts). No bitcoind, no header relay, no waiting — and,
 * more importantly, no way for the result to depend on Bitcoin-side timing.
 *
 * THE READING THIS ATTACK MUST NOT ALLOW. If the plant were wrong — bad slot, bad encoding — every
 * intent would be refused, and a careless run would report "the rule held". That is the same phantom
 * pass this suite has had to kill repeatedly, wearing a defence's clothes. So the first intent is a
 * PRECONDITION: if it is refused, the ticket was never planted, and the attack skips rather than
 * claiming a defence it did not observe. A control with an unplanted txid then proves the rule is
 * switched on at all, so "everything was admitted" cannot be explained by the flag being off.
 *
 * Falsifier: the flood is refused after the first intent (something does bound reuse), the planted
 * ticket does not admit even one intent (the plant failed — reported as a skip, not a defence), or the
 * unplanted control is admitted (the rule is off and the run proves nothing).
 */
import { getBytes } from "ethers";
import { buildIntent, freshWallet, randomH } from "../src/intent.js";
import { Attack } from "./_forensics.js";
import { AttackSpec, Outcome } from "./registry.js";
import { StackCtx } from "./_stacks.js";
import { NO_TICKET_TXID, TICKET_TXID } from "./_ticket.js";

/** Enough to show it is unbounded rather than lucky, without making the run slow. */
const FLOOD = 40;

export async function run(spec: AttackSpec, ctx: StackCtx): Promise<number> {
  const a = new Attack(spec, ctx.rpc);
  const rpc = ctx.rpc;
  const ticket = getBytes("0x" + TICKET_TXID);

  a.step("get past activation, so the ticket rule is the only thing that can refuse an intent");
  const activation = spec.fresh?.activation ?? 0;
  await ctx.mineTo(activation + 1);
  const height = await rpc.blockNumber();
  a.check("node is post-activation", height > activation, `height ${height}, activation at ${activation}`);

  /** one intent naming `txid`, from a key nobody has used before */
  const offer = async (txid: Uint8Array) => {
    const intent = buildIntent(freshWallet(), {
      H: randomH(), btcTxid: txid, expiry: height + 50, minOut: 0n,
    });
    try {
      await rpc.sendRaw(intent.rawHex);
      return { admitted: true, reason: "", intent };
    } catch (e) {
      return { admitted: false, reason: e instanceof Error ? e.message : String(e), intent };
    }
  };

  // ---- precondition: the planted ticket must actually work -------------------------------------
  // Read this before anything else. If the plant failed, every result below is "refused", which would
  // look exactly like a defence. The attack refuses to report that as one.
  a.step("precondition — the genesis-planted ticket admits ONE intent");
  const first = await offer(ticket);
  if (!first.admitted) {
    a.check("planted ticket is visible to admission", false, first.reason.slice(0, 110));
    a.skip("the whole attack", "the ticket was not planted correctly, so nothing below was tested — " +
      "a run of all-refusals here would mean the SETUP failed, not that the rule bounds reuse");
    a.note("check ./_ticket.ts against IntentConstants.bridgeProcessedPeginKey — the slot is");
    a.note("keccak256(utf8(\"btcTxHashAP-\" + txidHex)) on the Bridge, read with getStorageBytes.");
    return a.finish("blocked");
  }
  a.check("planted ticket is visible to admission — one intent admitted", true, `txid ${TICKET_TXID.slice(0, 12)}…`);

  // ---- control: the rule is genuinely on --------------------------------------------------------
  a.step("control — an intent naming an UNPLANTED txid must be refused");
  const control = await offer(getBytes("0x" + NO_TICKET_TXID));
  a.check("unplanted txid REFUSED", !control.admitted, control.reason.slice(0, 110) || "admitted");
  a.check("refused on the ticket rule, not something else",
    /ticket not visible in Bridge SPV view/i.test(control.reason), control.reason.slice(0, 110));
  a.note("so requireBtcTicket is ON — 'everything was admitted' below cannot mean the flag is off");

  // ---- the attack: reuse the one ticket ---------------------------------------------------------
  a.step(`flood — ${FLOOD} more intents, all naming the SAME txid, each from a fresh key`);
  let admitted = 0;
  let firstRefusal = "";
  for (let i = 0; i < FLOOD; i++) {
    const r = await offer(ticket);
    if (r.admitted) admitted++;
    else if (!firstRefusal) firstRefusal = `#${i + 1}: ${r.reason.slice(0, 100)}`;
  }
  a.check(`all ${FLOOD} admitted against one ticket`, admitted === FLOOD,
    firstRefusal || `${admitted}/${FLOOD} admitted`);
  a.check("nothing bounds how many intents may name one txid",
    admitted === FLOOD, "no counter, no dedup, no per-txid accounting in the admission rule");

  const total = admitted + 1;
  const pool = await rpc.pendingTxs().catch(() => []);
  a.check("and they are all sitting in the mempool", pool.length >= total,
    `${pool.length} pending, ${total} admitted against a single peg-in`);

  a.note(`ONE confirmed Bitcoin transaction bought ${total} admitted intents at roughly 262 bytes each.`);
  a.note("The ticket is a cost per ATTACKER, not per intent — a one-time entry fee, after which the");
  a.note("free object is free without limit. A2 misses this: it floods with BOGUS txids, so it proves");
  a.note("the rule EXISTS without testing what it BOUNDS.");
  a.note("The fix is to key admission on the escrow rather than the txid: require an escrow bound to");
  a.note("keccak256(H || signer) — the same binding settlement already checks. Each intent then needs");
  a.note("its own derived deposit, so the flood costs one Bitcoin transaction PER INTENT, which is the");
  a.note("design's own premise anyway. It also makes the relaxed-admission question moot, since what");
  a.note("is checked becomes escrow existence rather than confirmation depth.");

  const observed: Outcome = admitted === FLOOD ? "succeeds" : "blocked";
  return a.finish(observed);
}
