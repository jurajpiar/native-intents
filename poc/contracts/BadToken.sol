// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.19;

/**
 * Red-team helper (attack C7): an ERC-20 that misbehaves in the three ways settlement's output path
 * could be fooled by, each switchable at runtime:
 *
 *  - FEE_ON_TRANSFER: `transferFrom` moves LESS than the requested amount (a fee is skimmed). The
 *    question: does settle credit the user with what ARRIVED, or with what it ASKED for? The PoC
 *    checks the transferFrom return value, not a balance delta, so a fee-on-transfer output token
 *    short-changes the user by design — this is the documented modelling choice, made visible.
 *  - LIAR: `transferFrom` moves nothing and returns true. The worst case: a token can claim success
 *    while delivering zero.
 *  - NO_RETURN: `transferFrom` returns no data at all (the pre-EIP-20 style many real tokens use).
 *    Solidity decodes a missing bool as a revert, so this asks whether such tokens are simply
 *    unusable as outputs.
 */
contract BadToken {
    string public constant name = "BadToken";
    string public constant symbol = "BAD";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    enum Mode { HONEST, FEE_ON_TRANSFER, LIAR, NO_RETURN }
    Mode public mode = Mode.HONEST;
    uint256 public feeBps = 1000; // 10% skim in FEE_ON_TRANSFER

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function setMode(Mode m) external { mode = m; }
    function setFeeBps(uint256 b) external { feeBps = b; }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;

        if (mode == Mode.LIAR) return true;                       // moves nothing, claims success
        if (mode == Mode.FEE_ON_TRANSFER) {
            uint256 fee = (amount * feeBps) / 10_000;
            _move(from, to, amount - fee);
            _move(from, address(this), fee);
            return true;
        }
        _move(from, to, amount);
        if (mode == Mode.NO_RETURN) {
            // return NOTHING: the caller's abi.decode(..., (bool)) has no data to decode
            assembly { return(0, 0) }
        }
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
