/**
 * A1 — SUBMIT AN INTENT BEFORE ITS CONSENSUS RULE ACTIVATES.
 *
 * The intent transaction type is parseable by the node's codecs before the fork that legitimises it,
 * so the attack is simply: send one early. If the node admits it, the type is live before its
 * activation height, and a block containing one would split consensus between upgraded and
 * un-upgraded nodes. That makes this the cheapest possible attack with the most expensive failure.
 *
 * WHY THIS RUNS ON ITS OWN NODE. Until now A1 delegated to the E13 experiment against whatever shared
 * chain happened to be up — and a shared chain is always thousands of blocks past activation, so the
 * pre-activation window could not be observed at all. The experiment said so and then reported a PASS
 * anyway (`r.check("pre-activation window already passed", true)`), which is worse than a gap: the
 * board printed "attack BLOCKED · as predicted" for a rule nothing had exercised.
 *
 * A height below a fork cannot be reached by mining forward, so this attack ships the state it needs
 * instead: a private node whose `rskipIntent` activation height is a parameter, mining ON DEMAND so
 * the pre-activation window stays open until the attack chooses to close it. What used to be a
 * 40-second race against regtest's block timer is now an ordinary assertion.
 *
 * The decisive detail is that BOTH halves use THE SAME SIGNED BYTES. Rejected at height h, admitted at
 * height h+n, identical payload — so the only variable is the activation rule. A fresh intent for the
 * second half would leave open the possibility that the first was malformed.
 *
 * Falsifier: the intent is admitted below the activation height (the gate is policy, not consensus),
 * the rejection is for some reason other than activation, the same bytes are still refused after
 * activation (the gate never opens, which would make the type unusable), or an admitted intent gets
 * MINED rather than staying mempool-only.
 */
import { getBytes, randomBytes } from "ethers";
import { buildIntent, freshWallet, randomH } from "../src/intent.js";
import { ACTIVATION_HEIGHT } from "../experiments/_harness.js";
import { Attack } from "./_forensics.js";
import { AttackSpec, Outcome } from "./registry.js";
import { StackCtx } from "./_stacks.js";

export async function run(spec: AttackSpec, ctx: StackCtx): Promise<number> {
  const a = new Attack(spec, ctx.rpc);
  const rpc = ctx.rpc;

  // One source of truth: the height the registry told the node to activate at.
  const activation = spec.fresh?.activation ?? ACTIVATION_HEIGHT;

  a.step("confirm this node really is below its own activation height");
  const start = await rpc.blockNumber();
  a.check("the node is pre-activation", start < activation, `height ${start}, activation at ${activation}`);
  a.check("and it mines on demand, so the window cannot close on its own", ctx.onDemand);
  if (start >= activation) {
    a.skip("the whole attack", `this node is already at or past activation (${start} >= ${activation}), ` +
      `so the pre-activation window cannot be observed — every check below would be vacuous`);
    return a.finish("blocked");
  }

  a.step("sign one intent — the same bytes will be offered before and after activation");
  const user = freshWallet();
  const intent = buildIntent(user, {
    H: randomH(),
    btcTxid: getBytes(randomBytes(32)),
    expiry: activation + 50, // valid on both sides of the fork, so expiry is never the reason
    minOut: 0n,
  });
  a.check("intent signed", intent.rawHex.length > 2, `${intent.rawHex.length / 2 - 1} bytes, H=${intent.H.slice(0, 12)}…`);

  a.step("offer it to the node BEFORE the rule activates");
  let earlyErr = "";
  let admittedEarly = false;
  try {
    await rpc.sendRaw(intent.rawHex);
    admittedEarly = true;
  } catch (e) {
    earlyErr = e instanceof Error ? e.message : String(e);
  }
  a.check("REJECTED below the activation height", !admittedEarly, earlyErr.slice(0, 120) || "admitted");
  a.check("rejected because the rule is not active, not for some other reason",
    /not active/i.test(earlyErr), earlyErr.slice(0, 120));
  const poolEarly = await rpc.pendingTxs().catch(() => []);
  a.check("nothing entered the mempool", !poolEarly.some((t) => t.hash?.toLowerCase() === intent.hash.toLowerCase()),
    `${poolEarly.length} pending tx(s)`);

  a.step(`mine past the activation height (${start} -> ${activation})`);
  await ctx.mineTo(activation);
  const now = await rpc.blockNumber();
  a.check("the node is now post-activation", now >= activation, `height ${now}`);

  a.step("offer THE SAME BYTES again");
  let lateErr = "";
  let admittedLate = false;
  try {
    await rpc.sendRaw(intent.rawHex);
    admittedLate = true;
  } catch (e) {
    lateErr = e instanceof Error ? e.message : String(e);
  }
  a.check("ADMITTED once the rule is active", admittedLate, lateErr.slice(0, 120) || "admitted");
  a.check("so the only thing that changed was the activation rule", !admittedEarly && admittedLate,
    "identical payload, opposite outcomes");
  const poolLate = await rpc.pendingTxs().catch(() => []);
  a.check("and it is in the mempool now",
    poolLate.some((t) => t.hash?.toLowerCase() === intent.hash.toLowerCase()), `${poolLate.length} pending tx(s)`);

  a.step("mine a block: an admitted intent must be gossipable but never mined");
  await ctx.mine(1);
  const rec = await rpc.getReceipt(intent.hash).catch(() => null);
  a.check("the intent was NOT included in a block", rec === null || rec.blockNumber === null,
    rec?.blockNumber ? `mined at block ${rec.blockNumber}` : "no receipt — still mempool-only");

  a.note("the gate is a consensus rule, not a policy flag: below the height the node refuses the type");
  a.note("outright, and the refusal names activation. Above it, the identical bytes are admitted.");
  a.note("This is the first run in which that was actually measured — the shared-chain version could");
  a.note("not reach a pre-activation height and asserted a pass instead.");

  const observed: Outcome = admittedEarly ? "succeeds" : "blocked";
  return a.finish(observed);
}
