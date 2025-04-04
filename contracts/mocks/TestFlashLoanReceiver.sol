// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import "../FlashLoanReceiver.sol";

/**
 * @title TestFlashLoanReceiver
 * @dev Test implementation of FlashLoanReceiver that simulates unprofitable operations
 */
contract TestFlashLoanReceiver is FlashLoanReceiver {
    bool public shouldBeUnprofitable;
    
    /**
     * @dev Constructor that inherits from FlashLoanReceiver
     */
    constructor(
        address _owner,
        address _uniswapRouter,
        address _targetPair,
        address _tokenIn,
        address _tokenOut,
        uint256 _victimAmount,
        uint256 _victimMinOut
    ) FlashLoanReceiver(
        _owner,
        _uniswapRouter,
        _targetPair,
        _tokenIn,
        _tokenOut,
        _victimAmount,
        _victimMinOut
    ) {
        shouldBeUnprofitable = true;
    }
    
    /**
     * @dev Override executeSandwich to simulate unprofitable scenario
     */
    function executeSandwich(
        address token,
        uint256 amount,
        uint256 premium
    ) internal override {
        if (shouldBeUnprofitable) {
            // Revert with unprofitable message to simulate unprofitable sandwich
            revert("Unprofitable sandwich");
        } else {
            // Call the original implementation
            super.executeSandwich(token, amount, premium);
        }
    }
    
    /**
     * @dev Set whether operations should be profitable
     */
    function setShouldBeUnprofitable(bool _shouldBeUnprofitable) external {
        shouldBeUnprofitable = _shouldBeUnprofitable;
    }
}