/**
 * Gas price management utilities for optimizing MEV strategy gas usage
 */
const { ethers } = require("hardhat");
const { BigNumber } = require("ethers");
const { GAS_SETTINGS } = require("./constants");

/**
 * Gets the current gas price information
 * @returns {Promise<Object>} - Gas price information
 */
async function getGasPrice() {
  // Get current base fee from latest block
  const latestBlock = await ethers.provider.getBlock("latest");
  const baseFee = latestBlock.baseFeePerGas || 
                  await ethers.provider.getGasPrice();
  
  // Calculate a reasonable priority fee
  // We check recent blocks to determine a competitive priority fee
  const priorityFee = await calculatePriorityFee();
  
  // Calculate total gas price (base fee + priority fee)
  const gasPrice = baseFee.add(priorityFee);
  
  return {
    baseFee,
    priorityFee,
    gasPrice
  };
}

/**
 * Calculates an appropriate priority fee based on network conditions
 * @returns {Promise<BigNumber>} - Recommended priority fee in wei
 */
async function calculatePriorityFee() {
  try {
    // For EIP-1559 compatible networks, check maxPriorityFeePerGas
    const feeHistory = await ethers.provider.getFeeHistory(
      5, // Number of blocks to look back
      "latest",
      [20, 50, 80] // Percentiles to sample
    );
    
    if (feeHistory && feeHistory.reward && feeHistory.reward.length > 0) {
      // Use the 50th percentile (median) priority fee from recent blocks
      const medianPriorityFees = feeHistory.reward.map(rewards => rewards[1]);
      const sumPriorityFees = medianPriorityFees.reduce(
        (sum, fee) => sum.add(fee),
        BigNumber.from(0)
      );
      
      // Average of the median priority fees from the last 5 blocks
      const avgPriorityFee = sumPriorityFees.div(medianPriorityFees.length);
      
      // Apply a small boost to ensure transactions get included quickly
      const boostedPriorityFee = avgPriorityFee.mul(120).div(100); // 20% boost
      
      // Ensure it's within reasonable bounds
      const minPriorityFee = ethers.utils.parseUnits(
        GAS_SETTINGS.DEFAULT_PRIORITY_FEE.toString(),
        "gwei"
      );
      
      const maxPriorityFee = ethers.utils.parseUnits(
        GAS_SETTINGS.MAX_PRIORITY_FEE.toString(),
        "gwei"
      );
      
      if (boostedPriorityFee.lt(minPriorityFee)) {
        return minPriorityFee;
      } else if (boostedPriorityFee.gt(maxPriorityFee)) {
        return maxPriorityFee;
      }
      
      return boostedPriorityFee;
    }
  } catch (error) {
    console.warn("Error calculating priority fee from fee history:", error.message);
  }
  
  // Fallback: Use default priority fee
  return ethers.utils.parseUnits(
    GAS_SETTINGS.DEFAULT_PRIORITY_FEE.toString(),
    "gwei"
  );
}

/**
 * Calculates gas settings for a sandwich attack
 * Front-run needs to be high priority, back-run can be lower
 * @returns {Promise<Object>} - Gas settings for sandwich attack
 */
async function getSandwichGasSettings() {
  const { baseFee, priorityFee } = await getGasPrice();
  
  // Front-run: Higher priority to get in before victim
  const frontRunPriorityFee = priorityFee.mul(150).div(100); // 50% higher
  
  // Back-run: Lower priority than front-run but still competitive
  const backRunPriorityFee = priorityFee.mul(120).div(100); // 20% higher
  
  // Calculate max fee per gas (base fee + priority fee + buffer)
  const baseFeeBump = baseFee.mul(120).div(100); // 20% buffer for base fee fluctuations
  
  return {
    frontRun: {
      maxFeePerGas: baseFeeBump.add(frontRunPriorityFee),
      maxPriorityFeePerGas: frontRunPriorityFee,
      gasLimit: GAS_SETTINGS.SANDWICH_GAS_LIMIT
    },
    backRun: {
      maxFeePerGas: baseFeeBump.add(backRunPriorityFee),
      maxPriorityFeePerGas: backRunPriorityFee,
      gasLimit: GAS_SETTINGS.SANDWICH_GAS_LIMIT
    }
  };
}

/**
 * Calculates gas settings for arbitrage
 * @returns {Promise<Object>} - Gas settings for arbitrage
 */
async function getArbitrageGasSettings() {
  const { baseFee, priorityFee } = await getGasPrice();
  
  // For arbitrage, we want competitive but not necessarily highest priority
  const arbPriorityFee = priorityFee.mul(110).div(100); // 10% higher
  
  // Calculate max fee per gas (base fee + priority fee + buffer)
  const baseFeeBump = baseFee.mul(120).div(100); // 20% buffer
  
  return {
    maxFeePerGas: baseFeeBump.add(arbPriorityFee),
    maxPriorityFeePerGas: arbPriorityFee,
    gasLimit: GAS_SETTINGS.ARBITRAGE_GAS_LIMIT
  };
}

/**
 * Calculates gas settings for multi-hop operations
 * @returns {Promise<Object>} - Gas settings for multi-hop operations
 */
async function getMultiHopGasSettings() {
  const { baseFee, priorityFee } = await getGasPrice();
  
  // For multi-hop, we need higher gas limit but similar priority to arbitrage
  const multiHopPriorityFee = priorityFee.mul(110).div(100); // 10% higher
  
  // Calculate max fee per gas (base fee + priority fee + buffer)
  const baseFeeBump = baseFee.mul(120).div(100); // 20% buffer
  
  return {
    maxFeePerGas: baseFeeBump.add(multiHopPriorityFee),
    maxPriorityFeePerGas: multiHopPriorityFee,
    gasLimit: GAS_SETTINGS.MULTI_HOP_GAS_LIMIT
  };
}

/**
 * Calculates the gas cost for a transaction
 * @param {BigNumber} gasPrice - Gas price in wei
 * @param {number} gasLimit - Gas limit for the transaction
 * @returns {BigNumber} - Gas cost in wei
 */
function calculateGasCost(gasPrice, gasLimit) {
  return gasPrice.mul(BigNumber.from(gasLimit));
}

/**
 * Determines if an MEV opportunity is profitable after gas costs
 * @param {BigNumber} expectedProfit - Expected profit in wei
 * @param {BigNumber} gasPrice - Gas price in wei
 * @param {number} gasLimit - Gas limit for the transaction
 * @param {number} minProfitMarginBps - Minimum profit margin in basis points
 * @returns {Object} - Profitability assessment
 */
function isProfitableAfterGas(expectedProfit, gasPrice, gasLimit, minProfitMarginBps = 50) {
  const gasCost = calculateGasCost(gasPrice, gasLimit);
  
  if (expectedProfit.lte(gasCost)) {
    return {
      isProfitable: false,
      netProfit: BigNumber.from(0),
      profitMarginBps: 0,
      gasCost
    };
  }
  
  const netProfit = expectedProfit.sub(gasCost);
  const profitMarginBps = netProfit.mul(10000).div(expectedProfit.add(gasCost));
  
  return {
    isProfitable: profitMarginBps.gte(minProfitMarginBps),
    netProfit,
    profitMarginBps: profitMarginBps.toNumber(),
    gasCost
  };
}

module.exports = {
  getGasPrice,
  calculatePriorityFee,
  getSandwichGasSettings,
  getArbitrageGasSettings,
  getMultiHopGasSettings,
  calculateGasCost,
  isProfitableAfterGas
};