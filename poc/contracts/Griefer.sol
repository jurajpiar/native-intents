// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.19;

/**
 * E18 test helper: a bidder/payee that CANNOT receive native RBTC (no receive, no fallback).
 *
 * Pre-hardening, this contract weaponised two push-payments in Auction.sol:
 *  - winning an auction bricked the intent — every execute() reverted "winner pay failed";
 *  - merely being outbid blocked all higher bids — bid() reverted "outbid refund failed".
 * Post-hardening both payouts downgrade to pull-payment credits this contract can never claim,
 * so the loss is confined to the griefer itself. E18 asserts exactly that.
 */
contract Griefer {
    /// Place a bid on the auction, funded by msg.value.
    function doBid(address auctionAddr, bytes calldata rawIntentTx) external payable {
        (bool ok,) = auctionAddr.call{value: msg.value}(
            abi.encodeWithSignature("bid(bytes)", rawIntentTx)
        );
        require(ok, "inner bid failed");
    }

    /// Attempt to withdraw accrued credit. The auction's transfer back to this contract always
    /// reverts (no receive), so this demonstrates withdraw-failure isolation: only THIS call
    /// fails; the credit survives untouched.
    function doWithdraw(address auctionAddr) external {
        (bool ok,) = auctionAddr.call(abi.encodeWithSignature("withdraw()"));
        require(ok, "inner withdraw failed");
    }
}
