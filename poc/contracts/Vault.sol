// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.19;

/**
 * BtcVault — the realistic destination for the demo's flagship intent: "my BTC, working in a Rootstock
 * vault, in one signature". Shares (bvBTC) are a minimal ERC-20 minted 1:1 against deposited RBTC
 * (an exchange rate would add maths, not insight). The solver acquires shares by depositing its own
 * RBTC, approves the settlement contract, and settle() delivers >= minOut shares to the user while the
 * solver claims the user's pegged-in RBTC — the user ends up IN the vault without ever holding RBTC
 * for gas.
 */
contract BtcVault {
    string public constant name = "BTC Vault Shares";
    string public constant symbol = "bvBTC";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;      // == totalAssets: shares are 1:1 with deposited RBTC
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(address indexed from, uint256 assets);
    event Withdraw(address indexed to, uint256 assets);

    /// Deposit RBTC, receive shares 1:1.
    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
        totalSupply += msg.value;
        emit Deposit(msg.sender, msg.value);
        emit Transfer(address(0), msg.sender, msg.value);
    }

    /// Burn shares, withdraw the underlying RBTC 1:1.
    function withdraw(uint256 shares) external {
        require(balanceOf[msg.sender] >= shares, "insufficient shares");
        balanceOf[msg.sender] -= shares;
        totalSupply -= shares;
        (bool ok, ) = payable(msg.sender).call{value: shares}("");
        require(ok, "withdraw failed");
        emit Withdraw(msg.sender, shares);
        emit Transfer(msg.sender, address(0), shares);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return _move(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= value, "insufficient allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - value;
        return _move(from, to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function _move(address from, address to, uint256 value) internal returns (bool) {
        require(balanceOf[from] >= value, "insufficient shares");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }
}
