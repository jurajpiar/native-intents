// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.19;

/**
 * Minimal constant-product AMM for native RBTC / one ERC-20 (playground infrastructure for compound
 * intents: swap -> addLiquidity -> LP tokens). The LP position is itself an ERC-20 ("LPT"), so it can be
 * vaulted, auctioned, and delivered by settlement like any other output asset. No fees, no oracles, no
 * slippage guards beyond the caller's own maths — a venue for the PoC's solvers, not a production DEX.
 */
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract Pool {
    string public constant name = "RBTC-TOK LP";
    string public constant symbol = "LPT";
    uint8 public constant decimals = 18;

    IERC20 public immutable tok;
    uint256 public reserveRbtc;
    uint256 public reserveTok;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event LiquidityAdded(address indexed provider, uint256 rbtc, uint256 tokAmount, uint256 lp);
    event LiquidityRemoved(address indexed provider, uint256 rbtc, uint256 tokAmount, uint256 lp);
    event Swap(address indexed trader, bool rbtcIn, uint256 amountIn, uint256 amountOut);

    constructor(address tokAddr) { tok = IERC20(tokAddr); }

    // --- LP token (minimal ERC-20) ---
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
        require(balanceOf[from] >= v, "insufficient LP");
        balanceOf[from] -= v; balanceOf[to] += v; emit Transfer(from, to, v); return true;
    }
    function _mint(address to, uint256 v) internal { balanceOf[to] += v; totalSupply += v; emit Transfer(address(0), to, v); }
    function _burn(address from, uint256 v) internal { balanceOf[from] -= v; totalSupply -= v; emit Transfer(from, address(0), v); }

    // --- AMM ---
    /// Provide msg.value RBTC + tokAmount TOK (must match the reserve ratio within 1%); mints LP.
    function addLiquidity(uint256 tokAmount) external payable returns (uint256 lp) {
        require(msg.value > 0 && tokAmount > 0, "zero amounts");
        if (totalSupply == 0) {
            lp = _sqrt(msg.value * tokAmount);
        } else {
            uint256 expectedTok = (msg.value * reserveTok) / reserveRbtc;
            require(tokAmount >= (expectedTok * 99) / 100 && tokAmount <= (expectedTok * 101) / 100, "ratio off");
            lp = (msg.value * totalSupply) / reserveRbtc;
        }
        require(tok.transferFrom(msg.sender, address(this), tokAmount), "tok pull failed");
        reserveRbtc += msg.value;
        reserveTok += tokAmount;
        _mint(msg.sender, lp);
        emit LiquidityAdded(msg.sender, msg.value, tokAmount, lp);
    }

    /// Burn LP for the proportional share of both reserves.
    function removeLiquidity(uint256 lp) external returns (uint256 rbtcOut, uint256 tokOut) {
        require(balanceOf[msg.sender] >= lp && lp > 0, "insufficient LP");
        rbtcOut = (lp * reserveRbtc) / totalSupply;
        tokOut = (lp * reserveTok) / totalSupply;
        _burn(msg.sender, lp);
        reserveRbtc -= rbtcOut;
        reserveTok -= tokOut;
        require(tok.transfer(msg.sender, tokOut), "tok send failed");
        (bool ok,) = payable(msg.sender).call{value: rbtcOut}("");
        require(ok, "rbtc send failed");
        emit LiquidityRemoved(msg.sender, rbtcOut, tokOut, lp);
    }

    /// Swap msg.value RBTC for TOK at x*y=k (no fee).
    function swapRbtcForTok() external payable returns (uint256 out) {
        require(msg.value > 0 && reserveRbtc > 0, "bad swap");
        out = (reserveTok * msg.value) / (reserveRbtc + msg.value);
        reserveRbtc += msg.value;
        reserveTok -= out;
        require(tok.transfer(msg.sender, out), "tok send failed");
        emit Swap(msg.sender, true, msg.value, out);
    }

    /// Swap TOK for RBTC at x*y=k (no fee).
    function swapTokForRbtc(uint256 amountIn) external returns (uint256 out) {
        require(amountIn > 0 && reserveTok > 0, "bad swap");
        out = (reserveRbtc * amountIn) / (reserveTok + amountIn);
        require(tok.transferFrom(msg.sender, address(this), amountIn), "tok pull failed");
        reserveTok += amountIn;
        reserveRbtc -= out;
        (bool ok,) = payable(msg.sender).call{value: out}("");
        require(ok, "rbtc send failed");
        emit Swap(msg.sender, false, amountIn, out);
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        uint256 z = (x + 1) / 2; y = x;
        while (z < y) { y = z; z = (x / z + z) / 2; }
    }
}
