// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.19;

/**
 * Above-minOut auction (productionization C refinement), generalised to ANY output asset.
 *
 * Bids are denominated in the intent's own output asset: native RBTC bids escrow msg.value (bid),
 * ERC-20 bids escrow output tokens pulled via transferFrom (bidToken) — which makes vault shares and
 * LP tokens auctionable exactly like RBTC, and lets solvers compete on ROUTE QUALITY for compound
 * intents: a solver with a better route mints more of the terminal asset per input and can bid higher.
 * The auction never needs to know what the token is or how it was produced — settlement is
 * outcome-based, so the route stays the solver's business.
 *
 * Two deployment modes, one contract:
 *  - SDK-deployed (any address): pure off-consensus market structure; bypassable at minOut (E17).
 *  - Genesis-deployed at 0x..01000022: Settlement rejects settle() from anyone but this contract while
 *    an auction for H is OPEN (bid upon, not executed/reclaimed) — including after the deadline, so a
 *    bypasser cannot front-run the permissionless execute() (E17b). Enforcement engages only once
 *    someone bids; a lock requires escrowing a bid > minOut, so the user always nets above their ask.
 *    No constructor (genesis injects runtime code only) — everything is constants.
 *
 * Failure containment (post-win revert hardening):
 *  - PULL-PAYMENTS: execute() never push-pays with a reverting require. The winner's input is CREDITED
 *    (pure pull via withdraw()/withdrawToken()); the user's surplus is pushed with a gas-capped,
 *    require-free call that falls back to a credit. An unpayable winner or user can therefore no longer
 *    make execute() revert — the "winner pay failed" / "surplus pay failed" griefing brick is gone.
 *  - LOCK DECAY: exclusivity expires GRACE blocks after the bidding deadline if the auction has not
 *    executed by then (lockedUntil returns 0), so a settle() that persistently reverts INSIDE execute
 *    (e.g. an unpayable user) releases the intent back to open competition at minOut instead of holding
 *    it hostage until expiry. execute() itself stays valid after decay until H is consumed, so the
 *    auction can still win the race and pay the better price.
 */
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface ISettlement {
    function isConsumed(bytes32 h) external view returns (bool);
    function settle(bytes calldata rawIntentTx) external payable;
}

contract Auction {
    // parse precompile, returns abi(sender,H,btcTxid,expiry,minOut,outputToken) for a raw intent tx
    address constant PARSE = 0x0000000000000000000000000000000001000020;
    address constant SETTLEMENT = 0x0000000000000000000000000000000001000021;
    uint256 public constant WINDOW = 10; // blocks of bidding after the first bid
    uint256 public constant GRACE = 10;  // blocks after the deadline before exclusivity decays
    uint256 constant PUSH_GAS = 30_000; // stipend for best-effort pushes (surplus, outbid refunds)
    /**
     * Floor on the gas execute() must be given, so the settle it wraps cannot be starved.
     *
     * EIP-150 forwards 63/64 of the remaining gas to a call, keeping 1/64 for the caller. Without a
     * floor, anyone could call execute() with just enough gas that the inner settle dies OOG while the
     * catch block still runs — recording a "failure" against a perfectly healthy auction and decaying
     * its exclusivity early. Requiring a floor well above a real settle (~150k observed; execute ~246k
     * end to end) means the inner call always receives more than it can spend.
     */
    uint256 public constant MIN_EXECUTE_GAS = 500_000;

    struct Bid {
        address bidder;    // current best bidder
        uint256 amount;    // current best bid, in output-asset units (> minOut)
        uint256 deadline;  // bidding closes at this block (set by the first bid)
        uint256 expiry;    // the intent's expiry (cached so reclaim works without the raw tx)
        address outToken;  // the output asset (0 = native RBTC), cached from the first bid's parse
        bool settledHere;  // execute()/reclaim() ran — escrow accounted for
    }
    mapping(bytes32 => Bid) public bids;

    /// Block at which execute() was first OBSERVED to fail for H. Zero means never attempted, or
    /// attempted and succeeded. Exclusivity decays from this, not from the bidding deadline.
    mapping(bytes32 => uint256) public failedAt;

    /// Pull-payment ledgers. `credit` is native RBTC owed; `creditToken` is token => payee => amount.
    /// Credits are backed 1:1 by RBTC/tokens already held by this contract when they are recorded.
    mapping(address => uint256) public credit;
    mapping(address => mapping(address => uint256)) public creditToken;

    event BidPlaced(bytes32 indexed h, address indexed bidder, uint256 amount, uint256 deadline);
    event Executed(bytes32 indexed h, address indexed winner, uint256 paidToUser, uint256 inputToWinner);
    event Reclaimed(bytes32 indexed h, address indexed bidder, uint256 amount);
    /// execute() ran and the settlement inside it reverted. The auction keeps the intent for GRACE
    /// more blocks, then releases it. Emitted rather than reverted, because a revert would roll the
    /// record back and there would be nothing to decay from.
    event ExecuteFailed(bytes32 indexed h, uint256 atBlock);
    event Credited(address indexed payee, address indexed token, uint256 amount);
    event Withdrawn(address indexed payee, address indexed token, uint256 amount);

    /// Settlement releases the claimed input to its caller with a plain transfer — this contract must be
    /// able to receive it or execute() reverts with "input claim failed". An open receive is harmless:
    /// inputClaimed is measured as the balance DELTA across the settle call, so RBTC sent here at any
    /// other time is never attributed to a winner (it is simply stranded, as in any PoC contract).
    receive() external payable {}

    /// Nonzero (the bidding deadline) while an auction for H is open — i.e. bid upon and not yet
    /// executed/reclaimed. Settlement (genesis deployment only) consults this and, while nonzero,
    /// rejects settle() from anyone but this contract; 0 means no lock.
    /**
     * DECAY: exclusivity ends GRACE blocks after execute() was SEEN TO FAIL — not GRACE blocks after
     * the deadline.
     *
     * The earlier rule decayed on elapsed time alone, which handed the intent to whoever controlled
     * block production: decline to include execute(), wait out the grace window, and settle directly
     * at minOut around a higher standing bid (attack M3). Worse, for an RBTC intent that path had no
     * legitimate use at all — the auction holds the winning bid, so the settle inside execute() cannot
     * fail for want of funds, and the only party who ever reached a time-based decay was one who chose
     * not to execute.
     *
     * Keyed on demonstrated failure, a producer that withholds execute() decays nothing and can settle
     * nothing: the attack stops paying. The S4 property it was introduced for survives — a genuinely
     * wedged auction still releases the intent — but someone must first call execute() and have it
     * fail, which any solver wanting the intent back has every reason to do.
     *
     * The trade this makes, stated plainly: the user's old fallback of "minOut after GRACE, whatever
     * happens" becomes "the best bid, or nothing until expiry". That is the better bargain only
     * because withholding execute() now gains the withholder nothing, so there is no longer a reason
     * to withhold it beyond censorship for its own sake.
     */
    function lockedUntil(bytes32 h) external view returns (uint256) {
        Bid storage b = bids[h];
        if (b.deadline == 0 || b.settledHere) return 0;
        uint256 f = failedAt[h];
        if (f != 0 && block.number >= f + GRACE) return 0; // exclusivity decayed after a real failure
        return b.deadline;
    }

    function parse(bytes calldata rawIntentTx)
        internal view
        returns (address user, bytes32 H, uint256 expiry, uint256 minOut, address outToken)
    {
        (bool ok, bytes memory ret) = PARSE.staticcall(rawIntentTx);
        require(ok && ret.length == 192, "intent parse failed");
        bytes32 btcTxid;
        (user, H, btcTxid, expiry, minOut, outToken) =
            abi.decode(ret, (address, bytes32, bytes32, uint256, uint256, address));
        require(user != address(0), "bad intent");
    }

    /// Shared bid bookkeeping: open the window on the first bid, enforce the price ladder, swap out the
    /// previous best. Returns the previous bidder/amount so the caller can refund in the right asset.
    function _book(bytes32 H, uint256 expiry, uint256 minOut, address outToken, uint256 amount)
        internal
        returns (address prevBidder, uint256 prevAmount)
    {
        require(!ISettlement(SETTLEMENT).isConsumed(H), "already settled");
        require(block.number < expiry, "intent expired");
        Bid storage b = bids[H];
        require(!b.settledHere, "auction closed");
        if (b.deadline == 0) {
            require(block.number + WINDOW < expiry, "window would outlive intent");
            b.deadline = block.number + WINDOW;
            b.expiry = expiry;
            b.outToken = outToken;
        } else {
            require(block.number < b.deadline, "bidding closed");
        }
        require(amount > minOut && amount > b.amount, "bid too low");
        prevBidder = b.bidder;
        prevAmount = b.amount;
        b.bidder = msg.sender;
        b.amount = amount;                             // effects before the refund interaction
        emit BidPlaced(H, msg.sender, amount, b.deadline);
    }

    /// Bid msg.value of NATIVE RBTC (RBTC-output intents). Refunds the outbid bidder in RBTC.
    function bid(bytes calldata rawIntentTx) external payable {
        (, bytes32 H, uint256 expiry, uint256 minOut, address outToken) = parse(rawIntentTx);
        require(outToken == address(0), "use bidToken for erc20 outputs");
        (address prev, uint256 prevAmt) = _book(H, expiry, minOut, address(0), msg.value);
        if (prev != address(0)) {
            // best-effort refund: an unpayable previous bidder must not be able to block
            // higher bids ("outbid refund failed" was a price-discovery griefing vector).
            (bool r,) = payable(prev).call{value: prevAmt, gas: PUSH_GAS}("");
            if (!r) {
                credit[prev] += prevAmt;
                emit Credited(prev, address(0), prevAmt);
            }
        }
    }

    /// Bid `amount` of the intent's OUTPUT TOKEN (vault shares, LP tokens, any ERC-20); the bidder must
    /// have approved this contract. Refunds the outbid bidder in the same token.
    function bidToken(bytes calldata rawIntentTx, uint256 amount) external {
        (, bytes32 H, uint256 expiry, uint256 minOut, address outToken) = parse(rawIntentTx);
        require(outToken != address(0), "use bid for rbtc outputs");
        (address prev, uint256 prevAmt) = _book(H, expiry, minOut, outToken, amount);
        // Measure what ARRIVED, not what the token claims — the same rule the settlement's delivery
        // uses. A fee-on-transfer token would otherwise let a bidder register a bid of `amount` while
        // escrowing less, and the auction would owe the user a price it is not holding. Requiring the
        // delta to be exact (rather than crediting the received amount) keeps one rule across both
        // contracts: a token that skims cannot be an intent's output asset anywhere.
        uint256 held = IERC20(outToken).balanceOf(address(this));
        require(IERC20(outToken).transferFrom(msg.sender, address(this), amount), "bid escrow failed");
        require(IERC20(outToken).balanceOf(address(this)) - held == amount, "bid escrow short");
        if (prev != address(0)) {
            // best-effort refund, credited on failure — see bid() above.
            (bool s, bytes memory rd) = outToken.call(
                abi.encodeWithSelector(IERC20.transfer.selector, prev, prevAmt)
            );
            if (!(s && (rd.length == 0 || (rd.length >= 32 && abi.decode(rd, (bool)))))) {
                creditToken[outToken][prev] += prevAmt;
                emit Credited(prev, outToken, prevAmt);
            }
        }
    }

    /// After the window closes, settle with the winning bid: the user gets minOut via settle PLUS the
    /// surplus (best - minOut) in the output asset; the winning bidder gets the input settle releases.
    /// Permissionless — anyone may trigger it.
    function execute(bytes calldata rawIntentTx) external {
        (address user, bytes32 H,, uint256 minOut,) = parse(rawIntentTx);
        Bid storage b = bids[H];
        require(b.deadline != 0 && !b.settledHere, "no open auction");
        require(block.number >= b.deadline, "bidding still open");
        // See MIN_EXECUTE_GAS: without this floor, an under-gassed call could make the settle below
        // die OOG while the catch still runs, recording a failure against a healthy auction.
        require(gasleft() >= MIN_EXECUTE_GAS, "execute needs more gas");
        b.settledHere = true;                          // effect first; undone by _noteFailure

        uint256 balBefore = address(this).balance;
        uint256 inputClaimed;
        uint256 surplus = b.amount - minOut;
        if (b.outToken == address(0)) {
            try ISettlement(SETTLEMENT).settle{value: minOut}(rawIntentTx) {
                inputClaimed = address(this).balance - (balBefore - minOut);
            } catch {
                return _noteFailure(H, b);
            }
            if (surplus > 0) {
                // best-effort push (gas-capped, require-free): an unpayable or gas-burning user
                // cannot revert execute(); their surplus falls back to a pull-payment credit.
                (bool s,) = payable(user).call{value: surplus, gas: PUSH_GAS}("");
                if (!s) {
                    credit[user] += surplus;
                    emit Credited(user, address(0), surplus);
                }
            }
        } else {
            require(IERC20(b.outToken).approve(SETTLEMENT, minOut), "approve failed");
            try ISettlement(SETTLEMENT).settle(rawIntentTx) {
                inputClaimed = address(this).balance - balBefore;
            } catch {
                // The allowance granted just above survives the failed attempt. That is harmless:
                // Settlement only ever pulls from its own caller, so this allowance is reachable only
                // when THIS contract calls settle — i.e. from a later execute() for this same intent.
                return _noteFailure(H, b);
            }
            if (surplus > 0) {
                // require-free push: a token that reverts or returns false on transfer-to-user
                // (e.g. ERC-777 hooks) downgrades to a credit instead of bricking the auction.
                (bool s, bytes memory rd) = b.outToken.call(
                    abi.encodeWithSelector(IERC20.transfer.selector, user, surplus)
                );
                if (!(s && (rd.length == 0 || (rd.length >= 32 && abi.decode(rd, (bool)))))) {
                    creditToken[b.outToken][user] += surplus;
                    emit Credited(user, b.outToken, surplus);
                }
            }
        }
        if (inputClaimed > 0) {
            // winner is PURE PULL — never called from here, so an unpayable winner cannot
            // grief the intent to death (the former "winner pay failed" brick).
            credit[b.bidder] += inputClaimed;
            emit Credited(b.bidder, address(0), inputClaimed);
        }
        emit Executed(H, b.bidder, minOut + surplus, inputClaimed);
    }

    /**
     * Record that the settlement inside execute() reverted, and hand the auction back its open state.
     *
     * execute() returns NORMALLY on this path rather than reverting, which is the only way the record
     * can survive — a revert would roll `failedAt` back and leave nothing to decay from. The caller
     * therefore pays gas for a transaction that changed little; `settledHere` staying false and the
     * ExecuteFailed event are what tell them (and any watcher) what happened.
     *
     * Only the FIRST failure counts. Otherwise repeated calls would keep pushing the decay away, and
     * anyone could hold an intent hostage by re-failing it once per block.
     */
    function _noteFailure(bytes32 H, Bid storage b) internal {
        b.settledHere = false;                         // the auction is still open for a retry
        if (failedAt[H] == 0) failedAt[H] = block.number;
        emit ExecuteFailed(H, failedAt[H]);
    }

    /// Claim accrued native-RBTC credits (winner input, fallen-back surplus). Effects-first, so a
    /// failed transfer reverts only this call and the credit survives for a later retry.
    function withdraw() external {
        uint256 amt = credit[msg.sender];
        require(amt > 0, "nothing to withdraw");
        credit[msg.sender] = 0; // effect first
        (bool r,) = payable(msg.sender).call{value: amt}("");
        require(r, "withdraw failed");
        emit Withdrawn(msg.sender, address(0), amt);
    }

    /// Claim accrued ERC-20 credits for `token`.
    function withdrawToken(address token) external {
        uint256 amt = creditToken[token][msg.sender];
        require(amt > 0, "nothing to withdraw");
        creditToken[token][msg.sender] = 0; // effect first
        require(IERC20(token).transfer(msg.sender, amt), "withdraw failed");
        emit Withdrawn(msg.sender, token, amt);
    }

    /// Escrow recovery when the auction can never execute: the intent was settled directly by a
    /// bypassing solver (H consumed), or it expired unexecuted. Returns the best bid to its bidder,
    /// in the asset it was escrowed in.
    function reclaim(bytes32 h) external {
        Bid storage b = bids[h];
        require(b.deadline != 0 && !b.settledHere && b.bidder != address(0), "nothing to reclaim");
        require(ISettlement(SETTLEMENT).isConsumed(h) || block.number >= b.expiry, "auction still live");
        b.settledHere = true;                          // effect first
        if (b.outToken == address(0)) {
            (bool r,) = payable(b.bidder).call{value: b.amount}("");
            require(r, "reclaim failed");
        } else {
            require(IERC20(b.outToken).transfer(b.bidder, b.amount), "reclaim failed");
        }
        emit Reclaimed(h, b.bidder, b.amount);
    }
}
