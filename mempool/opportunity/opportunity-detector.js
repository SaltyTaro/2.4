/**
 * MEV Opportunity Detector
 * Analyzes transaction data and market conditions to find MEV opportunities
 */
const ethers = require("hardhat");
const { Logger } = require("../../infrastructure/logging");
const { StrategySimulator } = require("./strategy-simulator");
const { DEX_ADDRESSES, TOKEN_ADDRESSES } = require("../../utils/constants");
const { findMultiHopPath } = require("../../utils/path-finder");
const { getReserves, getAmountOut } = require("../../utils/dex-utils");
const { getPriceInEth, getPriceInUsd } = require("../../utils/price-utils");

// Logger setup
const logger = new Logger("OpportunityDetector");

class OpportunityDetector {
  constructor(options = {}) {
    this.options = {
      minProfitThreshold: ethers.utils.parseEther("0.01"), // 0.01 ETH
      minProfitThresholdUsd: 50, // $50 USD
      minRoiBps: 50, // 0.5% minimum ROI
      maxExposure: ethers.utils.parseEther("100"), // Maximum 100 ETH exposure
      maxPoolUsageBps: 100, // 1% maximum pool reserves usage
      blacklistedAddresses: [], // Addresses to avoid targeting
      blacklistedTokens: [], // Tokens to avoid
      rpcUrl: process.env.ETH_RPC_URL || "https://eth-mainnet.alchemyapi.io/v2/your-api-key",
      ...options
    };
    
    this.provider = null;
    this.simulator = null;
    this.detectedOpportunities = new Map(); // Track detected opportunities
    this.executedOpportunities = new Map(); // Track executed opportunities
    this.successfulOpportunities = new Map(); // Track successful opportunities
    
    // Stats
    this.stats = {
      opportunitiesDetected: 0,
      opportunitiesSent: 0,
      opportunitiesExecuted: 0,
      opportunitiesSuccessful: 0,
      totalProfitETH: ethers.BigNumber.from(0),
      totalProfitUSD: 0,
      totalGasSpentETH: ethers.BigNumber.from(0),
      totalGasSpentUSD: 0
    };
  }

  /**
   * Initialize the opportunity detector
   */
  async initialize() {
    try {
      logger.info("Initializing opportunity detector...");
      
      // Create provider
      this.provider = new ethers.providers.JsonRpcProvider(this.options.rpcUrl);
      
      // Create simulator
      this.simulator = new StrategySimulator({
        provider: this.provider
      });
      await this.simulator.initialize();
      
      logger.info("Opportunity detector initialized successfully");
      return true;
    } catch (error) {
      logger.error("Failed to initialize opportunity detector:", error);
      throw error;
    }
  }

  /**
   * Detect MEV opportunities from analyzed transaction data
   * @param {Object} analysis Transaction analysis result
   * @param {Object} gasInfo Gas price information
   * @returns {Promise<Object|null>} Detected opportunity or null
   */
  async detectOpportunity(analysis, gasInfo) {
    try {
      // Skip if not a potential opportunity
      if (!analysis.isPotentialOpportunity) {
        return null;
      }
      
      // Skip if blacklisted tokens are involved
      if (
        this.options.blacklistedTokens.includes(analysis.details?.swap?.tokenIn?.toLowerCase()) ||
        this.options.blacklistedTokens.includes(analysis.details?.swap?.tokenOut?.toLowerCase())
      ) {
        return null;
      }
      
      // Basic opportunity structure
      const opportunity = {
        hash: analysis.hash,
        type: null,
        strategies: [],
        bestStrategy: null,
        estimatedProfit: ethers.constants.Zero,
        estimatedProfitUsd: "0.00",
        gasInfo,
        targetTx: analysis.details?.swap || {},
        timestamp: Date.now()
      };
      
      // Determine opportunity type and best strategy
      if (analysis.opportunityTypes.includes("sandwich")) {
        opportunity.type = "sandwich";
        
        // Get sandwich strategy details
        const sandwichStrategy = analysis.strategies.find(s => s.type === "sandwich");
        if (sandwichStrategy) {
          // Simulate the strategy to verify profit
          const simulationResult = await this.simulator.simulateSandwich(
            analysis.details.swap.tokenIn,
            analysis.details.swap.tokenOut,
            ethers.BigNumber.from(sandwichStrategy.frontRunAmount),
            ethers.BigNumber.from(analysis.details.swap.amountIn),
            analysis.details.swap.pairAddress
          );
          
          if (simulationResult.isProfit && simulationResult.profit.gt(this.options.minProfitThreshold)) {
            // Create the detailed strategy
            const detailedStrategy = await this.createSandwichStrategy(
              analysis,
              sandwichStrategy,
              simulationResult,
              gasInfo
            );
            
            if (detailedStrategy) {
              opportunity.strategies.push(detailedStrategy);
              opportunity.bestStrategy = detailedStrategy;
              opportunity.estimatedProfit = detailedStrategy.estimatedProfit;
              opportunity.estimatedProfitUsd = detailedStrategy.estimatedProfitUsd;
            }
          }
        }
      } else if (analysis.opportunityTypes.includes("arbitrage")) {
        opportunity.type = "arbitrage";
        
        // Get arbitrage strategy details
        const arbitrageStrategy = analysis.strategies.find(s => s.type === "arbitrage");
        if (arbitrageStrategy) {
          // Simulate the strategy to verify profit
          const simulationResult = await this.simulator.simulateArbitrage(
            arbitrageStrategy.sourcePool,
            arbitrageStrategy.targetPool,
            ethers.BigNumber.from(arbitrageStrategy.amount)
          );
          
          if (simulationResult.isProfit && simulationResult.profit.gt(this.options.minProfitThreshold)) {
            // Create the detailed strategy
            const detailedStrategy = await this.createArbitrageStrategy(
              analysis,
              arbitrageStrategy,
              simulationResult,
              gasInfo
            );
            
            if (detailedStrategy) {
              opportunity.strategies.push(detailedStrategy);
              opportunity.bestStrategy = detailedStrategy;
              opportunity.estimatedProfit = detailedStrategy.estimatedProfit;
              opportunity.estimatedProfitUsd = detailedStrategy.estimatedProfitUsd;
            }
          }
        }
      } else if (analysis.opportunityTypes.includes("frontrun") || analysis.opportunityTypes.includes("backrun")) {
        // Front-run or back-run (not sandwich)
        opportunity.type = analysis.opportunityTypes.includes("frontrun") ? "frontrun" : "backrun";
        
        // Get the strategy details
        const strategy = analysis.strategies.find(s => s.type === opportunity.type);
        if (strategy) {
          // For simple front-run or back-run, we create the strategy more directly
          const detailedStrategy = await this.createSimpleStrategy(
            analysis,
            strategy,
            gasInfo
          );
          
          if (detailedStrategy) {
            opportunity.strategies.push(detailedStrategy);
            opportunity.bestStrategy = detailedStrategy;
            opportunity.estimatedProfit = detailedStrategy.estimatedProfit;
            opportunity.estimatedProfitUsd = detailedStrategy.estimatedProfitUsd;
          }
        }
      }
      
      // Check if we found any valid strategies
      if (opportunity.strategies.length === 0 || !opportunity.bestStrategy) {
        return null;
      }
      
      // Check profitability thresholds
      if (
        opportunity.estimatedProfit.lt(this.options.minProfitThreshold) ||
        parseFloat(opportunity.estimatedProfitUsd) < this.options.minProfitThresholdUsd
      ) {
        return null;
      }
      
      // Store the opportunity
      this.storeOpportunity(opportunity);
      
      // Update stats
      this.stats.opportunitiesDetected++;
      
      return opportunity;
    } catch (error) {
      logger.error(`Error detecting opportunity for transaction ${analysis.hash}:`, error);
      return null;
    }
  }

  /**
   * Create a detailed sandwich strategy
   * @param {Object} analysis Transaction analysis
   * @param {Object} strategy Basic strategy information
   * @param {Object} simulation Simulation results
   * @param {Object} gasInfo Gas price information
   * @returns {Promise<Object|null>} Detailed strategy or null
   */
  async createSandwichStrategy(analysis, strategy, simulation, gasInfo) {
    try {
      // Get swap details
      const swap = analysis.details.swap;
      
      // Calculate gas costs
      const gasPrice = gasInfo.type === 2 ? gasInfo.maxFeePerGas : gasInfo.gasPrice;
      const frontRunGasLimit = 200000; // Gas limit for front-run tx
      const backRunGasLimit = 200000; // Gas limit for back-run tx
      const totalGasLimit = frontRunGasLimit + backRunGasLimit;
      const gasCost = gasPrice.mul(totalGasLimit);
      
      // Adjust profit for gas costs
      const netProfit = simulation.profit.sub(gasCost);
      
      // Check if still profitable after gas
      if (netProfit.lte(0)) {
        return null;
      }
      
      // Calculate ROI
      const frontRunAmount = ethers.BigNumber.from(strategy.frontRunAmount);
      const roiBps = netProfit.mul(10000).div(frontRunAmount);
      
      // Check minimum ROI
      if (roiBps.lt(this.options.minRoiBps)) {
        return null;
      }
      
      // Calculate optimal front-run amount (cap at pool limits)
      const reserveIn = ethers.BigNumber.from(swap.reserveIn);
      const maxAmount = reserveIn.mul(this.options.maxPoolUsageBps).div(10000); // e.g., 1% of pool
      
      const optimizedFrontRunAmount = frontRunAmount.gt(maxAmount) ? maxAmount : frontRunAmount;
      
      // Calculate estimated profit in USD
      const profitUsd = await this.convertEthToUsd(netProfit);
      
      // Create the detailed strategy
      return {
        type: "sandwich",
        targetHash: analysis.hash,
        pairAddress: swap.pairAddress,
        tokenIn: swap.tokenIn,
        tokenOut: swap.tokenOut,
        tokenInSymbol: swap.tokenInSymbol,
        tokenOutSymbol: swap.tokenOutSymbol,
        frontRunAmount: optimizedFrontRunAmount.toString(),
        victimAmount: swap.amountIn,
        estimatedProfit: netProfit,
        estimatedProfitUsd: profitUsd,
        gasInfo: {
          gasPrice: gasPrice.toString(),
          frontRunGasLimit,
          backRunGasLimit,
          totalGasLimit,
          gasCost: gasCost.toString()
        },
        roiBps: roiBps.toNumber(),
        execution: {
          frontRunParams: {
            router: DEX_ADDRESSES.UNISWAP_V2_ROUTER,
            tokenIn: swap.tokenIn,
            tokenOut: swap.tokenOut,
            amountIn: optimizedFrontRunAmount.toString(),
            amountOutMin: "0", // Set to 0 for simplicity - in production would use slippage tolerance
            path: [swap.tokenIn, swap.tokenOut],
            deadline: Math.floor(Date.now() / 1000) + 300 // 5 minutes
          },
          backRunParams: {
            router: DEX_ADDRESSES.UNISWAP_V2_ROUTER,
            tokenIn: swap.tokenOut, // Reversed for back-run
            tokenOut: swap.tokenIn, // Reversed for back-run
            amountInEstimated: simulation.frontRunOutput.toString(),
            amountOutMin: "0", // Set to 0 for simplicity - in production would use slippage tolerance
            path: [swap.tokenOut, swap.tokenIn],
            deadline: Math.floor(Date.now() / 1000) + 300 // 5 minutes
          }
        }
      };
    } catch (error) {
      logger.error(`Error creating sandwich strategy:`, error);
      return null;
    }
  }

  /**
   * Create a detailed arbitrage strategy
   * @param {Object} analysis Transaction analysis
   * @param {Object} strategy Basic strategy information
   * @param {Object} simulation Simulation results
   * @param {Object} gasInfo Gas price information
   * @returns {Promise<Object|null>} Detailed strategy or null
   */
  async createArbitrageStrategy(analysis, strategy, simulation, gasInfo) {
    try {
      // Calculate gas costs
      const gasPrice = gasInfo.type === 2 ? gasInfo.maxFeePerGas : gasInfo.gasPrice;
      const gasLimit = 400000; // Complex arbitrage requires more gas
      const gasCost = gasPrice.mul(gasLimit);
      
      // Adjust profit for gas costs
      const netProfit = simulation.profit.sub(gasCost);
      
      // Check if still profitable after gas
      if (netProfit.lte(0)) {
        return null;
      }
      
      // Calculate ROI
      const arbAmount = ethers.BigNumber.from(strategy.amount);
      const roiBps = netProfit.mul(10000).div(arbAmount);
      
      // Check minimum ROI
      if (roiBps.lt(this.options.minRoiBps)) {
        return null;
      }
      
      // Calculate USD value of profit
      const profitUsd = await this.convertEthToUsd(netProfit);
      
      // Create the detailed strategy
      return {
        type: "arbitrage",
        sourcePool: strategy.sourcePool,
        targetPool: strategy.targetPool,
        tokenA: strategy.tokenA,
        tokenB: strategy.tokenB,
        amount: arbAmount.toString(),
        estimatedProfit: netProfit,
        estimatedProfitUsd: profitUsd,
        gasInfo: {
          gasPrice: gasPrice.toString(),
          gasLimit,
          gasCost: gasCost.toString()
        },
        roiBps: roiBps.toNumber(),
        execution: {
          // Execution parameters
          sourceRouter: DEX_ADDRESSES.UNISWAP_V2_ROUTER,
          targetRouter: DEX_ADDRESSES.SUSHISWAP_ROUTER,
          tokenIn: strategy.tokenA,
          tokenMid: strategy.tokenB,
          amountIn: arbAmount.toString(),
          sourceAmountOutMin: "0", // Would use slippage tolerance in production
          targetAmountOutMin: "0", // Would use slippage tolerance in production
          deadline: Math.floor(Date.now() / 1000) + 300 // 5 minutes
        }
      };
    } catch (error) {
      logger.error(`Error creating arbitrage strategy:`, error);
      return null;
    }
  }

  /**
   * Create a detailed simple strategy (front-run or back-run)
   * @param {Object} analysis Transaction analysis
   * @param {Object} strategy Basic strategy information
   * @param {Object} gasInfo Gas price information
   * @returns {Promise<Object|null>} Detailed strategy or null
   */
  async createSimpleStrategy(analysis, strategy, gasInfo) {
    try {
      // Get swap details
      const swap = analysis.details.swap;
      
      // Calculate gas costs
      const gasPrice = gasInfo.type === 2 ? gasInfo.maxFeePerGas : gasInfo.gasPrice;
      const gasLimit = 200000; // Gas limit for a single swap
      const gasCost = gasPrice.mul(gasLimit);
      
      // Adjust profit for gas costs
      const netProfit = ethers.BigNumber.from(strategy.estimatedProfit).sub(gasCost);
      
      // Check if still profitable after gas
      if (netProfit.lte(0)) {
        return null;
      }
      
      // Calculate ROI
      let amount;
      if (strategy.type === "frontrun") {
        amount = ethers.BigNumber.from(strategy.frontRunAmount);
      } else {
        amount = ethers.BigNumber.from(strategy.backRunAmount);
      }
      
      const roiBps = netProfit.mul(10000).div(amount);
      
      // Check minimum ROI
      if (roiBps.lt(this.options.minRoiBps)) {
        return null;
      }
      
      // Calculate optimal amount (cap at pool limits)
      const reserveIn = ethers.BigNumber.from(swap.reserveIn);
      const maxAmount = reserveIn.mul(this.options.maxPoolUsageBps).div(10000); // e.g., 1% of pool
      
      const optimizedAmount = amount.gt(maxAmount) ? maxAmount : amount;
      
      // Calculate USD value of profit
      const profitUsd = await this.convertEthToUsd(netProfit);
      
      // Create the detailed strategy
      if (strategy.type === "frontrun") {
        return {
          type: "frontrun",
          targetHash: analysis.hash,
          pairAddress: swap.pairAddress,
          tokenIn: swap.tokenIn,
          tokenOut: swap.tokenOut,
          tokenInSymbol: swap.tokenInSymbol,
          tokenOutSymbol: swap.tokenOutSymbol,
          amount: optimizedAmount.toString(),
          estimatedProfit: netProfit,
          estimatedProfitUsd: profitUsd,
          gasInfo: {
            gasPrice: gasPrice.toString(),
            gasLimit,
            gasCost: gasCost.toString()
          },
          roiBps: roiBps.toNumber(),
          execution: {
            params: {
              router: DEX_ADDRESSES.UNISWAP_V2_ROUTER,
              tokenIn: swap.tokenIn,
              tokenOut: swap.tokenOut,
              amountIn: optimizedAmount.toString(),
              amountOutMin: "0", // Set to 0 for simplicity - in production would use slippage tolerance
              path: [swap.tokenIn, swap.tokenOut],
              deadline: Math.floor(Date.now() / 1000) + 300 // 5 minutes
            }
          }
        };
      } else { // backrun
        return {
          type: "backrun",
          targetHash: analysis.hash,
          pairAddress: swap.pairAddress,
          tokenIn: swap.tokenOut, // Reversed for back-run
          tokenOut: swap.tokenIn, // Reversed for back-run
          tokenInSymbol: swap.tokenOutSymbol,
          tokenOutSymbol: swap.tokenInSymbol,
          amount: optimizedAmount.toString(),
          estimatedProfit: netProfit,
          estimatedProfitUsd: profitUsd,
          gasInfo: {
            gasPrice: gasPrice.toString(),
            gasLimit,
            gasCost: gasCost.toString()
          },
          roiBps: roiBps.toNumber(),
          execution: {
            params: {
              router: DEX_ADDRESSES.UNISWAP_V2_ROUTER,
              tokenIn: swap.tokenOut, // Reversed for back-run
              tokenOut: swap.tokenIn, // Reversed for back-run
              amountIn: optimizedAmount.toString(),
              amountOutMin: "0", // Set to 0 for simplicity - in production would use slippage tolerance
              path: [swap.tokenOut, swap.tokenIn],
              deadline: Math.floor(Date.now() / 1000) + 300 // 5 minutes
            }
          }
        };
      }
    } catch (error) {
      logger.error(`Error creating simple strategy:`, error);
      return null;
    }
  }

  /**
   * Store a detected opportunity
   * @param {Object} opportunity The opportunity to store
   */
  storeOpportunity(opportunity) {
    this.detectedOpportunities.set(opportunity.hash, opportunity);
    
    // Clean up old opportunities
    this.cleanupOpportunities();
  }

  /**
   * Clean up old opportunities
   */
  cleanupOpportunities() {
    const now = Date.now();
    const maxAge = 300000; // 5 minutes TTL
    
    for (const [hash, opportunity] of this.detectedOpportunities.entries()) {
      if (now - opportunity.timestamp > maxAge) {
        this.detectedOpportunities.delete(hash);
      }
    }
  }

  /**
   * Mark an opportunity as executed
   * @param {Object} opportunity The executed opportunity
   * @param {Object} txInfo Transaction information
   */
  markOpportunityExecuted(opportunity, txInfo) {
    opportunity.executionTimestamp = Date.now();
    opportunity.executionTxHash = txInfo.hash;
    opportunity.executionStatus = "pending";
    
    this.executedOpportunities.set(opportunity.hash, opportunity);
    this.stats.opportunitiesExecuted++;
  }

  /**
   * Mark an opportunity as successful
   * @param {Object} opportunity The successful opportunity
   * @param {Object} receipt Transaction receipt
   * @param {BigNumber} profit Actual profit amount
   */
  markOpportunitySuccessful(opportunity, receipt, profit) {
    opportunity.executionStatus = "success";
    opportunity.gasUsed = receipt.gasUsed;
    opportunity.actualProfit = profit;
    
    const profitUsd = this.convertEthToUsd(profit);
    opportunity.actualProfitUsd = profitUsd;
    
    this.successfulOpportunities.set(opportunity.hash, opportunity);
    this.stats.opportunitiesSuccessful++;
    this.stats.totalProfitETH = this.stats.totalProfitETH.add(profit);
    this.stats.totalProfitUSD += parseFloat(profitUsd);
    
    const gasPrice = opportunity.gasInfo.type === 2 ? 
      opportunity.gasInfo.maxFeePerGas : 
      opportunity.gasInfo.gasPrice;
    
    const gasSpent = ethers.BigNumber.from(gasPrice).mul(receipt.gasUsed);
    this.stats.totalGasSpentETH = this.stats.totalGasSpentETH.add(gasSpent);
    
    const gasSpentUsd = this.convertEthToUsd(gasSpent);
    this.stats.totalGasSpentUSD += parseFloat(gasSpentUsd);
  }

  /**
   * Look for multi-hop arbitrage opportunities
   * @param {Array} tokenPairs Array of token pairs to check
   * @param {number} maxHops Maximum hops to consider
   * @returns {Promise<Array>} Array of multi-hop opportunities
   */
  async findMultiHopOpportunities(tokenPairs, maxHops = 3) {
    try {
      const opportunities = [];
      
      // For each token pair, try to find profitable paths
      for (const pair of tokenPairs) {
        const { tokenA, tokenB } = pair;
        
        // Find potential paths
        const paths = await findMultiHopPath(tokenA, tokenB, maxHops, this.provider);
        
        for (const path of paths) {
          // Simulate the multi-hop path to check profitability
          const simulation = await this.simulator.simulateMultiHop(
            path.tokens,
            path.pairs,
            ethers.utils.parseEther("1") // Start with 1 ETH for simulation
          );
          
          if (simulation.isProfit && simulation.profit.gt(this.options.minProfitThreshold)) {
            // Calculate optimal amount
            const optimalAmount = await this.findOptimalMultiHopAmount(path, simulation);
            
            // Calculate gas costs
            const gasPrice = ethers.utils.parseUnits("50", "gwei"); // Example gas price
            const gasLimit = 600000; // Higher gas for multi-hop
            const gasCost = gasPrice.mul(gasLimit);
            
            // Calculate net profit
            const netProfit = simulation.profit.mul(optimalAmount).div(ethers.utils.parseEther("1")).sub(gasCost);
            
            if (netProfit.gt(this.options.minProfitThreshold)) {
              const profitUsd = await this.convertEthToUsd(netProfit);
              
              opportunities.push({
                type: "multihop",
                path: path,
                tokens: path.tokens,
                pairs: path.pairs,
                amount: optimalAmount.toString(),
                estimatedProfit: netProfit,
                estimatedProfitUsd: profitUsd,
                gasInfo: {
                  gasPrice: gasPrice.toString(),
                  gasLimit,
                  gasCost: gasCost.toString()
                },
                roiBps: netProfit.mul(10000).div(optimalAmount).toNumber()
              });
            }
          }
        }
      }
      
      return opportunities;
    } catch (error) {
      logger.error(`Error finding multi-hop opportunities:`, error);
      return [];
    }
  }

  /**
   * Find the optimal amount for a multi-hop opportunity
   * @param {Object} path The multi-hop path
   * @param {Object} simulation Simulation results
   * @returns {Promise<BigNumber>} Optimal amount
   */
  async findOptimalMultiHopAmount(path, simulation) {
    try {
      // Test different amounts to find optimal
      const testAmounts = [
        ethers.utils.parseEther("0.1"),
        ethers.utils.parseEther("0.5"),
        ethers.utils.parseEther("1"),
        ethers.utils.parseEther("5"),
        ethers.utils.parseEther("10"),
        ethers.utils.parseEther("50")
      ];
      
      let bestAmount = ethers.utils.parseEther("1"); // Default
      let bestProfit = simulation.profit;
      
      for (const amount of testAmounts) {
        // Cap at maximum exposure
        if (amount.gt(this.options.maxExposure)) {
          continue;
        }
        
        // Simulate with this amount
        const sim = await this.simulator.simulateMultiHop(
          path.tokens,
          path.pairs,
          amount
        );
        
        if (sim.isProfit && sim.profit.gt(bestProfit)) {
          bestAmount = amount;
          bestProfit = sim.profit;
        }
      }
      
      return bestAmount;
    } catch (error) {
      logger.error(`Error finding optimal multi-hop amount:`, error);
      return ethers.utils.parseEther("1"); // Default fallback
    }
  }

  /**
   * Convert ETH amount to USD value
   * @param {BigNumber} ethAmount Amount in ETH (wei)
   * @returns {Promise<string>} USD value formatted as string
   */
  async convertEthToUsd(ethAmount) {
    try {
      // Get ETH/USD price
      const ethPriceInUsd = await getPriceInUsd(TOKEN_ADDRESSES.WETH, this.provider);
      
      const ethValue = parseFloat(ethers.utils.formatEther(ethAmount));
      const usdValue = ethValue * parseFloat(ethPriceInUsd);
      
      return usdValue.toFixed(2);
    } catch (error) {
      logger.error("Error converting ETH to USD:", error);
      return "0.00";
    }
  }

  /**
   * Get statistics on detected opportunities
   * @returns {Object} Statistics
   */
  getStats() {
    return {
      ...this.stats,
      currentOpportunities: this.detectedOpportunities.size,
      executedOpportunities: this.executedOpportunities.size,
      successfulOpportunities: this.successfulOpportunities.size
    };
  }
}

module.exports = {
  OpportunityDetector
};