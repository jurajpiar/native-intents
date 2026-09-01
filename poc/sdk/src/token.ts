/** Deploy / interact with the test ERC-20 (for the token-output experiment E10). */
import { Contract, ContractFactory, JsonRpcProvider, Network, Wallet } from "ethers";
import tokenArtifact from "./abi/TestToken.json" with { type: "json" };
import { CHAIN_ID, COW_KEY } from "./config.js";

type Artifact = { abi: import("ethers").InterfaceAbi; bytecode: string };
const art = tokenArtifact as Artifact;

function walletFor(rpcUrl: string, key: string): Wallet {
  const provider = new JsonRpcProvider(rpcUrl, new Network("rsk-regtest", CHAIN_ID), { staticNetwork: true });
  return new Wallet(key, provider);
}

/** Deploy the test token; returns its address. */
export async function deployToken(rpcUrl: string, key: string = COW_KEY): Promise<string> {
  const factory = new ContractFactory(art.abi, art.bytecode, walletFor(rpcUrl, key));
  const c = await factory.deploy({ gasLimit: 2_000_000, gasPrice: 1_000_000, type: 0, chainId: CHAIN_ID });
  await c.waitForDeployment();
  return c.getAddress();
}

/** A token handle bound to a signer. */
export function token(rpcUrl: string, address: string, key: string = COW_KEY): Contract {
  return new Contract(address, art.abi, walletFor(rpcUrl, key));
}

const ov = { gasLimit: 200_000, gasPrice: 1_000_000, type: 0, chainId: CHAIN_ID } as const;

export async function mint(t: Contract, to: string, amount: bigint): Promise<string> {
  return (await t.mint(to, amount, ov)).hash;
}
export async function approve(t: Contract, spender: string, amount: bigint): Promise<string> {
  return (await t.approve(spender, amount, ov)).hash;
}
export async function balanceOf(t: Contract, who: string): Promise<bigint> {
  return t.balanceOf(who);
}
