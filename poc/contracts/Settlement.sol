// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.19;

/**
 * Native-intent settlement contract (milestone 3). Genesis-deployed at a fixed address.
 *
 * Moves settlement from a raw precompile into the VM so that (a) it can deliver ERC-20 outputs and
 * (b) a failed solve reverts VISIBLY (the raw-precompile path swallows exceptions into a success
 * receipt; the VM path rolls back and fails the receipt).
 *
 * The one thing kept in a precompile is parsing/authenticating the intent transaction (reconstructing
 * the RSK-namespace signing hash and ecrecover is impractical in Solidity). This contract STATICCALLs
 * the parse precompile with the raw intent bytes and receives the authenticated fields.
 *
 * The consumed set is this contract's own storage at slot == H (via assembly), so the node's
 * admission check reads it exactly as before, just at this address.
 */
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

contract Settlement {
    // parse precompile (IntentRegistryContract), returns abi(sender,H,btcTxid,expiry,minOut,outputToken)
    address constant PARSE = 0x0000000000000000000000000000000001000020;
    // RSK Bridge precompile — getPeginInfo(bytes32) returns the real peg-in (destination, amount) for a txid
    address constant BRIDGE = 0x0000000000000000000000000000000001000006;
    // genesis-deployed Auction (E17b). If an auction for H is OPEN there (bid upon, not executed or
    // reclaimed), only the auction may settle H — closing the settle-at-minOut bypass. The check is
    // conditional: with no code at this address (older genesis) or no bid for H it is a no-op, so
    // bid-free intents and SDK-deployed auction instances behave exactly as before.
    address constant AUCTION = 0x0000000000000000000000000000000001000022;
    // sentinel outputToken meaning "the output is BTC, delivered ON BITCOIN" (exit intents / E19).
    // No code lives here — it is only a marker an intent's outputToken field can carry.
    address constant BTC_OUT = 0x0000000000000000000000000000000001000023;
    // confirmations the solver's BTC payout needs in the Bridge's SPV view before it settles. Regtest
    // PoC value; mainnet policy would set this per reorg-risk appetite (the solver bears that risk).
    int256 constant MIN_BTC_CONF = 1;
    // blocks a reservation shields the reserver's BTC payment from exit races (see reserveExit)
    uint256 public constant RESERVE_WINDOW = 30;
    /**
     * Exit payouts MUST carry a settler commitment: an OP_RETURN output holding
     * "RSKX" || <20-byte RSK address of the settler>. Rationale (attack E8, "payout hijack"): the
     * payout is public bytes and the SPV proof is a BEARER object, so without this anyone could
     * present another solver's payout against their OWN dust intent on the same destination — the
     * per-output claim then burns the paying solver's bitcoin irreversibly. The reservation gate
     * cannot help: it keys on H, and the hijacker brings a different H. Committing the SETTLER (not
     * H) keeps batching intact: one 25-byte output protects every payment in the transaction.
     * Legitimate here, unlike on the entry side, because the solver BUILDS this transaction and
     * wants to be repaid — omitting the commitment costs only the omitter.
     */
    bytes4 constant SETTLER_TAG = 0x52534b58; // "RSKX"
    /// Bound on the payout's output count: an unbounded scan lets a wide payout exceed any gas limit.
    uint256 public constant MAX_PAYOUT_OUTPUTS = 64;

    // one real peg-in per btcTxid can be claimed once (the Bridge does not clear its record)
    mapping(bytes32 => bool) public claimedPegin;

    /**
     * Input escrow, keyed by BTC txid (m4 fee mechanics). In the flagship flow the peg-in credits RBTC
     * to this contract earmarked for its btcTxid; `settle` releases it to the solver as repayment plus
     * spread. depositForPegin models that peg-in credit for the PoC (native RBTC cannot be pulled from
     * the user's account, so the input is escrowed here rather than sitting in the user's balance).
     */
    mapping(bytes32 => uint256) public pegin;

    /**
     * Exit intents (BTC_OUT): each output of a solver's BTC payout transaction can settle at most one
     * intent, keyed by keccak(payoutTxidDisplay, voutIndex). Per-OUTPUT (not per-tx) on purpose: one
     * BTC transaction paying N users can settle N exit intents — batched payouts amortise BTC fees.
     */
    mapping(bytes32 => bool) public claimedBtcOut;

    /**
     * Exit reservations — the fix for "exit races burn the loser's BTC". A Bitcoin payment is
     * irreversible, so if two solvers race the same exit, both have paid and only one is repaid; nobody
     * competes under that rule. reserveExit moves the race onto RSK: a solver posts a bond and gains
     * exclusive settlement rights for RESERVE_WINDOW blocks — long enough to pay on Bitcoin, confirm,
     * and prove. Losing a reservation race costs gas, never bitcoin. Squatting (reserve, never pay) is
     * priced: a lapsed reservation's bond is forfeited INTO the input escrow, so the stale exit becomes
     * strictly more profitable for the next solver — the mechanism heals its own delays.
     */
    struct ExitReservation { address solver; uint256 until; uint256 bond; }
    mapping(bytes32 => ExitReservation) public exitReservations;

    /**
     * Pull-payment ledger (the F1–F4 pattern from Auction.sol): solver-side RBTC payouts — the input
     * release, exit bond refunds, excess refunds — are pushed best-effort with a gas cap and DOWNGRADE
     * TO A CREDIT on failure instead of reverting the settlement. An unpayable solver therefore only
     * ever hurts itself (its money waits here), never the user or the intent. Delivery of minOut to
     * the USER stays a hard require: paying the user is the settlement's core promise.
     */
    mapping(address => uint256) public credit;
    uint256 constant PUSH_GAS = 30_000;

    event Settled(bytes32 indexed h, address indexed user, address outputToken, uint256 minOut, uint256 inputClaimed);
    event ExitReserved(bytes32 indexed h, address indexed solver, uint256 until, uint256 bond);
    event ExitReservationForfeited(bytes32 indexed h, address indexed solver, uint256 bond);
    event Credited(address indexed payee, uint256 amount);
    event Withdrawn(address indexed payee, uint256 amount);

    /// Best-effort RBTC push; on failure the amount becomes a withdrawable credit for `to`.
    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = payable(to).call{value: amount, gas: PUSH_GAS}("");
        if (!ok) {
            credit[to] += amount;
            emit Credited(to, amount);
        }
    }

    /**
     * Deliver `amount` of an ERC-20 to `to`, and verify it ARRIVED.
     *
     * The obvious form — `require(token.transferFrom(...))` — checks what the token SAYS, not what the
     * user received, and those differ for two common kinds of token. A fee-on-transfer token moves 90%
     * and returns true; an outright liar moves nothing and returns true. In both cases the settlement
     * succeeded, H was consumed and the input released, while the user got less than the minimum they
     * signed for. `minOut` has to mean "arrived", not "asked", or it guarantees nothing.
     *
     * So the balance is measured either side of the call and the DELTA is what must reach minOut. That
     * is the only check that cannot be talked out of by the token's own return value.
     *
     * The call is also made low-level rather than through the typed interface, for the pre-EIP-20
     * tokens that return no data at all: Solidity cannot decode a missing bool, so the typed form
     * reverts on tokens that transferred perfectly well. Empty returndata is accepted as success, and
     * the delta check is what makes that safe — a non-token address returns empty too, and moves
     * nothing, so it fails on the delta instead of passing on the silence.
     *
     * Not defended against, because it cannot be: a token whose issuer can claw the balance back after
     * this transaction. No on-chain check survives an adversarial issuer, which is why the output asset
     * being the USER'S OWN signed choice matters — wallets must not offer arbitrary tokens as outputs.
     */
    function _deliverToken(address token, address to, uint256 amount) internal {
        uint256 before = IERC20(token).balanceOf(to);
        (bool ok, bytes memory ret) = token.call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, msg.sender, to, amount));
        require(ok, "erc20 transfer failed");
        // A token that returns data must return `true`; one that returns nothing is the pre-EIP-20 form.
        require(ret.length == 0 || abi.decode(ret, (bool)), "erc20 returned false");
        require(IERC20(token).balanceOf(to) - before >= amount, "erc20 under-delivered");
    }

    /// Claim accrued credits. Effects-first: a failed transfer reverts only this call, never the ledger.
    function withdraw() external {
        uint256 amt = credit[msg.sender];
        require(amt > 0, "nothing to withdraw");
        credit[msg.sender] = 0;
        (bool r,) = payable(msg.sender).call{value: amt}("");
        require(r, "withdraw failed");
        emit Withdrawn(msg.sender, amt);
    }

    /**
     * Which intent an escrowed input answers to: btcTxid -> BINDING (0 = unbound), where
     *
     *     binding = keccak256(H || signer)
     *
     * and NOT H alone. H is the pipeline commitment: thirty-two bytes that sit in the clear in every
     * intent in the public mempool, and that anyone may copy into an intent of their own. The signer is
     * recovered from the signature at settlement, so a binding that omits it lets a rival sign a twin
     * of the victim's intent — same H, same btcTxid, dust minOut — and have a solver release the
     * victim's escrow against it (attack B5). Including the signer means a rival with a different key
     * computes a different binding and commands no funds.
     *
     * This is the PoC model of RSKIP176 entry binding: in production the peg-in's DERIVED DEPOSIT
     * ADDRESS carries the binding as its derivationArgumentsHash, so the Bridge credits an escrow only
     * the matching (intent, signer) pair can claim; here the deposit call carries it instead. The same
     * lesson applies there — the derivation argument MUST be keccak256(H || signer), not H — because
     * RSKIP176's other derivation inputs (refund address, LBC, LP) do not include the Rootstock signer.
     */
    mapping(bytes32 => bytes32) public peginIntent;

    /// The binding an escrow is keyed on. One place, so the SDK, the attacks and the contract cannot
    /// disagree about it — a mismatched hash here would look exactly like an unbound escrow.
    function bindingOf(bytes32 h, address signer) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(h, signer));
    }

    /**
     * Model the peg-in credit: escrow `msg.value` of input RBTC against a BTC txid, BOUND to
     * `binding = bindingOf(H, signer)`. Commit-first ordering, as RSKIP176 requires: H and the signer
     * are known before any coins move, so the binding can determine the deposit address.
     * binding == 0 models a legacy/unbound peg-in: still claimable by any intent naming the txid, kept
     * only to mirror the real-pegin path's current exposure (see _releaseInput).
     */
    function depositForPegin(bytes32 btcTxid, bytes32 binding) external payable {
        if (binding != bytes32(0)) {
            require(peginIntent[btcTxid] == bytes32(0) || peginIntent[btcTxid] == binding, "escrow bound to another intent");
            peginIntent[btcTxid] = binding;
        }
        pegin[btcTxid] += msg.value;
    }

    /// consumed-set view: true once H has been settled
    function isConsumed(bytes32 h) external view returns (bool) {
        uint256 v;
        assembly { v := sload(h) }
        return v != 0;
    }

    /**
     * Atomically settle an intent: deliver >= minOut of the output asset to the user and record H.
     * RBTC output (outputToken == 0): send msg.value (>= minOut) to the user, refund any excess.
     * ERC-20 output: pull minOut from the solver (msg.sender must have approved this contract).
     * Reverts (visibly) on any failed check or transfer, leaving H unconsumed.
     */
    function settle(bytes calldata rawIntentTx) external payable {
        (bool ok, bytes memory ret) = PARSE.staticcall(rawIntentTx);
        require(ok && ret.length == 192, "intent parse failed");
        (address user, bytes32 H, bytes32 btcTxid, uint256 expiry, uint256 minOut, address outToken) =
            abi.decode(ret, (address, bytes32, bytes32, uint256, uint256, address));

        require(user != address(0), "bad intent");
        require(outToken != BTC_OUT, "btc output: use settleBtcOut");
        require(block.number < expiry, "expired");

        // auction lock (see AUCTION above): while an open auction exists for H, only the auction settles
        if (msg.sender != AUCTION) {
            (bool okA, bytes memory rl) = AUCTION.staticcall(abi.encodeWithSignature("lockedUntil(bytes32)", H));
            if (okA && rl.length == 32) {
                require(abi.decode(rl, (uint256)) == 0, "auction owns this intent");
            }
        }

        uint256 consumed;
        assembly { consumed := sload(H) }
        require(consumed == 0, "H already consumed");

        // effects before interactions: record H consumed up front (a reentrant settle for the same H reverts)
        assembly { sstore(H, add(number(), 1)) }

        // deliver >= minOut of the output asset to the user
        if (outToken == address(0)) {
            require(msg.value >= minOut, "under minOut");
            (bool d,) = payable(user).call{value: minOut}("");
            require(d, "deliver failed");
            uint256 excess = msg.value - minOut;
            _pay(msg.sender, excess); // best-effort refund — an unpayable solver cannot revert delivery
        } else {
            require(msg.value == 0, "no rbtc for token intent");
            _deliverToken(outToken, user, minOut);
        }

        uint256 input = _releaseInput(btcTxid, H, user);
        emit Settled(H, user, outToken, minOut, input);
    }

    /**
     * Exit intent settlement — the path BACK to BTC (the user's whole lifecycle stays on Bitcoin).
     * The intent's outputToken is the BTC_OUT sentinel and its H commits to the user's BTC destination:
     * H = keccak256("BTCOUT" || dest20 || salt). The solver pays `dest` on BITCOIN from its own UTXOs,
     * then proves that payment here: SPV inclusion via the Bridge's header chain (RSKIP122
     * getBtcTransactionConfirmations) plus a parse of the raw payout tx showing an unclaimed P2PKH
     * output of >= minOut SATS (minOut is denominated in sats for exit intents) to `dest`. On success
     * H is consumed and the escrowed RSK-side input is released to the solver — the mirror image of
     * the peg-in flow, with the SPV proof pointing the other way.
     *
     * All bytes32 BTC hashes are DISPLAY order (as bitcoin-cli prints them); the contract reverses its
     * own sha256d to match. Legacy (non-segwit) payout transactions only.
     */
    /// The bond a reservation must post: 10% of the payout (1 sat = 1e10 wei at par).
    function exitBondFor(uint256 minOutSats) public pure returns (uint256) {
        return minOutSats * 1_000_000_000; // minOutSats * 1e10 / 10
    }

    /**
     * Reserve an exit intent before paying BTC: exclusive settlement rights for RESERVE_WINDOW blocks
     * against a bond of >= exitBondFor(minOut). Refunded on the reserver's own settle; forfeited into
     * the input escrow if the reservation lapses unsettled. Reserving over a LAPSED reservation
     * forfeits the old bond the same way.
     */
    function reserveExit(bytes calldata rawIntentTx) external payable {
        (bool ok, bytes memory ret) = PARSE.staticcall(rawIntentTx);
        require(ok && ret.length == 192, "intent parse failed");
        (address user, bytes32 H, bytes32 btcTxid, uint256 expiry, uint256 minOut, address outToken) =
            abi.decode(ret, (address, bytes32, bytes32, uint256, uint256, address));
        require(user != address(0), "bad intent");
        require(outToken == BTC_OUT, "not a btc-out intent");
        require(block.number < expiry, "expired");
        uint256 consumed;
        assembly { consumed := sload(H) }
        require(consumed == 0, "H already consumed");

        // the window must not outlive the intent (Auction.sol:91 precedent) — otherwise an honest
        // reserver could be handed exclusivity it cannot possibly use, and forfeit at expiry (below)
        require(block.number + RESERVE_WINDOW < expiry, "window would outlive intent");

        ExitReservation storage r = exitReservations[H];
        require(r.solver == address(0) || block.number >= r.until, "exit already reserved");
        if (r.solver != address(0)) {
            pegin[btcTxid] += r.bond; // lapsed: the old bond sweetens the pot for whoever fills now
            emit ExitReservationForfeited(H, r.solver, r.bond);
        }
        require(msg.value >= exitBondFor(minOut), "reservation bond too low");
        exitReservations[H] = ExitReservation(msg.sender, block.number + RESERVE_WINDOW, msg.value);
        emit ExitReserved(H, msg.sender, block.number + RESERVE_WINDOW, msg.value);
    }

    /**
     * A reservation that outlives its INTENT previously stranded the bond forever: reserveExit and
     * settleBtcOut both require an unexpired intent, and forfeiture only ran inside those two paths.
     * Now anyone may forfeit an expired-while-reserved exit's bond TO THE USER (push-then-credit) —
     * the party the dead exit harmed. Squatting an exit to death therefore costs the full bond;
     * an honest reserver is protected by the window guard above and by settling inside its window.
     */
    function forfeitExpiredExitBond(bytes calldata rawIntentTx) external {
        (bool ok, bytes memory ret) = PARSE.staticcall(rawIntentTx);
        require(ok && ret.length == 192, "intent parse failed");
        (address user, bytes32 H,, uint256 expiry,, address outToken) =
            abi.decode(ret, (address, bytes32, bytes32, uint256, uint256, address));
        require(outToken == BTC_OUT, "not a btc-out intent");
        uint256 consumed;
        assembly { consumed := sload(H) }
        require(consumed == 0, "settled - reservation already resolved");
        require(block.number >= expiry, "intent still live");
        ExitReservation storage r = exitReservations[H];
        require(r.solver != address(0), "no reservation");
        address squatter = r.solver;
        uint256 bondAmt = r.bond;
        delete exitReservations[H];
        _pay(user, bondAmt);
        emit ExitReservationForfeited(H, squatter, bondAmt);
    }

    function settleBtcOut(
        bytes calldata rawIntentTx,
        bytes32 salt,
        bytes20 btcDest,
        bytes calldata rawBtcTx,
        bytes32 btcBlockHash,
        uint256 merklePath,
        bytes32[] calldata merkleHashes
    ) external {
        (address user, bytes32 H, bytes32 btcTxid, uint256 minOut) = _checkBtcOutIntent(rawIntentTx, salt, btcDest);

        // reservation gate (cheap, before the SPV work): a LIVE reservation is exclusive; a lapsed one
        // forfeits its bond into the release below unless the late reserver is the settler after all.
        uint256 bondBack = 0;
        ExitReservation storage resv = exitReservations[H];
        if (resv.solver != address(0)) {
            if (block.number < resv.until) {
                require(msg.sender == resv.solver, "exit reserved by another solver");
                bondBack = resv.bond;
            } else if (msg.sender == resv.solver) {
                bondBack = resv.bond; // late, but nobody re-reserved — no forfeit
            } else {
                pegin[btcTxid] += resv.bond;
                emit ExitReservationForfeited(H, resv.solver, resv.bond);
            }
            delete exitReservations[H];
        }

        _checkAndClaimBtcPayment(rawBtcTx, btcDest, minOut, btcBlockHash, merklePath, merkleHashes);
        assembly { sstore(H, add(number(), 1)) }
        uint256 input = _releaseInput(btcTxid, H, user);
        // best-effort bond refund: a reserver that cannot receive RBTC must not be able to brick its
        // own settle AFTER having paid real, irreversible BTC (the old "bond refund failed" footgun).
        _pay(msg.sender, bondBack);
        emit Settled(H, user, BTC_OUT, minOut, input);
    }

    /// Parse + validate an exit intent: sentinel output, unexpired, H commits to (btcDest, salt), unconsumed.
    function _checkBtcOutIntent(bytes calldata rawIntentTx, bytes32 salt, bytes20 btcDest)
        internal view returns (address user, bytes32 H, bytes32 btcTxid, uint256 minOut)
    {
        (bool ok, bytes memory ret) = PARSE.staticcall(rawIntentTx);
        require(ok && ret.length == 192, "intent parse failed");
        uint256 expiry;
        address outToken;
        (user, H, btcTxid, expiry, minOut, outToken) =
            abi.decode(ret, (address, bytes32, bytes32, uint256, uint256, address));
        require(user != address(0), "bad intent");
        require(outToken == BTC_OUT, "not a btc-out intent");
        require(block.number < expiry, "expired");
        require(H == keccak256(abi.encodePacked("BTCOUT", btcDest, salt)), "dest not committed in H");
        uint256 consumed;
        assembly { consumed := sload(H) }
        require(consumed == 0, "H already consumed");
    }

    /// SPV-verify the solver's BTC payout via the Bridge's header chain, find an unclaimed P2PKH output
    /// of >= minSats to dest, and mark that (txid, vout) claimed.
    function _checkAndClaimBtcPayment(
        bytes calldata rawBtcTx,
        bytes20 btcDest,
        uint256 minSats,
        bytes32 btcBlockHash,
        uint256 merklePath,
        bytes32[] calldata merkleHashes
    ) internal {
        bytes32 payTxid = _reverse32(sha256(abi.encodePacked(sha256(rawBtcTx))));
        (bool okC, bytes memory retC) = BRIDGE.staticcall(abi.encodeWithSignature(
            "getBtcTransactionConfirmations(bytes32,bytes32,uint256,bytes32[])",
            payTxid, btcBlockHash, merklePath, merkleHashes));
        require(okC && retC.length == 32, "confirmations call failed");
        require(abi.decode(retC, (int256)) >= MIN_BTC_CONF, "btc payout not confirmed");
        require(_settlerOf(rawBtcTx) == msg.sender, "payout not committed to this settler");
        (uint256 voutIdx, ) = _findPayment(rawBtcTx, btcDest, minSats, payTxid);
        claimedBtcOut[keccak256(abi.encodePacked(payTxid, voutIdx))] = true;
    }

    /// Release the input to the solver — repayment + spread. Prefer the REAL peg-in credited to this
    /// contract (recorded by the Bridge at peg-in), falling back to the modelled depositForPegin escrow.
    /// ENTRY BINDING: a bound modelled escrow answers only to the (intent, signer) pair it was
    /// deposited for. A rival naming the same txid with its own H reverts here (B1), and so does a
    /// rival carrying the victim's H under a different key (B5) — the binding includes the signer,
    /// which the rival cannot forge because settlement recovers it from the signature.
    /// The REAL-pegin branch cannot carry a binding today (the OP_RETURN has no room for it) — that
    /// path keeps the B1 exposure by construction and is exactly what RSKIP176 derivation replaces.
    function _releaseInput(bytes32 btcTxid, bytes32 h, address signer) internal returns (uint256 input) {
        (bool ok2, bytes memory raw) = BRIDGE.staticcall(abi.encodeWithSignature("getPeginInfo(bytes32)", btcTxid));
        if (ok2 && raw.length >= 128 && !claimedPegin[btcTxid]) {
            bytes memory info = abi.decode(raw, (bytes)); // Bridge returns BYTES wrapping 64 bytes
            if (info.length == 64) {
                (address dest, uint256 amt) = abi.decode(info, (address, uint256));
                if (dest == address(this) && amt > 0) {
                    claimedPegin[btcTxid] = true; // effect before the transfer below
                    input = amt;
                }
            }
        }
        if (input == 0) {
            uint256 esc = pegin[btcTxid];
            if (esc > 0) {
                bytes32 bound = peginIntent[btcTxid];
                require(bound == bytes32(0) || bound == bindingOf(h, signer), "input escrow bound to another intent");
                input = esc;
                pegin[btcTxid] = 0;
            }
        }
        _pay(msg.sender, input); // best-effort — an unpayable claimant's input waits as a credit
    }

    /// First unclaimed P2PKH output in a LEGACY btc tx paying >= minSats to dest20. Reverts if none.
    function _findPayment(bytes calldata t, bytes20 dest, uint256 minSats, bytes32 payTxid)
        internal view returns (uint256 voutIdx, uint256 sats)
    {
        require(t.length > 5 && t[4] != 0x00, "segwit payout unsupported");
        uint256 o = 4; // skip version
        uint256 n;
        (n, o) = _varint(t, o);                       // inputs
        for (uint256 i = 0; i < n; i++) {
            o += 36;                                  // prevout (32 + 4)
            uint256 sl;
            (sl, o) = _varint(t, o);
            o += sl + 4;                              // scriptSig + sequence
        }
        (n, o) = _varint(t, o);                       // outputs
        require(n <= MAX_PAYOUT_OUTPUTS, "payout too wide");
        for (uint256 i = 0; i < n; i++) {
            uint256 value = 0;
            for (uint256 j = 0; j < 8; j++) { value |= uint256(uint8(t[o + j])) << (8 * j); } // LE sats
            o += 8;
            uint256 sl;
            (sl, o) = _varint(t, o);
            if (sl == 25 && t[o] == 0x76 && t[o + 1] == 0xa9 && t[o + 2] == 0x14
                && t[o + 23] == 0x88 && t[o + 24] == 0xac
                && bytes20(t[o + 3:o + 23]) == dest
                && value >= minSats
                && !claimedBtcOut[keccak256(abi.encodePacked(payTxid, i))]) {
                return (i, value);
            }
            o += sl;
        }
        revert("no unclaimed payout to dest");
    }

    /**
     * The RSK address this payout commits to, read from its OP_RETURN settler commitment:
     * OP_RETURN (0x6a) PUSH24 (0x18) "RSKX" <20-byte address> = a 26-byte scriptPubKey.
     * Reverts if the payout carries no such output — an uncommitted payout is unclaimable, which is
     * exactly what stops a hijacker replaying someone else's proof.
     */
    function _settlerOf(bytes calldata t) internal pure returns (address settler) {
        uint256 o = 4;                                // skip version
        uint256 n;
        (n, o) = _varint(t, o);                       // inputs
        for (uint256 i = 0; i < n; i++) {
            o += 36;
            uint256 sl;
            (sl, o) = _varint(t, o);
            o += sl + 4;
        }
        (n, o) = _varint(t, o);                       // outputs
        require(n <= MAX_PAYOUT_OUTPUTS, "payout too wide");
        for (uint256 i = 0; i < n; i++) {
            o += 8;                                   // value
            uint256 sl;
            (sl, o) = _varint(t, o);
            if (sl == 26 && t[o] == 0x6a && t[o + 1] == 0x18 && bytes4(t[o + 2:o + 6]) == SETTLER_TAG) {
                return address(bytes20(t[o + 6:o + 26]));
            }
            o += sl;
        }
        revert("payout carries no settler commitment");
    }

    function _varint(bytes calldata t, uint256 o) internal pure returns (uint256 v, uint256 no) {
        uint8 b = uint8(t[o]);
        if (b < 0xfd) return (b, o + 1);
        if (b == 0xfd) return (uint256(uint8(t[o + 1])) | (uint256(uint8(t[o + 2])) << 8), o + 3);
        revert("varint too large");
    }

    /// byte-reverse a bytes32 (internal sha256d order <-> bitcoin display order)
    function _reverse32(bytes32 x) internal pure returns (bytes32) {
        uint256 v = uint256(x);
        v = ((v >> 8)  & 0x00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF)
          | ((v & 0x00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF) << 8);
        v = ((v >> 16) & 0x0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF)
          | ((v & 0x0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF) << 16);
        v = ((v >> 32) & 0x00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF)
          | ((v & 0x00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF) << 32);
        v = ((v >> 64) & 0x0000000000000000FFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF)
          | ((v & 0x0000000000000000FFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF) << 64);
        v = (v >> 128) | (v << 128);
        return bytes32(v);
    }
}
