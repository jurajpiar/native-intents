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
}

contract Settlement {
    // parse precompile (IntentRegistryContract), returns abi(sender,H,btcTxid,expiry,minOut,outputToken)
    address constant PARSE = 0x0000000000000000000000000000000001000020;

    event Settled(bytes32 indexed h, address indexed user, address outputToken, uint256 minOut);

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
        (address user, bytes32 H, , uint256 expiry, uint256 minOut, address outToken) =
            abi.decode(ret, (address, bytes32, bytes32, uint256, uint256, address));

        require(user != address(0), "bad intent");
        require(block.number < expiry, "expired");
        uint256 consumed;
        assembly { consumed := sload(H) }
        require(consumed == 0, "H already consumed");

        if (outToken == address(0)) {
            require(msg.value >= minOut, "under minOut");
            (bool d,) = payable(user).call{value: minOut}("");
            require(d, "deliver failed");
            uint256 excess = msg.value - minOut;
            if (excess > 0) {
                (bool r,) = payable(msg.sender).call{value: excess}("");
                require(r, "refund failed");
            }
        } else {
            require(msg.value == 0, "no rbtc for token intent");
            require(IERC20(outToken).transferFrom(msg.sender, user, minOut), "erc20 transfer failed");
        }

        assembly { sstore(H, add(number(), 1)) } // record consumed (height+1, non-zero marker)
        emit Settled(H, user, outToken, minOut);
    }
}
