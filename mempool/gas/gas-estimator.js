/**
 * Gas price estimation for MEV transactions
 * Calculates optimal gas prices for transaction inclusion
 */
const ethers = require('ethers');
const { GAS_SETTINGS } = require('../../utils/constants');
const { Logger } = require('../../infrastructure/logging');

// Logger setup
const logger = new Logger('GasEstimator');

class GasEstimator {
  constructor(options = {}) {
    this.options = {
      gasMultiplier: GAS_SETTINGS.DEFAULT_PRIORITY_FEE, // Multiplier for gas price
      maxGasPrice: ethers.utils.parseUnits(GAS_SETTINGS.MAX_PRIORITY_FEE.toString(), 'gwei'),
      priorityFeeMultiplier: GAS_SETTINGS.DEFAULT_PRIORITY_FEE, // Multiplier for priority fee
      defaultPriorityFee: ethers.utils.parseUnits('2', 'gwei'), // 2 gwei default priority fee
      refreshInterval: 10000, // Refresh gas prices every 10 seconds
      rpcUrl: process.env.ETH_RPC_URL || 'https://eth-mainnet.alchemyapi.io/v2/your-api-key',
      fallbackGasPrice: ethers.utils.parseUnits('50', 'gwei'), // Fallback gas price if estimation fails
      blocksToConsider: 10, // Number of blocks to consider for gas estimation
      ...options
    };
    
    this.provider = null;
    this.latestGasPrice = null;
    this.latestBaseFee = null;
    this.latestPriorityFee = null;
    this.lastUpdated = 0;
    this.refreshTimer = null;
    this.isEip1559 = false; // Whether the network supports EIP-1559
    
    // Historical gas prices for better estimation
    this.recentGasPrices = [];
    this.recentBaseFees = [];
    this.recentPriorityFees = [];
  }

  /**
   * Initialize the gas estimator
   */
  async initialize() {
    try {
      logger.info('Initializing gas estimator...');
      
      // Create provider
      this.provider = new ethers.providers.JsonRpcProvider(this.options.rpcUrl);
      
      // Check if network supports EIP-1559
      const block = await this.provider.getBlock('latest');
      this.isEip1559 = block && block.baseFeePerGas !== undefined;
      
      logger.info(`Network ${this.isEip1559 ? 'supports' : 'does not support'} EIP-1559`);
      
      // Initial gas price update
      await this.updateGasPrices();
      
      // Set up timer for regular updates
      this.refreshTimer = setInterval(() => {
        this.updateGasPrices().catch(error => {
          logger.error('Error updating gas prices:', error);
        });
      }, this.options.refreshInterval);
      
      logger.info('Gas estimator initialized successfully');
      return true;
    } catch (error) {
      logger.error('Failed to initialize gas estimator:', error);
      throw error;
    }
  }

  /**
   * Update gas prices from the network
   */
  async updateGasPrices() {
    try {
      const block = await this.provider.getBlock('latest');
      
      if (this.isEip1559 && block.baseFeePerGas) {
        // EIP-1559 network
        const baseFee = block.baseFeePerGas;
        
        // Get priority fee from recent transactions
        const priorityFee = await this.estimatePriorityFee();
        
        // Calculate total gas price (base fee + priority fee)
        const gasPrice = baseFee.add(priorityFee);
        
        // Update latest values
        this.latestBaseFee = baseFee;
        this.latestPriorityFee = priorityFee;
        this.latestGasPrice = gasPrice;
        
        // Update historical data
        this.recentBaseFees.push(baseFee);
        this.recentPriorityFees.push(priorityFee);
        this.recentGasPrices.push(gasPrice);
      } else {
        // Legacy network (pre-EIP-1559)
        const gasPrice = await this.provider.getGasPrice();
        
        // Update latest values
        this.latestGasPrice = gasPrice;
        this.latestBaseFee = null;
        this.latestPriorityFee = null;
        
        // Update historical data
        this.recentGasPrices.push(gasPrice);
      }
      
      // Keep only recent data
      const maxHistory = 50;
      if (this.recentGasPrices.length > maxHistory) {
        this.recentGasPrices = this.recentGasPrices.slice(-maxHistory);
      }
      if (this.recentBaseFees.length > maxHistory) {
        this.recentBaseFees = this.recentBaseFees.slice(-maxHistory);
      }
      if (this.recentPriorityFees.length > maxHistory) {
        this.recentPriorityFees = this.recentPriorityFees.slice(-maxHistory);
      }
      
      this.lastUpdated = Date.now();
      
      logger.debug('Gas prices updated', {
        baseFee: this.latestBaseFee ? ethers.utils.formatUnits(this.latestBaseFee, 'gwei') + ' gwei' : 'N/A',
        priorityFee: this.latestPriorityFee ? ethers.utils.formatUnits(this.latestPriorityFee, 'gwei') + ' gwei' : 'N/A',
        gasPrice: ethers.utils.formatUnits(this.latestGasPrice, 'gwei') + ' gwei'
      });
      
      return {
        baseFee: this.latestBaseFee,
        priorityFee: this.latestPriorityFee,
        gasPrice: this.latestGasPrice
      };
    } catch (error) {
      logger.error('Error updating gas prices:', error);
      throw error;
    }
  }

  /**
   * Estimate priority fee from recent transactions
   * @returns {Promise<BigNumber>} Estimated priority fee
   */
  async estimatePriorityFee() {
    try {
      // Get fee history from the provider
      const feeHistory = await this.provider.send('eth_feeHistory', [
        this.options.blocksToConsider, // Number of blocks
        'latest', // Most recent block
        [10, 50, 90] // Percentiles to include
      ]);
      
      if (!feeHistory || !feeHistory.reward || feeHistory.reward.length === 0) {
        // Fall back to default
        return this.options.defaultPriorityFee;
      }
      
      // Extract priority fees from 50th percentile (median)
      const priorityFees = feeHistory.reward.map(rewards => {
        // Each reward is an array of percentiles, we take the middle (50th)
        const medianReward = rewards[1];
        return ethers.BigNumber.from(medianReward);
      });
      
      // Calculate median of priority fees
      const sortedFees = [...priorityFees].sort((a, b) => a.lt(b) ? -1 : (a.gt(b) ? 1 : 0));
      const median = sortedFees[Math.floor(sortedFees.length / 2)];
      
      // Apply multiplier for competitive priority fee
      const adjustedPriorityFee = median.mul(Math.floor(this.options.priorityFeeMultiplier * 100)).div(100);
      
      return adjustedPriorityFee;
    } catch (error) {
      logger.error('Error estimating priority fee:', error);
      return this.options.defaultPriorityFee;
    }
  }

  /**
   * Estimate optimal gas price for including a transaction in the next block
   * @param {Object} txData Transaction data
   * @returns {Promise<Object>} Estimated gas price parameters
   */
  async estimateOptimalGasPrice(txData) {
    try {
      // Ensure gas prices are up to date
      if (Date.now() - this.lastUpdated > this.options.refreshInterval) {
        await this.updateGasPrices();
      }
      
      // Start with the pending transaction's gas price as a reference
      let referenceGasPrice;
      
      if (txData.maxFeePerGas) {
        // EIP-1559 transaction
        referenceGasPrice = ethers.BigNumber.from(txData.maxFeePerGas);
      } else if (txData.gasPrice) {
        // Legacy transaction
        referenceGasPrice = ethers.BigNumber.from(txData.gasPrice);
      } else {
        // Default to current gas price
        referenceGasPrice = this.latestGasPrice;
      }
      
      // For EIP-1559 transactions, we need to estimate both the max fee and priority fee
      if (this.isEip1559) {
        // Estimate base fee for next block (current base fee + 12.5% increase as worst case)
        const nextBlockBaseFee = this.latestBaseFee.mul(1125).div(1000);
        
        // Extract or estimate priority fee
        let priorityFee;
        if (txData.maxPriorityFeePerGas) {
          // Use the transaction's priority fee as reference
          priorityFee = ethers.BigNumber.from(txData.maxPriorityFeePerGas);
        } else {
          // Use our estimated priority fee
          priorityFee = this.latestPriorityFee;
        }
        
        // Apply multiplier for competitive priority fee
        const competitivePriorityFee = priorityFee.mul(Math.floor(this.options.priorityFeeMultiplier * 100)).div(100);
        
        // Calculate max fee per gas (next block base fee + competitive priority fee + buffer)
        const maxFeePerGas = nextBlockBaseFee.add(competitivePriorityFee).mul(110).div(100);
        
        // Cap at max gas price
        const cappedMaxFeePerGas = maxFeePerGas.gt(this.options.maxGasPrice) ? 
          this.options.maxGasPrice : maxFeePerGas;
        
        return {
          maxFeePerGas: cappedMaxFeePerGas,
          maxPriorityFeePerGas: competitivePriorityFee,
          baseFee: nextBlockBaseFee,
          type: 2 // EIP-1559 transaction type
        };
      } else {
        // Legacy transaction
        // Apply multiplier to the reference gas price
        const competitiveGasPrice = referenceGasPrice.mul(Math.floor(this.options.gasMultiplier * 100)).div(100);
        
        // Cap at max gas price
        const cappedGasPrice = competitiveGasPrice.gt(this.options.maxGasPrice) ? 
          this.options.maxGasPrice : competitiveGasPrice;
        
        return {
          gasPrice: cappedGasPrice,
          type: 0 // Legacy transaction type
        };
      }
    } catch (error) {
      logger.error('Error estimating optimal gas price:', error);
      
      // Fall back to default values
      if (this.isEip1559) {
        return {
          maxFeePerGas: this.options.fallbackGasPrice,
          maxPriorityFeePerGas: this.options.defaultPriorityFee,
          type: 2
        };
      } else {
        return {
          gasPrice: this.options.fallbackGasPrice,
          type: 0
        };
      }
    }
  }

  /**
   * Estimate gas for sandwich attack front-running
   * @param {Object} victimTx Victim transaction data
   * @returns {Promise<Object>} Gas parameters for front-running
   */
  async estimateSandwichFrontRunGas(victimTx) {
    try {
      const baseEstimation = await this.estimateOptimalGasPrice(victimTx);
      
      // For front-running, we need to be more aggressive with gas price
      if (this.isEip1559) {
        // For EIP-1559, increase priority fee significantly to ensure front-running
        const boostedPriorityFee = baseEstimation.maxPriorityFeePerGas.mul(150).div(100);
        const boostedMaxFee = baseEstimation.maxFeePerGas.mul(120).div(100);
        
        return {
          ...baseEstimation,
          maxPriorityFeePerGas: boostedPriorityFee,
          maxFeePerGas: boostedMaxFee
        };
      } else {
        // For legacy transactions, use a higher gas price multiplier
        const boostedGasPrice = baseEstimation.gasPrice.mul(130).div(100);
        
        return {
          ...baseEstimation,
          gasPrice: boostedGasPrice
        };
      }
    } catch (error) {
      logger.error('Error estimating sandwich front-run gas:', error);
      return this.estimateOptimalGasPrice(victimTx);
    }
  }

  /**
   * Estimate gas for sandwich attack back-running
   * @param {Object} victimTx Victim transaction data
   * @returns {Promise<Object>} Gas parameters for back-running
   */
  async estimateSandwichBackRunGas(victimTx) {
    try {
      const baseEstimation = await this.estimateOptimalGasPrice(victimTx);
      
      // For back-running, we can be slightly less aggressive than front-running
      if (this.isEip1559) {
        // For EIP-1559, we still need competitive priority fee, but lower than front-run
        const backRunPriorityFee = baseEstimation.maxPriorityFeePerGas.mul(110).div(100);
        
        return {
          ...baseEstimation,
          maxPriorityFeePerGas: backRunPriorityFee
        };
      } else {
        // For legacy transactions, use a slightly higher gas price than victim
        const backRunGasPrice = baseEstimation.gasPrice.mul(110).div(100);
        
        return {
          ...baseEstimation,
          gasPrice: backRunGasPrice
        };
      }
    } catch (error) {
      logger.error('Error estimating sandwich back-run gas:', error);
      return this.estimateOptimalGasPrice(victimTx);
    }
  }

  /**
   * Clean up resources used by the gas estimator
   */
  cleanup() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}

module.exports = {
  GasEstimator
};