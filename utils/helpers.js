/**
 * Helper functions for the MEV strategy project
 */
const { ethers } = require("hardhat");
const { BigNumber } = require("ethers");
const { TOKEN_ADDRESSES, DEX_ADDRESSES } = require("./constants");

/**
 * Gets token balances for a specific address
 * @param {string} address - The address to check balances for
 * @param {string[]} tokens - Array of token addresses to check
 * @returns {Promise<Object>} - Object mapping token addresses to balances
 */
async function getTokenBalances(address, tokens) {
  const balances = {};
  
  for (const token of tokens) {
    const tokenContract = await ethers.getContractAt("IERC20", token);
    const balance = await tokenContract.balanceOf(address);
    balances[token] = balance;
  }
  
  return balances;
}

/**
 * Gets the token symbol for a token address
 * @param {string} tokenAddress - The token address
 * @returns {Promise<string>} - The token symbol
 */
async function getTokenSymbol(tokenAddress) {
  try {
    const tokenContract = await ethers.getContractAt("IERC20", tokenAddress);
    return await tokenContract.symbol();
  } catch (error) {
    // If we can't get the symbol, return a shortened address
    return tokenAddress.slice(0, 6) + "..." + tokenAddress.slice(-4);
  }
}

/**
 * Gets the token decimals for a token address
 * @param {string} tokenAddress - The token address
 * @returns {Promise<number>} - The token decimals
 */
async function getTokenDecimals(tokenAddress) {
  try {
    const tokenContract = await ethers.getContractAt("IERC20", tokenAddress);
    return await tokenContract.decimals();
  } catch (error) {
    // Default to 18 decimals if we can't get the value
    return 18;
  }
}

/**
 * Formats a token amount with proper decimals
 * @param {BigNumber} amount - The token amount
 * @param {number} decimals - The token decimals
 * @returns {string} - Formatted token amount
 */
function formatTokenAmount(amount, decimals = 18) {
  return ethers.utils.formatUnits(amount, decimals);
}

/**
 * Gets the current price of ETH in USD using a Chainlink price feed
 * @returns {Promise<BigNumber>} - The ETH price in USD with 8 decimals
 */
async function getEthPrice() {
  // Chainlink ETH/USD price feed on mainnet
  const ETH_USD_FEED = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
  
  const priceFeed = await ethers.getContractAt("AggregatorV3Interface", ETH_USD_FEED);
  const { answer } = await priceFeed.latestRoundData();
  
  return answer;
}

/**
 * Finds potential sandwich attack opportunities
 * @param {string[]} pairs - Array of pair addresses to check
 * @param {string} factory - DEX factory address
 * @param {BigNumber} minVictimAmount - Minimum victim amount to consider
 * @param {BigNumber} maxFrontRunAmount - Maximum amount to use for front-running
 * @returns {Promise<Array>} - Array of potential sandwich opportunities
 */
async function getSandwichOpportunities(pairs, factory, minVictimAmount, maxFrontRunAmount) {
  const opportunities = [];
  
  for (const pairAddress of pairs) {
    const pair = await ethers.getContractAt("IUniswapV2Pair", pairAddress);
    const [reserve0, reserve1] = await pair.getReserves();
    const token0 = await pair.token0();
    const token1 = await pair.token1();
    
    // Skip pairs with low liquidity
    const MIN_LIQUIDITY = ethers.utils.parseEther("10"); // 10 ETH equivalent
    if (reserve0.lt(MIN_LIQUIDITY) || reserve1.lt(MIN_LIQUIDITY)) {
      continue;
    }
    
    // Determine if one of the tokens is a major token (ETH, stablecoins, etc.)
    const isMajorToken0 = isMainToken(token0);
    const isMajorToken1 = isMainToken(token1);
    
    // Skip pairs without major tokens
    if (!isMajorToken0 && !isMajorToken1) {
      continue;
    }
    
    // Determine input and output tokens for the sandwich
    const tokenIn = isMajorToken0 ? token0 : token1;
    const tokenOut = isMajorToken0 ? token1 : token0;
    const reserveIn = isMajorToken0 ? reserve0 : reserve1;
    const reserveOut = isMajorToken0 ? reserve1 : reserve0;
    
    // Simulate different victim amounts
    const victimAmounts = [
      ethers.utils.parseEther("1"),   // 1 ETH
      ethers.utils.parseEther("5"),   // 5 ETH
      ethers.utils.parseEther("10")   // 10 ETH
    ];
    
    for (const victimAmount of victimAmounts) {
      if (victimAmount.lt(minVictimAmount)) continue;
      
      // Calculate optimal front-run amount
      const frontRunAmount = calculateOptimalFrontRunAmount(
        reserveIn,
        reserveOut,
        victimAmount,
        maxFrontRunAmount
      );
      
      // Calculate expected profit
      const profit = calculateSandwichProfit(
        reserveIn,
        reserveOut,
        frontRunAmount,
        victimAmount
      );
      
      // If profitable, add to opportunities
      if (profit.gt(0)) {
        opportunities.push({
          pair: pairAddress,
          tokenIn,
          tokenOut,
          frontRunAmount,
          victimAmount,
          expectedProfit: profit
        });
      }
    }
  }
  
  // Sort by expected profit (descending)
  opportunities.sort((a, b) => {
    return b.expectedProfit.gt(a.expectedProfit) ? 1 : -1;
  });
  
  return opportunities;
}

/**
 * Calculates the optimal front-run amount for a sandwich attack
 * @param {BigNumber} reserveIn - Input token reserve
 * @param {BigNumber} reserveOut - Output token reserve
 * @param {BigNumber} victimAmount - Victim transaction amount
 * @param {BigNumber} maxAmount - Maximum amount to consider
 * @returns {BigNumber} - Optimal amount for front-running
 */
function calculateOptimalFrontRunAmount(reserveIn, reserveOut, victimAmount, maxAmount) {
  // For simplicity, we're using a heuristic based on victim amount
  // In a production system, this would be more sophisticated
  
  // Start with 100% of victim amount
  let optimalAmount = victimAmount;
  
  // Cap at maximum amount
  if (optimalAmount.gt(maxAmount)) {
    optimalAmount = maxAmount;
  }
  
  // Cap at 1% of reserves to avoid excessive price impact
  const maxReserveUsage = reserveIn.mul(1).div(100); // 1% of reserves
  if (optimalAmount.gt(maxReserveUsage)) {
    optimalAmount = maxReserveUsage;
  }
  
  return optimalAmount;
}

/**
 * Calculates the expected profit from a sandwich attack
 * This is a simplified calculation for illustration purposes
 * @param {BigNumber} reserveIn - Input token reserve
 * @param {BigNumber} reserveOut - Output token reserve
 * @param {BigNumber} frontRunAmount - Front-run amount
 * @param {BigNumber} victimAmount - Victim transaction amount
 * @returns {BigNumber} - Expected profit
 */
function calculateSandwichProfit(reserveIn, reserveOut, frontRunAmount, victimAmount) {
  // Step 1: Calculate output from front-run
  const amountInWithFee = frontRunAmount.mul(997);
  const numerator1 = amountInWithFee.mul(reserveOut);
  const denominator1 = reserveIn.mul(1000).add(amountInWithFee);
  const frontRunOut = numerator1.div(denominator1);
  
  // Step 2: Update reserves after front-run
  const newReserveIn = reserveIn.add(frontRunAmount);
  const newReserveOut = reserveOut.sub(frontRunOut);
  
  // Step 3: Calculate victim's output (not needed for profit calculation)
  
  // Step 4: Update reserves after victim's transaction
  const victimInWithFee = victimAmount.mul(997);
  const numerator2 = victimInWithFee.mul(newReserveOut);
  const denominator2 = newReserveIn.mul(1000).add(victimInWithFee);
  const victimOut = numerator2.div(denominator2);
  
  const finalReserveIn = newReserveIn.add(victimAmount);
  const finalReserveOut = newReserveOut.sub(victimOut);
  
  // Step 5: Calculate output from back-run
  const backRunInWithFee = frontRunOut.mul(997);
  const numerator3 = backRunInWithFee.mul(finalReserveIn);
  const denominator3 = finalReserveOut.mul(1000).add(backRunInWithFee);
  const backRunOut = numerator3.div(denominator3);
  
  // Calculate profit
  const profit = backRunOut.sub(frontRunAmount);
  
  // Return positive profit or zero
  return profit.gt(0) ? profit : BigNumber.from(0);
}

/**
 * Checks if a token is a main/major token (ETH, stablecoins, etc.)
 * @param {string} tokenAddress - Token address to check
 * @returns {boolean} - Whether it's a main token
 */
function isMainToken(tokenAddress) {
  const mainTokens = [
    TOKEN_ADDRESSES.WETH.toLowerCase(),
    TOKEN_ADDRESSES.USDC.toLowerCase(),
    TOKEN_ADDRESSES.USDT.toLowerCase(),
    TOKEN_ADDRESSES.DAI.toLowerCase(),
    TOKEN_ADDRESSES.WBTC.toLowerCase()
  ];
  
  return mainTokens.includes(tokenAddress.toLowerCase());
}

/**
 * Finds potential arbitrage opportunities between DEXes
 * @param {string[]} tokenPairs - Array of token pairs to check (e.g., [WETH, USDC])
 * @param {string[]} dexes - Array of DEX factory addresses to check
 * @param {BigNumber} minProfitThreshold - Minimum profit to consider
 * @returns {Promise<Array>} - Array of potential arbitrage opportunities
 */
async function getArbitrageOpportunities(tokenPairs, dexes, minProfitThreshold) {
  const opportunities = [];
  
  for (const pair of tokenPairs) {
    const [tokenA, tokenB] = pair;
    
    // Get all DEX pairs for this token combination
    const dexPairs = [];
    
    for (const dex of dexes) {
      const factory = await ethers.getContractAt("IUniswapV2Factory", dex);
      const pairAddress = await factory.getPair(tokenA, tokenB);
      
      // Skip if pair doesn't exist
      if (pairAddress === ethers.constants.AddressZero) {
        continue;
      }
      
      // Get pair contract and reserves
      const pairContract = await ethers.getContractAt("IUniswapV2Pair", pairAddress);
      const [reserve0, reserve1] = await pairContract.getReserves();
      const token0 = await pairContract.token0();
      
      // Store DEX info with reserves
      dexPairs.push({
        dex,
        pair: pairAddress,
        reserve0,
        reserve1,
        isToken0A: token0.toLowerCase() === tokenA.toLowerCase()
      });
    }
    
    // Need at least 2 DEXes for arbitrage
    if (dexPairs.length < 2) {
      continue;
    }
    
    // Check all DEX combinations for arbitrage
    for (let i = 0; i < dexPairs.length; i++) {
      for (let j = i + 1; j < dexPairs.length; j++) {
        const dex1 = dexPairs[i];
        const dex2 = dexPairs[j];
        
        // Calculate prices on both DEXes
        // Price = reserveOut/reserveIn (tokenB per tokenA)
        const price1 = dex1.isToken0A ? 
          dex1.reserve1.mul(ethers.utils.parseEther("1")).div(dex1.reserve0) : 
          dex1.reserve0.mul(ethers.utils.parseEther("1")).div(dex1.reserve1);
        
        const price2 = dex2.isToken0A ? 
          dex2.reserve1.mul(ethers.utils.parseEther("1")).div(dex2.reserve0) : 
          dex2.reserve0.mul(ethers.utils.parseEther("1")).div(dex2.reserve1);
        
        // Calculate price difference
        const priceDiff = price1.gt(price2) ? 
          price1.sub(price2) : price2.sub(price1);
        
        const priceDiffBps = priceDiff.mul(10000).div(
          price1.gt(price2) ? price1 : price2
        );
        
        // Skip if price difference is too small
        if (priceDiffBps.lt(10)) { // Less than 0.1%
          continue;
        }
        
        // Determine direction (buy on cheaper DEX, sell on more expensive)
        const buyOnDex1 = price2.gt(price1);
        
        // Calculate optimal arbitrage amount and expected profit
        const sourceReserveIn = buyOnDex1 ? 
          (dex1.isToken0A ? dex1.reserve0 : dex1.reserve1) : 
          (dex2.isToken0A ? dex2.reserve0 : dex2.reserve1);
        
        const sourceReserveOut = buyOnDex1 ? 
          (dex1.isToken0A ? dex1.reserve1 : dex1.reserve0) : 
          (dex2.isToken0A ? dex2.reserve1 : dex2.reserve0);
        
        const targetReserveIn = buyOnDex1 ? 
          (dex2.isToken0A ? dex2.reserve1 : dex2.reserve0) : 
          (dex1.isToken0A ? dex1.reserve1 : dex1.reserve0);
        
        const targetReserveOut = buyOnDex1 ? 
          (dex2.isToken0A ? dex2.reserve0 : dex2.reserve1) : 
          (dex1.isToken0A ? dex1.reserve0 : dex1.reserve1);
        
        // Test different amounts to find optimal
        const testAmounts = [
          ethers.utils.parseEther("1"),
          ethers.utils.parseEther("5"),
          ethers.utils.parseEther("10"),
          ethers.utils.parseEther("50"),
          ethers.utils.parseEther("100")
        ];
        
        let bestAmount = BigNumber.from(0);
        let bestProfit = BigNumber.from(0);
        
        for (const amount of testAmounts) {
          // Calculate first swap output
          const amountOut = calculateAmountOut(amount, sourceReserveIn, sourceReserveOut);
          
          // Calculate second swap output
          const finalAmount = calculateAmountOut(amountOut, targetReserveIn, targetReserveOut);
          
          // Calculate profit
          const profit = finalAmount.sub(amount);
          
          if (profit.gt(bestProfit)) {
            bestProfit = profit;
            bestAmount = amount;
          }
        }
        
        // If profitable above threshold, add to opportunities
        if (bestProfit.gt(minProfitThreshold)) {
          opportunities.push({
            tokenA,
            tokenB,
            sourceDex: buyOnDex1 ? dex1.dex : dex2.dex,
            targetDex: buyOnDex1 ? dex2.dex : dex1.dex,
            sourcePair: buyOnDex1 ? dex1.pair : dex2.pair,
            targetPair: buyOnDex1 ? dex2.pair : dex1.pair,
            amount: bestAmount,
            expectedProfit: bestProfit,
            profitBps: bestProfit.mul(10000).div(bestAmount)
          });
        }
      }
    }
  }
  
  // Sort by expected profit (descending)
  opportunities.sort((a, b) => {
    return b.expectedProfit.gt(a.expectedProfit) ? 1 : -1;
  });
  
  return opportunities;
}

/**
 * Calculates the output amount for a swap
 * @param {BigNumber} amountIn - Input amount
 * @param {BigNumber} reserveIn - Input token reserve
 * @param {BigNumber} reserveOut - Output token reserve
 * @returns {BigNumber} - Output amount
 */
function calculateAmountOut(amountIn, reserveIn, reserveOut) {
  const amountInWithFee = amountIn.mul(997);
  const numerator = amountInWithFee.mul(reserveOut);
  const denominator = reserveIn.mul(1000).add(amountInWithFee);
  return numerator.div(denominator);
}

module.exports = {
  getTokenBalances,
  getTokenSymbol,
  getTokenDecimals,
  formatTokenAmount,
  getEthPrice,
  getSandwichOpportunities,
  calculateOptimalFrontRunAmount,
  calculateSandwichProfit,
  isMainToken,
  getArbitrageOpportunities,
  calculateAmountOut
};