// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import "../interfaces/IERC20.sol";
import "../MevStrategy.sol";

/**
 * @title MaliciousReceiver
 * @dev Mock malicious contract that attempts reentrancy attacks
 */
contract MaliciousReceiver {
    MevStrategy public targetContract;
    bool public attacking;
    
    /**
     * @dev Constructor that sets the target contract
     */
    constructor(address _targetContract) {
        targetContract = MevStrategy(payable(_targetContract));
    }
    
    /**
     * @dev Function to start an attack
     */
    function attack(address token, uint256 amount) external {
        // First get some tokens from the caller
        IERC20(token).transferFrom(msg.sender, address(this), amount);
        
        // Approve the target contract to spend tokens
        IERC20(token).approve(address(targetContract), amount);
        
        // Start attack
        attacking = true;
        
        // Call a function that should be protected
        targetContract.withdrawProfit(token, amount, address(this));
    }
    
    /**
     * @dev Fallback function to perform reentrancy attack
     */
    receive() external payable {
        if (attacking) {
            // Try to call the protected function again
            address token = address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2); // WETH
            try targetContract.withdrawProfit(token, 1, address(this)) {
                // Attack succeeded
            } catch {
                // Attack failed
                attacking = false;
            }
        }
    }
    
    /**
     * @dev Function to handle ERC20 token transfers
     */
    function onERC20Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (attacking) {
            // Try to call the protected function again
            address token = address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2); // WETH
            try targetContract.withdrawProfit(token, 1, address(this)) {
                // Attack succeeded
            } catch {
                // Attack failed
                attacking = false;
            }
        }
        return this.onERC20Received.selector;
    }
}