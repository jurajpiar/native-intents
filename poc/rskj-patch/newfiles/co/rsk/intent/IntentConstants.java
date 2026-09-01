/*
 * Native-intent PoC — milestone 1 (mempool-only, never mined standalone).
 * This file is NEW. It compiles against the pr3558 (RSKIP543/545/546 typed-tx) branch.
 *
 * Nothing here is committed rskj design. See ../../README.md for the honest caveats.
 */
package co.rsk.intent;

import co.rsk.core.RskAddress;
import org.ethereum.vm.DataWord;
import org.ethereum.vm.PrecompiledContracts;

/**
 * Constants for the native-intent transaction subtype and its registry precompile.
 *
 * Wire format (milestone 1): an intent is a normal RSK-namespace typed transaction
 *   0x02 || {@link #INTENT_SUBTYPE} || rlp([nonce, gasPrice, gasLimit, to, value, data, v, r, s])
 * whose {@code data} field carries the signed constraints, laid out as four 32-byte words:
 *   data = H (32) || btcTxid (32) || expiryHeight E (32) || minOut (32)   // 128 bytes
 *
 * Because pr3558 already decodes any 0x02||subtype body through the legacy 9-field parser,
 * the PoC needs NO new parser/encoder/record — the subtype byte lives in the prefix and the
 * constraints live in {@code data}. See EDITS.md.
 */
public final class IntentConstants {

    private IntentConstants() { }

    /** Subtype byte under the 0x02 RSK namespace. Must be in [0x00, 0x7f]. 0x49 = 'I' (Intent). */
    public static final byte INTENT_SUBTYPE = 0x49;

    /** data field is exactly four 32-byte words. */
    public static final int INTENT_DATA_LEN = 128;
    public static final int OFF_H = 0;
    public static final int OFF_BTCTXID = 32;
    public static final int OFF_EXPIRY = 64;
    public static final int OFF_MINOUT = 96;

    /** Registry precompile address: 0x...01000020 (next free slot after the existing 01000017). */
    public static final String INTENT_REGISTRY_ADDR_STR = "0000000000000000000000000000000001000020";
    public static final DataWord INTENT_REGISTRY_ADDR_DW = DataWord.valueFromHex(INTENT_REGISTRY_ADDR_STR);
    public static final RskAddress INTENT_REGISTRY_ADDR = new RskAddress(INTENT_REGISTRY_ADDR_STR);

    /** Registry ABI selectors (keccak256(sig)[:4]); see IntentRegistryContract. */
    public static final int SEL_IS_CONSUMED = 0x6346e832;      // isConsumed(bytes32)
    public static final int SEL_CONSUMED_HEIGHT = 0xc6c79c8b;  // consumedHeight(bytes32)
    // m2: solve(rawIntentTx) atomically delivers >= minOut and consumes H. The permissionless
    // consume(bytes32) from m1 is removed — the only way to consume H is to satisfy the intent.
    public static final int SEL_SOLVE = 0xc000a702;            // solve(bytes)

    /**
     * Bridge storage key for the processed-peg-in set, mirroring
     * BridgeStorageProvider.getStorageKeyForBtcTxHashAlreadyProcessed (post-RSKIP134 layout).
     * A non-empty value under this key at PrecompiledContracts.BRIDGE_ADDR means the BTC txid
     * has been registered as a peg-in — the PoC's anti-spam "ticket".
     *
     * @param btcTxidBigEndianHex the BTC txid as the 64-char hex string Sha256Hash.toString() returns
     */
    public static DataWord bridgeProcessedPeginKey(String btcTxidBigEndianHex) {
        return DataWord.fromLongString("btcTxHashAP" + "-" + btcTxidBigEndianHex);
    }

    /** Registry storage key for a committed intent hash H. */
    public static DataWord registryKeyForH(byte[] h32) {
        return DataWord.valueOf(h32);
    }

    public static RskAddress bridgeAddr() {
        return PrecompiledContracts.BRIDGE_ADDR;
    }

    // --- Node-local admission policy, overridable via -Dintent.* JVM flags (see stack/config) ---

    /** Require the referenced BTC txid to be a processed peg-in. Default true; set false for fast E1/E2/E3. */
    public static boolean requireBtcTicket() {
        return Boolean.parseBoolean(System.getProperty("intent.requireBtcTicket", "true"));
    }

    /** Reject intents whose expiry E is more than this many blocks ahead (bounds the consumed-set window). */
    public static long maxExpirySpan() {
        return Long.getLong("intent.maxExpirySpan", 100L);
    }
}
