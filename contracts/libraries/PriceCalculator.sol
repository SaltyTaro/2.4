// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

/**
 * @title PriceCalculator
 * @dev Library for calculating prices and profits for MEV strategies
 */
library PriceCalculator {
    /**
     * @dev Calculate the output amount for a swap given the input amount and reserves
     * @param amountIn Amount of tokens to swap
     * @param reserveIn Reserve of the input token
     * @param reserveOut Reserve of the output token
     * @return amountOut The output amount
     */
    function getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) internal pure returns (uint256 amountOut) {
        require(amountIn > 0, "PriceCalculator: INSUFFICIENT_INPUT_AMOUNT");
        require(reserveIn > 0 && reserveOut > 0, "PriceCalculator: INSUFFICIENT_LIQUIDITY");
        
        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = (reserveIn * 1000) + amountInWithFee;
        amountOut = numerator / denominator;
    }
    
    /**
     * @dev Calculate the input amount required for a given output amount
     * @param amountOut Desired amount of output tokens
     * @param reserveIn Reserve of the input token
     * @param reserveOut Reserve of the output token
     * @return amountIn The required input amount
     */
    function getAmountIn(
        uint256 amountOut,
        uint256 reserveIn,
        uint256 reserveOut
    ) internal pure returns (uint256 amountIn) {
        require(amountOut > 0, "PriceCalculator: INSUFFICIENT_OUTPUT_AMOUNT");
        require(reserveIn > 0 && reserveOut > 0, "PriceCalculator: INSUFFICIENT_LIQUIDITY");
        
        uint256 numerator = reserveIn * amountOut * 1000;
        uint256 denominator = (reserveOut - amountOut) * 997;
        amountIn = (numerator / denominator) + 1;
    }
    
    /**
     * @dev Calculate the expected profit from a sandwich attack
     * @param reserve0 Reserve of token0 in the pair
     * @param reserve1 Reserve of token1 in the pair
     * @param frontRunAmount Amount used for front-running
     * @param victimAmount Amount the victim is swapping
     * @param zeroForOne Whether the trade is from token0 to token1
     * @return profit The expected profit
     */
    function calculateSandwichProfit(
        uint256 reserve0,
        uint256 reserve1,
        uint256 frontRunAmount,
        uint256 victimAmount,
        bool zeroForOne
    ) internal pure returns (uint256 profit) {
        // 1. Calculate the state after front-run
        uint256 newReserve0;
        uint256 newReserve1;
        uint256 frontRunAmountOut;
        
        if (zeroForOne) {
            // Front-run token0 -> token1
            frontRunAmountOut = getAmountOut(frontRunAmount, reserve0, reserve1);
            newReserve0 = reserve0 + frontRunAmount;
            newReserve1 = reserve1 - frontRunAmountOut;
            
            // 2. Calculate the state after victim's transaction
            uint256 victimAmountOut = getAmountOut(victimAmount, newReserve0, newReserve1);
            newReserve0 = newReserve0 + victimAmount;
            newReserve1 = newReserve1 - victimAmountOut;
            
            // 3. Calculate the output amount for the back-run
            uint256 backRunAmountOut = getAmountOut(frontRunAmountOut, newReserve1, newReserve0);
            
            // 4. Calculate profit
            if (backRunAmountOut > frontRunAmount) {
                profit = backRunAmountOut - frontRunAmount;
            } else {
                profit = 0;
            }
        } else {
            // Front-run token1 -> token0
            frontRunAmountOut = getAmountOut(frontRunAmount, reserve1, reserve0);
            newReserve1 = reserve1 + frontRunAmount;
            newReserve0 = reserve0 - frontRunAmountOut;
            
            // 2. Calculate the state after victim's transaction
            uint256 victimAmountOut = getAmountOut(victimAmount, newReserve1, newReserve0);
            newReserve1 = newReserve1 + victimAmount;
            newReserve0 = newReserve0 - victimAmountOut;
            
            // 3. Calculate the output amount for the back-run
            uint256 backRunAmountOut = getAmountOut(frontRunAmountOut, newReserve0, newReserve1);
            
            // 4. Calculate profit
            if (backRunAmountOut > frontRunAmount) {
                profit = backRunAmountOut - frontRunAmount;
            } else {
                profit = 0;
            }
        }
    }
    
    /**
     * @dev Calculate the optimal amount for a sandwich attack front-run
     * @param reserve0 Reserve of token0 in the pair
     * @param reserve1 Reserve of token1 in the pair
     * @param victimAmount Amount the victim is swapping
     * @param zeroForOne Whether the trade is from token0 to token1
     * @param maxFrontRunAmount Maximum amount to use for front-running
     * @return optimalAmount The optimal amount for front-running
     */
    function calculateOptimalFrontRunAmount(
        uint256 reserve0,
        uint256 reserve1,
        uint256 victimAmount,
        bool zeroForOne,
        uint256 maxFrontRunAmount
    ) internal pure returns (uint256 optimalAmount) {
        // Binary search to find the optimal front-run amount
        uint256 left = 1;
        uint256 right = maxFrontRunAmount;
        uint256 bestProfit = 0;
        optimalAmount = 0;
        
        // Perform binary search with fixed number of iterations
        // In practice, more sophisticated methods would be used
        for (uint256 i = 0; i < 10; i++) {
            if (left >= right) break;
            
            uint256 mid = (left + right) / 2;
            uint256 profit = calculateSandwichProfit(reserve0, reserve1, mid, victimAmount, zeroForOne);
            
            if (profit > bestProfit) {
                bestProfit = profit;
                optimalAmount = mid;
                left = mid + 1;
            } else {
                right = mid;
            }
        }
    }
    
    /**
     * @dev Calculate the expected profit from an arbitrage between two pools
     * @param sourceReserveIn Reserve of input token in the source pool
     * @param sourceReserveOut Reserve of output token in the source pool
     * @param targetReserveIn Reserve of input token in the target pool
     * @param targetReserveOut Reserve of output token in the target pool
     * @param amount Amount to use for arbitrage
     * @return profit The expected profit
     */
    function calculateArbitrageProfit(
        uint256 sourceReserveIn,
        uint256 sourceReserveOut,
        uint256 targetReserveIn,
        uint256 targetReserveOut,
        uint256 amount
    ) internal pure returns (uint256 profit) {
        // Calculate output from first swap
        uint256 amountOut = getAmountOut(amount, sourceReserveIn, sourceReserveOut);
        
        // Calculate output from second swap (back to original token)
        uint256 finalAmount = getAmountOut(amountOut, targetReserveOut, targetReserveIn);
        
        // Calculate profit
        if (finalAmount > amount) {
            profit = finalAmount - amount;
        } else {
            profit = 0;
        }
    }
    
    /**
     * @dev Calculate the optimal amount for arbitrage between two pools
     * @param sourceReserveIn Reserve of input token in the source pool
     * @param sourceReserveOut Reserve of output token in the source pool
     * @param targetReserveIn Reserve of input token in the target pool
     * @param targetReserveOut Reserve of output token in the target pool
     * @param maxAmount Maximum amount to use for arbitrage
     * @return optimalAmount The optimal amount for arbitrage
     */
    function calculateOptimalArbitrageAmount(
        uint256 sourceReserveIn,
        uint256 sourceReserveOut,
        uint256 targetReserveIn,
        uint256 targetReserveOut,
        uint256 maxAmount
    ) internal pure returns (uint256 optimalAmount) {
        // Binary search for optimal amount
        uint256 left = 1;
        uint256 right = maxAmount;
        uint256 bestProfit = 0;
        optimalAmount = 0;
        
        for (uint256 i = 0; i < 10; i++) {
            if (left >= right) break;
            
            uint256 mid = (left + right) / 2;
            uint256 profit = calculateArbitrageProfit(
                sourceReserveIn,
                sourceReserveOut,
                targetReserveIn,
                targetReserveOut,
                mid
            );
            
            if (profit > bestProfit) {
                bestProfit = profit;
                optimalAmount = mid;
                left = mid + 1;
            } else {
                right = mid;
            }
        }
    }
    
    /**
     * @dev Calculate price impact of a swap
     * @param amountIn Amount to swap
     * @param reserveIn Reserve of input token
     * @param reserveOut Reserve of output token
     * @return priceImpact The price impact in basis points (1/100 of a percent)
     */
    function calculatePriceImpact(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) internal pure returns (uint256 priceImpact) {
        // Calculate expected output
        uint256 amountOut = getAmountOut(amountIn, reserveIn, reserveOut);
        
        // Calculate spot price
        uint256 spotPrice = (reserveOut * 1e18) / reserveIn;
        
        // Calculate execution price
        uint256 executionPrice = (amountOut * 1e18) / amountIn;
        
        // Calculate price impact in basis points
        if (spotPrice > executionPrice) {
            priceImpact = ((spotPrice - executionPrice) * 10000) / spotPrice;
        } else {
            priceImpact = 0;
        }
    }
}