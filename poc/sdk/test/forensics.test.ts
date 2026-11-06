/**
 * Deterministic checks on the attack suite's revert-reason decoding — no node required.
 *
 * These exist because both bugs they guard were found by EXECUTION, not by reading: the original
 * prose regex reported "ed" as the reason for any failure whose text ended in "reverted", and a
 * Panic (an out-of-bounds calldata read — exactly what attack e5 probes) decoded to nothing at all.
 * A wrong reason is worse than no reason here: the attacks assert on it with `.includes(...)`, so a
 * garbage reason turns a passing check into a false DEVIATION.
 *
 * The trap in the other direction is just as easy to fall into: rskj's prose form is
 * "…transaction: revert <reason>" with NO colon after "revert", so requiring one silently returns
 * null for every named require in the contract. Both directions are pinned below.
 *
 * Run: npm run test:forensics
 */
import { AbiCoder } from "ethers";
import { decodeRevertReason } from "../attacks/_forensics.js";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
}
const eq = (name: string, got: string | null, want: string | null) =>
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const coder = AbiCoder.defaultAbiCoder();
const VM = "VM Exception while processing transaction: revert ";
/** An rskj eth_call failure as ../src/client.ts RpcError surfaces it. */
const rpcErr = (message: string, data?: string) =>
  Object.assign(new Error(message), { code: -32015, ...(data ? { data } : {}) });

// --- the prose path: rskj's revert text has no colon after "revert" -------------------------------
for (const reason of [
  "escrow bound to another intent",
  "input escrow bound to another intent",
  "no unclaimed payout to dest",
  "segwit payout unsupported",
  "btc payout not confirmed",
  "H already consumed",
]) {
  eq(`prose: "${reason}"`, decodeRevertReason(rpcErr(VM + reason)), reason);
}

// --- the regression: "reverted" must not decode its own suffix as a reason -----------------------
eq(`"transaction reverted" yields no reason`, decodeRevertReason(rpcErr("transaction reverted")), null);
eq(`"Execution error: transaction reverted" yields no reason`,
  decodeRevertReason(rpcErr("Execution error: transaction reverted")), null);
eq(`"reverted:" with a reason still decodes`,
  decodeRevertReason(rpcErr("transaction reverted: out of gas")), "out of gas");

// --- the ABI path wins over the prose path ------------------------------------------------------
const errData = "0x08c379a0" + coder.encode(["string"], ["escrow bound to another intent"]).slice(2);
eq("Error(string) payload decodes", decodeRevertReason(rpcErr("whatever", errData)), "escrow bound to another intent");
eq("Error(string) beats a conflicting prose message",
  decodeRevertReason(rpcErr(VM + "stale prose", errData)), "escrow bound to another intent");

// --- Panic(uint256): a code, not a string. e5's bounds checks land here -------------------------
const panic = (code: number) => "0x4e487b71" + coder.encode(["uint256"], [code]).slice(2);
eq("Panic(0x32) names the out-of-bounds", decodeRevertReason(rpcErr("revert", panic(0x32))),
  "Panic(0x32) array/calldata out of bounds");
eq("Panic(0x11) names the overflow", decodeRevertReason(rpcErr("revert", panic(0x11))),
  "Panic(0x11) arithmetic overflow");
eq("Panic(0x1) names the assert", decodeRevertReason(rpcErr("revert", panic(0x01))),
  "Panic(0x1) assert failed");

// --- errBlob duplicates the message across keys; one reason must come back, not two -------------
eq("a doubled blob yields ONE reason",
  decodeRevertReason(rpcErr(VM + "escrow bound to another intent")), "escrow bound to another intent");
eq("two concatenated prose copies still yield one reason",
  decodeRevertReason(rpcErr(`${VM}first reason ${VM}second reason`)), "first reason");

// --- shapes that carry nothing decodable --------------------------------------------------------
eq("no reason at all", decodeRevertReason(rpcErr("connection refused")), null);
eq("undefined", decodeRevertReason(undefined), null);
eq("plain string with a reason", decodeRevertReason(VM + "expired"), "expired");
eq("nested cause is searched", decodeRevertReason(
  Object.assign(new Error("outer"), { cause: VM + "under minOut" })), "under minOut");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
