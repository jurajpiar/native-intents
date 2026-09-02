/**
 * Above-minOut auction helpers (E17/E17b). One contract, two deployment modes:
 *  - deployAuction(): an SDK-deployed instance — pure off-consensus market structure, bypassable (E17);
 *  - AUCTION_ADDR: the genesis instance whose open auctions Settlement enforces (E17b).
 */
import { Contract, ContractFactory, JsonRpcProvider, Network, Wallet } from "ethers";
import auctionArtifact from "./abi/Auction.json" with { type: "json" };
import { AUCTION_ADDR, CHAIN_ID, COW_KEY } from "./config.js";

type Artifact = { abi: import("ethers").InterfaceAbi; bytecode: string };
const art = auctionArtifact as Artifact;

function walletFor(rpcUrl: string, key: string): Wallet {
  const provider = new JsonRpcProvider(rpcUrl, new Network("rsk-regtest", CHAIN_ID), { staticNetwork: true });
  return new Wallet(key, provider);
}

/** Deploy an unenforced (off-consensus) auction instance; returns its address. */
export async function deployAuction(rpcUrl: string, key: string = COW_KEY): Promise<string> {
  const factory = new ContractFactory(art.abi, art.bytecode, walletFor(rpcUrl, key));
  const c = await factory.deploy({ gasLimit: 3_000_000, gasPrice: 1_000_000, type: 0, chainId: CHAIN_ID });
  await c.waitForDeployment();
  return c.getAddress();
}

/** A handle bound to a signer; address defaults to the genesis (enforced) auction. */
export function auction(rpcUrl: string, key: string = COW_KEY, address: string = AUCTION_ADDR): Contract {
  return new Contract(address, art.abi, walletFor(rpcUrl, key));
}

const ov = { gasLimit: 700_000, gasPrice: 1_000_000, type: 0, chainId: CHAIN_ID } as const;

/** Bid `amount` weis of native RBTC (> minOut and > current best) on an RBTC-output intent. */
export async function placeBid(a: Contract, rawIntentTxHex: string, amount: bigint): Promise<string> {
  return (await a.bid(rawIntentTxHex, { ...ov, value: amount })).hash;
}
/** Bid `amount` of the intent's OUTPUT TOKEN (bidder must have approved the auction). */
export async function placeBidToken(a: Contract, rawIntentTxHex: string, amount: bigint): Promise<string> {
  return (await a.bidToken(rawIntentTxHex, amount, ov)).hash;
}
/** Execute the auction after its window closes (permissionless). Returns tx hash. */
export async function executeAuction(a: Contract, rawIntentTxHex: string): Promise<string> {
  return (await a.execute(rawIntentTxHex, ov)).hash;
}
/** Withdraw the signer's accrued native-RBTC credit (winner input / fallen-back surplus). */
export async function withdrawCredit(a: Contract): Promise<string> {
  return (await a.withdraw(ov)).hash;
}
/** Read the pull-payment credit ledger for `payee` (native RBTC). */
export async function creditOf(a: Contract, payee: string): Promise<bigint> {
  return a.credit(payee);
}
/** Reclaim a stranded best bid (H consumed elsewhere, or intent expired). Returns tx hash. */
export async function reclaimBid(a: Contract, H: Uint8Array | string): Promise<string> {
  return (await a.reclaim(H, ov)).hash;
}
export async function bidOf(a: Contract, H: Uint8Array | string): Promise<{ bidder: string; amount: bigint; deadline: bigint }> {
  const b = await a.bids(H);
  return { bidder: b.bidder, amount: b.amount, deadline: b.deadline };
}
export async function lockedUntil(a: Contract, H: Uint8Array | string): Promise<bigint> {
  return a.lockedUntil(H);
}
