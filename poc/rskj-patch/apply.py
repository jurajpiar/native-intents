#!/usr/bin/env python3
"""
Apply the native-intent PoC (milestone 1) to an rskj checkout.

Idempotent: safe to run twice. Each edit is skipped if its marker is already present.
The patch targets the pr3558 branch (RSKIP543/545/546 typed transactions). See README.md.

Usage:
    python3 apply.py /path/to/rskj            # apply
    python3 apply.py /path/to/rskj --check    # dry run, report only
"""
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
     "        // Native-intent PoC (m1): intents are free mempool objects, never mined. Zero cost is what\n"
     "        // lets a zero-balance sender be admitted and gossiped (irreducible claim 1).\n"
     "        if (isNativeIntent()) {\n"
     "            return 0;\n"
     "        }\n\n"
     "        // Federators txs to the bridge are free during system setup\n"
     "        if (BridgeUtils.isFreeBridgeTx(this, constants, activations, signatureCache)) {\n"
     "            return 0;\n"
     "        }\n",
     "Native-intent PoC (m1): intents are free"),

    # E3: TransactionPoolImpl intent admission
    (f"{SRC}/co/rsk/core/bc/TransactionPoolImpl.java",
     "        RepositorySnapshot currentRepository = getCurrentRepository();\n"
     "        TransactionValidationResult validationResult = shouldAcceptTx(tx, currentRepository);\n",
     "        RepositorySnapshot currentRepository = getCurrentRepository();\n"
     "        TransactionValidationResult validationResult = shouldAcceptTx(tx, currentRepository);\n\n"
     "        // Native-intent PoC (m1): pre-inclusion validity (irreducible claim 2).\n"
     "        if (tx.isNativeIntent()) {\n"
     "            co.rsk.intent.IntentAdmission.Result intentResult = co.rsk.intent.IntentAdmission.check(\n"
     "                    tx, currentRepository, getBestBlock().getNumber(),\n"
     "                    co.rsk.intent.IntentConstants.requireBtcTicket(),\n"
     "                    co.rsk.intent.IntentConstants.maxExpirySpan());\n"
     "            if (!intentResult.ok()) {\n"
     "                return TransactionPoolAddResult.withError(intentResult.error);\n"
     "            }\n"
     "        }\n",
     "Native-intent PoC (m1): pre-inclusion validity"),

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
     "        // Native-intent PoC (m1): consumed-set registry (always on at genesis for regtest).\n"
     "        if (address.equals(co.rsk.intent.IntentConstants.INTENT_REGISTRY_ADDR_DW)) {\n"
     "            return new co.rsk.intent.IntentRegistryContract(co.rsk.intent.IntentConstants.INTENT_REGISTRY_ADDR);\n"
     "        }\n",
     "Native-intent PoC (m1): consumed-set registry"),

    # E6: PrecompiledContracts adds the address to GENESIS_ADDRESSES (so precompiledContactExists() is consistent)
    (f"{SRC}/org/ethereum/vm/PrecompiledContracts.java",
     "            BRIDGE_ADDR,\n"
     "            REMASC_ADDR));",
     "            BRIDGE_ADDR,\n"
     "            REMASC_ADDR,\n"
     "            co.rsk.intent.IntentConstants.INTENT_REGISTRY_ADDR));",
     "INTENT_REGISTRY_ADDR));"),
]


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
    print("done." + (" (dry run)" if check else ""))


if __name__ == "__main__":
    main()
