/**
 * Main entry point for the MEV Strategy project
 */
const { ethers } = require("hardhat");
const { MempoolMonitor } = require("./mempool");
const { KeyManager } = require("./infrastructure/key-manager");
const { RiskManager } = require("./infrastructure/risk-manager");
const { NotificationService } = require("./infrastructure/notification-service");
const { Logger } = require("./infrastructure/logging");
const { getNetworkConfig } = require("./config/strategy-config");
const { networks, getNetworkByName } = require("./config/networks");
require("dotenv").config();

// Create logger
const logger = new Logger("MEVStrategy");

// Main application class
class MEVStrategyApp {
  constructor(options = {}) {
    this.options = {
      network: process.env.NETWORK || "mainnet",
      strategyConfig: null,
      rpcUrl: process.env.ETH_RPC_URL,
      ...options
    };
    
    // Initialize components
    this.keyManager = new KeyManager();
    this.riskManager = new RiskManager();
    this.notificationService = new NotificationService();
    
    // Network and strategy configuration
    this.networkConfig = getNetworkByName(this.options.network);
    this.strategyConfig = this.options.strategyConfig || getNetworkConfig(this.options.network);
    
    // Mempool monitoring
    this.mempoolMonitor = null;
    
    // Contract instances
    this.mevStrategy = null;
    this.provider = null;
    
    // Status
    this.isRunning = false;
  }
  
  /**
   * Initialize the application
   */
  async initialize() {
    try {
      logger.info("Initializing MEV Strategy application...");
      
      // Initialize infrastructure components
      await this.keyManager.initialize();
      await this.riskManager.initialize();
      await this.notificationService.initialize();
      
      // Create provider
      this.provider = new ethers.providers.JsonRpcProvider(
        this.options.rpcUrl || this.networkConfig.rpcUrls[0]
      );
      
      // Connect to deployed contracts or deploy if needed
      await this.connectToContracts();
      
      // Initialize mempool monitoring
      this.mempoolMonitor = new MempoolMonitor({
        rpcUrl: this.options.rpcUrl || this.networkConfig.rpcUrls[0],
        targetPairs: this.strategyConfig.targetPairs,
        targetDEXes: this.strategyConfig.targetDEXes,
        minValueThreshold: ethers.utils.parseEther(this.strategyConfig.general.profitThreshold)
      });
      
      await this.mempoolMonitor.initialize();
      
      // Set up event handlers
      this.setupEventHandlers();
      
      logger.info("MEV Strategy application initialized successfully");
      
      return true;
    } catch (error) {
      logger.error("Failed to initialize MEV Strategy application:", error);
      throw error;
    }
  }
  
  /**
   * Connect to deployed contracts or deploy if needed
   */
  async connectToContracts() {
    try {
      // Check if we have deployment info
      const deploymentPath = `./deployments/${this.options.network}.json`;
      
      let deployment;
      try {
        deployment = require(deploymentPath);
        logger.info(`Found existing deployment at ${deploymentPath}`);
      } catch (error) {
        logger.warn(`No deployment found at ${deploymentPath}, deploying contracts...`);
        deployment = await this.deployContracts();
      }
      
      // Connect to MevStrategy contract
      this.mevStrategy = await ethers.getContractAt("MevStrategy", deployment.mevStrategy);
      
      logger.info(`Connected to MevStrategy at ${this.mevStrategy.address}`);
      
      // Update strategy parameters if needed
      await this.updateStrategyParameters();
      
      return true;
    } catch (error) {
      logger.error("Error connecting to contracts:", error);
      throw error;
    }
  }
  
  /**
   * Deploy contracts if needed
   */
  async deployContracts() {
    // This would call the deploy script
    // For simplicity, we're just throwing an error for now
    throw new Error("Automatic deployment not implemented. Please run the deploy script manually.");
  }
  
  /**
   * Update strategy parameters
   */
  async updateStrategyParameters() {
    try {
      // Get current strategy parameters
      const currentParams = await this.mevStrategy.strategyParams();
      
      // Create new params object
      const params = {
        targetDEXes: this.strategyConfig.targetDEXes,
        targetTokens: this.strategyConfig.general.targetTokens,
        maxSlippage: this.strategyConfig.general.maxSlippage,
        profitThreshold: ethers.utils.parseEther(this.strategyConfig.general.profitThreshold),
        gasPrice: 0, // Will be set dynamically
        gasLimit: this.strategyConfig.gas.gasLimitBuffer * 500000, // Base gas limit
        useAave: this.strategyConfig.flashLoan.useAave,
        useBalancer: this.strategyConfig.flashLoan.useBalancer
      };
      
      // Check if we need to update
      let needsUpdate = false;
      
      // Check maxSlippage
      if (currentParams.maxSlippage.toNumber() !== params.maxSlippage) {
        needsUpdate = true;
      }
      
      // Check profit threshold
      if (!currentParams.profitThreshold.eq(params.profitThreshold)) {
        needsUpdate = true;
      }
      
      // Update if needed
      if (needsUpdate) {
        logger.info("Updating strategy parameters...");
        const signer = this.keyManager.getWallet();
        const tx = await this.mevStrategy.connect(signer).updateStrategyParams(params);
        await tx.wait();
        logger.info("Strategy parameters updated successfully");
      } else {
        logger.info("Strategy parameters are up to date");
      }
      
      return true;
    } catch (error) {
      logger.error("Error updating strategy parameters:", error);
      throw error;
    }
  }
  
  /**
   * Set up event handlers
   */
  setupEventHandlers() {
    // Set up handlers for mempool events
    this.mempoolMonitor.on("opportunity", this.handleOpportunity.bind(this));
    
    // Set up handlers for strategy contract events
    this.mevStrategy.on("StrategyExecuted", this.handleStrategyExecuted.bind(this));
    this.mevStrategy.on("SandwichExecuted", this.handleSandwichExecuted.bind(this));
    this.mevStrategy.on("ArbitrageExecuted", this.handleArbitrageExecuted.bind(this));
  }
  
  /**
   * Handle detected opportunity
   * @param {Object} opportunity Detected MEV opportunity
   */
  async handleOpportunity(opportunity) {
    try {
      logger.info(`MEV opportunity detected: ${opportunity.type} with estimated profit ${ethers.utils.formatEther(opportunity.estimatedProfit)} ETH`);
      
      // Validate opportunity against risk parameters
      if (!this.riskManager.validateOpportunity(opportunity)) {
        logger.info("Opportunity rejected by risk manager");
        return;
      }
      
      // Execute opportunity based on type
      switch (opportunity.type) {
        case "sandwich":
          await this.executeSandwichStrategy(opportunity);
          break;
        case "arbitrage":
          await this.executeArbitrageStrategy(opportunity);
          break;
        case "frontrun":
          await this.executeFrontRunStrategy(opportunity);
          break;
        case "backrun":
          await this.executeBackRunStrategy(opportunity);
          break;
        case "multihop":
          await this.executeMultiHopStrategy(opportunity);
          break;
        default:
          logger.warn(`Unknown opportunity type: ${opportunity.type}`);
      }
    } catch (error) {
      logger.error(`Error handling opportunity:`, error);
    }
  }
  
  /**
   * Execute a sandwich strategy
   * @param {Object} opportunity Sandwich opportunity
   */
  async executeSandwichStrategy(opportunity) {
    try {
      logger.info(`Executing sandwich strategy for ${opportunity.targetHash}`);
      
      // Get wallet
      const wallet = this.keyManager.getWallet();
      
      // Get strategy parameters
      const strategy = opportunity.bestStrategy;
      
      // Execute sandwich attack
      const tx = await this.mevStrategy.connect(wallet).executeSandwich(
        strategy.pairAddress,
        strategy.tokenIn,
        strategy.tokenOut,
        strategy.victimAmount,
        0, // victimAmountOutMin (not needed for our implementation)
        strategy.frontRunAmount
      );
      
      logger.info(`Sandwich execution transaction sent: ${tx.hash}`);
      
      // Record pending transaction
      this.riskManager.recordPendingTransaction(opportunity, tx);
      
      // Send notification
      this.notificationService.sendExecutionResult(
        {
          type: "sandwich",
          transactionHash: tx.hash,
          estimatedProfit: strategy.estimatedProfit.toString(),
          estimatedProfitUsd: strategy.estimatedProfitUsd
        },
        true
      );
      
      return tx;
    } catch (error) {
      logger.error(`Error executing sandwich strategy:`, error);
      
      // Send failure notification
      this.notificationService.sendExecutionResult(
        {
          type: "sandwich",
          error: error.message
        },
        false
      );
      
      throw error;
    }
  }
  
  /**
   * Execute an arbitrage strategy
   * @param {Object} opportunity Arbitrage opportunity
   */
  async executeArbitrageStrategy(opportunity) {
    try {
      logger.info(`Executing arbitrage strategy`);
      
      // Get wallet
      const wallet = this.keyManager.getWallet();
      
      // Get strategy parameters
      const strategy = opportunity.bestStrategy;
      
      // Execute arbitrage
      const tx = await this.mevStrategy.connect(wallet).executeArbitrage(
        strategy.sourcePool,
        strategy.targetPool,
        strategy.tokenA,
        strategy.amount
      );
      
      logger.info(`Arbitrage execution transaction sent: ${tx.hash}`);
      
      // Record pending transaction
      this.riskManager.recordPendingTransaction(opportunity, tx);
      
      // Send notification
      this.notificationService.sendExecutionResult(
        {
          type: "arbitrage",
          transactionHash: tx.hash,
          estimatedProfit: strategy.estimatedProfit.toString(),
          estimatedProfitUsd: strategy.estimatedProfitUsd
        },
        true
      );
      
      return tx;
    } catch (error) {
      logger.error(`Error executing arbitrage strategy:`, error);
      
      // Send failure notification
      this.notificationService.sendExecutionResult(
        {
          type: "arbitrage",
          error: error.message
        },
        false
      );
      
      throw error;
    }
  }
  
  /**
   * Execute other strategy types (frontrun, backrun, multihop)
   * These methods would be implemented similarly to the above
   */
  async executeFrontRunStrategy(opportunity) {
    // Implementation similar to sandwich but simpler
    logger.info(`Front-run strategy execution not implemented`);
  }
  
  async executeBackRunStrategy(opportunity) {
    // Implementation similar to sandwich but simpler
    logger.info(`Back-run strategy execution not implemented`);
  }
  
  async executeMultiHopStrategy(opportunity) {
    // Implementation for multi-hop strategy
    logger.info(`Multi-hop strategy execution not implemented`);
  }
  
  /**
   * Event handlers for contract events
   */
  handleStrategyExecuted(executor, tokenA, tokenB, profit, gasUsed) {
    logger.info(`Strategy executed by ${executor} with profit ${ethers.utils.formatEther(profit)} ETH`);
  }
  
  handleSandwichExecuted(pair, frontRunAmount, backRunAmount, profit) {
    logger.info(`Sandwich executed on ${pair} with profit ${ethers.utils.formatEther(profit)} ETH`);
  }
  
  handleArbitrageExecuted(sourcePool, targetPool, amount, profit) {
    logger.info(`Arbitrage executed from ${sourcePool} to ${targetPool} with profit ${ethers.utils.formatEther(profit)} ETH`);
  }
  
  /**
   * Start the MEV Strategy application
   */
  async start() {
    if (this.isRunning) {
      logger.warn("MEV Strategy application is already running");
      return;
    }
    
    try {
      logger.info("Starting MEV Strategy application...");
      
      // Start mempool monitoring
      await this.mempoolMonitor.start();
      
      this.isRunning = true;
      logger.info("MEV Strategy application started successfully");
      
      // Send notification
      this.notificationService.sendStatusNotification({
        status: "started",
        network: this.options.network,
        time: new Date().toISOString()
      });
      
      return true;
    } catch (error) {
      logger.error("Failed to start MEV Strategy application:", error);
      throw error;
    }
  }
  
  /**
   * Stop the MEV Strategy application
   */
  async stop() {
    if (!this.isRunning) {
      logger.warn("MEV Strategy application is not running");
      return;
    }
    
    try {
      logger.info("Stopping MEV Strategy application...");
      
      // Stop mempool monitoring
      await this.mempoolMonitor.stop();
      
      this.isRunning = false;
      logger.info("MEV Strategy application stopped successfully");
      
      // Send notification
      this.notificationService.sendStatusNotification({
        status: "stopped",
        network: this.options.network,
        time: new Date().toISOString()
      });
      
      return true;
    } catch (error) {
      logger.error("Failed to stop MEV Strategy application:", error);
      throw error;
    }
  }
  
  /**
   * Get application status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      network: this.options.network,
      mempoolStats: this.mempoolMonitor ? this.mempoolMonitor.getStats() : null,
      riskStatus: this.riskManager ? this.riskManager.getRiskStatus() : null
    };
  }
}

// Export the application
module.exports = {
  MEVStrategyApp
};

// Run if executed directly
if (require.main === module) {
  (async () => {
    try {
      const app = new MEVStrategyApp();
      await app.initialize();
      await app.start();
      
      // Keep the application running
      process.on("SIGINT", async () => {
        logger.info("Received SIGINT, shutting down...");
        await app.stop();
        process.exit(0);
      });
    } catch (error) {
      console.error("Fatal error:", error);
      process.exit(1);
    }
  })();
}