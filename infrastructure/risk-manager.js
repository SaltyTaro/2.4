/**
 * Risk management system for MEV strategies
 * Monitors and manages risk parameters to ensure safe operation
 */
const ethers = require('ethers');
const { Logger } = require('./logging');
const { getTokenPrice } = require('../utils/price-utils');

// Logger setup
const logger = new Logger('RiskManager');

class RiskManager {
  constructor(options = {}) {
    this.options = {
      maxExposureEth: ethers.utils.parseEther('100'), // Maximum 100 ETH exposure
      maxExposureUsd: 200000, // Maximum $200,000 USD exposure
      maxSingleTxExposureEth: ethers.utils.parseEther('10'), // Maximum 10 ETH per transaction
      maxPoolUsageBps: 100, // Maximum 1% of pool reserves usage
      minProfitRatio: 0.005, // Minimum 0.5% profit ratio
      minProfitEth: ethers.utils.parseEther('0.01'), // Minimum 0.01 ETH profit
      maxSlippageBps: 50, // Maximum 0.5% slippage
      maxGasPrice: ethers.utils.parseUnits('500', 'gwei'), // Maximum 500 gwei gas price
      maxPendingTxs: 5, // Maximum concurrent pending transactions
      cooldownPeriod: 3 * 60 * 1000, // 3 minute cooldown after failures
      dailyExposureLimit: ethers.utils.parseEther('500'), // Maximum 500 ETH daily exposure
      weeklyProfitTarget: ethers.utils.parseEther('10'), // 10 ETH weekly profit target
      emergencyStopThreshold: -10, // Emergency stop after 10 ETH loss
      blacklistedTokens: [], // Tokens to avoid
      blacklistedAddresses: [], // Addresses to avoid
      rpcUrl: process.env.ETH_RPC_URL || 'https://eth-mainnet.alchemyapi.io/v2/your-api-key',
      ...options
    };
    
    this.provider = null;
    this.currentExposure = ethers.constants.Zero;
    this.dailyExposure = ethers.constants.Zero;
    this.dailyProfit = ethers.constants.Zero;
    this.weeklyProfit = ethers.constants.Zero;
    this.lastResetTime = Date.now();
    this.pendingTransactions = new Map();
    this.failedTransactions = new Map();
    this.executionHistory = [];
    this.lastFailureTime = 0;
    this.emergencyStopped = false;
    this.pausedStrategies = new Set();
    
    // Circuit breakers
    this.circuitBreakers = {
      profitDecline: false, // Triggered on sustained profit decline
      highGas: false, // Triggered on sustained high gas prices
      failureRate: false, // Triggered on high failure rate
      liquidityShock: false, // Triggered on sudden liquidity changes
      flashCrash: false    // Triggered on market flash crash
    };
  }

  /**
   * Initialize the risk manager
   */
  async initialize() {
    try {
      logger.info('Initializing risk manager...');
      
      // Create provider
      this.provider = new ethers.providers.JsonRpcProvider(this.options.rpcUrl);
      
      // Set up timer for daily and weekly resets
      this.setupResetTimers();
      
      logger.info('Risk manager initialized successfully');
      return true;
    } catch (error) {
      logger.error('Failed to initialize risk manager:', error);
      throw error;
    }
  }

  /**
   * Set up timers for resetting daily and weekly counters
   */
  setupResetTimers() {
    // Calculate time until midnight
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const timeUntilMidnight = tomorrow.getTime() - now.getTime();
    
    // Reset daily counters at midnight
    setTimeout(() => {
      this.resetDailyCounters();
      // Set up next day's timer
      setInterval(this.resetDailyCounters.bind(this), 24 * 60 * 60 * 1000);
    }, timeUntilMidnight);
    
    // Reset weekly counters on Monday at midnight
    const daysUntilMonday = (1 + 7 - now.getDay()) % 7;
    const monday = new Date(now);
    monday.setDate(monday.getDate() + daysUntilMonday);
    monday.setHours(0, 0, 0, 0);
    const timeUntilMonday = monday.getTime() - now.getTime();
    
    setTimeout(() => {
      this.resetWeeklyCounters();
      // Set up next week's timer
      setInterval(this.resetWeeklyCounters.bind(this), 7 * 24 * 60 * 60 * 1000);
    }, timeUntilMonday);
  }

  /**
   * Reset daily counters
   */
  resetDailyCounters() {
    logger.info('Resetting daily risk counters');
    this.dailyExposure = ethers.constants.Zero;
    this.dailyProfit = ethers.constants.Zero;
  }

  /**
   * Reset weekly counters
   */
  resetWeeklyCounters() {
    logger.info('Resetting weekly risk counters');
    this.weeklyProfit = ethers.constants.Zero;
  }

  /**
   * Validate an opportunity against risk parameters
   * @param {Object} opportunity The opportunity to validate
   * @returns {boolean} Whether the opportunity is valid
   */
  validateOpportunity(opportunity) {
    try {
      // Skip validation if emergency stopped
      if (this.emergencyStopped) {
        logger.warn('Emergency stop is active - rejecting all opportunities');
        return false;
      }
      
      // Check if strategy type is paused
      if (this.pausedStrategies.has(opportunity.type)) {
        logger.warn(`Strategy type ${opportunity.type} is paused - rejecting opportunity`);
        return false;
      }
      
      // Check circuit breakers
      if (this.checkCircuitBreakers()) {
        logger.warn('Circuit breaker is active - rejecting opportunity');
        return false;
      }
      
      // Check cooldown period after failures
      if (Date.now() - this.lastFailureTime < this.options.cooldownPeriod) {
        logger.warn('In cooldown period after failure - rejecting opportunity');
        return false;
      }
      
      // Check pending transaction count
      if (this.pendingTransactions.size >= this.options.maxPendingTxs) {
        logger.warn('Maximum pending transactions reached - rejecting opportunity');
        return false;
      }
      
      // Check blacklisted tokens
      if (this.isBlacklistedToken(opportunity)) {
        logger.warn('Blacklisted token detected - rejecting opportunity');
        return false;
      }
      
      // Check profit thresholds
      const profit = opportunity.estimatedProfit || ethers.constants.Zero;
      if (profit.lt(this.options.minProfitEth)) {
        logger.debug('Profit below minimum threshold - rejecting opportunity');
        return false;
      }
      
      // Check gas price
      const gasPrice = this.getGasPrice(opportunity.gasInfo);
      if (gasPrice.gt(this.options.maxGasPrice)) {
        logger.warn('Gas price too high - rejecting opportunity');
        return false;
      }
      
      // Check exposure limits
      const exposure = this.getExposureAmount(opportunity);
      
      // Check single transaction exposure
      if (exposure.gt(this.options.maxSingleTxExposureEth)) {
        logger.warn('Single transaction exposure too high - rejecting opportunity');
        return false;
      }
      
      // Check total current exposure
      const projectedExposure = this.currentExposure.add(exposure);
      if (projectedExposure.gt(this.options.maxExposureEth)) {
        logger.warn('Total exposure too high - rejecting opportunity');
        return false;
      }
      
      // Check daily exposure limit
      const projectedDailyExposure = this.dailyExposure.add(exposure);
      if (projectedDailyExposure.gt(this.options.dailyExposureLimit)) {
        logger.warn('Daily exposure limit reached - rejecting opportunity');
        return false;
      }
      
      // Check profit ratio
      const profitRatio = profit.mul(10000).div(exposure);
      if (profitRatio.lt(Math.floor(this.options.minProfitRatio * 10000))) {
        logger.debug('Profit ratio below minimum threshold - rejecting opportunity');
        return false;
      }
      
      // Check pool usage for DEX transactions
      if (opportunity.type === 'sandwich' || opportunity.type === 'frontrun' || opportunity.type === 'backrun') {
        const poolUsage = this.calculatePoolUsage(opportunity);
        if (poolUsage > this.options.maxPoolUsageBps) {
          logger.warn('Pool usage too high - rejecting opportunity');
          return false;
        }
      }
      
      // All checks passed
      logger.info(`Opportunity ${opportunity.type} passed risk validation`);
      return true;
    } catch (error) {
      logger.error('Error in risk validation:', error);
      return false; // Fail safe - reject on error
    }
  }

  /**
   * Check if circuit breakers are active
   * @returns {boolean} Whether any circuit breaker is active
   */
  checkCircuitBreakers() {
    return Object.values(this.circuitBreakers).some(breaker => breaker);
  }

  /**
   * Check if a token is blacklisted
   * @param {Object} opportunity The opportunity to check
   * @returns {boolean} Whether any token is blacklisted
   */
  isBlacklistedToken(opportunity) {
    // Check for different opportunity types
    if (opportunity.type === 'sandwich' || opportunity.type === 'frontrun' || opportunity.type === 'backrun') {
      return (
        this.options.blacklistedTokens.includes(opportunity.tokenIn?.toLowerCase()) ||
        this.options.blacklistedTokens.includes(opportunity.tokenOut?.toLowerCase())
      );
    } else if (opportunity.type === 'arbitrage') {
      return (
        this.options.blacklistedTokens.includes(opportunity.tokenA?.toLowerCase()) ||
        this.options.blacklistedTokens.includes(opportunity.tokenB?.toLowerCase())
      );
    } else if (opportunity.type === 'multihop') {
      return opportunity.tokens.some(token => 
        this.options.blacklistedTokens.includes(token.toLowerCase())
      );
    }
    
    return false;
  }

  /**
   * Get exposure amount from an opportunity
   * @param {Object} opportunity The opportunity
   * @returns {BigNumber} Exposure amount in ETH
   */
  getExposureAmount(opportunity) {
    if (opportunity.type === 'sandwich' || opportunity.type === 'frontrun') {
      return ethers.BigNumber.from(opportunity.frontRunAmount || '0');
    } else if (opportunity.type === 'backrun') {
      return ethers.BigNumber.from(opportunity.backRunAmount || '0');
    } else if (opportunity.type === 'arbitrage' || opportunity.type === 'multihop') {
      return ethers.BigNumber.from(opportunity.amount || '0');
    }
    
    // Default fallback
    return ethers.constants.Zero;
  }

  /**
   * Get gas price from gas info
   * @param {Object} gasInfo Gas price information
   * @returns {BigNumber} Gas price in wei
   */
  getGasPrice(gasInfo) {
    if (!gasInfo) {
      return ethers.constants.Zero;
    }
    
    if (gasInfo.type === 2) {
      // EIP-1559 transaction
      return ethers.BigNumber.from(gasInfo.maxFeePerGas || '0');
    } else {
      // Legacy transaction
      return ethers.BigNumber.from(gasInfo.gasPrice || '0');
    }
  }

  /**
   * Calculate pool usage for a DEX opportunity
   * @param {Object} opportunity The opportunity
   * @returns {number} Pool usage in basis points
   */
  calculatePoolUsage(opportunity) {
    try {
      // Get relevant amounts based on opportunity type
      let amount = ethers.constants.Zero;
      let reserveIn = ethers.constants.Zero;
      
      if (opportunity.type === 'sandwich' || opportunity.type === 'frontrun') {
        amount = ethers.BigNumber.from(opportunity.frontRunAmount || '0');
        reserveIn = ethers.BigNumber.from(opportunity.targetTx?.reserveIn || '0');
      } else if (opportunity.type === 'backrun') {
        amount = ethers.BigNumber.from(opportunity.backRunAmount || '0');
        reserveIn = ethers.BigNumber.from(opportunity.targetTx?.reserveOut || '0');
      }
      
      // Skip if reserve is zero or very small (avoid division by zero or unrealistic values)
      if (reserveIn.lt(ethers.utils.parseEther('0.1'))) {
        return 0;
      }
      
      // Calculate usage in basis points
      return amount.mul(10000).div(reserveIn).toNumber();
    } catch (error) {
      logger.error('Error calculating pool usage:', error);
      return 10000; // Return high value to fail the check
    }
  }

  /**
   * Record a pending transaction
   * @param {Object} opportunity The opportunity
   * @param {Object} transaction Transaction details
   */
  recordPendingTransaction(opportunity, transaction) {
    // Update exposure
    const exposure = this.getExposureAmount(opportunity);
    this.currentExposure = this.currentExposure.add(exposure);
    this.dailyExposure = this.dailyExposure.add(exposure);
    
    // Store pending transaction
    this.pendingTransactions.set(transaction.hash, {
      opportunity,
      transaction,
      exposure,
      timestamp: Date.now()
    });
    
    logger.info(`Recorded pending transaction ${transaction.hash} for ${opportunity.type}`, {
      exposureEth: ethers.utils.formatEther(exposure),
      currentExposureEth: ethers.utils.formatEther(this.currentExposure),
      dailyExposureEth: ethers.utils.formatEther(this.dailyExposure)
    });
  }

  /**
   * Record a completed transaction
   * @param {Object} opportunity The opportunity
   * @param {Object} receipt Transaction receipt
   * @param {BigNumber} profit Actual profit made
   * @param {boolean} success Whether the transaction was successful
   */
  recordCompletedTransaction(opportunity, receipt, profit, success) {
    // Get the pending transaction
    const pendingTx = this.pendingTransactions.get(receipt.transactionHash);
    if (!pendingTx) {
      logger.warn(`Transaction ${receipt.transactionHash} not found in pending transactions`);
      return;
    }
    
    // Update exposure
    this.currentExposure = this.currentExposure.sub(pendingTx.exposure);
    
    // Update profit counters
    if (success) {
      this.dailyProfit = this.dailyProfit.add(profit);
      this.weeklyProfit = this.weeklyProfit.add(profit);
      
      // Record successful execution
      this.executionHistory.push({
        type: opportunity.type,
        profit,
        timestamp: Date.now(),
        gasUsed: receipt.gasUsed,
        success: true
      });
      
      logger.info(`Recorded successful transaction ${receipt.transactionHash}`, {
        profitEth: ethers.utils.formatEther(profit),
        currentExposureEth: ethers.utils.formatEther(this.currentExposure),
        dailyProfitEth: ethers.utils.formatEther(this.dailyProfit),
        weeklyProfitEth: ethers.utils.formatEther(this.weeklyProfit)
      });
    } else {
      // Record loss as negative profit
      const gasPrice = ethers.BigNumber.from(
        pendingTx.transaction.gasPrice || pendingTx.transaction.maxFeePerGas || '0'
      );
      const gasLoss = gasPrice.mul(receipt.gasUsed);
      
      this.dailyProfit = this.dailyProfit.sub(gasLoss);
      this.weeklyProfit = this.weeklyProfit.sub(gasLoss);
      
      // Record failed execution
      this.executionHistory.push({
        type: opportunity.type,
        profit: gasLoss.mul(-1), // Negative profit (loss)
        timestamp: Date.now(),
        gasUsed: receipt.gasUsed,
        success: false
      });
      
      // Update failure tracking
      this.lastFailureTime = Date.now();
      this.failedTransactions.set(receipt.transactionHash, {
        opportunity,
        receipt,
        timestamp: Date.now()
      });
      
      logger.warn(`Recorded failed transaction ${receipt.transactionHash}`, {
        lossEth: ethers.utils.formatEther(gasLoss),
        currentExposureEth: ethers.utils.formatEther(this.currentExposure),
        dailyProfitEth: ethers.utils.formatEther(this.dailyProfit),
        weeklyProfitEth: ethers.utils.formatEther(this.weeklyProfit)
      });
      
      // Check for emergency stop condition
      this.checkEmergencyStop();
    }
    
    // Remove from pending transactions
    this.pendingTransactions.delete(receipt.transactionHash);
    
    // Update circuit breakers
    this.updateCircuitBreakers();
  }

  /**
   * Check if emergency stop should be triggered
   */
  checkEmergencyStop() {
    // Check if we've hit the emergency stop threshold
    if (this.weeklyProfit.lt(ethers.utils.parseEther(this.options.emergencyStopThreshold.toString()))) {
      this.triggerEmergencyStop();
    }
    
    // Check failure rate
    const recentExecutions = this.getRecentExecutions(30 * 60 * 1000); // Last 30 minutes
    if (recentExecutions.length >= 5) {
      const failureRate = recentExecutions.filter(e => !e.success).length / recentExecutions.length;
      if (failureRate > 0.5) { // More than 50% failures
        this.triggerEmergencyStop();
      }
    }
  }

  /**
   * Trigger emergency stop
   */
  triggerEmergencyStop() {
    if (!this.emergencyStopped) {
      this.emergencyStopped = true;
      logger.error('EMERGENCY STOP TRIGGERED - All trading has been halted');
      
      // Notify team (would implement actual notification system in production)
      console.error('EMERGENCY STOP: MEV strategy halted due to excessive losses or failures');
    }
  }

  /**
   * Update circuit breakers based on recent performance
   */
  updateCircuitBreakers() {
    // Check profit decline
    const profitTrend = this.calculateProfitTrend();
    this.circuitBreakers.profitDecline = profitTrend < -0.3; // 30% decline in profit trend
    
    // Check failure rate
    const recentExecutions = this.getRecentExecutions(60 * 60 * 1000); // Last hour
    if (recentExecutions.length >= 3) {
      const failureRate = recentExecutions.filter(e => !e.success).length / recentExecutions.length;
      this.circuitBreakers.failureRate = failureRate > 0.3; // More than 30% failures
    }
    
    // Check high gas
    const averageGasPrice = this.calculateAverageGasPrice();
    this.circuitBreakers.highGas = averageGasPrice.gt(ethers.utils.parseUnits('300', 'gwei')); // Over 300 gwei
    
    // Log any newly triggered circuit breakers
    Object.entries(this.circuitBreakers).forEach(([breaker, isTriggered]) => {
      if (isTriggered) {
        logger.warn(`Circuit breaker triggered: ${breaker}`);
      }
    });
  }

  /**
   * Calculate profit trend from recent executions
   * @returns {number} Profit trend as decimal (-1 to 1)
   */
  calculateProfitTrend() {
    const recent = this.getRecentExecutions(2 * 60 * 60 * 1000); // Last 2 hours
    if (recent.length < 5) {
      return 0; // Not enough data
    }
    
    // Split into two halves
    const midpoint = Math.floor(recent.length / 2);
    const firstHalf = recent.slice(0, midpoint);
    const secondHalf = recent.slice(midpoint);
    
    // Calculate average profit for each half
    const sumProfit = (executions) => {
      return executions.reduce((sum, execution) => {
        return sum.add(execution.profit);
      }, ethers.constants.Zero);
    };
    
    const firstHalfProfit = sumProfit(firstHalf);
    const secondHalfProfit = sumProfit(secondHalf);
    
    // Calculate trend
    if (firstHalfProfit.isZero()) {
      return secondHalfProfit.gt(0) ? 1 : -1;
    }
    
    const trend = secondHalfProfit.sub(firstHalfProfit).mul(100).div(firstHalfProfit);
    return trend.toNumber() / 100; // Convert to decimal
  }

  /**
   * Calculate average gas price from recent transactions
   * @returns {BigNumber} Average gas price in wei
   */
  calculateAverageGasPrice() {
    const recent = this.getRecentExecutions(30 * 60 * 1000); // Last 30 minutes
    if (recent.length === 0) {
      return ethers.utils.parseUnits('50', 'gwei'); // Default value
    }
    
    let totalGasPrice = ethers.constants.Zero;
    let count = 0;
    
    for (const [hash, tx] of this.pendingTransactions.entries()) {
      if (tx.transaction.gasPrice || tx.transaction.maxFeePerGas) {
        totalGasPrice = totalGasPrice.add(
          tx.transaction.gasPrice || tx.transaction.maxFeePerGas
        );
        count++;
      }
    }
    
    if (count === 0) {
      return ethers.utils.parseUnits('50', 'gwei'); // Default value
    }
    
    return totalGasPrice.div(count);
  }

  /**
   * Get recent executions
   * @param {number} timeWindow Time window in milliseconds
   * @returns {Array} Recent executions
   */
  getRecentExecutions(timeWindow) {
    const cutoff = Date.now() - timeWindow;
    return this.executionHistory.filter(execution => execution.timestamp > cutoff);
  }

  /**
   * Pause a specific strategy type
   * @param {string} strategyType Strategy type to pause
   */
  pauseStrategy(strategyType) {
    this.pausedStrategies.add(strategyType);
    logger.warn(`Paused strategy type: ${strategyType}`);
  }

  /**
   * Resume a specific strategy type
   * @param {string} strategyType Strategy type to resume
   */
  resumeStrategy(strategyType) {
    this.pausedStrategies.delete(strategyType);
    logger.info(`Resumed strategy type: ${strategyType}`);
  }

  /**
   * Reset emergency stop
   */
  resetEmergencyStop() {
    this.emergencyStopped = false;
    logger.info('Emergency stop has been reset');
  }

  /**
   * Get current risk status
   * @returns {Object} Risk status
   */
  getRiskStatus() {
    return {
      currentExposure: this.currentExposure.toString(),
      dailyExposure: this.dailyExposure.toString(),
      dailyProfit: this.dailyProfit.toString(),
      weeklyProfit: this.weeklyProfit.toString(),
      pendingTransactions: this.pendingTransactions.size,
      failedTransactions: this.failedTransactions.size,
      emergencyStopped: this.emergencyStopped,
      circuitBreakers: { ...this.circuitBreakers },
      pausedStrategies: Array.from(this.pausedStrategies)
    };
  }
}

module.exports = {
  RiskManager
};