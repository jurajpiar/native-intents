/**
 * E20 — Exit failure containment: the reservation edges E19 leaves unasserted, plus the exit-side
 * pull-payment hardening (Settlement `credit` ledger, mirroring the auction's F1–F4 pattern).
 *
 *  part 1: LATE BUT UNRACED — a reserver whose window lapsed with nobody re-reserving still settles
 *          and gets its bond back (no forfeit without a challenger).
 *  part 2: RE-RESERVE OVER LAPSED — taking over a lapsed reservation forfeits the old bond into the
 *          input escrow AT RESERVE TIME, and the taker's own settle returns its own bond: release =
 *          input + squatter's bond (+ own bond back).
 *  part 3: UNPAYABLE RESERVER — a CONTRACT solver with no receive() reserves, pays real BTC, and
 *          settles anyway: the bond refund and input release downgrade to Settlement credits instead
 *          of reverting ("bond refund failed" / "input claim failed" are gone). Its failed withdraw
 *          is confined to its own tx; the user is paid exactly once.
 *
 * Falsifier: an unraced late settle forfeits the bond, a lapsed reservation cannot be taken over (or
 * the old bond vanishes instead of sweetening the escrow), the unpayable reserver's settle reverts
 * (the self-brick survives — user would be double-paid after the lapse), the credit ledger mismatches
 * input + bond, or a failed withdraw corrupts it.
 *
 * Standalone + slow (real BTC headers, two 30-block reservation lapses). Needs bitcoind and the
 * hardened-exit genesis (Settlement with credit()): rebuild with wiped volumes if the probe fails.
 */
import { buildIntent, freshWallet, isConsumed, btcOutH } from "../src/intent.js";
import {
  depositForPegin, peginIntentOf, peginOf, settleBtcOut, reserveExit, exitBondFor, exitReservationOf,
  settlementCreditOf,
} from "../src/settlement.js";
import { branchFromTxOutProof } from "../src/merkle.js";
import { Bridge, syncHeadersTo } from "../src/bridge.js";
import { BtcRpc } from "../src/btcrpc.js";
import { Report, preflight, requireSettlement, rpcA, fundAccount, waitReceipt, succeeded, reverted } from "./_harness.js";
import { BTC_OUT, CHAIN_ID, COW_KEY, SETTLEMENT_ADDR } from "../src/config.js";
import { waitFor } from "../src/client.js";
import settlementArtifact from "../src/abi/Settlement.json" with { type: "json" };
import grieferArtifact from "../src/abi/Griefer.json" with { type: "json" };
import { Contract, ContractFactory, Interface, JsonRpcProvider, Network, Wallet, getBytes, hexlify, randomBytes } from "ethers";

const INPUT = 10_000_000_000_000_000n;  // 1e16 wei escrowed input per exit
const PAY_BTC = 0.009;
const MIN_SATS = 900_000n;
const GAS_BOUND = 3_000_000_000_000n;
const ov = { gasLimit: 2_000_000, gasPrice: 1_000_000, type: 0, chainId: CHAIN_ID } as const;

function cowW(): Wallet {
  const provider = new JsonRpcProvider(rpcA.url, new Network("rsk-regtest", CHAIN_ID), { staticNetwork: true });
  return new Wallet(COW_KEY, provider);
}

async function main(): Promise<number> {
  await preflight(rpcA);
  await requireSettlement(rpcA);
  // generation probe: the hardened exit leg ships the pull-payment ledger AND the entry binding this
  // experiment's escrows rely on (peginIntent). Probing only credit() let a half-old genesis through,
  // where the run failed later as three confusing balance-delta mismatches instead of bailing here.
  try {
    await settlementCreditOf(rpcA.url, "0x" + "0".repeat(40));
    await peginIntentOf(rpcA.url, "0x" + "0".repeat(64));
  }
  catch {
    console.error(`\nSettlement predates the exit pull-payment hardening (no credit()). Rebuild from the repo root:\n` +
      `  docker-compose -f poc/stack/podman-compose.yml down -v && docker-compose -f poc/stack/podman-compose.yml up -d --build\n`);
    process.exit(2);
  }
  const r = new Report("E20 exit failure containment",
    "late-but-unraced reservations keep their bond, takeovers of lapsed reservations forfeit the old bond into the escrow, and an unpayable reserver cannot self-brick a paid exit — its money waits as a credit");

  const btc = new BtcRpc();
  const bridge = new Bridge(rpcA);
  await btc.ensureWallet();
  const faucet = await btc.getNewAddress("e20-faucet", "legacy");
  if ((await btc.getBlockCount()) < 101 || (await btc.getBalance()) < 1) await btc.generateToAddress(101, faucet);
  const userBtcAddr = await btc.getNewAddress("e20-user", "legacy");
  const userDest = await btc.hash160Of(userBtcAddr);
  const solverBtcAddr = await btc.getNewAddress("e20-solver", "legacy");
  await btc.sendToAddress(solverBtcAddr, 0.06);
  await btc.generateToAddress(1, faucet);

  // Chunked: batch-sending a ~100-header backlog on one nonce run dies at -32010 "nonce too high"
  // around twenty deep (see syncHeadersTo).
  const relayTo = (target: number) => syncHeadersTo(rpcA, bridge, btc, target);
  console.log("syncing the Bridge to the BTC tip before any intent exists…");
  await relayTo(await btc.getBlockCount());

  /** A fresh exit intent (escrow deposited, broadcast) whose H commits to the shared user dest. */
  async function freshExit() {
    const salt = getBytes(randomBytes(32));
    const H = btcOutH(userDest, salt);
    const btcTxid = getBytes(randomBytes(32));
    // Assert the escrow landed: a silently failed deposit surfaces much later as an unexplained
    // "solver claimed nothing" delta, which reads as a falsified claim rather than a setup failure.
    if (!succeeded(await waitReceipt(rpcA, await depositForPegin(rpcA.url, hexlify(btcTxid), INPUT, hexlify(H))))) {
      throw new Error(`escrow deposit failed for ${hexlify(btcTxid).slice(0, 12)}…`);
    }
    // +90, not +150: admission caps the expiry span at intent.maxExpirySpan (100, pinned in
    // podman-compose.yml), so +150 was rejected outright and this experiment never ran a single
    // check. The widest part needs ~67 blocks — part 2 reserves TWICE in sequence, and each
    // reserveExit demands block.number + RESERVE_WINDOW(30) < expiry — so 90 leaves ~23 spare and
    // matches the sibling exit experiments (E19 uses +90).
    const intent = buildIntent(freshWallet(), { H, btcTxid, expiry: (await rpcA.blockNumber()) + 90, minOut: MIN_SATS, outputToken: BTC_OUT });
    await rpcA.sendRaw(intent.rawHex);
    return { salt, H, btcTxid, intent };
  }

  /**
   * Pay the user on Bitcoin, confirm, relay headers, and return proof parts for settleBtcOut.
   * `settler` is the RSK address that will CALL settleBtcOut: the payout commits to it, and the
   * contract requires msg.sender to match (the E8 payout-hijack fix). Part 3's settler is the
   * unpayable Griefer contract, not cow — committing to the wrong one reverts on that check.
   */
  async function payAndProve(settler: string = new Wallet(COW_KEY).address) {
    const { txid, rawHex } = await btc.payToAddress(solverBtcAddr, userBtcAddr, PAY_BTC, settler);
    await btc.generateToAddress(2, faucet);
    const v = await btc.getRawTransactionVerbose(txid);
    const payHeight = (await btc.getBlockCount()) - ((v.confirmations ?? 1) - 1);
    await relayTo(await btc.getBlockCount());
    const branch = branchFromTxOutProof(await btc.getTxOutProof([txid]), txid);
    return { rawBtcTx: rawHex, btcBlockHash: "0x" + (await btc.getBlockHash(payHeight)), merklePath: branch.path, merkleHashes: branch.hashes };
  }

  const bond = exitBondFor(MIN_SATS);
  const cowAddr = new Wallet(COW_KEY).address;

  // ---- part 1: LATE BUT UNRACED — lapsed reservation, nobody re-reserved, own settle keeps the bond ----
  const p1 = await freshExit();
  r.check("p1: reserver posts the bond", succeeded(await waitReceipt(rpcA, await reserveExit(rpcA.url, p1.intent.rawHex, bond))));
  const resv1 = await exitReservationOf(rpcA.url, p1.H);
  const proof1 = await payAndProve(); // pays DURING the window, settles after it
  console.log(`p1: letting the reservation lapse unraced (block ${resv1.until})…`);
  await waitFor(async () => BigInt(await rpcA.blockNumber()) >= resv1.until, 120000, 1000);
  const before1 = BigInt(await rpcA.getBalance(cowAddr));
  const late = await waitReceipt(rpcA, await settleBtcOut(rpcA.url, { rawIntentTx: p1.intent.rawHex, salt: p1.salt, btcDest: userDest, ...proof1 }));
  r.check("p1: late-but-unraced settle succeeds", succeeded(late), late ? late.status : "no receipt");
  const delta1 = BigInt(await rpcA.getBalance(cowAddr)) - before1;
  r.check("p1: bond returned despite the lapse (release = input + bond)", delta1 > INPUT + bond - GAS_BOUND, `delta=${delta1} (bond=${bond})`);

  // ---- part 2: RE-RESERVE OVER LAPSED — takeover forfeits the old bond into the escrow at reserve time ----
  const p2 = await freshExit();
  const s2key = Wallet.createRandom().privateKey;
  await waitReceipt(rpcA, await fundAccount(new Wallet(s2key).address, 20_000_000_000_000_000n));
  r.check("p2: squatter reserves (never pays)", succeeded(await waitReceipt(rpcA, await reserveExit(rpcA.url, p2.intent.rawHex, bond, s2key))));
  const squat = await exitReservationOf(rpcA.url, p2.H);
  console.log(`p2: letting the squat lapse (block ${squat.until})…`);
  await waitFor(async () => BigInt(await rpcA.blockNumber()) >= squat.until, 120000, 1000);
  const escrowBefore = await peginOf(rpcA.url, hexlify(p2.btcTxid));
  r.check("p2: takeover re-reserve over the lapsed squat succeeds", succeeded(await waitReceipt(rpcA, await reserveExit(rpcA.url, p2.intent.rawHex, bond))));
  r.check("p2: old bond forfeited INTO the escrow at reserve time", (await peginOf(rpcA.url, hexlify(p2.btcTxid))) - escrowBefore === bond, `escrow +${(await peginOf(rpcA.url, hexlify(p2.btcTxid))) - escrowBefore}`);
  const resv2 = await exitReservationOf(rpcA.url, p2.H);
  r.check("p2: reservation now belongs to the taker", resv2.solver.toLowerCase() === cowAddr.toLowerCase(), `until blk ${resv2.until}`);
  const proof2 = await payAndProve();
  const before2 = BigInt(await rpcA.getBalance(cowAddr));
  const rec2 = await waitReceipt(rpcA, await settleBtcOut(rpcA.url, { rawIntentTx: p2.intent.rawHex, salt: p2.salt, btcDest: userDest, ...proof2 }));
  r.check("p2: taker settles inside its window", succeeded(rec2), rec2 ? rec2.status : "no receipt");
  const delta2 = BigInt(await rpcA.getBalance(cowAddr)) - before2;
  r.check("p2: release = input + squatter's bond + own bond back", delta2 > INPUT + bond * 2n - GAS_BOUND, `delta=${delta2}`);

  // ---- part 3: UNPAYABLE RESERVER — pays real BTC, settles anyway; its money waits as a credit ----
  const cow = cowW();
  const gf = new ContractFactory(grieferArtifact.abi, grieferArtifact.bytecode, cow);
  const gdep = await gf.deploy({ ...ov, gasLimit: 1_500_000 });
  await gdep.waitForDeployment();
  const grieferAddr = await gdep.getAddress();
  const griefer = new Contract(grieferAddr, grieferArtifact.abi, cow);
  const iface = new Interface(settlementArtifact as import("ethers").InterfaceAbi);
  r.check("p3: unpayable contract solver deployed (no receive)", (await rpcA.getCode(grieferAddr)) !== "0x");

  const p3 = await freshExit();
  r.check("p3: griefer reserves through its contract",
    succeeded(await waitReceipt(rpcA, (await griefer.exec(SETTLEMENT_ADDR, iface.encodeFunctionData("reserveExit", [p3.intent.rawHex]), { ...ov, value: bond })).hash)));
  const proof3 = await payAndProve(grieferAddr); // real, irreversible — and committed to the GRIEFER, which settles it
  const settleData = iface.encodeFunctionData("settleBtcOut",
    [p3.intent.rawHex, p3.salt, userDest, "0x" + proof3.rawBtcTx.replace(/^0x/, ""), proof3.btcBlockHash, proof3.merklePath, proof3.merkleHashes]);
  const rec3 = await waitReceipt(rpcA, (await griefer.exec(SETTLEMENT_ADDR, settleData, ov)).hash);
  r.check("p3: settle SUCCEEDS despite the unpayable reserver (pre-fix: 'bond refund failed' self-brick)", succeeded(rec3), rec3 ? rec3.status : "no receipt");
  r.check("p3: H consumed — the user's exit settled exactly once, no double payment window", await isConsumed((to, d) => rpcA.ethCall(to, d), p3.H));
  const cred = await settlementCreditOf(rpcA.url, grieferAddr);
  r.check("p3: input + bond credited, not pushed", cred === INPUT + bond, `credit=${cred}`);

  const wd = await waitReceipt(rpcA, (await griefer.doWithdraw(SETTLEMENT_ADDR, { ...ov, gasLimit: 300_000 })).hash).catch(() => null);
  r.check("p3: griefer's withdraw fails in its OWN tx only", wd === null || reverted(wd), wd ? wd.status : "not mined");
  r.check("p3: credit ledger untouched by the failed withdraw", (await settlementCreditOf(rpcA.url, grieferAddr)) === INPUT + bond);

  console.log("\nexit failure modes are contained: lapses without challengers are free, takeovers pay the taker,");
  console.log("and an unpayable reserver strands only its own money — the user's exit settles exactly once.");
  return r.done();
}

main().then((c) => process.exit(c));
