// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import "../libraries/GasOptimizer.sol";

/**
 * @title GasOptimizerTest
 * @dev Test contract for the GasOptimizer library
 */
contract GasOptimizerTest {
    using GasOptimizer for uint256;
    
    /**
     * @dev Test function for estimateGasCost
     */
    function testEstimateGasCost(uint256 gasPrice, uint256 gasLimit) public pure returns (uint256) {
        return GasOptimizer.estimateGasCost(gasPrice, gasLimit);
    }
    
    /**
     * @dev Test function for calculateOptimalGasPrice
     */
    function testCalculateOptimalGasPrice(uint256 baseGasPrice, uint256 maxPriorityFee, uint256 targetPosition) public pure returns (uint256) {
        return GasOptimizer.calculateOptimalGasPrice(baseGasPrice, maxPriorityFee, targetPosition);
    }
    
    /**
     * @dev Test function for calculateSandwichGasPrices
     */
    function testCalculateSandwichGasPrices(uint256 baseGasPrice, uint256 frontRunPriorityFee, uint256 backRunPriorityFee) public pure returns (uint256 frontRunGasPrice, uint256 backRunGasPrice) {
        return GasOptimizer.calculateSandwichGasPrices(baseGasPrice, frontRunPriorityFee, backRunPriorityFee);
    }
    
    /**
     * @dev Test function for isProfitableAfterGas
     */
    function testIsProfitableAfterGas(uint256 expectedProfit, uint256 gasPrice, uint256 gasLimit, uint256 minProfitMargin) public pure returns (bool isProfitable, uint256 netProfit) {
        return GasOptimizer.isProfitableAfterGas(expectedProfit, gasPrice, gasLimit, minProfitMargin);
    }
    
    /**
     * @dev Test function for calculateEIP1559GasPrice
     */
    function testCalculateEIP1559GasPrice(uint256 baseFee, uint256 priorityFee) public pure returns (uint256 maxFeePerGas, uint256 maxPriorityFeePerGas) {
        return GasOptimizer.calculateEIP1559GasPrice(baseFee, priorityFee);
    }
    
    /**
     * @dev Test function for optimizeApprovalAmount
     */
    function testOptimizeApprovalAmount(uint256 currentAllowance, uint256 requiredAmount) public pure returns (uint256) {
        return GasOptimizer.optimizeApprovalAmount(currentAllowance, requiredAmount);
    }
}