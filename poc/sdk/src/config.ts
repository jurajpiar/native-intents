import { keccak256, toUtf8Bytes, Wallet } from "ethers";

export const CHAIN_ID = 33;                 // rskj regtest
export const INTENT_SUBTYPE = 0x49;         // 0x02 || 0x49

export const RPC_A = process.env.RPC_A ?? "http://localhost:4444";
export const RPC_B = process.env.RPC_B ?? "http://localhost:4445";

/** parse precompile (stateless: authenticates the intent, returns its fields) */
export const REGISTRY_ADDR = "0x0000000000000000000000000000000001000020";

/** settlement contract (m3, genesis-deployed): settle(bytes) + isConsumed(bytes32); owns the consumed set */
export const SETTLEMENT_ADDR = "0x0000000000000000000000000000000001000021";

/** RSK Bridge precompile (peg-in / SPV) */
export const BRIDGE_ADDR = "0x0000000000000000000000000000000001000006";

/** zero address == native RBTC output */
export const RBTC = "0x0000000000000000000000000000000000000000";

/** pre-funded regtest account, privkey = keccak256("cow"); address 0xcd2a...d826 */
export const COW_KEY = keccak256(toUtf8Bytes("cow"));
export const cowWallet = () => new Wallet(COW_KEY);

/** intent data layout: H(32) | btcTxid(32) | E(32) | minOut(32) | outputToken(32) = 160 bytes */
export const INTENT_DATA_LEN = 160;
