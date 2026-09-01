/*
 * Native-intent PoC — milestone 3. This file is NEW.
 *
 * Pre-inclusion admission checks for an intent transaction (the two irreducible claims):
 *   - Claim 1 (payer-less mempool citizenship): handled upstream by treating the intent as a free tx
 *     (Transaction.transactionCost == 0), so a zero-balance sender is admitted and gossiped.
 *   - Claim 2 (invalidity before inclusion costs nothing): the checks below — expired, replayed (H in
 *     the consumed set), or missing BTC ticket are rejected here, before the mempool.
 *
 * The consumed set now lives in the settlement contract's storage (slot == H); admission reads it
 * there. Both reads are plain storage reads against the current snapshot.
 */
package co.rsk.intent;

import co.rsk.core.bc.AccountInformationProvider;
import org.ethereum.core.Transaction;
import org.ethereum.util.ByteUtil;

import java.math.BigInteger;
import java.util.Arrays;

public final class IntentAdmission {

    private IntentAdmission() { }

    public static final class Result {
        public final String error;
        private Result(String error) { this.error = error; }
        public boolean ok() { return error == null; }
        static Result accept() { return new Result(null); }
        static Result reject(String e) { return new Result(e); }
    }

    public static Result check(Transaction tx,
                               AccountInformationProvider repo,
                               long bestBlockNumber,
                               boolean requireBtcTicket,
                               long maxExpirySpan) {
        byte[] data = tx.getData();
        if (data == null || data.length != IntentConstants.INTENT_DATA_LEN) {
            return Result.reject("intent: data must be exactly " + IntentConstants.INTENT_DATA_LEN + " bytes (H|btcTxid|E|minOut|outputToken)");
        }

        byte[] h = Arrays.copyOfRange(data, IntentConstants.OFF_H, IntentConstants.OFF_H + 32);
        byte[] btcTxid = Arrays.copyOfRange(data, IntentConstants.OFF_BTCTXID, IntentConstants.OFF_BTCTXID + 32);
        BigInteger expiryBig = new BigInteger(1, Arrays.copyOfRange(data, IntentConstants.OFF_EXPIRY, IntentConstants.OFF_EXPIRY + 32));
        if (expiryBig.bitLength() > 63) {
            return Result.reject("intent: expiry E out of range");
        }
        long expiryE = expiryBig.longValue();

        // Claim 2a: not yet expired
        if (bestBlockNumber >= expiryE) {
            return Result.reject("intent: expired (height " + bestBlockNumber + " >= E " + expiryE + ")");
        }
        if (maxExpirySpan > 0 && expiryE - bestBlockNumber > maxExpirySpan) {
            return Result.reject("intent: expiry too far ahead (E-height " + (expiryE - bestBlockNumber) + " > max " + maxExpirySpan + ")");
        }

        // Claim 2b: H not already consumed (settlement contract storage, slot == H)
        byte[] consumed = repo.getStorageBytes(IntentConstants.SETTLEMENT_ADDR, IntentConstants.consumedKeyForH(h));
        if (consumed != null && consumed.length > 0) {
            return Result.reject("intent: H already consumed");
        }

        // Claim 2c: anti-spam ticket — referenced BTC tx is a processed peg-in in the Bridge SPV view
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
