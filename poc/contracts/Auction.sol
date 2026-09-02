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

    struct Bid {
        address bidder;    // current best bidder
        uint256 amount;    // current best bid, in output-asset units (> minOut)
        uint256 deadline;  // bidding closes at this block (set by the first bid)
        uint256 expiry;    // the intent's expiry (cached so reclaim works without the raw tx)
        address outToken;  // the output asset (0 = native RBTC), cached from the first bid's parse
        bool settledHere;  // execute()/reclaim() ran — escrow accounted for
    }
    mapping(bytes32 => Bid) public bids;

    /// Pull-payment ledgers. `credit` is native RBTC owed; `creditToken` is token => payee => amount.
    /// Credits are backed 1:1 by RBTC/tokens already held by this contract when they are recorded.
    mapping(address => uint256) public credit;
    mapping(address => mapping(address => uint256)) public creditToken;

    event BidPlaced(bytes32 indexed h, address indexed bidder, uint256 amount, uint256 deadline);
    event Executed(bytes32 indexed h, address indexed winner, uint256 paidToUser, uint256 inputToWinner);
    event Reclaimed(bytes32 indexed h, address indexed bidder, uint256 amount);
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
    /// DECAY: exclusivity is time-bounded. If execute() has not landed within GRACE blocks of the
    /// deadline, this returns 0 and direct settlement reopens at minOut. Deliberately a pure view-time
    /// rule (no new write path): releasing the lock on OBSERVED settle failure instead would require
    /// try/catch in execute(), and EIP-150's 63/64 rule would then let anyone under-gas execute() so
    /// the inner settle dies OOG while the catch still runs — aborting a healthy auction.
    function lockedUntil(bytes32 h) external view returns (uint256) {
        Bid storage b = bids[h];
        if (b.deadline == 0 || b.settledHere) return 0;
        if (block.number >= b.deadline + GRACE) return 0; // exclusivity decayed
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
        require(IERC20(outToken).transferFrom(msg.sender, address(this), amount), "bid escrow failed");
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
        b.settledHere = true;                          // effect first

        uint256 balBefore = address(this).balance;
        uint256 inputClaimed;
        uint256 surplus = b.amount - minOut;
        if (b.outToken == address(0)) {
            ISettlement(SETTLEMENT).settle{value: minOut}(rawIntentTx);
            inputClaimed = address(this).balance - (balBefore - minOut);
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
            ISettlement(SETTLEMENT).settle(rawIntentTx);
            inputClaimed = address(this).balance - balBefore;
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
