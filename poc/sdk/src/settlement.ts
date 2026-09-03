/** Settlement contract helpers for the fee mechanics (m4): model the peg-in credit and read the escrow. */
import { Contract, JsonRpcProvider, Network, Wallet, keccak256, solidityPacked, hexlify } from "ethers";
import settlementAbi from "./abi/Settlement.json" with { type: "json" };
import { CHAIN_ID, COW_KEY, SETTLEMENT_ADDR } from "./config.js";

function contract(rpcUrl: string, key: string = COW_KEY): Contract {
  const provider = new JsonRpcProvider(rpcUrl, new Network("rsk-regtest", CHAIN_ID), { staticNetwork: true });
  return new Contract(SETTLEMENT_ADDR, settlementAbi as import("ethers").InterfaceAbi, new Wallet(key, provider));
}

/**
 * Model the peg-in: escrow `valueWei` of input RBTC against a BTC txid, BOUND to intent commitment
 * `intentH` (the PoC model of RSKIP176 entry binding — sign first, then deposit). Passing the default
 * zero H models a legacy/unbound peg-in, which stays exposed to txid squatting (atlas B1).
 */
/**
 * The escrow binding the contract keys on: keccak256(H || signer). Mirrors Settlement.bindingOf.
 *
 * NOT H alone. H is public the moment an intent is in the mempool, and anyone can sign an intent
 * carrying it; the signer is what a rival cannot forge. Binding to the pair is what stops a same-H
 * twin with a dust minOut collecting the victim's escrow (attack B5). In production this is the value
 * that goes into RSKIP-176's derivationArgumentsHash.
 */
export function bindingOf(H: string | Uint8Array, signer: string): string {
  return keccak256(solidityPacked(["bytes32", "address"], [hexlify(H), signer]));
}

/**
 * Model the peg-in credit. `binding` is bindingOf(H, signer) for a bound escrow, or all-zero for the
 * legacy unbound path. It is deliberately NOT computed here from an H: every caller has to say who the
 * signer is, because getting that wrong silently produces an escrow nobody can claim.
 */
export async function depositForPegin(
  rpcUrl: string, btcTxidHex: string, valueWei: bigint,
  binding: string | Uint8Array = "0x" + "0".repeat(64), key: string = COW_KEY,
): Promise<string> {
  const s = contract(rpcUrl, key);
  const tx = await s.depositForPegin(btcTxidHex, binding, { value: valueWei, gasLimit: 200_000, gasPrice: 1_000_000, type: 0, chainId: CHAIN_ID });
  return tx.hash;
}

/** Which intent a modelled escrow is bound to (zero hash = unbound/legacy). */
export async function peginIntentOf(rpcUrl: string, btcTxidHex: string): Promise<string> {
  return contract(rpcUrl).peginIntent(btcTxidHex);
}

/** Read the escrowed input for a BTC txid. */
export async function peginOf(rpcUrl: string, btcTxidHex: string): Promise<bigint> {
  return contract(rpcUrl).pegin(btcTxidHex);
}

/**
 * Settle an EXIT intent (E19): prove the solver's BTC payout (raw legacy tx + SPV branch against the
 * Bridge's header chain) paid >= minOut sats to the destination committed in H, consume H, and claim
 * the escrowed input. All BTC hashes in DISPLAY order. Returns the tx hash.
 */
export async function settleBtcOut(
  rpcUrl: string,
  p: { rawIntentTx: string; salt: Uint8Array | string; btcDest: string; rawBtcTx: string; btcBlockHash: string; merklePath: number; merkleHashes: string[] },
  key: string = COW_KEY,
  /** _findPayment scans every output, so a wide payout needs more than the default — see attacks/e5. */
  gasLimit = 1_500_000,
): Promise<string> {
  const s = contract(rpcUrl, key);
  const tx = await s.settleBtcOut(
    p.rawIntentTx, p.salt, p.btcDest,
    p.rawBtcTx.startsWith("0x") ? p.rawBtcTx : "0x" + p.rawBtcTx,
    p.btcBlockHash.startsWith("0x") ? p.btcBlockHash : "0x" + p.btcBlockHash,
    p.merklePath, p.merkleHashes,
    { gasLimit, gasPrice: 1_000_000, type: 0, chainId: CHAIN_ID },
  );
  return tx.hash;
}

/** The reservation bond for an exit paying `minOutSats`: 10% of the payout, in wei. */
export const exitBondFor = (minOutSats: bigint): bigint => minOutSats * 1_000_000_000n;

/**
 * Reserve an exit intent (exclusive settlement rights for RESERVE_WINDOW blocks) by posting the bond.
 * Losing this race costs gas; losing an UNRESERVED exit race costs real bitcoin — always reserve first.
 */
export async function reserveExit(rpcUrl: string, rawIntentTx: string, bondWei: bigint, key: string = COW_KEY): Promise<string> {
  const s = contract(rpcUrl, key);
  const tx = await s.reserveExit(rawIntentTx, { value: bondWei, gasLimit: 400_000, gasPrice: 1_000_000, type: 0, chainId: CHAIN_ID });
  return tx.hash;
}

/** Current reservation for an exit intent's H (zero solver = none). */
export async function exitReservationOf(rpcUrl: string, H: Uint8Array | string): Promise<{ solver: string; until: bigint; bond: bigint }> {
  const r = await contract(rpcUrl).exitReservations(H);
  return { solver: r.solver, until: r.until, bond: r.bond };
}

/** Forfeit an EXPIRED-while-reserved exit's bond to the intent's user (callable by anyone). */
export async function forfeitExpiredExitBond(rpcUrl: string, rawIntentTx: string, key: string = COW_KEY): Promise<string> {
  const s = contract(rpcUrl, key);
  const tx = await s.forfeitExpiredExitBond(rawIntentTx, { gasLimit: 300_000, gasPrice: 1_000_000, type: 0, chainId: CHAIN_ID });
  return tx.hash;
}

/** Pull-payment ledger: RBTC owed to `payee` after a failed best-effort push (input, bond, refund). */
export async function settlementCreditOf(rpcUrl: string, payee: string): Promise<bigint> {
  return contract(rpcUrl).credit(payee);
}

/** Withdraw the signer's accrued Settlement credits. Returns the tx hash. */
export async function withdrawSettlementCredit(rpcUrl: string, key: string = COW_KEY): Promise<string> {
  const s = contract(rpcUrl, key);
  const tx = await s.withdraw({ gasLimit: 200_000, gasPrice: 1_000_000, type: 0, chainId: CHAIN_ID });
  return tx.hash;
}

/** Has this (payout txid, vout) already settled an exit intent? txid in display order. */
export async function btcOutClaimed(rpcUrl: string, payTxidDisplay: string, vout: number): Promise<boolean> {
  const { solidityPackedKeccak256 } = await import("ethers");
  return contract(rpcUrl).claimedBtcOut(solidityPackedKeccak256(["bytes32", "uint256"], [payTxidDisplay, vout]));
}
