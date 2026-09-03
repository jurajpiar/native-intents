// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.19;

/**
 * Red-team helper (attacks C5/C6): a contract whose `receive()` calls BACK into a target while the
 * first call is still on the stack.
 *
 * Two shapes are needed because the two reentrancy questions differ:
 *  - C5: reenter `settle` from the USER's receive() — the payee is the user, and the delivery push is
 *    what hands control back. A second intent is attempted mid-settle.
 *  - C6: reenter `withdraw()` from a credit payee's receive() — the classic ledger drain, which the
 *    effects-first ordering (zero the credit, then transfer) is supposed to make worthless.
 *
 * `armedData` is replayed on every inbound transfer until `maxDepth` is reached, so a single funding
 * push can drive several nested calls. Failures inside the callback are SWALLOWED and recorded rather
 * than bubbled: a reverting reentry must not mask itself as a failure of the outer call, which is the
 * distinction the attack is trying to observe.
 */
contract Reenterer {
    address public target;
    bytes public armedData;
    uint256 public armedValue;   // value the callback forwards (a nested settle needs its own minOut)
    uint256 public maxDepth;
    uint256 public depth;        // how many times receive() actually fired
    uint256 public reenters;     // how many callbacks were attempted
    uint256 public succeeded;    // how many of those returned ok
    bool public accept = true;   // false = reject inbound RBTC entirely (Griefer behaviour)
    bytes public lastError;      // revert payload of the most recent failed callback

    event Reentered(uint256 depth, bool ok, bytes ret);

    receive() external payable {
        require(accept, "not accepting");
        if (depth >= maxDepth || armedData.length == 0 || target == address(0)) return;
        depth += 1;
        reenters += 1;
        (bool ok, bytes memory ret) = target.call{value: armedValue}(armedData);
        if (ok) succeeded += 1; else lastError = ret;
        emit Reentered(depth, ok, ret);
    }

    function arm(address t, bytes calldata data, uint256 depthLimit, uint256 value) external {
        target = t;
        armedData = data;
        maxDepth = depthLimit;
        armedValue = value;
        depth = 0;
        reenters = 0;
        succeeded = 0;
        lastError = "";
    }

    function disarm() external {
        armedData = "";
        maxDepth = 0;
    }

    function setAccept(bool a) external {
        accept = a;
    }

    /// Call any function on any target as this contract (so it is the msg.sender the target sees).
    function exec(address t, bytes calldata data) external payable {
        (bool ok, bytes memory ret) = t.call{value: msg.value}(data);
        if (!ok) {
            // bubble the reason so the harness can decode it
            assembly { revert(add(ret, 0x20), mload(ret)) }
        }
    }

    /// Drain whatever the contract collected, so an attack can report what it actually took.
    function sweep(address to) external {
        (bool ok,) = payable(to).call{value: address(this).balance}("");
        require(ok, "sweep failed");
    }
}
