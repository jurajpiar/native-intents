/**
 * Solver bond (productionization C). A standalone contract solvers stake into so they have capital at
 * risk; entry stays permissionless (anyone can bond). It is NOT on the settlement path — bonding is
 * off-consensus market structure / skin-in-the-game, not a validity gate — so it is deployed by the SDK
 * (no genesis change) and referenced only by the competing-solvers experiment.
 */
import { Contract, ContractFactory, JsonRpcProvider, Network, Wallet } from "ethers";
import bondArtifact from "./abi/Bond.json" with { type: "json" };
import { CHAIN_ID, COW_KEY } from "./config.js";

type Artifact = { abi: import("ethers").InterfaceAbi; bytecode: string };
const art = bondArtifact as Artifact;

export const MIN_BOND = 100_000_000_000_000_000n; // 0.1 RBTC, matches Bond.MIN_BOND

function walletFor(rpcUrl: string, key: string): Wallet {
  const provider = new JsonRpcProvider(rpcUrl, new Network("rsk-regtest", CHAIN_ID), { staticNetwork: true });
  return new Wallet(key, provider);
}

/** Deploy the bond contract; the deployer becomes the arbiter (can slash). Returns its address. */
export async function deployBond(rpcUrl: string, key: string = COW_KEY): Promise<string> {
  const factory = new ContractFactory(art.abi, art.bytecode, walletFor(rpcUrl, key));
  const c = await factory.deploy({ gasLimit: 1_500_000, gasPrice: 1_000_000, type: 0, chainId: CHAIN_ID });
  await c.waitForDeployment();
  return c.getAddress();
}

/** A bond handle bound to a signer (the solver, or the arbiter for slash). */
export function bond(rpcUrl: string, address: string, key: string = COW_KEY): Contract {
  return new Contract(address, art.abi, walletFor(rpcUrl, key));
}

const ov = { gasLimit: 120_000, gasPrice: 1_000_000, type: 0, chainId: CHAIN_ID } as const;

/** Stake `amount` weis as the signer's bond. Returns tx hash. */
export async function bondUp(b: Contract, amount: bigint): Promise<string> {
  return (await b.bondUp({ ...ov, value: amount })).hash;
}
export async function isBonded(b: Contract, solver: string): Promise<boolean> {
  return b.bonded(solver);
}
export async function bondOf(b: Contract, solver: string): Promise<bigint> {
  return b.bond(solver);
}
/** Arbiter-only slash of a solver's bond. Returns tx hash. */
export async function slash(b: Contract, solver: string, amount: bigint): Promise<string> {
  return (await b.slash(solver, amount, ov)).hash;
}
