/** BtcVault helpers (demo): the realistic intent destination — BTC in, bvBTC vault shares out. */
import { Contract, ContractFactory, JsonRpcProvider, Network, Wallet } from "ethers";
import vaultArtifact from "./abi/Vault.json" with { type: "json" };
import { CHAIN_ID, COW_KEY } from "./config.js";

type Artifact = { abi: import("ethers").InterfaceAbi; bytecode: string };
const art = vaultArtifact as Artifact;

function walletFor(rpcUrl: string, key: string): Wallet {
  const provider = new JsonRpcProvider(rpcUrl, new Network("rsk-regtest", CHAIN_ID), { staticNetwork: true });
  return new Wallet(key, provider);
}

/** Deploy the vault; returns its address. */
export async function deployVault(rpcUrl: string, key: string = COW_KEY): Promise<string> {
  const factory = new ContractFactory(art.abi, art.bytecode, walletFor(rpcUrl, key));
  const c = await factory.deploy({ gasLimit: 2_000_000, gasPrice: 1_000_000, type: 0, chainId: CHAIN_ID });
  await c.waitForDeployment();
  return c.getAddress();
}

export function vault(rpcUrl: string, address: string, key: string = COW_KEY): Contract {
  return new Contract(address, art.abi, walletFor(rpcUrl, key));
}

const ov = { gasLimit: 200_000, gasPrice: 1_000_000, type: 0, chainId: CHAIN_ID } as const;

/** Deposit RBTC for 1:1 shares. Returns tx hash. */
export async function vaultDeposit(v: Contract, amount: bigint): Promise<string> {
  return (await v.deposit({ ...ov, value: amount })).hash;
}
export async function vaultApprove(v: Contract, spender: string, amount: bigint): Promise<string> {
  return (await v.approve(spender, amount, ov)).hash;
}
export async function sharesOf(v: Contract, who: string): Promise<bigint> {
  return v.balanceOf(who);
}
