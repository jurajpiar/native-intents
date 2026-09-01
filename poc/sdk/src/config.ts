import { keccak256, toUtf8Bytes, Wallet } from "ethers";

export const CHAIN_ID = 33;                 // rskj regtest
export const INTENT_SUBTYPE = 0x49;         // 0x02 || 0x49

export const RPC_A = process.env.RPC_A ?? "http://localhost:4444";
export const RPC_B = process.env.RPC_B ?? "http://localhost:4445";

/** consumed-set registry precompile (see IntentConstants.java) */
export const REGISTRY_ADDR = "0x0000000000000000000000000000000001000020";

/** registry selectors (keccak256(sig)[:4]) */
export const SEL_IS_CONSUMED = "0x6346e832";
export const SEL_CONSUMED_HEIGHT = "0xc6c79c8b";
export const SEL_CONSUME = "0xaf6f8c1b";

/** pre-funded regtest account, privkey = keccak256("cow"); address 0xcd2a...d826 */
export const COW_KEY = keccak256(toUtf8Bytes("cow"));
export const cowWallet = () => new Wallet(COW_KEY);

/** intent data layout: H(32) | btcTxid(32) | E(32) | minOut(32) = 128 bytes */
export const INTENT_DATA_LEN = 128;
