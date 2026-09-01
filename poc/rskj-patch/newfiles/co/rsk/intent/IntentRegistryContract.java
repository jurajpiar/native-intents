/*
 * Native-intent PoC — milestone 3. This file is NEW.
 *
 * Stateless parse precompile. Reconstructing the RSK-namespace signing hash and recovering the signer
 * is impractical in Solidity, so the settlement contract STATICCALLs this precompile with the raw
 * intent transaction bytes and receives the authenticated fields ABI-encoded.
 *
 * Input:  the raw intent transaction (0x02 || 0x49 || rlp([...])) as the whole call data.
 * Output: abi.encode(address sender, bytes32 H, bytes32 btcTxid, uint256 expiry, uint256 minOut,
 *         address outputToken) = 192 bytes. Which is exactly senderWord(32) ++ data(160), since the
 *         intent's 160-byte data field already lays out H|btcTxid|expiry|minOut|outputToken in order.
 *
 * No state is read or written (safe under STATICCALL). On a malformed or non-intent input it throws,
 * so the calling contract's STATICCALL returns failure and the settle reverts.
 */
package co.rsk.intent;

import co.rsk.core.RskAddress;
import org.ethereum.core.ImmutableTransaction;
import org.ethereum.core.Transaction;
import org.ethereum.vm.DataWord;
import org.ethereum.vm.PrecompiledContracts.PrecompiledContract;
import org.ethereum.vm.exception.VMException;

public class IntentRegistryContract extends PrecompiledContract {

    public IntentRegistryContract(RskAddress contractAddress) {
        super(contractAddress);
    }

    @Override
    public long getGasForData(byte[] data) {
        // parse + ecrecover
        return 30_000L;
    }

    @Override
    public byte[] execute(byte[] rawIntentTx) throws VMException {
        Transaction intentTx;
        RskAddress sender;
        try {
            intentTx = new ImmutableTransaction(rawIntentTx);
            sender = intentTx.getSender(); // recovers + validates the user's signature
        } catch (RuntimeException e) {
            throw new VMException("intent-parse: malformed or unsigned intent: " + e.getMessage());
        }
        if (sender == null || !intentTx.isNativeIntent()) {
            throw new VMException("intent-parse: not a native-intent transaction");
        }
        byte[] data = intentTx.getData();
        if (data == null || data.length != IntentConstants.INTENT_DATA_LEN) {
            throw new VMException("intent-parse: bad intent data length");
        }

        // abi(sender, H, btcTxid, expiry, minOut, outputToken) == senderWord ++ data
        byte[] out = new byte[32 + IntentConstants.INTENT_DATA_LEN];
        System.arraycopy(DataWord.valueOf(sender.getBytes()).getData(), 0, out, 0, 32);
        System.arraycopy(data, 0, out, 32, IntentConstants.INTENT_DATA_LEN);
        return out;
    }
}
