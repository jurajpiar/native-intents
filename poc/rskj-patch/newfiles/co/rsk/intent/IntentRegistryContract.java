/*
 * Native-intent PoC — milestone 1. This file is NEW.
 *
 * The consumed-set registry precompile. World state under a fixed address, same pattern as the
 * Bridge's processed-peg-in set: plain storage under IntentConstants.INTENT_REGISTRY_ADDR,
 * readable via eth_call + storage proofs, reorg handling is ordinary state reversion.
 *
 * "H consumed on successful execution only" falls out for free: writes go to the transaction's
 * execution track, which TransactionExecutor.finalization() commits only when the tx succeeds.
 * If the solver's tx reverts, the consume() write is rolled back with it.
 *
 * KNOWN RESIDUAL (documented, deliberately not fixed in m1): consume(H) is permissionless. With no
 * atomic bundle, nothing binds consumption to actually delivering min-out, so a griefer can consume
 * an H it never solved. Milestone 2's atomic intent+solution bundle is what closes this. Experiment
 * E6 measures it.
 */
package co.rsk.intent;

import co.rsk.core.RskAddress;
import org.ethereum.core.Block;
import org.ethereum.core.Repository;
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

    public IntentRegistryContract(RskAddress contractAddress) {
        super(contractAddress);
    }

    @Override
    public void init(PrecompiledContractArgs args) {
        this.repository = args.getRepository();
        this.executionBlock = args.getExecutionBlock();
    }

    @Override
    public long getGasForData(byte[] data) {
        // Flat cost. consume() writes one storage word; reads are usually via eth_call (free).
        return 20_000L;
    }

    @Override
    public byte[] execute(byte[] data) throws VMException {
        if (data == null || data.length < 4) {
            throw new VMException("intent-registry: missing selector");
        }
        int selector = ByteBuffer.wrap(data, 0, 4).getInt();
        byte[] h = arg32(data);

        switch (selector) {
            case IntentConstants.SEL_IS_CONSUMED:
                return isConsumed(h) ? TRUE_WORD.clone() : FALSE_WORD.clone();
            case IntentConstants.SEL_CONSUMED_HEIGHT:
                return consumedHeightWord(h);
            case IntentConstants.SEL_CONSUME:
                return consume(h);
            default:
                throw new VMException("intent-registry: unknown selector 0x" + Integer.toHexString(selector));
        }
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

    private byte[] consume(byte[] h) throws VMException {
        DataWord key = IntentConstants.registryKeyForH(h);
        byte[] existing = repository.getStorageBytes(contractAddress, key);
        if (existing != null && existing.length > 0) {
            throw new VMException("intent-registry: H already consumed");
        }
        long height = executionBlock == null ? 0L : executionBlock.getNumber();
        // Store height+1 so that height 0 is still a non-empty marker (empty == not consumed).
        DataWord value = DataWord.valueOf(BigInteger.valueOf(height + 1).toByteArray());
        repository.addStorageBytes(contractAddress, key, value.getData());
        return new byte[0];
    }
}
