/** Toy AMM (Pool: RBTC/TOK constant-product, LP token "LPT") + generic TokenVault ("vLP") helpers —
 *  the venues for the compound intent: swap -> addLiquidity -> vault the LP. */
import { Contract, ContractFactory, JsonRpcProvider, Network, Wallet } from "ethers";
import poolArtifact from "./abi/Pool.json" with { type: "json" };
import tokenVaultArtifact from "./abi/TokenVault.json" with { type: "json" };
import { CHAIN_ID, COW_KEY } from "./config.js";

type Artifact = { abi: import("ethers").InterfaceAbi; bytecode: string };
const poolArt = poolArtifact as Artifact;
const tvArt = tokenVaultArtifact as Artifact;

function walletFor(rpcUrl: string, key: string): Wallet {
  const provider = new JsonRpcProvider(rpcUrl, new Network("rsk-regtest", CHAIN_ID), { staticNetwork: true });
  return new Wallet(key, provider);
}
const ov = { gasLimit: 400_000, gasPrice: 1_000_000, type: 0, chainId: CHAIN_ID } as const;

export async function deployPool(rpcUrl: string, tokAddr: string, key: string = COW_KEY): Promise<string> {
  const f = new ContractFactory(poolArt.abi, poolArt.bytecode, walletFor(rpcUrl, key));
  const c = await f.deploy(tokAddr, { gasLimit: 3_000_000, gasPrice: 1_000_000, type: 0, chainId: CHAIN_ID });
  await c.waitForDeployment();
  return c.getAddress();
}
export async function deployTokenVault(rpcUrl: string, assetAddr: string, key: string = COW_KEY): Promise<string> {
  const f = new ContractFactory(tvArt.abi, tvArt.bytecode, walletFor(rpcUrl, key));
  const c = await f.deploy(assetAddr, { gasLimit: 2_000_000, gasPrice: 1_000_000, type: 0, chainId: CHAIN_ID });
  await c.waitForDeployment();
  return c.getAddress();
}
export function pool(rpcUrl: string, address: string, key: string = COW_KEY): Contract {
  return new Contract(address, poolArt.abi, walletFor(rpcUrl, key));
}
export function tokenVault(rpcUrl: string, address: string, key: string = COW_KEY): Contract {
  return new Contract(address, tvArt.abi, walletFor(rpcUrl, key));
}

export async function reserves(p: Contract): Promise<{ rbtc: bigint; tok: bigint; lpSupply: bigint }> {
  return { rbtc: await p.reserveRbtc(), tok: await p.reserveTok(), lpSupply: await p.totalSupply() };
}
/** Provide rbtc + matching tok (caller must have approved the pool for tok). Returns tx hash. */
export async function addLiquidity(p: Contract, rbtc: bigint, tok: bigint): Promise<string> {
  return (await p.addLiquidity(tok, { ...ov, value: rbtc })).hash;
}
export async function lpBalanceOf(p: Contract, who: string): Promise<bigint> {
  return p.balanceOf(who);
}
/** Burn LP for the proportional share of both reserves. Returns tx hash. */
export async function removeLiquidity(p: Contract, lp: bigint): Promise<string> {
  return (await p.removeLiquidity(lp, ov)).hash;
}
export async function lpApprove(p: Contract, spender: string, amount: bigint): Promise<string> {
  return (await p.approve(spender, amount, ov)).hash;
}
/** Deposit LP into the vault for vLP shares 1:1 (caller must have approved the vault). Returns tx hash. */
export async function tvDeposit(tv: Contract, amount: bigint): Promise<string> {
  return (await tv.deposit(amount, ov)).hash;
}
export async function tvApprove(tv: Contract, spender: string, amount: bigint): Promise<string> {
  return (await tv.approve(spender, amount, ov)).hash;
}
export async function tvSharesOf(tv: Contract, who: string): Promise<bigint> {
  return tv.balanceOf(who);
}
export async function tvWithdraw(tv: Contract, shares: bigint): Promise<string> {
  return (await tv.withdraw(shares, ov)).hash;
}
