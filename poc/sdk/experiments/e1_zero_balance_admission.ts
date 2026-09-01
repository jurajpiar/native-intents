/**
 * E1 — Mempool citizenship for an account that can't pay (irreducible claim 1).
 *
 * Hypothesis: a signed intent from a brand-new, zero-balance, zero-history account is admitted to
 * the mempool and becomes a gossiped mempool object — something a smart contract cannot do.
 * Procedure: fresh key -> assert 0 balance -> build+send intent -> assert it is in the mempool.
 * Falsifier: eth_sendRawTransaction errors, or the tx never appears in txpool_content.
 *
 * Run the node with -Dintent.requireBtcTicket=false (the default in podman-compose).
 */
import { buildIntent, freshWallet, randomH } from "../src/intent.js";
import { Report, preflight, rpcA, errMsg } from "./_harness.js";

async function main(): Promise<number> {
  await preflight(rpcA);
  const r = new Report("E1 zero-balance admission", "claim 1: a payer-less account's signed intent becomes a mempool object");

  const wallet = freshWallet();
  const balance = BigInt(await rpcA.getBalance(wallet.address));
  r.check("sender has zero balance", balance === 0n, `${wallet.address} = ${balance}`);

  const height = await rpcA.blockNumber();
  const intent = buildIntent(wallet, { H: randomH(), btcTxid: new Uint8Array(32), expiry: height + 50, minOut: 0n });

  let accepted = false;
  try {
    const hash = await rpcA.sendRaw(intent.rawHex);
    accepted = true;
    r.check("intent accepted by node", hash.toLowerCase() === intent.hash.toLowerCase(), hash);
  } catch (e) {
    r.check("intent accepted by node", false, errMsg(e));
  }

  if (accepted) {
    const inPool = (await rpcA.pendingTxs()).some((t) => t.hash.toLowerCase() === intent.hash.toLowerCase());
    r.check("intent is a mempool object (txpool_content)", inPool);
  }
  return r.done();
}

main().then((c) => process.exit(c));
