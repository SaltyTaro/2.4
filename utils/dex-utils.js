/**
 * Utility functions for interacting with DEXes (Uniswap, Sushiswap, etc.)
 */
const { ethers } = require("hardhat");
const { BigNumber } = require("ethers");
const { TOKEN_ADDRESSES, DEX_ADDRESSES } = require("./constants");

/**
 * Gets the reserves for a token pair from a DEX
 * @param {string} tokenA - First token address
 * @param {string} tokenB - Second token address
 * @param {Object} provider - Ethers provider
 * @param {string} factoryAddress - DEX factory address (optional, defaults to Uniswap V2)
 * @returns {Promise<Object>} - Reserves and pair information
 */
async function getReserves(tokenA, tokenB, provider, factoryAddress = DEX_ADDRESSES.UNISWAP_V2_FACTORY) {
  try {
    // Create factory contract instance
    const factory = new ethers.Contract(
      factoryAddress,
      ['function getPair(address, address) view returns (address)'],
      provider
    );
    
    // Get pair address
    const pairAddress = await factory.getPair(tokenA, tokenB);
    
    // If pair doesn't exist, return null
    if (pairAddress === ethers.constants.AddressZero) {
      return null;
    }
    
    // Create pair contract instance
    const pair = new ethers.Contract(
      pairAddress,
      [
        'function getReserves() view returns (uint112, uint112, uint32)',
        'function token0() view returns (address)',
        'function token1() view returns (address)'
      ],
      provider
    );
    
    // Get reserves and tokens
    const [reserve0, reserve1] = await pair.getReserves();
    const token0 = await pair.token0();
    const token1 = await pair.token1();
    
    // Determine which reserve corresponds to which token
    const isToken0A = token0.toLowerCase() === tokenA.toLowerCase();
    
    return {
      pairAddress,
      reserveA: isToken0A ? reserve0 : reserve1,
      reserveB: isToken0A ? reserve1 : reserve0,
      token0,
      token1
    };
  } catch (error) {
    console.error(`Error getting reserves for ${tokenA}-${tokenB}:`, error);
    return null;
  }
}

/**
 * Calculates the output amount for a swap
 * @param {BigNumber} amountIn - Input amount
 * @param {BigNumber} reserveIn - Input token reserve
 * @param {BigNumber} reserveOut - Output token reserve
 * @returns {BigNumber} - Output amount
 */
function getAmountOut(amountIn, reserveIn, reserveOut) {
  if (amountIn.isZero() || reserveIn.isZero() || reserveOut.isZero()) {
    return BigNumber.from(0);
  }
  
  const amountInWithFee = amountIn.mul(997);
  const numerator = amountInWithFee.mul(reserveOut);
  const denominator = reserveIn.mul(1000).add(amountInWithFee);
  return numerator.div(denominator);
}

/**
 * Calculates the input amount required for a desired output
 * @param {BigNumber} amountOut - Desired output amount
 * @param {BigNumber} reserveIn - Input token reserve
 * @param {BigNumber} reserveOut - Output token reserve
 * @returns {BigNumber} - Required input amount
 */
function getAmountIn(amountOut, reserveIn, reserveOut) {
  if (amountOut.isZero() || reserveIn.isZero() || reserveOut.isZero() || amountOut.gte(reserveOut)) {
    return BigNumber.from(0);
  }
  
  const numerator = reserveIn.mul(amountOut).mul(1000);
  const denominator = reserveOut.sub(amountOut).mul(997);
  // Add 1 to round up
  return numerator.div(denominator).add(1);
}

/**
 * Calculates the optimal amount for a sandwich attack front-run
 * @param {BigNumber} reserveIn - Input token reserve
 * @param {BigNumber} reserveOut - Output token reserve
 * @param {BigNumber} victimAmount - Victim swap amount
 * @param {BigNumber} maxPoolUsageBps - Maximum percentage of pool reserves to use (basis points)
 * @returns {BigNumber} - Optimal front-run amount
 */
function calculateOptimalFrontRunAmount(reserveIn, reserveOut, victimAmount, maxPoolUsageBps = 100) {
  // Start with a percentage of victim amount
  let optimalAmount = victimAmount.mul(150).div(100); // 150% of victim amount
  
  // Limit by maximum pool usage
  const maxAmount = reserveIn.mul(maxPoolUsageBps).div(10000); // e.g., 1% of reserves
  if (optimalAmount.gt(maxAmount)) {
    optimalAmount = maxAmount;
  }
  
  return optimalAmount;
}

/**
 * Simulates a sandwich attack to calculate potential profit
 * @param {BigNumber} frontRunAmount - Amount for front-running
 * @param {BigNumber} victimAmount - Victim swap amount
 * @param {BigNumber} reserveIn - Input token reserve
 * @param {BigNumber} reserveOut - Output token reserve
 * @returns {Object} - Simulation results
 */
function simulateSandwich(frontRunAmount, victimAmount, reserveIn, reserveOut) {
  // Front-run: Calculate expected output from front-run
  const frontRunOut = getAmountOut(frontRunAmount, reserveIn, reserveOut);
  
  // Update reserves after front-run
  const reserveInAfterFrontRun = reserveIn.add(frontRunAmount);
  const reserveOutAfterFrontRun = reserveOut.sub(frontRunOut);
  
  // Victim swap: Calculate expected output for victim after front-run
  const victimOut = getAmountOut(victimAmount, reserveInAfterFrontRun, reserveOutAfterFrontRun);
  
  // Update reserves after victim swap
  const reserveInAfterVictim = reserveInAfterFrontRun.add(victimAmount);
  const reserveOutAfterVictim = reserveOutAfterFrontRun.sub(victimOut);
  
  // Back-run: Calculate expected output from back-run
  const backRunOut = getAmountOut(frontRunOut, reserveOutAfterVictim, reserveInAfterVictim);
  
  // Calculate profit
  const profit = backRunOut.sub(frontRunAmount);
  
  return {
    frontRunOut,
    victimOut,
    backRunOut,
    profit,
    isProfitable: profit.gt(0)
  };
}

module.exports = {
  getReserves,
  getAmountOut,
  getAmountIn,
  calculateOptimalFrontRunAmount,
  simulateSandwich
};