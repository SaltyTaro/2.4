// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

/**
 * @title GasOptimizer
 * @dev Library for gas optimization strategies and calculations
 */
library GasOptimizer {
    /**
     * @dev Calculate the gas cost of a transaction
     * @param gasPrice Gas price in wei
     * @param gasLimit Gas limit for the transaction
     * @return gasCost The estimated gas cost in wei
     */
    function estimateGasCost(
        uint256 gasPrice,
        uint256 gasLimit
    ) internal pure returns (uint256 gasCost) {
        return gasPrice * gasLimit;
    }
    
    /**
     * @dev Calculate the optimal gas price based on block conditions
     * @param baseGasPrice Current base gas price
     * @param maxPriorityFee Maximum priority fee to consider
     * @param targetPosition Target position in the block (0 = first)
     * @return optimalGasPrice The optimal gas price to use
     */
    function calculateOptimalGasPrice(
        uint256 baseGasPrice,
        uint256 maxPriorityFee,
        uint256 targetPosition
    ) internal pure returns (uint256 optimalGasPrice) {
        // Simple model: increase gas price based on desired position
        // In practice, a more sophisticated model would be used
        uint256 priorityFee;
        
        if (targetPosition == 0) {
            // Want to be first, use max priority fee
            priorityFee = maxPriorityFee;
        } else if (targetPosition < 5) {
            // Want to be in top 5, use 75% of max
            priorityFee = (maxPriorityFee * 75) / 100;
        } else {
            // Lower position, use 50% of max
            priorityFee = (maxPriorityFee * 50) / 100;
        }
        
        return baseGasPrice + priorityFee;
    }
    
    /**
     * @dev Calculate the optimal gas price for a sandwich attack
     * @param baseGasPrice Current base gas price
     * @param frontRunPriorityFee Priority fee for the front-run transaction
     * @param backRunPriorityFee Priority fee for the back-run transaction
     * @return frontRunGasPrice Optimal gas price for the front-run
     * @return backRunGasPrice Optimal gas price for the back-run
     */
    function calculateSandwichGasPrices(
        uint256 baseGasPrice,
        uint256 frontRunPriorityFee,
        uint256 backRunPriorityFee
    ) internal pure returns (
        uint256 frontRunGasPrice,
        uint256 backRunGasPrice
    ) {
        // Front-run should be higher than victim's transaction
        frontRunGasPrice = baseGasPrice + frontRunPriorityFee;
        
        // Back-run should be lower than front-run but still high enough
        backRunGasPrice = baseGasPrice + backRunPriorityFee;
        
        return (frontRunGasPrice, backRunGasPrice);
    }
    
    /**
     * @dev Calculate if a MEV opportunity is profitable after gas costs
     * @param expectedProfit Expected profit from the MEV operation
     * @param gasPrice Gas price in wei
     * @param gasLimit Gas limit for the transaction
     * @param minProfitMargin Minimum profit margin in basis points (e.g., 50 = 0.5%)
     * @return isProfitable Whether the opportunity is profitable
     * @return netProfit The expected net profit after gas costs
     */
    function isProfitableAfterGas(
        uint256 expectedProfit,
        uint256 gasPrice,
        uint256 gasLimit,
        uint256 minProfitMargin
    ) internal pure returns (
        bool isProfitable,
        uint256 netProfit
    ) {
        uint256 gasCost = estimateGasCost(gasPrice, gasLimit);
        
        if (expectedProfit > gasCost) {
            netProfit = expectedProfit - gasCost;
            
            // Check if profit margin is sufficient
            uint256 profitMargin = (netProfit * 10000) / (gasCost + netProfit);
            isProfitable = profitMargin >= minProfitMargin;
        } else {
            isProfitable = false;
            netProfit = 0;
        }
    }
    
    /**
     * @dev Calculate the EIP-1559 gas price components
     * @param baseFee Current base fee
     * @param priorityFee Desired priority fee
     * @return maxFeePerGas Maximum fee per gas
     * @return maxPriorityFeePerGas Maximum priority fee per gas
     */
    function calculateEIP1559GasPrice(
        uint256 baseFee,
        uint256 priorityFee
    ) internal pure returns (
        uint256 maxFeePerGas,
        uint256 maxPriorityFeePerGas
    ) {
        // Add a buffer to the base fee to account for potential increases
        uint256 baseFeeBump = (baseFee * 125) / 100; // 25% buffer
        
        maxPriorityFeePerGas = priorityFee;
        maxFeePerGas = baseFeeBump + priorityFee;
    }
    
    /**
     * @dev Optimize gas usage for token approvals
     * @param currentAllowance Current allowance
     * @param requiredAmount Amount required for the transaction
     * @return approvalAmount The optimal approval amount
     */
    function optimizeApprovalAmount(
        uint256 currentAllowance,
        uint256 requiredAmount
    ) internal pure returns (uint256 approvalAmount) {
        if (currentAllowance >= requiredAmount) {
            // No need for approval, save gas
            return 0;
        } else if (currentAllowance > 0) {
            // Existing allowance but not enough
            return requiredAmount - currentAllowance;
        } else {
            // No existing allowance
            // Approve a larger amount to save gas on future transactions
            return requiredAmount * 2;
        }
    }
}