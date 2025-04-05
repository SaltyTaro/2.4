/**
 * Transaction analyzer for MEV opportunities
 * Analyzes decoded transaction data to evaluate potential MEV strategies
 */
const ethers = require('ethers');
const { TOKEN_ADDRESSES, DEX_ADDRESSES } = require('../../utils/constants');
const { getReserves, getAmountOut, getAmountIn } = require('../../utils/dex-utils');
const { getPriceImpact } = require('../../utils/price-utils');
const { Logger } = require('../../infrastructure/logging');

// Logger setup
const logger = new Logger('TxAnalyzer');

class TxAnalyzer {
  constructor(options = {}) {
    this.options = {
      minSwapValueEth: ethers.utils.parseEther('1'), // Minimum value for potential MEV opportunity
      minSwapValueUsd: 1000, // Minimum USD value for potential MEV opportunity
      minPriceImpactBps: 10, // Minimum price impact in basis points (0.1%)
      maxPriceImpactBps: 500, // Maximum price impact in basis points (5%)
      maxSlippageBps: 50, // Maximum slippage in basis points (0.5%)
      rpcUrl: process.env.ETH_RPC_URL || 'https://eth-mainnet.alchemyapi.io/v2/your-api-key',
      minProfitRatioFrontrun: 0.001, // 0.1% minimum profit ratio for frontrunning
      minProfitRatioBackrun: 0.002, // 0.2% minimum profit ratio for backrunning
      minProfitRatioArbitrage: 0.003, // 0.3% minimum profit ratio for arbitrage
      blacklistedAddresses: [], // Addresses to avoid targeting
      ...options
    };
    
    this.provider = null;
    this.pendingSwaps = new Map(); // Track potential victim transactions
  }

  /**
   * Initialize the transaction analyzer
   */
  async initialize() {
    try {
      logger.info('Initializing transaction analyzer...');
      
      // Create provider
      this.provider = new ethers.providers.JsonRpcProvider(this.options.rpcUrl);
      
      logger.info('Transaction analyzer initialized successfully');
      return true;
    } catch (error) {
      logger.error('Failed to initialize transaction analyzer:', error);
      throw error;
    }
  }

  /**
   * Analyze a decoded transaction for MEV opportunities
   * @param {Object} decodedTx Decoded transaction data
   * @returns {Promise<Object>} Analysis results
   */
  async analyze(decodedTx) {
    try {
      // Basic result structure
      const result = {
        hash: decodedTx.hash,
        isPotentialOpportunity: false,
        opportunityTypes: [],
        estimatedProfit: ethers.constants.Zero,
        estimatedProfitUsd: '0.00',
        details: {}
      };
      
      // Skip blacklisted addresses
      if (
        this.options.blacklistedAddresses.includes(decodedTx.from?.toLowerCase()) ||
        this.options.blacklistedAddresses.includes(decodedTx.to?.toLowerCase())
      ) {
        return result;
      }
      
      // Analyze based on transaction type
      if (decodedTx.isSwap) {
        return await this.analyzeSwap(decodedTx, result);
      } else if (decodedTx.isFlashLoan) {
        return await this.analyzeFlashLoan(decodedTx, result);
      } else if (decodedTx.isLiquidation) {
        return await this.analyzeLiquidation(decodedTx, result);
      } else if (decodedTx.isERC20Transfer) {
        return await this.analyzeERC20Transfer(decodedTx, result);
      }
      
      // Default result for unsupported transaction types
      return result;
    } catch (error) {
      logger.error(`Error analyzing transaction ${decodedTx.hash}:`, error);
      return {
        hash: decodedTx.hash,
        isPotentialOpportunity: false,
        error: error.message
      };
    }
  }

  /**
   * Analyze a swap transaction
   * @param {Object} decodedTx Decoded transaction data
   * @param {Object} result Analysis result to build upon
   * @returns {Promise<Object>} Updated analysis results
   */
  async analyzeSwap(decodedTx, result) {
    try {
      // Skip if it doesn't meet value thresholds
      const valueInEth = decodedTx.valueETH ? 
        ethers.utils.parseEther(decodedTx.valueETH) : 
        ethers.constants.Zero;
      
      const valueInUsd = decodedTx.valueUSD ? 
        parseFloat(decodedTx.valueUSD) : 
        0;
      
      if (
        valueInEth.lt(this.options.minSwapValueEth) &&
        valueInUsd < this.options.minSwapValueUsd
      ) {
        return result;
      }
      
      // Get pair information and reserves
      const pairInfo = await this.getPairInfo(decodedTx.tokenIn, decodedTx.tokenOut);
      if (!pairInfo) {
        return result;
      }
      
      // Calculate price impact
      const priceImpact = await this.calculatePriceImpact(
        decodedTx,
        pairInfo
      );
      
      // Store swap details
      const swapDetails = {
        tokenIn: decodedTx.tokenIn,
        tokenOut: decodedTx.tokenOut,
        tokenInSymbol: decodedTx.tokenInInfo?.symbol || 'Unknown',
        tokenOutSymbol: decodedTx.tokenOutInfo?.symbol || 'Unknown',
        amountIn: decodedTx.amountIn?.toString() || '0',
        amountOutMin: decodedTx.amountOutMin?.toString() || '0',
        estimatedAmountOut: '0',
        priceImpactBps: Math.round(priceImpact * 10000),
        valueEth: decodedTx.valueETH || '0',
        valueUsd: decodedTx.valueUSD || '0',
        dexType: decodedTx.dexType || 'Unknown',
        pairAddress: pairInfo?.pairAddress || 'Unknown',
        reserveIn: pairInfo?.reserveIn?.toString() || '0',
        reserveOut: pairInfo?.reserveOut?.toString() || '0'
      };
      
      // Calculate estimated output amount
      if (pairInfo && decodedTx.amountIn) {
        const estimatedOut = getAmountOut(
          decodedTx.amountIn,
          pairInfo.reserveIn,
          pairInfo.reserveOut
        );
        swapDetails.estimatedAmountOut = estimatedOut.toString();
      }
      
      // Store details in result
      result.details.swap = swapDetails;
      
      // Check if swap meets criteria for MEV opportunity
      const meetsOpportunityCriteria = await this.checkSwapMevOpportunity(
        decodedTx,
        pairInfo,
        priceImpact
      );
      
      if (meetsOpportunityCriteria) {
        // Calculate potential strategies and profits
        const strategies = await this.calculateSwapMevStrategies(
          decodedTx,
          pairInfo,
          priceImpact
        );
        
        if (strategies.length > 0) {
          result.isPotentialOpportunity = true;
          result.strategies = strategies;
          
          // Find the most profitable strategy
          const mostProfitable = strategies.reduce((best, current) => {
            return current.estimatedProfit.gt(best.estimatedProfit) ? current : best;
          }, { estimatedProfit: ethers.constants.Zero });
          
          result.estimatedProfit = mostProfitable.estimatedProfit;
          result.estimatedProfitUsd = mostProfitable.estimatedProfitUsd;
          result.opportunityTypes = strategies.map(s => s.type);
          
          // Store the transaction in pending swaps for arbitrage opportunities
          this.storePendingSwap(decodedTx, pairInfo, priceImpact);
        }
      }
      
      return result;
    } catch (error) {
      logger.error(`Error analyzing swap transaction ${decodedTx.hash}:`, error);
      return result;
    }
  }

  /**
   * Check if a swap transaction meets criteria for MEV opportunity
   * @param {Object} decodedTx Decoded transaction data
   * @param {Object} pairInfo Pair information with reserves
   * @param {number} priceImpact Price impact percentage (0-1)
   * @returns {Promise<boolean>} Whether the swap meets criteria
   */
  async checkSwapMevOpportunity(decodedTx, pairInfo, priceImpact) {
    // Check price impact is within reasonable range
    const priceImpactBps = Math.round(priceImpact * 10000);
    if (
      priceImpactBps < this.options.minPriceImpactBps ||
      priceImpactBps > this.options.maxPriceImpactBps
    ) {
      return false;
    }
    
    // Check slippage is reasonable
    if (decodedTx.amountIn && decodedTx.amountOutMin && pairInfo) {
      const expectedOut = getAmountOut(
        decodedTx.amountIn,
        pairInfo.reserveIn,
        pairInfo.reserveOut
      );
      
      const slippage = expectedOut.sub(decodedTx.amountOutMin).mul(10000).div(expectedOut);
      
      // Skip if slippage is too low (likely a well-optimized trade)
      if (slippage.lt(this.options.maxSlippageBps)) {
        return false;
      }
    }
    
    // Calculate if the size is appropriate for the pool
    if (decodedTx.amountIn && pairInfo) {
      const swapRatio = decodedTx.amountIn.mul(10000).div(pairInfo.reserveIn);
      
      // Skip if swap is too small relative to pool size (< 0.1%)
      if (swapRatio.lt(10)) {
        return false;
      }
      
      // Skip if swap is too large relative to pool size (> 10%)
      if (swapRatio.gt(1000)) {
        return false;
      }
    }
    
    // Check gas price is reasonable for front-running
    if (decodedTx.gasPrice || decodedTx.maxFeePerGas) {
      const gasPrice = decodedTx.gasPrice || decodedTx.maxFeePerGas;
      const baseFeeInGwei = ethers.utils.formatUnits(gasPrice, 'gwei');
      
      // Skip if gas price is too high
      if (parseFloat(baseFeeInGwei) > 500) {
        return false;
      }
    }
    
    return true;
  }

  /**
   * Calculate potential MEV strategies for a swap transaction
   * @param {Object} decodedTx Decoded transaction data
   * @param {Object} pairInfo Pair information with reserves
   * @param {number} priceImpact Price impact percentage (0-1)
   * @returns {Promise<Array>} Array of potential strategies with estimated profits
   */
  async calculateSwapMevStrategies(decodedTx, pairInfo, priceImpact) {
    const strategies = [];
    
    // Try front-running strategy
    const frontrunStrategy = await this.calculateFrontrunStrategy(
      decodedTx,
      pairInfo,
      priceImpact
    );
    
    if (frontrunStrategy) {
      strategies.push(frontrunStrategy);
    }
    
    // Try back-running strategy
    const backrunStrategy = await this.calculateBackrunStrategy(
      decodedTx,
      pairInfo,
      priceImpact
    );
    
    if (backrunStrategy) {
      strategies.push(backrunStrategy);
    }
    
    // Try sandwich strategy (combination of front-run and back-run)
    const sandwichStrategy = await this.calculateSandwichStrategy(
      decodedTx,
      pairInfo,
      priceImpact
    );
    
    if (sandwichStrategy) {
      strategies.push(sandwichStrategy);
    }
    
    return strategies;
  }

  /**
   * Calculate front-running strategy for a swap
   * @param {Object} decodedTx Decoded transaction data
   * @param {Object} pairInfo Pair information with reserves
   * @param {number} priceImpact Price impact percentage (0-1)
   * @returns {Promise<Object|null>} Strategy details or null if not profitable
   */
  async calculateFrontrunStrategy(decodedTx, pairInfo, priceImpact) {
    try {
      // Only applicable for swaps with significant price impact
      if (priceImpact < 0.001) { // At least 0.1% price impact
        return null;
      }
      
      // Calculate optimal front-run amount (usually a fraction of victim's amount)
      const frontRunRatio = 0.5; // 50% of victim's amount
      const frontRunAmount = decodedTx.amountIn.mul(Math.floor(frontRunRatio * 100)).div(100);
      
      // Calculate expected output from front-run
      const frontRunOutput = getAmountOut(
        frontRunAmount,
        pairInfo.reserveIn,
        pairInfo.reserveOut
      );
      
      // Calculate new reserves after front-run
      const newReserveIn = pairInfo.reserveIn.add(frontRunAmount);
      const newReserveOut = pairInfo.reserveOut.sub(frontRunOutput);
      
      // Calculate victim's output after front-run
      const victimOutputAfterFrontRun = getAmountOut(
        decodedTx.amountIn,
        newReserveIn,
        newReserveOut
      );
      
      // Calculate price improvement for front-runner
      // (difference between getting in before vs. after victim)
      const outputWithoutFrontRun = getAmountOut(
        frontRunAmount,
        pairInfo.reserveIn.add(decodedTx.amountIn),
        pairInfo.reserveOut.sub(victimOutputAfterFrontRun)
      );
      
      const priceDifference = frontRunOutput.sub(outputWithoutFrontRun);
      
      // Estimate gas costs for front-running
      const gasCost = this.estimateGasCost(decodedTx, 'frontrun');
      
      // Calculate net profit
      const netProfit = priceDifference.sub(gasCost);
      
      // Check if profitable
      const profitRatio = netProfit.mul(10000).div(frontRunAmount);
      
      if (profitRatio.lt(Math.floor(this.options.minProfitRatioFrontrun * 10000))) {
        return null;
      }
      
      // Convert to USD value
      const netProfitUsd = await this.convertEthToUsd(netProfit);
      
      return {
        type: 'frontrun',
        estimatedProfit: netProfit,
        estimatedProfitUsd: netProfitUsd,
        frontRunAmount: frontRunAmount.toString(),
        frontRunOutput: frontRunOutput.toString(),
        gasCost: gasCost.toString(),
        profitRatioBps: profitRatio.toNumber(),
        targetHash: decodedTx.hash
      };
    } catch (error) {
      logger.error(`Error calculating front-run strategy for ${decodedTx.hash}:`, error);
      return null;
    }
  }

  /**
   * Calculate back-running strategy for a swap
   * @param {Object} decodedTx Decoded transaction data
   * @param {Object} pairInfo Pair information with reserves
   * @param {number} priceImpact Price impact percentage (0-1)
   * @returns {Promise<Object|null>} Strategy details or null if not profitable
   */
  async calculateBackrunStrategy(decodedTx, pairInfo, priceImpact) {
    try {
      // Only applicable for swaps with significant price impact
      if (priceImpact < 0.001) { // At least 0.1% price impact
        return null;
      }
      
      // Calculate new reserves after victim's swap
      const victimOutput = getAmountOut(
        decodedTx.amountIn,
        pairInfo.reserveIn,
        pairInfo.reserveOut
      );
      
      const newReserveIn = pairInfo.reserveIn.add(decodedTx.amountIn);
      const newReserveOut = pairInfo.reserveOut.sub(victimOutput);
      
      // For back-running, we trade in the opposite direction as the victim
      // (victim buys token, we sell token)
      const backRunAmount = victimOutput.mul(50).div(100); // 50% of victim's output
      
      // Calculate expected output from back-run
      const backRunOutput = getAmountOut(
        backRunAmount,
        newReserveOut, // token out for victim is token in for back-run
        newReserveIn  // token in for victim is token out for back-run
      );
      
      // Calculate price improvement for back-runner
      // (difference between trading after victim vs. before victim)
      const outputWithoutBackRun = getAmountOut(
        backRunAmount,
        pairInfo.reserveOut,
        pairInfo.reserveIn
      );
      
      const priceDifference = backRunOutput.sub(outputWithoutBackRun);
      
      // Estimate gas costs for back-running
      const gasCost = this.estimateGasCost(decodedTx, 'backrun');
      
      // Calculate net profit
      const netProfit = priceDifference.sub(gasCost);
      
      // Check if profitable
      const profitRatio = netProfit.mul(10000).div(backRunAmount);
      
      if (profitRatio.lt(Math.floor(this.options.minProfitRatioBackrun * 10000))) {
        return null;
      }
      
      // Convert to USD value
      const netProfitUsd = await this.convertEthToUsd(netProfit);
      
      return {
        type: 'backrun',
        estimatedProfit: netProfit,
        estimatedProfitUsd: netProfitUsd,
        backRunAmount: backRunAmount.toString(),
        backRunOutput: backRunOutput.toString(),
        gasCost: gasCost.toString(),
        profitRatioBps: profitRatio.toNumber(),
        targetHash: decodedTx.hash
      };
    } catch (error) {
      logger.error(`Error calculating back-run strategy for ${decodedTx.hash}:`, error);
      return null;
    }
  }

  /**
   * Calculate sandwich strategy (front-run + back-run) for a swap
   * @param {Object} decodedTx Decoded transaction data
   * @param {Object} pairInfo Pair information with reserves
   * @param {number} priceImpact Price impact percentage (0-1)
   * @returns {Promise<Object|null>} Strategy details or null if not profitable
   */
  async calculateSandwichStrategy(decodedTx, pairInfo, priceImpact) {
    try {
      // Only applicable for swaps with significant price impact
      if (priceImpact < 0.002) { // At least 0.2% price impact
        return null;
      }
      
      // Calculate optimal front-run amount (usually a fraction of victim's amount)
      const frontRunRatio = 0.5; // 50% of victim's amount
      const frontRunAmount = decodedTx.amountIn.mul(Math.floor(frontRunRatio * 100)).div(100);
      
      // Calculate expected output from front-run
      const frontRunOutput = getAmountOut(
        frontRunAmount,
        pairInfo.reserveIn,
        pairInfo.reserveOut
      );
      
      // Calculate new reserves after front-run
      const reserveInAfterFrontRun = pairInfo.reserveIn.add(frontRunAmount);
      const reserveOutAfterFrontRun = pairInfo.reserveOut.sub(frontRunOutput);
      
      // Calculate victim's output after front-run
      const victimOutputAfterFrontRun = getAmountOut(
        decodedTx.amountIn,
        reserveInAfterFrontRun,
        reserveOutAfterFrontRun
      );
      
      // Calculate new reserves after victim's swap
      const reserveInAfterVictim = reserveInAfterFrontRun.add(decodedTx.amountIn);
      const reserveOutAfterVictim = reserveOutAfterFrontRun.sub(victimOutputAfterFrontRun);
      
      // For back-run, we swap the token we received in the front-run
      const backRunAmount = frontRunOutput;
      
      // Calculate expected output from back-run
      const backRunOutput = getAmountOut(
        backRunAmount,
        reserveOutAfterVictim, // token out from front-run is token in for back-run
        reserveInAfterVictim  // token in from front-run is token out for back-run
      );
      
      // Calculate profit (difference between back-run output and front-run input)
      const grossProfit = backRunOutput.sub(frontRunAmount);
      
      // Estimate gas costs for sandwich attack (front-run + back-run)
      const gasCost = this.estimateGasCost(decodedTx, 'sandwich');
      
      // Calculate net profit
      const netProfit = grossProfit.sub(gasCost);
      
      // Check if profitable
      const profitRatio = netProfit.mul(10000).div(frontRunAmount);
      
      // Minimum profit ratio is higher for sandwich (more complex, more risk)
      const minProfitRatioSandwich = Math.floor((this.options.minProfitRatioFrontrun + this.options.minProfitRatioBackrun) * 10000);
      
      if (profitRatio.lt(minProfitRatioSandwich)) {
        return null;
      }
      
      // Convert to USD value
      const netProfitUsd = await this.convertEthToUsd(netProfit);
      
      return {
        type: 'sandwich',
        estimatedProfit: netProfit,
        estimatedProfitUsd: netProfitUsd,
        frontRunAmount: frontRunAmount.toString(),
        frontRunOutput: frontRunOutput.toString(),
        backRunOutput: backRunOutput.toString(),
        victimOutput: victimOutputAfterFrontRun.toString(),
        gasCost: gasCost.toString(),
        profitRatioBps: profitRatio.toNumber(),
        targetHash: decodedTx.hash
      };
    } catch (error) {
      logger.error(`Error calculating sandwich strategy for ${decodedTx.hash}:`, error);
      return null;
    }
  }

  /**
   * Analyze a flash loan transaction
   * @param {Object} decodedTx Decoded transaction data
   * @param {Object} result Analysis result to build upon
   * @returns {Promise<Object>} Updated analysis results
   */
  async analyzeFlashLoan(decodedTx, result) {
    // For flash loans, we mainly track them but don't extract MEV opportunities directly
    // They can be useful signals for pending complex MEV operations
    
    result.details.flashLoan = {
      protocol: decodedTx.protocol,
      tokens: decodedTx.tokens?.map(t => t.toString()) || [],
      amounts: decodedTx.amounts?.map(a => a.toString()) || [],
      totalValueETH: decodedTx.totalValueETH || '0',
      totalValueUSD: decodedTx.totalValueUSD || '0'
    };
    
    // Flash loans over certain size might be worth monitoring for complex MEV
    if (
      decodedTx.totalValueETH && 
      ethers.utils.parseEther(decodedTx.totalValueETH).gt(ethers.utils.parseEther('100'))
    ) {
      result.isPotentialInterest = true;
      result.interestReason = 'large-flash-loan';
    }
    
    return result;
  }

  /**
   * Analyze a liquidation transaction
   * @param {Object} decodedTx Decoded transaction data
   * @param {Object} result Analysis result to build upon
   * @returns {Promise<Object>} Updated analysis results
   */
  async analyzeLiquidation(decodedTx, result) {
    // Liquidations can be MEV opportunities themselves, but also
    // signals for potential market movements
    
    result.details.liquidation = {
      protocol: decodedTx.protocol,
      user: decodedTx.user,
      collateralAsset: decodedTx.collateralAsset,
      collateralSymbol: decodedTx.collateralInfo?.symbol || 'Unknown',
      debtAsset: decodedTx.debtAsset,
      debtSymbol: decodedTx.debtInfo?.symbol || 'Unknown',
      debtToCover: decodedTx.debtToCover?.toString() || '0',
      debtToCoverFormatted: decodedTx.debtToCoverFormatted || '0',
      valueETH: decodedTx.valueETH || '0',
      valueUSD: decodedTx.valueUSD || '0'
    };
    
    // Liquidations over certain size are notable
    if (
      decodedTx.valueETH && 
      ethers.utils.parseEther(decodedTx.valueETH).gt(ethers.utils.parseEther('5'))
    ) {
      result.isPotentialInterest = true;
      result.interestReason = 'large-liquidation';
    }
    
    return result;
  }

  /**
   * Analyze an ERC20 transfer transaction
   * @param {Object} decodedTx Decoded transaction data
   * @param {Object} result Analysis result to build upon
   * @returns {Promise<Object>} Updated analysis results
   */
  async analyzeERC20Transfer(decodedTx, result) {
    // For simple ERC20 transfers, we often don't get direct MEV opportunities
    // but there can be signals for upcoming actions
    
    result.details.erc20Transfer = {
      token: decodedTx.tokenAddress,
      tokenSymbol: decodedTx.tokenInfo?.symbol || 'Unknown',
      from: decodedTx.from,
      to: decodedTx.to,
      amount: decodedTx.amount?.toString() || '0',
      amountFormatted: decodedTx.amountFormatted || '0',
      valueETH: decodedTx.valueETH || '0',
      valueUSD: decodedTx.valueUSD || '0'
    };
    
    // Large transfers to DEX router addresses might indicate pending swaps
    const isDexAddress = Object.values(DEX_ADDRESSES)
      .map(addr => addr.toLowerCase())
      .includes(decodedTx.to?.toLowerCase());
    
    if (
      isDexAddress && 
      decodedTx.valueETH &&
      ethers.utils.parseEther(decodedTx.valueETH).gt(ethers.utils.parseEther('10'))
    ) {
      result.isPotentialInterest = true;
      result.interestReason = 'large-transfer-to-dex';
    }
    
    return result;
  }

  /**
   * Get pair information and reserves for two tokens
   * @param {string} tokenA First token address
   * @param {string} tokenB Second token address
   * @returns {Promise<Object|null>} Pair information or null if not found
   */
  async getPairInfo(tokenA, tokenB) {
    try {
      const reserves = await getReserves(tokenA, tokenB, this.provider);
      
      if (!reserves) {
        return null;
      }
      
      return {
        pairAddress: reserves.pairAddress,
        reserveIn: reserves.reserveA,
        reserveOut: reserves.reserveB,
        tokenA: tokenA,
        tokenB: tokenB
      };
    } catch (error) {
      logger.error(`Error getting pair info for ${tokenA}-${tokenB}:`, error);
      return null;
    }
  }

  /**
   * Calculate price impact of a swap
   * @param {Object} decodedTx Decoded transaction data
   * @param {Object} pairInfo Pair information with reserves
   * @returns {Promise<number>} Price impact as a decimal (0.01 = 1%)
   */
  async calculatePriceImpact(decodedTx, pairInfo) {
    try {
      if (!decodedTx.amountIn || !pairInfo) {
        return 0;
      }
      
      const priceImpact = getPriceImpact(
        decodedTx.amountIn,
        pairInfo.reserveIn,
        pairInfo.reserveOut
      );
      
      return priceImpact;
    } catch (error) {
      logger.error(`Error calculating price impact:`, error);
      return 0;
    }
  }

  /**
   * Estimate gas cost for an MEV operation
   * @param {Object} victimTx Victim transaction data
   * @param {string} strategyType Type of MEV strategy
   * @returns {Promise<BigNumber>} Estimated gas cost in ETH
   */
  estimateGasCost(victimTx, strategyType) {
    // Get base gas price from victim transaction
    let baseGasPrice;
    if (victimTx.maxFeePerGas) {
      baseGasPrice = victimTx.maxFeePerGas;
    } else if (victimTx.gasPrice) {
      baseGasPrice = victimTx.gasPrice;
    } else {
      // Default fallback
      baseGasPrice = ethers.utils.parseUnits('50', 'gwei');
    }
    
    // Adjust gas price based on strategy type
    let gasPrice;
    let gasLimit;
    
    switch (strategyType) {
      case 'frontrun':
        // For front-running, we need a higher gas price to get in before victim
        gasPrice = baseGasPrice.mul(120).div(100); // 20% higher
        gasLimit = 150000; // Basic swap gas
        break;
        
      case 'backrun':
        // For back-running, we can use a lower gas price
        gasPrice = baseGasPrice.mul(105).div(100); // 5% higher
        gasLimit = 150000; // Basic swap gas
        break;
        
      case 'sandwich':
        // For sandwich, we need a higher gas price and more gas
        gasPrice = baseGasPrice.mul(120).div(100); // 20% higher
        gasLimit = 350000; // Two swaps + additional logic
        break;
        
      case 'arbitrage':
        // For arbitrage, we use a competitive but not extreme gas price
        gasPrice = baseGasPrice.mul(110).div(100); // 10% higher
        gasLimit = 400000; // Complex logic across multiple DEXes
        break;
        
      default:
        // Default values
        gasPrice = baseGasPrice.mul(110).div(100);
        gasLimit = 200000;
    }
    
    // Calculate gas cost
    return gasPrice.mul(gasLimit);
  }

  /**
   * Convert ETH amount to USD value
   * @param {BigNumber} ethAmount Amount in ETH (wei)
   * @returns {Promise<string>} USD value formatted as string
   */
  async convertEthToUsd(ethAmount) {
    try {
      // ETH/USD price lookup (could be cached/optimized)
      const ethPrice = 2000; // Simplified example - should use real price feed
      
      const ethValue = parseFloat(ethers.utils.formatEther(ethAmount));
      const usdValue = ethValue * ethPrice;
      
      return usdValue.toFixed(2);
    } catch (error) {
      logger.error('Error converting ETH to USD:', error);
      return '0.00';
    }
  }

  /**
   * Store a pending swap for potential cross-DEX arbitrage opportunities
   * @param {Object} decodedTx Decoded transaction data
   * @param {Object} pairInfo Pair information with reserves
   * @param {number} priceImpact Price impact as a decimal
   */
  storePendingSwap(decodedTx, pairInfo, priceImpact) {
    // Only store swaps with significant price impact
    if (priceImpact < 0.002) {
      return;
    }
    
    this.pendingSwaps.set(decodedTx.hash, {
      tx: decodedTx,
      pairInfo,
      priceImpact,
      timestamp: Date.now()
    });
    
    // Clean up old entries
    this.cleanupPendingSwaps();
  }

  /**
   * Clean up old pending swaps to prevent memory leaks
   */
  cleanupPendingSwaps() {
    const now = Date.now();
    const maxAge = 60000; // 1 minute TTL
    
    for (const [hash, swapInfo] of this.pendingSwaps.entries()) {
      if (now - swapInfo.timestamp > maxAge) {
        this.pendingSwaps.delete(hash);
      }
    }
  }

  /**
   * Find potential cross-DEX arbitrage opportunities
   * @returns {Promise<Array>} Array of arbitrage opportunities
   */
  async findArbitrageOpportunities() {
    const opportunities = [];
    
    // Simplified example - in production would compare prices across multiple DEXes
    
    return opportunities;
  }
}

module.exports = {
  TxAnalyzer
};