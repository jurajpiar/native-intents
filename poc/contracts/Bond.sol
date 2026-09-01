// SPDX-License-Identifier: LGPL-3.0
pragma solidity 0.8.19;

/**
 * Solver bond (productionization C). Off-consensus market structure: solvers stake a bond so they have
 * capital at risk; entry stays permissionless (anyone can bond). Slashable for provable misbehaviour by
 * an arbiter (here the deployer, for the PoC). The settlement path does not require a bond — bonding is
 * reputation/skin-in-the-game, not a consensus validity gate — so this contract is standalone.
 */
contract Bond {
    uint256 public constant MIN_BOND = 100_000_000_000_000_000; // 0.1 RBTC

    address public immutable arbiter;
    mapping(address => uint256) public bond;

    event Bonded(address indexed solver, uint256 total);
    event Slashed(address indexed solver, uint256 amount);
    event Withdrawn(address indexed solver, uint256 amount);

    constructor() {
        arbiter = msg.sender;
    }

    function bondUp() external payable {
        bond[msg.sender] += msg.value;
        emit Bonded(msg.sender, bond[msg.sender]);
    }

    function bonded(address solver) external view returns (bool) {
        return bond[solver] >= MIN_BOND;
    }

    /// Slash a misbehaving solver's bond (arbiter only). Slashed funds are burned to this contract.
    function slash(address solver, uint256 amount) external {
        require(msg.sender == arbiter, "not arbiter");
        uint256 b = bond[solver];
        uint256 slashAmount = amount > b ? b : amount;
        bond[solver] = b - slashAmount;
        emit Slashed(solver, slashAmount);
    }

    function withdraw(uint256 amount) external {
        require(bond[msg.sender] >= amount, "insufficient bond");
        bond[msg.sender] -= amount;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "withdraw failed");
        emit Withdrawn(msg.sender, amount);
    }
}
