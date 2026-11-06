/**
 * A2 — FLOOD THE MEMPOOL WITH FREE INTENTS.
 *
 * An intent is payer-less and carries gasPrice 0. That is the design's central convenience — a user
 * whose only asset is arriving from Bitcoin can transact without holding RBTC — and it is also the
 * central DoS objection: if admission costs nothing, N intents from N fresh keys cost nothing, and
 * "sender can pay" is not there to bound the pool.
 *
 * The replacement bound is a BTC ticket: admission demands that the intent's `btcTxid` is a peg-in the
 * Bridge has actually processed. That makes the scarce resource a confirmed Bitcoin transaction rather
 * than gas, which cannot be minted from a keyboard.
 *
 * WHY THIS RUNS ON ITS OWN NODE. The rule is a NODE FLAG, `-Dintent.requireBtcTicket`, and the shared
 * stack pins it to `false` so the core claims can be exercised without any Bitcoin setup. No amount of
 * on-chain state reaches a startup flag, so for a long time this attack was not on the board at all:
 * it lived as a `docker run` line in a README, to be pasted by hand and remembered. It now declares a
 * private node with the flag on, which is the same isolation that line was reaching for, with the
 * remembering removed.
 *
 * The other half of that history matters too. An ADMITTED intent means one of two opposite things, and
 * the node's response is byte-identical either way: the rule is off (nothing was tested) or the rule is
 * on and was defeated (the finding). E8 handles that ambiguity by making the operator assert which
 * world the run is in. Here it cannot arise — the attack starts the node itself, so the flag's value is
 * known rather than declared, and an admission can only mean the rule was defeated.
 *
 * Falsifier: any intent is admitted (the ticket rule does not bind), a rejection names something other
 * than the ticket, the pool retains anything, or the node degrades under the flood.
 */
import { getBytes, randomBytes } from "ethers";
import { buildIntent, freshWallet, randomH } from "../src/intent.js";
import { Attack } from "./_forensics.js";
import { AttackSpec, Outcome } from "./registry.js";
import { StackCtx } from "./_stacks.js";

/** Enough to show the pattern holds rather than that one intent was unlucky. */
const FLOOD = 25;

export async function run(spec: AttackSpec, ctx: StackCtx): Promise<number> {
  const a = new Attack(spec, ctx.rpc);
  const rpc = ctx.rpc;

  a.note("the node under this attack was started BY the attack with requireBtcTicket=true, so an");
  a.note("admission here cannot be explained by the rule being off — the usual ambiguity is gone.");

  a.step("get past activation, so the ticket rule is the only thing left to refuse an intent");
  const activation = spec.fresh?.activation ?? 0;
  await ctx.mineTo(activation + 1);
  a.check("node is post-activation", (await rpc.blockNumber()) > activation,
    `height ${await rpc.blockNumber()}, activation at ${activation}`);

  a.step(`flood: ${FLOOD} intents, each from a FRESH key with a bogus btcTxid, all costing nothing`);
  const height = await rpc.blockNumber();
  let admitted = 0;
  let namedTicket = 0;
  const reasons = new Set<string>();
  for (let i = 0; i < FLOOD; i++) {
    // Fresh signer + random txid each time: no key is reused, so nothing here is rate-limited by a
    // nonce, and no two intents share a commitment. This is the cheapest shape the attack has.
    const intent = buildIntent(freshWallet(), {
      H: randomH(),
      btcTxid: getBytes(randomBytes(32)), // never a processed peg-in
      expiry: height + 50,
      minOut: 0n,
    });
    try {
      await rpc.sendRaw(intent.rawHex);
      admitted++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/ticket not visible in Bridge SPV view/i.test(msg)) namedTicket++;
      reasons.add(msg.replace(/txid 0x[0-9a-f]+/i, "txid …").slice(0, 90));
    }
  }
  a.check(`every one of the ${FLOOD} was REFUSED`, admitted === 0, `${admitted} admitted`);
  a.check("refused on the TICKET rule, not incidentally", namedTicket === FLOOD,
    `${namedTicket}/${FLOOD} named the ticket`);
  a.check("and they all failed the same way — one rule, not a scatter of accidents",
    reasons.size === 1, [...reasons].join(" | "));

  a.step("nothing survived in the pool: a refused intent must not be stored at all");
  const pool = await rpc.pendingTxs().catch(() => []);
  a.check("the mempool is empty", pool.length === 0, `${pool.length} pending`);

  a.step("the node is unharmed by the attempt");
  await ctx.mine(1);
  const head = await rpc.blockNumber();
  a.check("still building blocks", head > height, `head ${head}`);
  a.check("RPC still serving other methods", (await rpc.getBalance(freshWallet().address)) === "0x0");

  a.note("so the bound on a payer-less pool is a CONFIRMED BITCOIN TRANSACTION, not gas: the attacker");
  a.note("can mint keys and commitments freely, but not peg-ins. The cost of an admitted intent is");
  a.note("pushed onto Bitcoin, where it is already priced.");
  a.note("Not tested here, because a fresh node has no bitcoind: that a VALID ticket is admitted.");
  a.note("That is the positive half, and it lives in e8pos on the stack that has a Bitcoin node.");

  const observed: Outcome = admitted > 0 ? "succeeds" : "blocked";
  return a.finish(observed);
}
