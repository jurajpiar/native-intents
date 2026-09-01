# rskj patch for native intents

This patch adds the native-intent subtype, pre-inclusion admission, activation gating, a stateless
parsing precompile, and a fixed-address settlement contract to rskj. Intents are public mempool objects
but are never mined on their own; a solver fulfils them through a normal settlement transaction.

## Target branch

The patch targets PR #3558 in `rsksmart/rskj`, at commit
`8d7b0918f7a3b3eaeacbe432b26d985fb22cb4f9`. That branch implements the RSKIP543/545/546 typed-
transaction namespace used by the `0x02 || 0x49` envelope.

Do not apply this patch to `master`: it does not contain the typed-transaction machinery or the anchors
expected by the patcher.

## Architecture

Three Java files are copied into `co.rsk.intent`:

- `IntentConstants` defines subtype `0x49`, the parser and settlement addresses, the 160-byte intent
  layout (`H | btcTxid | E | minOut | outputToken`), and the Bridge storage key used for ticket checks.
- `IntentRegistryContract` is a stateless parsing precompile. Given the raw intent bytes, it
  authenticates the signature and returns ABI-encoded `sender`, `H`, `btcTxid`, `expiry`, `minOut`, and
  `outputToken`. It reads and writes no state.
- `IntentAdmission` performs the pre-inclusion checks: valid data length, bounded unexpired height,
  unconsumed `H`, and—when enabled—a processed Bitcoin ticket. Consumption is read directly from the
  settlement contract's storage.

The settlement contract source is [`../contracts/Settlement.sol`](../contracts/Settlement.sol). It is
compiled to runtime bytecode and injected into the regtest genesis allocation at
`0x…01000021`. Change the Solidity source through `contracts/compile.js`, then regenerate
`genesis/settlement.runtime.hex` before reapplying the patch.

## Changes made to rskj

The patcher applies anchored edits for the following behaviour:

1. recognise `0x02 || 0x49` as a native intent;
2. give active intents zero transaction cost so payer-less senders can enter the mempool;
3. reject intents before activation and run the intent admission checks afterwards;
4. remove standalone intents from miners' candidate transaction list;
5. register the parser only while `RSKIPINTENT` is active;
6. add the parser to `CONSENSUS_ENABLED_ADDRESSES`, avoiding a historical genesis-address change;
7. disable the `receiveHeader` throttle on regtest so the peg-in driver can relay headers quickly;
8. add the `RSKIPINTENT` consensus rule and its configuration entries; and
9. activate that rule at regtest block 40, providing a short testable pre-fork window.

The patcher also inserts the compiled settlement runtime into `rsk-dev.json`. That deployment is
regtest scaffolding rather than the intended public-network activation mechanism.

## Applying the patch

From this directory, run:

```sh
python3 apply.py /path/to/rskj
```

Use `--check` for a dry run:

```sh
python3 apply.py /path/to/rskj --check
```

The script requires every text anchor to match exactly once and stops when the target branch does not
match its expectations. Re-running it skips edits whose markers are already present, and the genesis
insertion is also idempotent.

## Caveats

- **The parser is activation-gated, but the settlement contract is still in genesis.** That is
  acceptable for a fresh regtest chain. A public-network implementation must install the contract at
  the activation block and verify the state root across the fork.
- **Admission reads Bridge and settlement storage on the synchronised transaction-pool path.** Each
  check is cheap, but this is a peer-to-peer ingress hot path and should be benchmarked under load. A
  safe cache may be worth considering.
- **The parser is a precompile because authenticating the RSK namespace envelope in Solidity is
  impractical.** Settlement remains in the VM, where ERC-20 calls and ordinary revert semantics work.
- **Ticket admission and economic input binding are not the same thing.** The PoC can check that a
  `btcTxid` appears in Bridge state, while `depositForPegin` separately models the contract credit.
  Production needs a single authenticated peg-in-to-escrow binding.
- **Escrow recovery is not implemented.** A real contract-held peg-in needs a safe path back to the user
  if no solver settles before expiry.
- **The patch is tied to one upstream commit.** Even a nearby rskj revision may require a manual port if
  an anchor has moved.

The current regtest harness verifies admission, gossip, atomic RBTC and ERC-20 settlement, visible
reverts, input release to the solver, and activation behaviour. It does not make this patch suitable for
mainnet or testnet deployment without the production work above.
