// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.19;

/**
 * Test helper (E21): a contract caller whose ability to receive RBTC is TOGGLEABLE. While
 * `accept` is false it behaves like Griefer (payouts to it downgrade to credits); flipping
 * `accept` lets an experiment prove those credits are actually CLAIMABLE via withdraw(),
 * not merely recorded.
 */
contract Turncoat {
    bool public accept;

    receive() external payable {
        require(accept, "not accepting");
    }

    function setAccept(bool a) external {
        accept = a;
    }

    /// Generic passthrough: act as this contract when calling any function.
    function exec(address target, bytes calldata data) external payable {
        (bool ok,) = target.call{value: msg.value}(data);
        require(ok, "inner call failed");
    }

    /// Claim credits from any contract exposing withdraw().
    function doWithdraw(address target) external {
        (bool ok,) = target.call(abi.encodeWithSignature("withdraw()"));
        require(ok, "inner withdraw failed");
    }
}
