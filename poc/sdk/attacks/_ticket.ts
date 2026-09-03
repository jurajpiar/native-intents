/**
 * The anti-spam ticket, as ADMISSION sees it — shared by the registry entry and the attack so the
 * planted genesis slot and the txid the attack signs over cannot drift apart.
 *
 * `IntentAdmission.check` treats a txid as a valid ticket when the Bridge has a non-empty value at
 *
 *     keccak256(utf8("btcTxHashAP-" + <64 lowercase hex chars of the txid>))
 *
 * read with `getStorageBytes` — mirroring BridgeStorageProvider's processed-peg-in map. Genesis
 * `contract.data` writes go through `addStorageBytes`, the same store, so a ticket can be planted at
 * block 0 with no Bitcoin, no bitcoind and no header relay. That is what lets A6 test the ticket rule
 * on a node that has never seen a peg-in.
 */
import { keccak256, toUtf8Bytes } from "ethers";

/** The Bridge precompile — where processed peg-ins live. */
export const BRIDGE_ADDR = "0000000000000000000000000000000001000006";

/**
 * The txid A6 plants as a valid ticket. Fixed rather than random because the registry entry has to
 * name the genesis slot statically, and a mismatch between the planted slot and the signed txid would
 * make every intent get rejected — which reads as "the rule held" when it actually means the test
 * never ran. A6 guards against that reading explicitly.
 */
export const TICKET_TXID = "a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6";

/** A txid deliberately NOT planted, for the control that proves the ticket rule is switched on. */
export const NO_TICKET_TXID = "beef00000000000000000000000000000000000000000000000000000000beef";

/** Storage slot (unprefixed 64-char hex) the admission check reads for a given txid. */
export function bridgeTicketSlot(btcTxidHex: string): string {
  const txid = btcTxidHex.replace(/^0x/, "").toLowerCase();
  return keccak256(toUtf8Bytes(`btcTxHashAP-${txid}`)).slice(2);
}

/** Any non-empty value marks the peg-in processed. The real Bridge stores a height here. */
export const TICKET_VALUE = "1".padStart(64, "0");
