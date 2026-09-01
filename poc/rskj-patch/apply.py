#!/usr/bin/env python3
"""
Apply the native-intent PoC (milestone 1) to an rskj checkout.

Idempotent: safe to run twice. Each edit is skipped if its marker is already present.
The patch targets the pr3558 branch (RSKIP543/545/546 typed transactions). See README.md.

Usage:
    python3 apply.py /path/to/rskj            # apply
    python3 apply.py /path/to/rskj --check    # dry run, report only
"""
import json
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
NEWFILES = HERE / "newfiles"

# base commit this patch was written against (pr3558 head). Informational.
EXPECTED_BASE = "8d7b0918f7a3b3eaeacbe432b26d985fb22cb4f9"

SRC = "rskj-core/src/main/java"

# (relative path, find, replace, idempotency marker)
EDITS = [
    # E1: Transaction.isNativeIntent()
    (f"{SRC}/org/ethereum/core/Transaction.java",
     "    public boolean isRskNamespaceTransaction() {\n"
     "        return typePrefix.isRskNamespace();\n"
     "    }\n",
     "    public boolean isRskNamespaceTransaction() {\n"
     "        return typePrefix.isRskNamespace();\n"
     "    }\n\n"
     "    /** Native-intent PoC (m1): 0x02 || 0x49 subtype. */\n"
     "    public boolean isNativeIntent() {\n"
     "        return typePrefix.isRskNamespace()\n"
     "                && typePrefix.subtype() == co.rsk.intent.IntentConstants.INTENT_SUBTYPE;\n"
     "    }\n",
     "isNativeIntent"),

    # E2: Transaction.transactionCost -> 0 for intents
    (f"{SRC}/org/ethereum/core/Transaction.java",
     "        // Federators txs to the bridge are free during system setup\n"
     "        if (BridgeUtils.isFreeBridgeTx(this, constants, activations, signatureCache)) {\n"
     "            return 0;\n"
     "        }\n",
     "        // Native-intent PoC: intents are free mempool objects, never mined. Zero cost is what\n"
     "        // lets a zero-balance sender be admitted and gossiped (irreducible claim 1). Gated on the\n"
     "        // activation rule so the privilege only exists after the fork (production activation gate).\n"
     "        if (isNativeIntent() && activations.isActive(org.ethereum.config.blockchain.upgrades.ConsensusRule.RSKIPINTENT)) {\n"
     "            return 0;\n"
     "        }\n\n"
     "        // Federators txs to the bridge are free during system setup\n"
     "        if (BridgeUtils.isFreeBridgeTx(this, constants, activations, signatureCache)) {\n"
     "            return 0;\n"
     "        }\n",
     "Native-intent PoC: intents are free"),

    # E3: TransactionPoolImpl intent admission
    (f"{SRC}/co/rsk/core/bc/TransactionPoolImpl.java",
     "        RepositorySnapshot currentRepository = getCurrentRepository();\n"
     "        TransactionValidationResult validationResult = shouldAcceptTx(tx, currentRepository);\n",
     "        RepositorySnapshot currentRepository = getCurrentRepository();\n"
     "        TransactionValidationResult validationResult = shouldAcceptTx(tx, currentRepository);\n\n"
     "        // Native-intent PoC: pre-inclusion validity (irreducible claim 2), behind the activation rule.\n"
     "        if (tx.isNativeIntent()) {\n"
     "            if (!config.getActivationConfig().isActive(org.ethereum.config.blockchain.upgrades.ConsensusRule.RSKIPINTENT, getBestBlock().getNumber())) {\n"
     "                return TransactionPoolAddResult.withError(\"native intents are not active yet\");\n"
     "            }\n"
     "            co.rsk.intent.IntentAdmission.Result intentResult = co.rsk.intent.IntentAdmission.check(\n"
     "                    tx, currentRepository, getBestBlock().getNumber(),\n"
     "                    co.rsk.intent.IntentConstants.requireBtcTicket(),\n"
     "                    co.rsk.intent.IntentConstants.maxExpirySpan());\n"
     "            if (!intentResult.ok()) {\n"
     "                return TransactionPoolAddResult.withError(intentResult.error);\n"
     "            }\n"
     "        }\n",
     "Native-intent PoC: pre-inclusion validity"),

    # E4: MinerUtils excludes intents from mining
    (f"{SRC}/co/rsk/mine/MinerUtils.java",
     "        List<Transaction> txs = new ArrayList<>(transactionPool.getPendingTransactions());\n"
     "        return PendingState.sortByPriceTakingIntoAccountSenderAndNonce(txs, signatureCache, txsToRemove);",
     "        List<Transaction> txs = new ArrayList<>(transactionPool.getPendingTransactions());\n"
     "        // Native-intent PoC (m1): intents live in the mempool as discovery objects only; never mined standalone.\n"
     "        txs.removeIf(t -> t.isNativeIntent());\n"
     "        return PendingState.sortByPriceTakingIntoAccountSenderAndNonce(txs, signatureCache, txsToRemove);",
     "never mined standalone"),

    # E5: PrecompiledContracts registers the registry precompile
    (f"{SRC}/org/ethereum/vm/PrecompiledContracts.java",
     "        if (address.equals(REMASC_ADDR_DW)) {\n"
     "            return new RemascContract(REMASC_ADDR, remascConfig, config.getNetworkConstants(),\n"
     "                    config.getActivationConfig());\n"
     "        }\n",
     "        if (address.equals(REMASC_ADDR_DW)) {\n"
     "            return new RemascContract(REMASC_ADDR, remascConfig, config.getNetworkConstants(),\n"
     "                    config.getActivationConfig());\n"
     "        }\n\n"
     "        // Native-intent PoC: parse precompile, activation-gated (CONSENSUS_ENABLED_ADDRESSES).\n"
     "        if (activations.isActive(ConsensusRule.RSKIPINTENT) && address.equals(co.rsk.intent.IntentConstants.INTENT_REGISTRY_ADDR_DW)) {\n"
     "            return new co.rsk.intent.IntentRegistryContract(co.rsk.intent.IntentConstants.INTENT_REGISTRY_ADDR);\n"
     "        }\n",
     "Native-intent PoC: parse precompile"),

    # PrecompiledContracts: register the parse precompile in CONSENSUS_ENABLED_ADDRESSES (activation-gated,
    # not GENESIS_ADDRESSES — avoids changing the state root at the RSKIP126 block on existing networks)
    (f"{SRC}/org/ethereum/vm/PrecompiledContracts.java",
     "                    new AbstractMap.SimpleEntry<>(SECP256K1_MUL_ADDR, ConsensusRule.RSKIP516)\n",
     "                    new AbstractMap.SimpleEntry<>(SECP256K1_MUL_ADDR, ConsensusRule.RSKIP516),\n"
     "                    new AbstractMap.SimpleEntry<>(co.rsk.intent.IntentConstants.INTENT_REGISTRY_ADDR, ConsensusRule.RSKIPINTENT)\n",
     "IntentConstants.INTENT_REGISTRY_ADDR, ConsensusRule.RSKIPINTENT"),

    # E7 (BTC-ticket path): drop the regtest receiveHeader throttle so ~104 headers can be relayed
    # rapidly by the peg-in driver. Regtest-only constant; not a mainnet/testnet change.
    (f"{SRC}/co/rsk/peg/constants/BridgeRegTestConstants.java",
     "        minSecondsBetweenCallsReceiveHeader = 300;  // 5 minutes in seconds",
     "        minSecondsBetweenCallsReceiveHeader = 0;  // PoC: no throttle on regtest header relay (was 300)",
     "minSecondsBetweenCallsReceiveHeader = 0;"),

    # Activation gate: a new ConsensusRule for the intent transaction type
    (f"{SRC}/org/ethereum/config/blockchain/upgrades/ConsensusRule.java",
     "    RSKIP559(\"rskip559\"), // Pegouts deterministic sorting\n    ;",
     "    RSKIP559(\"rskip559\"), // Pegouts deterministic sorting\n"
     "    RSKIPINTENT(\"rskipIntent\"), // Native intent transaction type (PoC)\n    ;",
     "RSKIPINTENT(\"rskipIntent\")"),

    # reference.conf: default the rule to a hardfork name (kept consistent with expected.conf)
    ("rskj-core/src/main/resources/reference.conf",
     "            rskip559 = cardamom1000\n        }",
     "            rskip559 = cardamom1000\n            rskipIntent = vetiver900\n        }",
     "rskipIntent = vetiver900"),

    # expected.conf: the config-validation template must mirror reference.conf
    ("rskj-core/src/main/resources/expected.conf",
     "            rskip559 = <hardforkName>\n        }",
     "            rskip559 = <hardforkName>\n            rskipIntent = <hardforkName>\n        }",
     "rskipIntent = <hardforkName>"),

    # regtest.conf: activate the intent rule at block 40 (so the pre/post-activation window is testable)
    ("rskj-core/src/main/resources/config/regtest.conf",
     "        rskip535 = 1\n    }",
     "        rskip535 = 1\n        rskipIntent = 40\n    }",
     "rskipIntent = 40"),

    # A1: executePegIn records per-txid (destination, amount) so the settlement contract can verify + release input
    (f"{SRC}/co/rsk/peg/BridgeSupport.java",
     "        this.transferTo(peginInformation.getRskDestinationAddress(), amountInWeis);",
     "        this.transferTo(peginInformation.getRskDestinationAddress(), amountInWeis);\n"
     "        // Native-intent PoC (A): record (destination, amount) per btc txid so the settlement\n"
     "        // contract can verify and release exactly the pegged-in input. 64 bytes = destWord ++ amountWord.\n"
     "        {\n"
     "            org.ethereum.vm.DataWord peginDestWord = org.ethereum.vm.DataWord.valueOf(rskDestinationAddress.getBytes());\n"
     "            org.ethereum.vm.DataWord peginAmtWord = org.ethereum.vm.DataWord.valueOf(amountInWeis.asBigInteger().toByteArray());\n"
     "            byte[] peginInfoValue = new byte[64];\n"
     "            System.arraycopy(peginDestWord.getData(), 0, peginInfoValue, 0, 32);\n"
     "            System.arraycopy(peginAmtWord.getData(), 0, peginInfoValue, 32, 32);\n"
     "            rskRepository.addStorageBytes(PrecompiledContracts.BRIDGE_ADDR,\n"
     "                org.ethereum.vm.DataWord.fromLongString(\"intentPeginInfo-\" + btcTx.getHash().toString()), peginInfoValue);\n"
     "        }",
     "Native-intent PoC (A): record (destination, amount)"),

    # A2: BridgeSupport.getPeginInfo reader
    (f"{SRC}/co/rsk/peg/BridgeSupport.java",
     "    public Long getBtcTxHashProcessedHeight(Sha256Hash btcTxHash) throws IOException {\n"
     "        // Return -1 if the transaction hasn't been processed\n"
     "        return provider.getHeightIfBtcTxhashIsAlreadyProcessed(btcTxHash).orElse(-1L);\n"
     "    }\n",
     "    public Long getBtcTxHashProcessedHeight(Sha256Hash btcTxHash) throws IOException {\n"
     "        // Return -1 if the transaction hasn't been processed\n"
     "        return provider.getHeightIfBtcTxhashIsAlreadyProcessed(btcTxHash).orElse(-1L);\n"
     "    }\n\n"
     "    // Native-intent PoC (A): per-txid (destination, amount) recorded at peg-in. 64 bytes, or empty.\n"
     "    public byte[] getPeginInfo(byte[] btcTxid) {\n"
     "        byte[] v = rskRepository.getStorageBytes(PrecompiledContracts.BRIDGE_ADDR,\n"
     "            org.ethereum.vm.DataWord.fromLongString(\"intentPeginInfo-\" + org.ethereum.util.ByteUtil.toHexString(btcTxid)));\n"
     "        return v == null ? new byte[0] : v;\n"
     "    }\n",
     "Native-intent PoC (A): per-txid"),

    # A3: Bridge.getPeginInfo method + Function constant
    (f"{SRC}/co/rsk/peg/Bridge.java",
     "    public static final CallTransaction.Function GET_STATE_FOR_DEBUGGING = BridgeMethods.GET_STATE_FOR_DEBUGGING.getFunction();",
     "    public static final CallTransaction.Function GET_STATE_FOR_DEBUGGING = BridgeMethods.GET_STATE_FOR_DEBUGGING.getFunction();\n"
     "    public static final CallTransaction.Function GET_PEGIN_INFO = BridgeMethods.GET_PEGIN_INFO.getFunction(); // Native-intent PoC (A)",
     "GET_PEGIN_INFO = BridgeMethods.GET_PEGIN_INFO"),

    (f"{SRC}/co/rsk/peg/Bridge.java",
     "    public byte[] getStateForDebugging(Object[] args) throws VMException {\n"
     "        logger.trace(\"getStateForDebugging\");\n",
     "    public byte[] getPeginInfo(Object[] args) throws VMException {\n"
     "        try {\n"
     "            return bridgeSupport.getPeginInfo((byte[]) args[0]);\n"
     "        } catch (Exception e) {\n"
     "            throw new VMException(\"Exception in getPeginInfo\", e);\n"
     "        }\n"
     "    }\n\n"
     "    public byte[] getStateForDebugging(Object[] args) throws VMException {\n"
     "        logger.trace(\"getStateForDebugging\");\n",
     "public byte[] getPeginInfo(Object[] args)"),

    # A4: BridgeMethods GET_PEGIN_INFO entry (gated on RSKIPINTENT, public, static-callable)
    (f"{SRC}/co/rsk/peg/BridgeMethods.java",
     "    GET_STATE_FOR_DEBUGGING(\n"
     "        CallTransaction.Function.fromSignature(\n"
     "            \"getStateForDebugging\",\n"
     "            new String[]{},\n"
     "            new String[]{BYTES}\n"
     "        ),\n",
     "    GET_PEGIN_INFO(\n"
     "        CallTransaction.Function.fromSignature(\n"
     "            \"getPeginInfo\",\n"
     "            new String[]{BYTES32},\n"
     "            new String[]{BYTES}\n"
     "        ),\n"
     "        fixedCost(30_000L),\n"
     "        (BridgeMethodExecutorTyped<byte[]>) Bridge::getPeginInfo,\n"
     "        activations -> activations.isActive(RSKIPINTENT),\n"
     "        fixedPermission(false),\n"
     "        CallTypeHelper.ALLOW_STATIC_CALL\n"
     "    ),\n"
     "    GET_STATE_FOR_DEBUGGING(\n"
     "        CallTransaction.Function.fromSignature(\n"
     "            \"getStateForDebugging\",\n"
     "            new String[]{},\n"
     "            new String[]{BYTES}\n"
     "        ),\n",
     "GET_PEGIN_INFO("),
]


# Genesis-deployed VM contracts (runtime bytecode at fixed addresses):
#   m3   settlement contract at 0x..21 (owns the consumed set; delivers outputs; releases inputs)
#   E17b auction contract at 0x..22 (above-minOut auction; settlement enforces its lock when present)
GENESIS_JSON = "rskj-core/src/main/resources/genesis/rsk-dev.json"
GENESIS_CONTRACTS = [
    ("settlement", "0000000000000000000000000000000001000021", HERE / "genesis" / "settlement.runtime.hex"),
    ("auction",    "0000000000000000000000000000000001000022", HERE / "genesis" / "auction.runtime.hex"),
]


def inject_genesis(root: Path, check: bool):
    path = root / GENESIS_JSON
    if not path.exists():
        print(f"  [MISSING] {GENESIS_JSON} — wrong base branch?")
        sys.exit(2)
    genesis = json.loads(path.read_text())
    alloc = genesis.setdefault("alloc", {})
    changed = False
    for name, addr_key, hex_path in GENESIS_CONTRACTS:
        code = hex_path.read_text().strip()
        if addr_key in alloc:
            if alloc[addr_key].get("contract", {}).get("code") == code:
                print(f"  [skip]  genesis: {name} contract already at 0x{addr_key}")
                continue
            print(f"  [update] genesis: {name} contract at 0x{addr_key} ({len(code)//2} bytes of code)")
        else:
            print(f"  [add]   genesis: {name} contract at 0x{addr_key} ({len(code)//2} bytes of code)")
        if not check:
            alloc[addr_key] = {"balance": "0", "contract": {"code": code, "data": {}}}
            changed = True
    if changed:
        path.write_text(json.dumps(genesis, indent=2) + "\n")


def copy_newfiles(root: Path, check: bool):
    dest_dir = root / SRC / "co" / "rsk" / "intent"
    for src in sorted(NEWFILES.rglob("*.java")):
        rel = src.relative_to(NEWFILES)
        dest = root / SRC / rel
        status = "copy" if not dest.exists() else "overwrite"
        print(f"  [{status}] {rel}")
        if not check:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dest)


def apply_edits(root: Path, check: bool):
    for rel, find, replace, marker in EDITS:
        path = root / rel
        if not path.exists():
            print(f"  [MISSING] {rel} — wrong base branch?")
            sys.exit(2)
        text = path.read_text()
        if marker in text:
            print(f"  [skip]  {rel}  (marker present: {marker!r})")
            continue
        n = text.count(find)
        if n != 1:
            print(f"  [FAIL]  {rel}: anchor found {n} times (expected 1). Manual review needed.\n"
                  f"          Anchor starts: {find.splitlines()[0]!r}")
            sys.exit(3)
        print(f"  [edit]  {rel}  (+{marker!r})")
        if not check:
            path.write_text(text.replace(find, replace, 1))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    root = Path(sys.argv[1]).resolve()
    check = "--check" in sys.argv[2:]
    if not (root / SRC).exists():
        print(f"Not an rskj checkout (no {SRC}): {root}")
        sys.exit(1)
    print(f"rskj root: {root}")
    print(f"expected base (pr3558 head): {EXPECTED_BASE}")
    print("== new files ==")
    copy_newfiles(root, check)
    print("== edits ==")
    apply_edits(root, check)
    print("== genesis ==")
    inject_genesis(root, check)
    print("done." + (" (dry run)" if check else ""))


if __name__ == "__main__":
    main()
