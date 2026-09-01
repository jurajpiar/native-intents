// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.19;

/**
 * Above-minOut auction (productionization C refinement). Solvers compete to deliver MORE than the
 * intent's minOut: bids escrow RBTC, the first bid opens a WINDOW-block bidding window, and after it
 * closes anyone may execute() — which settles the intent, pays the user minOut PLUS the winning
 * surplus, and forwards the claimed input to the winning bidder.
 *
 * Two deployment modes, one contract:
 *  - SDK-deployed (any address): pure off-consensus market structure. The base first-valid-inclusion
 *    rule still stands, so a solver can BYPASS the auction and settle directly at minOut (E17 shows
 *    this honestly; outbid/stranded bidders reclaim their escrow).
 *  - Genesis-deployed at the fixed address 0x..01000022: Settlement enforces the auction — once a bid
 *    opens an auction for H, settle() rejects callers other than this contract until the auction is
 *    executed or reclaimed (not merely until the deadline: that would let a bypasser front-run the
 *    permissionless execute() the moment bidding closes). This closes the bypass (E17b). Enforcement
 *    engages only once someone bids, so bid-free intents settle exactly as before. Griefing bound: a
 *    lock requires a bid > minOut held in escrow, so the user always nets at least their ask + 1 wei.
 *    No constructor (genesis injects runtime code only) — everything is constants.
 *
 * PoC scope: RBTC-output intents only (token bids would add escrow-of-ERC20 complexity that teaches
 * nothing new about the mechanism).
 */
interface ISettlement {
    function isConsumed(bytes32 h) external view returns (bool);
    function settle(bytes calldata rawIntentTx) external payable;
}

contract Auction {
    // parse precompile, returns abi(sender,H,btcTxid,expiry,minOut,outputToken) for a raw intent tx
    address constant PARSE = 0x0000000000000000000000000000000001000020;
    address constant SETTLEMENT = 0x0000000000000000000000000000000001000021;
    uint256 public constant WINDOW = 10; // blocks of bidding after the first bid

    struct Bid {
        address bidder;    // current best bidder
        uint256 amount;    // current best bid (> minOut)
        uint256 deadline;  // bidding closes at this block (set by the first bid)
        uint256 expiry;    // the intent's expiry (cached so reclaim works without the raw tx)
        bool settledHere;  // execute()/reclaim() ran — escrow accounted for
    }
    mapping(bytes32 => Bid) public bids;

    event BidPlaced(bytes32 indexed h, address indexed bidder, uint256 amount, uint256 deadline);
    event Executed(bytes32 indexed h, address indexed winner, uint256 paidToUser, uint256 inputToWinner);
    event Reclaimed(bytes32 indexed h, address indexed bidder, uint256 amount);

    /// Settlement releases the claimed input to its caller with a plain transfer — this contract must be
    /// able to receive it or execute() reverts with "input claim failed". An open receive is harmless:
    /// inputClaimed is measured as the balance DELTA across the settle call, so RBTC sent here at any
    /// other time is never attributed to a winner (it is simply stranded, as in any PoC contract).
    receive() external payable {}

    /// Nonzero (the bidding deadline) while an auction for H is open — i.e. bid upon and not yet
    /// executed/reclaimed. Settlement (genesis deployment only) consults this and, while nonzero,
    /// rejects settle() from anyone but this contract; 0 means no lock.
    function lockedUntil(bytes32 h) external view returns (uint256) {
        Bid storage b = bids[h];
        if (b.deadline == 0 || b.settledHere) return 0;
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

    /// Bid to deliver msg.value (> minOut, > current best) for the intent. Refunds the outbid bidder.
    function bid(bytes calldata rawIntentTx) external payable {
        (, bytes32 H, uint256 expiry, uint256 minOut, address outToken) = parse(rawIntentTx);
        require(outToken == address(0), "rbtc outputs only");
        require(!ISettlement(SETTLEMENT).isConsumed(H), "already settled");
        require(block.number < expiry, "intent expired");

        Bid storage b = bids[H];
        require(!b.settledHere, "auction closed");
        if (b.deadline == 0) {
            require(block.number + WINDOW < expiry, "window would outlive intent");
            b.deadline = block.number + WINDOW;
            b.expiry = expiry;
        } else {
            require(block.number < b.deadline, "bidding closed");
        }
        require(msg.value > minOut && msg.value > b.amount, "bid too low");

        address prevBidder = b.bidder;
        uint256 prevAmount = b.amount;
        b.bidder = msg.sender;
        b.amount = msg.value;                          // effects before the refund interaction
        if (prevBidder != address(0)) {
            (bool r,) = payable(prevBidder).call{value: prevAmount}("");
            require(r, "outbid refund failed");
        }
        emit BidPlaced(H, msg.sender, msg.value, b.deadline);
    }

    /// After the window closes, settle with the winning bid: user gets minOut (via settle) + the
    /// surplus (best - minOut); the winning bidder gets the input settle releases. Permissionless.
    function execute(bytes calldata rawIntentTx) external {
        (address user, bytes32 H,, uint256 minOut,) = parse(rawIntentTx);
        Bid storage b = bids[H];
        require(b.deadline != 0 && !b.settledHere, "no open auction");
        require(block.number >= b.deadline, "bidding still open");
        b.settledHere = true;                          // effect first

        uint256 balBefore = address(this).balance;
        ISettlement(SETTLEMENT).settle{value: minOut}(rawIntentTx);
        uint256 inputClaimed = address(this).balance - (balBefore - minOut);

        uint256 surplus = b.amount - minOut;
        if (surplus > 0) {
            (bool s,) = payable(user).call{value: surplus}("");
            require(s, "surplus pay failed");
        }
        if (inputClaimed > 0) {
            (bool w,) = payable(b.bidder).call{value: inputClaimed}("");
            require(w, "winner pay failed");
        }
        emit Executed(H, b.bidder, minOut + surplus, inputClaimed);
    }

    /// Escrow recovery when the auction can never execute: the intent was settled directly by a
    /// bypassing solver (H consumed), or it expired unexecuted. Returns the best bid to its bidder.
    function reclaim(bytes32 h) external {
        Bid storage b = bids[h];
        require(b.deadline != 0 && !b.settledHere && b.bidder != address(0), "nothing to reclaim");
        require(ISettlement(SETTLEMENT).isConsumed(h) || block.number >= b.expiry, "auction still live");
        b.settledHere = true;                          // effect first
        (bool r,) = payable(b.bidder).call{value: b.amount}("");
        require(r, "reclaim failed");
        emit Reclaimed(h, b.bidder, b.amount);
    }
}
