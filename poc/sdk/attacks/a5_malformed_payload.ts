/**
 * A5 — MALFORMED INTENT PAYLOADS AT ADMISSION.
 *
 * Admission requires `data` to be exactly 160 bytes and then slices five 32-byte words out of it.
 * The SDK asserts that length before signing, so nothing in the normal suite ever puts a wrong-length
 * payload on the wire — an attacker has no such assert. IntentAdmission.check reads the length first
 * and rejects, but a Java-side slice on a short buffer would be an exception rather than a rejection,
 * and an exception on the admission path is a node-level denial-of-service, not a clean reject.
 *
 * So the question is narrow and worth answering exactly: for every wrong shape, does the node REJECT
 * (a named error, nothing pooled) or does it MISBEHAVE (throw, accept, or pool something it cannot
 * later parse)? Shapes tried:
 *
 *   empty          zero-length data
 *   one byte       far too short — a slice would run off the end immediately
 *   159 / 161      off by one in both directions, the classic boundary
 *   319 / 320      one word short of, and exactly, double length (a truncating parse would accept)
 *   huge           8 KB of payload, to see whether size alone is a cheap admission cost
 *
 * Every one carries a VALID signature over its own bytes, so nothing here is rejected for being
 * unsigned: the envelope is canonical and only the payload is wrong.
 *
 * Falsifier: any malformed payload is ACCEPTED into the mempool, or the node answers with something
 * other than a clean error (a socket hang-up, a 500, an internal exception surfaced to the caller).
 */
import { getBytes, hexlify, randomBytes } from "ethers";
import { buildRawIntent, freshWallet } from "../src/intent.js";
import { INTENT_DATA_LEN } from "../src/config.js";
import { errMsg, preflight, rpcA } from "../experiments/_harness.js";
import { Attack } from "./_forensics.js";
import { AttackSpec, Outcome } from "./registry.js";

/** the shapes worth trying, and why each one is interesting */
const SHAPES: { name: string; len: number; why: string }[] = [
  { name: "empty", len: 0, why: "zero-length: the first slice has nothing to read" },
  { name: "one byte", len: 1, why: "far too short — an unguarded slice runs off the end at once" },
  { name: "159 bytes", len: INTENT_DATA_LEN - 1, why: "one byte short of the boundary" },
  { name: "161 bytes", len: INTENT_DATA_LEN + 1, why: "one byte over — a length check that used >= would pass this" },
  { name: "319 bytes", len: INTENT_DATA_LEN * 2 - 1, why: "just under double: catches a modulo-based check" },
  { name: "320 bytes", len: INTENT_DATA_LEN * 2, why: "exactly double — a truncating parse would accept and pool it" },
  { name: "8 KB", len: 8192, why: "size alone: a free tx type must not make a big payload cheap to pool" },
];

export async function run(spec: AttackSpec): Promise<number> {
  await preflight(rpcA);
  const a = new Attack(spec, rpcA);

  a.note("every payload below is correctly SIGNED over its own bytes — only the length is wrong,");
  a.note("so any rejection is the payload rule firing and not a signature failure");

  let accepted = 0;
  let unclean = 0;

  for (const shape of SHAPES) {
    a.step(`${shape.name} — ${shape.why}`);
    const data = shape.len ? getBytes(hexlify(randomBytes(shape.len))) : new Uint8Array(0);
    const intent = buildRawIntent(freshWallet(), data);
    a.check(`signed a ${shape.len}-byte payload (SDK assert bypassed)`, intent.data.length === shape.len,
      `sender ${intent.sender.slice(0, 10)}…`);

    let err: string | null = null;
    let hash: string | null = null;
    try {
      hash = await rpcA.sendRaw(intent.rawHex);
    } catch (e) {
      err = errMsg(e);
    }

    if (hash) {
      accepted += 1;
      a.check("REJECTED at admission", false, `accepted as ${hash.slice(0, 14)}…`);
      const pooled = (await rpcA.pendingTxs()).some((t) => t.hash.toLowerCase() === hash!.toLowerCase());
      a.check("and it is NOT in the mempool", !pooled, pooled ? "pooled" : "not pooled");
      continue;
    }

    a.check("REJECTED at admission", true, (err ?? "").slice(0, 88));
    // a clean rejection names the rule. An internal exception surfaced as "Internal error" or an
    // empty message would mean the admission path threw rather than declining.
    const named = /intent|data|length|bytes|expired|payload/i.test(err ?? "");
    const internal = /internal error|unexpected|nullpointer|index out of|exception/i.test(err ?? "");
    if (!named || internal) unclean += 1;
    a.check("the error NAMES the rule (not an internal exception)", named && !internal, (err ?? "").slice(0, 88));
    a.check("nothing entered the mempool", !(await rpcA.pendingTxs()).some((t) => t.hash === intent.hash));
  }

  a.step("the node is still healthy after all of it");
  const head = await rpcA.blockNumber().catch(() => -1);
  a.check("node still answers and is building blocks", head > 0, `head ${head}`);
  const ok = await rpcA.peerCount().then(() => true, () => false);
  a.check("RPC still serving other methods", ok);

  a.note(`${SHAPES.length} malformed shapes tried: ${accepted} accepted, ${unclean} rejected uncleanly`);
  if (accepted === 0 && unclean === 0) {
    a.note("the length rule is checked BEFORE any slicing, so a bad payload is declined, never fatal");
  }

  const observed: Outcome = accepted > 0 ? "succeeds" : unclean > 0 ? "contained" : "blocked";
  return a.finish(observed);
}
