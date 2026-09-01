/*
 * Native-intent PoC — milestone 2 (atomic solve). This file is NEW.
 *
 * The consumed-set registry precompile. Milestone 2 binds consumption to delivery: the ONLY way to
 * record an intent's H consumed is solve(rawIntentTx), which in one EVM transaction authenticates the
 * intent, re-checks admission at the inclusion height, delivers >= minOut from the solver to the user,
 * and only then records H. EVM transaction atomicity is the all-or-nothing guarantee: if any step
 * fails (delivery short, expired, already consumed, bad ticket) the whole call reverts, H stays
 * unconsumed, and the solver forfeits the gas. This closes the m1 consume-griefing residual (E6).
 *
 * "H consumed on success only" still falls out for free: the write is on the tx execution track,
 * committed only if the tx succeeds.
 *
 * Simplification (honest): the intent output is modelled as RBTC value moved solver -> user via the
 * repository. A real pipeline produces arbitrary token outputs; here "user receives >= minOut" is an
 * RBTC transfer. Solver repayment/spread is out of scope (a planned companion fee RSKIP).
 */
package co.rsk.intent;

import co.rsk.core.Coin;
import co.rsk.core.RskAddress;
import org.ethereum.core.Block;
import org.ethereum.core.ImmutableTransaction;
import org.ethereum.core.Repository;
import org.ethereum.core.Transaction;
import org.ethereum.vm.DataWord;
import org.ethereum.vm.PrecompiledContractArgs;
import org.ethereum.vm.PrecompiledContracts.PrecompiledContract;
import org.ethereum.vm.exception.VMException;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.util.Arrays;

public class IntentRegistryContract extends PrecompiledContract {

    private static final byte[] TRUE_WORD = DataWord.ONE.getData();
    private static final byte[] FALSE_WORD = DataWord.ZERO.getData();

    private Repository repository;
    private Block executionBlock;
    private Transaction solveTx;

    public IntentRegistryContract(RskAddress contractAddress) {
        super(contractAddress);
    }

    @Override
    public void init(PrecompiledContractArgs args) {
        this.repository = args.getRepository();
        this.executionBlock = args.getExecutionBlock();
        this.solveTx = args.getTransaction();
    }

    @Override
    public long getGasForData(byte[] data) {
        // solve() parses a tx, recovers a signer, and moves value; price it above a plain SSTORE.
        return 60_000L;
    }

    @Override
    public byte[] execute(byte[] data) throws VMException {
        if (data == null || data.length < 4) {
            throw new VMException("intent-registry: missing selector");
        }
        int selector = ByteBuffer.wrap(data, 0, 4).getInt();

        switch (selector) {
            case IntentConstants.SEL_IS_CONSUMED:
                return isConsumed(arg32(data)) ? TRUE_WORD.clone() : FALSE_WORD.clone();
            case IntentConstants.SEL_CONSUMED_HEIGHT:
                return consumedHeightWord(arg32(data));
            case IntentConstants.SEL_SOLVE:
                return solve(Arrays.copyOfRange(data, 4, data.length));
            default:
                throw new VMException("intent-registry: unknown selector 0x" + Integer.toHexString(selector));
        }
    }

    /** solve(rawIntentTx): deliver >= minOut to the user and consume H, atomically. */
    private byte[] solve(byte[] rawIntentTx) throws VMException {
        Transaction intentTx;
        RskAddress user;
        try {
            intentTx = new ImmutableTransaction(rawIntentTx);
            user = intentTx.getSender(); // recovers + validates the user's signature
        } catch (RuntimeException e) {
            throw new VMException("intent-registry: malformed or unsigned intent: " + e.getMessage());
        }
        if (user == null || !intentTx.isNativeIntent()) {
            throw new VMException("intent-registry: not a native-intent transaction");
        }

        byte[] intentData = intentTx.getData();
        if (intentData == null || intentData.length != IntentConstants.INTENT_DATA_LEN) {
            throw new VMException("intent-registry: bad intent data length");
        }
        byte[] h = Arrays.copyOfRange(intentData, IntentConstants.OFF_H, IntentConstants.OFF_H + 32);
        Coin minOut = new Coin(new BigInteger(1,
                Arrays.copyOfRange(intentData, IntentConstants.OFF_MINOUT, IntentConstants.OFF_MINOUT + 32)));

        // Re-check admission at the inclusion height (unexpired, H unconsumed, BTC ticket).
        // maxExpirySpan = 0 disables the mempool-only "too far ahead" policy at settlement.
        IntentAdmission.Result adm = IntentAdmission.check(
                intentTx, repository, executionBlock.getNumber(), IntentConstants.requireBtcTicket(), 0);
        if (!adm.ok()) {
            throw new VMException("intent-registry: " + adm.error);
        }

        // Deliver >= minOut from the solver (this tx's sender) to the user.
        RskAddress solver = solveTx.getSender();
        if (repository.getBalance(solver).compareTo(minOut) < 0) {
            throw new VMException("intent-registry: solver cannot deliver minOut");
        }
        repository.transfer(solver, user, minOut);

        recordConsumed(h);
        return new byte[0];
    }

    private byte[] arg32(byte[] data) throws VMException {
        if (data.length < 36) {
            throw new VMException("intent-registry: expected 32-byte argument");
        }
        return Arrays.copyOfRange(data, 4, 36);
    }

    private boolean isConsumed(byte[] h) {
        byte[] stored = repository.getStorageBytes(contractAddress, IntentConstants.registryKeyForH(h));
        return stored != null && stored.length > 0;
    }

    private byte[] consumedHeightWord(byte[] h) {
        byte[] stored = repository.getStorageBytes(contractAddress, IntentConstants.registryKeyForH(h));
        if (stored == null || stored.length == 0) {
            return FALSE_WORD.clone();
        }
        return DataWord.valueOf(stored).getData();
    }

    private void recordConsumed(byte[] h) throws VMException {
        DataWord key = IntentConstants.registryKeyForH(h);
        byte[] existing = repository.getStorageBytes(contractAddress, key);
        if (existing != null && existing.length > 0) {
            throw new VMException("intent-registry: H already consumed");
        }
        long height = executionBlock == null ? 0L : executionBlock.getNumber();
        // Store height+1 so height 0 is still a non-empty marker (empty == not consumed).
        DataWord value = DataWord.valueOf(BigInteger.valueOf(height + 1).toByteArray());
        repository.addStorageBytes(contractAddress, key, value.getData());
    }
}
