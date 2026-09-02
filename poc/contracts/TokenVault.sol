// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.19;

/**
 * Generic ERC-20 vault (playground): deposit any fixed asset (here: the pool's LP token), receive
 * shares 1:1. The terminal step of the compound intent — "swap, LP, then vault the LP" — must end in a
 * token for `minOut` to measure, and this is that token ("vLP"). Same minimal-ERC-20 pattern as BtcVault.
 */
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract TokenVault {
    string public constant name = "Vaulted LP Shares";
    string public constant symbol = "vLP";
    uint8 public constant decimals = 18;

    IERC20 public immutable asset;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(address indexed from, uint256 assets);
    event Withdraw(address indexed to, uint256 assets);

    constructor(address assetAddr) { asset = IERC20(assetAddr); }

    /// Pull `amount` of the asset, mint shares 1:1.
    function deposit(uint256 amount) external {
        require(asset.transferFrom(msg.sender, address(this), amount), "asset pull failed");
        balanceOf[msg.sender] += amount;
        totalSupply += amount;
        emit Deposit(msg.sender, amount);
        emit Transfer(address(0), msg.sender, amount);
    }

    /// Burn shares, return the asset 1:1.
    function withdraw(uint256 shares) external {
        require(balanceOf[msg.sender] >= shares, "insufficient shares");
        balanceOf[msg.sender] -= shares;
        totalSupply -= shares;
        require(asset.transfer(msg.sender, shares), "asset send failed");
        emit Withdraw(msg.sender, shares);
        emit Transfer(msg.sender, address(0), shares);
    }

    function transfer(address to, uint256 v) external returns (bool) { return _move(msg.sender, to, v); }
    function transferFrom(address from, address to, uint256 v) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= v, "insufficient allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - v;
        return _move(from, to, v);
    }
    function approve(address spender, uint256 v) external returns (bool) {
        allowance[msg.sender][spender] = v; emit Approval(msg.sender, spender, v); return true;
    }
    function _move(address from, address to, uint256 v) internal returns (bool) {
        require(balanceOf[from] >= v, "insufficient shares");
        balanceOf[from] -= v; balanceOf[to] += v; emit Transfer(from, to, v); return true;
    }
}
