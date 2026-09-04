/**
 * M01 — WHAT EACH ADMISSION RULE COSTS THE NODE.
 *
 * `IntentAdmission.check` short-circuits in a fixed order, so an intent can be built to die at any
 * chosen step and the marginal cost of a rule is the difference between dying at it and dying at the
 * one before. The order, read from the source rather than the spec:
 *
 *     1. data.length != 160                                      pure, no state
 *     2. expiry bitLength > 63                                   pure
 *     3. bestBlockNumber >= E                                    pure
 *     4. E - best > maxExpirySpan                                pure
 *     5. getStorageBytes(Settlement, consumedKeyForH(H))         STORAGE READ
 *     6. getStorageBytes(Bridge, processedPegin(btcTxid))        STORAGE READ, only if the rule is on
 *     7. accept                                                  + pool insert + gossip
 *
 * Signature recovery is NOT in that file — it happens upstream in the general transaction path. The
 * `bad_signature` variant exists to place it on the same scale, because the question that prompted
 * this measurement was whether verifying a Bitcoin merkle branch at admission would be significant
 * next to work the node already does per intent. That comparison has been asserted in conversation
 * and never measured. This does not settle whether a merkle check is affordable — it establishes
 * what the existing per-intent work costs, which is the denominator that argument needs.
 *
 * WHAT THIS MEASUREMENT CANNOT DO. Every number here includes an HTTP round trip, JSON parsing and
 * the pool's own locking, and those may be larger than the rules themselves. That is the point of
 * measuring `control_rpc` and of reporting intervals: where a marginal is not resolvable, the honest
 * output is that this method cannot see it. Instrumenting rskj is the follow-up for exactly those
 * rows, and it should be aimed only at the rows this run cannot resolve.
 *
 * CONFOUNDER, DELIBERATELY LEFT VISIBLE. `accepted` is the one variant that changes the node: every
 * accepted intent stays in the mempool, so the pool grows across the run and later samples pay a
 * larger insert. Its pool size is recorded per sample rather than controlled away, because the
 * growth curve is itself a thing worth knowing about a free-object mempool.
 */
import { getBytes, hexlify, randomBytes } from "ethers";
import { buildIntent, buildRawIntent, freshWallet, randomH } from "../src/intent.js";
import { encodeIntentData } from "../src/intent.js";
import { Rpc } from "../src/client.js";
import { RPC_A } from "../src/config.js";
import { preflight } from "../experiments/_harness.js";
import { TICKET_TXID } from "../attacks/_ticket.js";
import { environment, measure, persist, report, Variant } from "./_bench.js";

const ROUNDS = Number(process.env.M01_ROUNDS ?? 400);
const WARMUP = Number(process.env.M01_WARMUP ?? 150);

const rpc = new Rpc(RPC_A);

/**
 * Replace s with a value above the curve order, which is not a decodable signature at all.
 *
 * The first version of this flipped the last byte of s, on the theory that a corrupted signature is
 * an invalid one. It is not: a different s is usually a perfectly valid signature that recovers a
 * DIFFERENT address, and since an intent is payer-less, any recovered address is acceptable. That
 * variant was admitting most of its samples while claiming to measure a rejection.
 *
 * Note what this can and cannot measure. An out-of-range s is refused by a cheap range check BEFORE
 * any elliptic-curve work, so this times the range check, not recovery. Recovery cost is not
 * separable from outside the node — it happens for every intent that gets as far as having a sender,
 * so it is folded into every row below. Isolating it needs timers inside rskj.
 */
const SECP256K1_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const BAD_S = getBytes("0x" + SECP256K1_N.toString(16).padStart(64, "0"));

function withUndecodableSignature(make: () => string): string {
  // s is RLP-encoded as encElem(stripLeadingZeros(s)), so a 32-byte s ends the envelope as
  // 0xa0 || <32 bytes>. When s happens to have a leading zero byte it is shorter and the surgery
  // below would corrupt the RLP structure instead of the signature, so regenerate until it is not.
  for (let attempt = 0; attempt < 64; attempt++) {
    const b = getBytes(make());
    if (b[b.length - 33] !== 0xa0) continue;
    b.set(BAD_S, b.length - 32);
    return hexlify(b);
  }
  throw new Error("could not produce a 32-byte s after 64 attempts");
}

async function main(): Promise<void> {
  // Wait for RSKIPINTENT, exactly as the experiments do. Without this, a run started straight after
  // `stack:reset` measures nothing: every intent-shaped variant is refused with "native intents are
  // not active yet", five rows go unusable, and the only row left is the control. Cost one full run.
  await preflight(rpc);

  const height = await rpc.blockNumber();
  const chainId = await rpc.chainId();
  const ticketOn = await (async () => {
    // Ask the node rather than assume: offer one intent with an unplantable txid and read the reason.
    const probe = buildIntent(freshWallet(), {
      H: randomH(), btcTxid: getBytes("0x" + "be".repeat(32)), expiry: height + 20, minOut: 0n,
    });
    try { await rpc.sendRaw(probe.rawHex); return false; }
    catch (e) { return /ticket not visible/i.test(e instanceof Error ? e.message : String(e)); }
  })();

  // INTENT_REQUIRE_TICKET is consumed by docker-compose when the CONTAINER starts, not by this
  // process. Prefixing it onto `npm run m01` changes nothing about an already-running node, and the
  // only symptom is a skipped row that looks like an ordinary environment limitation.
  if (process.env.INTENT_REQUIRE_TICKET === "true" && !ticketOn) {
    console.log(`\n  INTENT_REQUIRE_TICKET=true is set here, but the NODE says the rule is off.`);
    console.log(`  That variable is read by docker-compose at container start. To turn the rule on:`);
    console.log(`      cd poc && INTENT_REQUIRE_TICKET=true npm run stack:reset`);
    console.log(`  then re-run. Until then the no_ticket row cannot be measured.\n`);
  }

  const n = ROUNDS + WARMUP + 8;
  const mk = (fn: (i: number) => string) => Array.from({ length: n }, (_, i) => fn(i));

  const send = (raw: string) => rpc.sendRaw(raw);

  // Payloads that must still be VALID when they are sent get the longest life the node will accept.
  // The first run used height + 20 while regtest mines every second (miner.client.delayBetweenBlocks
  // = 1s in stack/config/node-a.conf) and generation alone takes ~10s, so those intents aged out
  // mid-run and were rejected as expired — two rows silently measured rule 3 instead of their own.
  const LIVE_E = height + 95;   // maxExpirySpan is 100
  const liveIntent = (txid: Uint8Array = getBytes(randomBytes(32))) => buildIntent(freshWallet(), {
    H: randomH(), btcTxid: txid, expiry: LIVE_E, minOut: 0n,
  }).rawHex;

  /**
   * A txid the node will accept as a ticket, or null.
   *
   * With the ticket rule ON, a random txid can never be accepted — so the `accepted` row measures a
   * rule-6 rejection while claiming to measure acceptance, which is how a ticket-ON run lost that row
   * entirely. The attack board plants a fixed ticket into genesis (attacks/_ticket.ts); if this node
   * carries that plant, use it. Otherwise say plainly that the row cannot be measured here.
   */
  const usableTicket = await (async () => {
    if (!ticketOn) return getBytes(randomBytes(32));   // rule is off: any txid is fine
    try { await rpc.sendRaw(liveIntent(getBytes("0x" + TICKET_TXID))); return getBytes("0x" + TICKET_TXID); }
    catch { return null; }
  })();

  // Exact strings from IntentAdmission.java, so each row can prove it reached its own step.
  const REASON = {
    len: "data must be exactly",
    overflow: "expiry E out of range",
    expired: "intent: expired",
    tooFar: "expiry too far ahead",
    consumed: "H already consumed",
    ticket: "ticket not visible",
  };

  // The signature path is outside IntentAdmission, so its wording is not in a file I have read.
  // Ask the node once and use whatever it says, rather than guessing a substring and silently
  // marking every sample off-target.
  const sigReason = await (async () => {
    try { await rpc.sendRaw(withUndecodableSignature(liveIntent)); return "__accepted__"; }
    catch (e) {
      const m = (e instanceof Error ? e.message : String(e));
      console.log(`  probe — an undecodable signature is refused with: ${JSON.stringify(m.slice(0, 90))}`);
      return m.slice(0, 40);
    }
  })();
  if (sigReason === "__accepted__") console.log(`  probe — WARNING: an out-of-range s was ACCEPTED. The sig_undecodable row will be unusable.`);

  const variants: Variant[] = [
    {
      name: "control_rpc",
      what: "eth_chainId — the round trip with no transaction in it at all",
      payloads: mk(() => ""),
      run: () => rpc.call("eth_chainId"),
    },
    {
      name: "sig_undecodable",
      // Measured: rskj refuses this in acceptTransactionSignature, whose first clause is
      // `s >= SECP256K1N_HALF` — a BigInteger comparison, before any elliptic-curve work. The error
      // surfaces as "Invalid chainId: 33" via checkInvalidChain, which is misleading wording for a
      // low-s failure and is worth knowing if you are ever debugging a signer against this node.
      what: "s above the curve order — refused at the component check, before any curve work",
      payloads: mk(() => withUndecodableSignature(liveIntent)),
      expect: sigReason,
      run: send,
    },
    {
      name: "len_161",
      what: "rule 1 — payload is 161 bytes, rejected before anything is parsed out of it",
      payloads: mk((i) => buildRawIntent(freshWallet(), new Uint8Array(161).fill(i & 0xff)).rawHex),
      expect: REASON.len,
      run: send,
    },
    {
      name: "expiry_overflow",
      what: "rule 2 — E occupies more than 63 bits",
      payloads: mk(() => {
        const data = encodeIntentData({ H: randomH(), btcTxid: getBytes(randomBytes(32)), expiry: 0, minOut: 0n });
        data.set(new Uint8Array(32).fill(0xff), 64); // the E word
        return buildRawIntent(freshWallet(), data).rawHex;
      }),
      expect: REASON.overflow,
      run: send,
    },
    {
      name: "expired",
      what: "rule 3 — E is in the past",
      payloads: mk(() => buildIntent(freshWallet(), {
        H: randomH(), btcTxid: getBytes(randomBytes(32)), expiry: 1, minOut: 0n,
      }).rawHex),
      expect: REASON.expired,
      run: send,
    },
    {
      name: "too_far_ahead",
      what: "rule 4 — E is beyond maxExpirySpan",
      payloads: mk(() => buildIntent(freshWallet(), {
        H: randomH(), btcTxid: getBytes(randomBytes(32)), expiry: height + 1_000_000, minOut: 0n,
      }).rawHex),
      expect: REASON.tooFar,
      run: send,
    },
    {
      name: "h_consumed",
      what: "rule 5 — reaches the FIRST storage read, on a consumed H",
      payloads: null,           // filled in below once a genuinely consumed H exists
      unavailable: "no consumed H on this chain — run 'npm run e24' first (which needs the ticket rule OFF), then re-run",
      expect: REASON.consumed,
      run: send,
    },
    {
      name: "no_ticket",
      what: "rule 6 — reaches the SECOND storage read, ticket absent",
      payloads: ticketOn ? mk(liveIntent) : null,
      unavailable: ticketOn ? undefined : "requireBtcTicket is OFF on this node, so rule 6 never runs",
      expect: REASON.ticket,
      run: send,
    },
    {
      name: "accepted",
      what: "all rules pass — includes pool insert and gossip, and grows the pool as it runs",
      payloads: usableTicket ? mk(() => liveIntent(usableTicket)) : null,
      unavailable: "the ticket rule is ON and this node has no ticket an intent can name. Either run "
        + "with the rule off, or bring up a node carrying the genesis plant from attacks/_ticket.ts",
      run: send,   // no `expect`: this row is on target when the node ACCEPTS
    },
  ];

  // A consumed H, taken from the chain rather than invented: read one out of a past Settled event if
  // there is one. Without a real consumed H this variant stays unavailable and says so.
  const consumed = await findConsumedH();
  if (consumed) {
    const v = variants.find((x) => x.name === "h_consumed")!;
    v.payloads = mk(() => buildIntent(freshWallet(), {
      H: getBytes(consumed), btcTxid: getBytes(randomBytes(32)), expiry: LIVE_E, minOut: 0n,
    }).rawHex);
    v.unavailable = undefined;
  }

  // Everything that must stay valid was signed against LIVE_E. Regtest mines every second, so a long
  // enough run outlives it — say so before spending ten minutes producing a contaminated table.
  const afterGen = await rpc.blockNumber();
  const headroom = LIVE_E - afterGen;
  console.log(`  headroom — E is ${headroom} blocks ahead after generation (regtest mines ~1/s).`);
  if (headroom < (ROUNDS + WARMUP) / 100) {
    console.log(`  WARNING: this run may outlive E. Lower M01_ROUNDS, or expect the live rows to go unusable.`);
  }

  const samples = await measure(variants, {
    title: `M01 admission staircase — ${ROUNDS} rounds, chainId ${chainId}, ticket rule ${ticketOn ? "ON" : "OFF"}`,
    rounds: ROUNDS, warmup: WARMUP,
  });

  const ladder = ["control_rpc", "sig_undecodable", "len_161", "expiry_overflow", "expired", "too_far_ahead",
    "h_consumed", "no_ticket", "accepted"].filter((nm) => variants.find((v) => v.name === nm)?.payloads);
  report(samples, variants, ladder);

  const file = persist("m01_admission_staircase", samples, environment({
    rpc: RPC_A, chainId, ticketRuleOn: ticketOn, startHeight: height, rounds: ROUNDS, warmup: WARMUP,
    poolAtEnd: (await rpc.pendingTxs().catch(() => [])).length,
  }));
  const pool = (await rpc.pendingTxs().catch(() => [])).length;
  console.log(`\n  raw samples: ${file}`);
  console.log(`  ${samples.length} samples. No conclusion is drawn here — that happens in CLAIMS.md, with a citation.`);
  console.log(`  mempool now holds ${pool} intents: every 'accepted' sample stayed. If that row's`);
  console.log(`  'on target' is below 100%, read the reason printed for it — a pool limit and a`);
  console.log(`  duplicate hash both show up there. 'npm run stack:reset' before the next run.\n`);
}

/** A consumed H from a real settlement, or null. Never fabricates one — a fake would measure rule 5 as a miss. */
async function findConsumedH(): Promise<string | null> {
  try {
    const logs = await rpc.call<{ topics: string[] }[]>("eth_getLogs", [{
      fromBlock: "0x0", toBlock: "latest",
      // Settled(bytes32 indexed H, address indexed user, address outToken, uint256 minOut, uint256 input)
      topics: [null],
      address: (await import("../src/config.js")).SETTLEMENT_ADDR,
    }]);
    for (const l of logs ?? []) if (l.topics?.[1]) return l.topics[1];
    return null;
  } catch { return null; }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
