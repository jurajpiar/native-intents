/*
 * Native-intent PoC — milestone 1. This file is NEW.
 *
 * Pre-inclusion admission checks for an intent transaction. This is where the two irreducible
 * claims are enforced:
 *
 *   Claim 1 (mempool citizenship for a payer-less account): handled UPSTREAM by treating the
 *     intent as a free tx (Transaction.transactionCost == 0), so the balance / account-state
 *     validators short-circuit and a zero-balance sender is admitted and gossiped. See EDITS.md.
 *
 *   Claim 2 (invalidity before inclusion costs nothing): the checks below. An intent that is
 *     expired, replayed (H already consumed), or lacks a valid BTC ticket is rejected here, at
 *     admission — it never enters the mempool, never gossips, never reaches a block. No gas, no
 *     block space, nothing on chain.
 *
 * Both checks are plain storage reads against the current repository snapshot — no BridgeSupport
 * construction (which would risk the RepositoryBtcBlockStoreWithCache init side-effects), no new
 * DI wiring. The BTC-ticket read mirrors BridgeStorageProvider's processed-peg-in key exactly.
 */
package co.rsk.intent;

import co.rsk.core.bc.AccountInformationProvider;
import org.ethereum.core.Transaction;
import org.ethereum.util.ByteUtil;

import java.math.BigInteger;
import java.util.Arrays;

public final class IntentAdmission {

    private IntentAdmission() { }

    /** Immutable result: {@code error == null} means admitted. */
    public static final class Result {
        public final String error;
        private Result(String error) { this.error = error; }
        public boolean ok() { return error == null; }
        static Result accept() { return new Result(null); }
        static Result reject(String e) { return new Result(e); }
    }

    /**
     * @param tx               the candidate intent transaction (caller has checked tx.isNativeIntent())
     * @param repo             current repository snapshot (best block state)
     * @param bestBlockNumber  current chain height
     * @param requireBtcTicket node policy: require the referenced BTC txid to be a processed peg-in
     * @param maxExpirySpan    node policy: reject intents whose E is more than this many blocks ahead
     */
    public static Result check(Transaction tx,
                               AccountInformationProvider repo,
                               long bestBlockNumber,
                               boolean requireBtcTicket,
                               long maxExpirySpan) {
        byte[] data = tx.getData();
        if (data == null || data.length != IntentConstants.INTENT_DATA_LEN) {
            return Result.reject("intent: data must be exactly " + IntentConstants.INTENT_DATA_LEN + " bytes (H|btcTxid|E|minOut)");
        }

        byte[] h = Arrays.copyOfRange(data, IntentConstants.OFF_H, IntentConstants.OFF_H + 32);
        byte[] btcTxid = Arrays.copyOfRange(data, IntentConstants.OFF_BTCTXID, IntentConstants.OFF_BTCTXID + 32);
        BigInteger expiryBig = new BigInteger(1, Arrays.copyOfRange(data, IntentConstants.OFF_EXPIRY, IntentConstants.OFF_EXPIRY + 32));
        // reject a crafted E that keeps high bits but would truncate into the admissible window
        if (expiryBig.bitLength() > 63) {
            return Result.reject("intent: expiry E out of range");
        }
        long expiryE = expiryBig.longValue();

        // --- Claim 2a: not yet expired (current height below E) ---
        if (bestBlockNumber >= expiryE) {
            return Result.reject("intent: expired (height " + bestBlockNumber + " >= E " + expiryE + ")");
        }
        // Height-relative, short maximum E: bound the consumed-set window.
        if (maxExpirySpan > 0 && expiryE - bestBlockNumber > maxExpirySpan) {
            return Result.reject("intent: expiry too far ahead (E-height " + (expiryE - bestBlockNumber) + " > max " + maxExpirySpan + ")");
        }

        // --- Claim 2b: H not already consumed ---
        byte[] consumed = repo.getStorageBytes(IntentConstants.INTENT_REGISTRY_ADDR, IntentConstants.registryKeyForH(h));
        if (consumed != null && consumed.length > 0) {
            return Result.reject("intent: H already consumed");
        }

        // --- Claim 2c: anti-spam ticket — referenced BTC tx is a processed peg-in in the Bridge SPV view ---
        if (requireBtcTicket) {
            String btcTxidHex = ByteUtil.toHexString(btcTxid);
            byte[] pegin = repo.getStorageBytes(IntentConstants.bridgeAddr(), IntentConstants.bridgeProcessedPeginKey(btcTxidHex));
            if (pegin == null || pegin.length == 0) {
                return Result.reject("intent: BTC ticket not visible in Bridge SPV view (txid " + btcTxidHex + ")");
            }
        }

        return Result.accept();
    }
}
