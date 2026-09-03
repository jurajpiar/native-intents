/**
 * Shared Bitcoin-side scaffolding for the E-class (exit) attacks.
 *
 * The exit leg is the only place the PoC parses attacker-supplied bytes on chain, so the attacks that
 * matter most need arbitrary payout transactions — several outputs to one address, outputs below the
 * ask, segwit inputs, hundreds of outputs. bitcoind's wallet helper in ../src/btcrpc.ts builds one
 * shape only (pay-one-address-with-change), so this module adds the raw-tx and Bridge-relay plumbing
 * those attacks need, following the header-sync ordering E19 established the hard way: relay to the
 * BTC tip BEFORE any intent exists, or the ~100-header backlog expires the intent under test.
 */
import { getBytes, hexlify, randomBytes } from "ethers";
import { Bridge } from "../src/bridge.js";
import { settlerCommitmentScript, BtcRpc } from "../src/btcrpc.js";
import { branchFromTxOutProof, MerkleBranch } from "../src/merkle.js";
import { buildIntent, btcOutH, freshWallet, BuiltIntent } from "../src/intent.js";
import { depositForPegin } from "../src/settlement.js";
import { BTC_OUT } from "../src/config.js";
import { waitReceipt, rpcA } from "../experiments/_harness.js";
import { Attack } from "./_forensics.js";

export const SATS = 100_000_000;

export interface ExitEnv {
  btc: BtcRpc;
  bridge: Bridge;
  faucet: string;
  /** legacy P2PKH, funded — spending it yields a legacy-serialised payout. */
  solverLegacy: string;
  /** bech32 p2wpkh, funded — spending it yields a BIP144 witness-serialised payout. */
  solverSegwit: string;
  relayTo(target: number): Promise<void>;
}

/** Bring bitcoind and the Bridge's SPV view to a state where exit payouts can be proven. */
export async function setupExitEnv(a: Attack): Promise<ExitEnv> {
  const btc = new BtcRpc();
  const bridge = new Bridge(rpcA);
  await btc.ensureWallet();
  const faucet = await btc.getNewAddress("atk-faucet", "legacy");
  if ((await btc.getBlockCount()) < 101 || (await btc.getBalance()) < 1) {
    a.note(`mining 101 blocks for coinbase maturity…`);
    await btc.generateToAddress(101, faucet);
  }

  /**
   * Relay headers in CHUNKS, draining each before queuing the next. E19 batch-sends the whole backlog
   * on one nonce run, which works for the two or three headers a warm chain needs but not for the ~100
   * a fresh bitcoind needs: rskj's pool rejects a nonce too far ahead of the account's mined one
   * (-32010 "transaction nonce too high") around twenty deep, and the batch dies mid-relay.
   */
  async function relayTo(target: number): Promise<void> {
    const CHUNK = 10;
    for (;;) {
      const from = await bridge.bestChainHeight();
      if (from >= target) return;
      bridge.resetNonce(); // cow signs through other paths between chunks — re-sync each time
      let last: string | null = null;
      for (let h = from + 1; h <= Math.min(from + CHUNK, target); h++) {
        last = await bridge.receiveHeader(await btc.getBlockHeaderRaw(await btc.getBlockHash(h)));
      }
      if (!last) return;
      await waitReceipt(rpcA, last, 60000);
      if ((await bridge.bestChainHeight()) <= from) throw new Error(`header relay stalled at btc height ${from}`);
    }
  }

  const solverLegacy = await btc.getNewAddress("atk-solver", "legacy");
  const solverSegwit = await btc.getNewAddress("atk-solver-sw", "bech32");
  await btc.sendToAddress(solverLegacy, 0.5);
  await btc.sendToAddress(solverSegwit, 0.2);
  await btc.generateToAddress(1, faucet);

  const tip = await btc.getBlockCount();
  const spv = await bridge.bestChainHeight();
  if (tip > spv) a.note(`syncing the Bridge's SPV view ${spv + 1}…${tip} before any intent exists…`);
  await relayTo(tip);
  a.note(`btc tip ${tip}, bridge spv height ${await bridge.bestChainHeight()}`);
  return { btc, bridge, faucet, solverLegacy, solverSegwit, relayTo };
}

/** little-endian encoders for hand-serialising a payout. */
const u32le = (n: number) => Uint8Array.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
const u64le = (v: bigint) => Uint8Array.from(Array.from({ length: 8 }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn)));
function varint(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.from([n]);
  if (n <= 0xffff) return Uint8Array.from([0xfd, n & 0xff, (n >>> 8) & 0xff]);
  return Uint8Array.from([0xfe, n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}
const cat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/**
 * Hand-serialise an unsigned legacy transaction.
 *
 * createrawtransaction cannot express the shapes these attacks need — it rejects a duplicated address
 * outright ("Invalid parameter, duplicated address"), which rules out paying one destination twice in
 * one transaction. An attacker has no such constraint, so neither does this: outputs are given as raw
 * scriptPubKeys in the order they should appear.
 */
export function serialiseUnsigned(
  inputs: { txid: string; vout: number }[], outputs: { script: string; sats: bigint }[],
): string {
  const ins = inputs.map((i) => cat([
    Uint8Array.from(getBytes("0x" + i.txid).reverse()), // prevout hash: internal (reversed) order
    u32le(i.vout),
    Uint8Array.from([0x00]),                            // empty scriptSig; the wallet fills it in
    Uint8Array.from([0xff, 0xff, 0xff, 0xff]),          // sequence
  ]));
  const outs = outputs.map((o) => {
    const script = getBytes(o.script.startsWith("0x") ? o.script : "0x" + o.script);
    return cat([u64le(o.sats), varint(script.length), script]);
  });
  if (!ins.length) throw new Error("payout tx needs at least one input");
  // bare hex, no 0x: bitcoind's raw-tx RPCs reject the prefix with "TX decode failed"
  return hexlify(cat([u32le(2), varint(ins.length), ...ins, varint(outs.length), ...outs, u32le(0)])).slice(2);
}

const scriptCache = new Map<string, string>();
async function scriptOf(env: ExitEnv, addr: string): Promise<string> {
  const hit = scriptCache.get(addr);
  if (hit) return hit;
  const v = await env.btc.validateAddress(addr);
  if (!v.isvalid) throw new Error(`invalid address ${addr}`);
  scriptCache.set(addr, v.scriptPubKey);
  return v.scriptPubKey;
}

/**
 * Build, sign and broadcast a payout with ARBITRARY outputs — duplicates and hundreds of them
 * included. Change returns to `from`, so a segwit `from` yields a witness-serialised transaction.
 */
export async function payMulti(
  env: ExitEnv, from: string, outs: { addr: string; btc: number }[], feeBtc = 0.0005,
  settler?: string,
): Promise<{ txid: string; rawHex: string }> {
  const need = outs.reduce((s, o) => s + o.btc, 0) + feeBtc;
  const utxos = (await env.btc.listUnspent([from])).filter((u) => u.spendable);
  const inputs: { txid: string; vout: number }[] = [];
  let inSum = 0;
  for (const u of utxos) {
    inputs.push({ txid: u.txid, vout: u.vout });
    inSum += u.amount;
    if (inSum >= need) break;
  }
  if (inSum < need) throw new Error(`insufficient BTC at ${from}: have ${inSum}, need ${need}`);
  const outputs: { script: string; sats: bigint }[] = [];
  for (const o of outs) outputs.push({ script: await scriptOf(env, o.addr), sats: BigInt(Math.round(o.btc * SATS)) });
  // settler commitment (settleBtcOut requires it) — omit it deliberately to test the requirement
  if (settler) outputs.push({ script: settlerCommitmentScript(settler), sats: 0n });
  const change = inSum - need;
  if (change > 0.00001) outputs.push({ script: await scriptOf(env, from), sats: BigInt(Math.round(change * SATS)) });
  const signed = await env.btc.signRawTransactionWithWallet(serialiseUnsigned(inputs, outputs));
  if (!signed.complete) throw new Error("payout tx not fully signed");
  return { txid: await env.btc.sendRawTransactionBtc(signed.hex), rawHex: signed.hex };
}

/** Confirm a payout, relay the new headers, and return everything settleBtcOut needs to prove it. */
export async function confirmAndProve(env: ExitEnv, txid: string): Promise<{ blockHash: string; branch: MerkleBranch; height: number }> {
  await env.btc.generateToAddress(2, env.faucet); // MIN_BTC_CONF is 1; the spare keeps the tip moving
  const v = await env.btc.getRawTransactionVerbose(txid);
  const height = (await env.btc.getBlockCount()) - ((v.confirmations ?? 1) - 1);
  await env.relayTo(await env.btc.getBlockCount());
  return {
    blockHash: "0x" + (await env.btc.getBlockHash(height)),
    branch: branchFromTxOutProof(await env.btc.getTxOutProof([txid]), txid),
    height,
  };
}

export interface ExitIntent {
  intent: BuiltIntent;
  H: Uint8Array;
  salt: Uint8Array;
  btcTxid: Uint8Array;
  user: ReturnType<typeof freshWallet>;
}

/** A signed, broadcast exit intent with its RSK-side input escrowed and bound to H. */
export async function freshExitIntent(
  p: { destHash160: string; minSats: bigint; inputWei?: bigint; expiryBlocks?: number },
): Promise<ExitIntent> {
  const user = freshWallet();
  const salt = getBytes(randomBytes(32));
  const H = btcOutH(p.destHash160, salt);
  const btcTxid = getBytes(randomBytes(32));
  await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btcTxid), p.inputWei ?? 10_000_000_000_000_000n, hexlify(H)));
  const intent = buildIntent(user, {
    H, btcTxid, expiry: (await rpcA.blockNumber()) + (p.expiryBlocks ?? 90), minOut: p.minSats, outputToken: BTC_OUT,
  });
  await rpcA.sendRaw(intent.rawHex);
  return { intent, H, salt, btcTxid, user };
}

/**
 * Strip a BIP144 witness serialisation back to the legacy form the payout parser expects.
 *
 * This is the whole of attack E5's headline case: sha256d of these bytes IS the txid, which is what
 * the Bridge's merkle tree commits to, so the stripped form proves exactly what the witness form
 * proves — and it walks straight past `require(t[4] != 0x00, "segwit payout unsupported")`.
 *
 * Layout: version(4) | 0x00 0x01 | txins | txouts | witness stacks | locktime(4).
 */
export function stripWitness(rawHex: string): string {
  const b = getBytes(rawHex.startsWith("0x") ? rawHex : "0x" + rawHex);
  if (!(b[4] === 0x00 && b[5] === 0x01)) return hexlify(b); // already legacy
  let o = 6;
  // NB: read the length into a local before advancing. `o += varint()` evaluates o BEFORE the call and
  // so discards the reader's own advance — the cursor then lands mid-script and the next varint reads
  // a script byte as a length.
  const varint = (): number => {
    const v = b[o];
    if (v < 0xfd) { o += 1; return v; }
    if (v === 0xfd) { o += 3; return b[o - 2] | (b[o - 1] << 8); }
    if (v === 0xfe) { o += 5; return b[o - 4] | (b[o - 3] << 8) | (b[o - 2] << 16) | (b[o - 1] << 24); }
    throw new Error("8-byte varint in payout tx");
  };
  const nin = varint();
  for (let i = 0; i < nin; i++) {
    o += 36;                    // prevout
    const sl = varint();
    o += sl + 4;                // scriptSig + sequence
  }
  const nout = varint();
  for (let i = 0; i < nout; i++) {
    o += 8;                     // value
    const sl = varint();
    o += sl;                    // scriptPubKey
  }
  const bodyEnd = o;
  const legacy = new Uint8Array(4 + (bodyEnd - 6) + 4);
  legacy.set(b.subarray(0, 4), 0);                      // version
  legacy.set(b.subarray(6, bodyEnd), 4);                // txins + txouts, marker/flag dropped
  legacy.set(b.subarray(b.length - 4), 4 + bodyEnd - 6); // locktime
  return hexlify(legacy);
}
