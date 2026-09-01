/*
 * Native-intent PoC — milestone 3 (settlement contract). This file is NEW.
 *
 * m3 moves settlement into a VM contract (Settlement.sol, genesis-deployed at SETTLEMENT_ADDR) so it
 * can deliver ERC-20 outputs and revert visibly. The precompile at INTENT_REGISTRY_ADDR is now a
 * stateless PARSER: it authenticates the raw intent tx and returns its fields to the contract. The
 * consumed set lives in the settlement contract's storage (slot == H), so admission reads it there.
 *
 * Wire format: 0x02 || 0x49 || rlp([nonce, gasPrice, gasLimit, to, value, data, v, r, s]) where
 *   data = H (32) || btcTxid (32) || expiryHeight (32) || minOut (32) || outputToken (32)   // 160 bytes
 *   outputToken is a 32-byte word with the 20-byte address right-aligned; the zero address = RBTC.
 */
package co.rsk.intent;

import co.rsk.core.RskAddress;
import org.ethereum.vm.DataWord;
import org.ethereum.vm.PrecompiledContracts;

public final class IntentConstants {

    private IntentConstants() { }

    /** Subtype byte under the 0x02 RSK namespace. 0x49 = 'I' (Intent). */
    public static final byte INTENT_SUBTYPE = 0x49;

    /** data field is exactly five 32-byte words. */
    public static final int INTENT_DATA_LEN = 160;
    public static final int OFF_H = 0;
    public static final int OFF_BTCTXID = 32;
    public static final int OFF_EXPIRY = 64;
    public static final int OFF_MINOUT = 96;
    public static final int OFF_OUTPUTTOKEN = 128;

    /** Parse precompile (stateless): parse(rawIntentTx) -> abi(sender,H,btcTxid,expiry,minOut,outputToken). */
    public static final String INTENT_REGISTRY_ADDR_STR = "0000000000000000000000000000000001000020";
    public static final DataWord INTENT_REGISTRY_ADDR_DW = DataWord.valueFromHex(INTENT_REGISTRY_ADDR_STR);
    public static final RskAddress INTENT_REGISTRY_ADDR = new RskAddress(INTENT_REGISTRY_ADDR_STR);

    /** Settlement contract (genesis-deployed): owns the consumed set at slot == H. */
    public static final String SETTLEMENT_ADDR_STR = "0000000000000000000000000000000001000021";
    public static final DataWord SETTLEMENT_ADDR_DW = DataWord.valueFromHex(SETTLEMENT_ADDR_STR);
    public static final RskAddress SETTLEMENT_ADDR = new RskAddress(SETTLEMENT_ADDR_STR);

    /**
     * Bridge processed-peg-in storage key, mirroring BridgeStorageProvider (post-RSKIP134). A non-empty
     * value under this key at the Bridge address means the BTC txid is a processed peg-in (the ticket).
     */
    public static DataWord bridgeProcessedPeginKey(String btcTxidBigEndianHex) {
        return DataWord.fromLongString("btcTxHashAP" + "-" + btcTxidBigEndianHex);
    }

    /** Consumed-set storage key for an intent hash H (slot == H in the settlement contract). */
    public static DataWord consumedKeyForH(byte[] h32) {
        return DataWord.valueOf(h32);
    }

    public static RskAddress bridgeAddr() {
        return PrecompiledContracts.BRIDGE_ADDR;
    }

    // --- Node-local admission policy, overridable via -Dintent.* JVM flags ---

    public static boolean requireBtcTicket() {
        return Boolean.parseBoolean(System.getProperty("intent.requireBtcTicket", "true"));
    }

    public static long maxExpirySpan() {
        return Long.getLong("intent.maxExpirySpan", 100L);
    }
}
