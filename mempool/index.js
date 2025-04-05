/**
 * Main entry point for mempool monitoring
 * Connects to Ethereum nodes with mempool access and processes pending transactions
 */
const ethers = require('ethers');
const { mempoolConfig } = require('./config');
const { FlashbotsProvider } = require('./providers/flashbots');
const { EdenProvider } = require('./providers/eden');
const { BlocknativeProvider } = require('./providers/blocknative');
const { TxFilter } = require('./filters/tx-filter');
const { GasEstimator } = require('./gas/gas-estimator');
const { TxDecoder } = require('./transaction/tx-decoder');
const { TxAnalyzer } = require('./transaction/tx-analyzer');
const { OpportunityDetector } = require('./opportunity/opportunity-detector');
const { Logger } = require('../infrastructure/logging');
const { RiskManager } = require('../infrastructure/risk-manager');
const { NotificationService } = require('../infrastructure/notification');

// Logger setup
const logger = new Logger('MempoolMonitor');

class MempoolMonitor {
  constructor(options = {}) {
    this.options = {
      ...mempoolConfig,
      ...options
    };

    this.providers = {};
    this.isRunning = false;
    this.pendingTxs = new Map();
    this.txDecoder = new TxDecoder();
    this.txAnalyzer = new TxAnalyzer();
    this.gasEstimator = new GasEstimator();
    this.txFilter = new TxFilter({
      targetPairs: this.options.targetPairs,
      minValueThreshold: this.options.minValueThreshold
    });
    this.opportunityDetector = new OpportunityDetector();
    this.riskManager = new RiskManager();
    this.notificationService = new NotificationService();
    
    // Stats
    this.stats = {
      transactionsProcessed: 0,
      opportunitiesDetected: 0,
      opportunitiesExecuted: 0,
      lastProcessedBlock: 0
    };
    
    // Setup automatic stats reporting
    if (this.options.statsReportingInterval > 0) {
      setInterval(() => this.reportStats(), this.options.statsReportingInterval);
    }
  }

  /**
   * Initialize and connect to mempool providers
   */
  async initialize() {
    logger.info('Initializing mempool monitoring service...');

    try {
      // Initialize providers based on configuration
      if (this.options.useFlashbots) {
        logger.info('Initializing Flashbots provider...');
        this.providers.flashbots = new FlashbotsProvider({
          url: this.options.flashbots.relayUrl,
          authSigner: new ethers.Wallet(this.options.flashbots.signingKey)
        });
        await this.providers.flashbots.initialize();
      }

      if (this.options.useEden) {
        logger.info('Initializing Eden Network provider...');
        this.providers.eden = new EdenProvider({
          url: this.options.eden.rpcUrl,
          apiKey: this.options.eden.apiKey
        });
        await this.providers.eden.initialize();
      }

      if (this.options.useBlocknative) {
        logger.info('Initializing Blocknative provider...');
        this.providers.blocknative = new BlocknativeProvider({
          dappId: this.options.blocknative.dappId,
          apiKey: this.options.blocknative.apiKey,
          networkId: this.options.blocknative.networkId || 1
        });
        await this.providers.blocknative.initialize();
      }

      if (Object.keys(this.providers).length === 0) {
        throw new Error('No mempool providers configured');
      }
      
      // Initialize supporting services
      await this.txDecoder.initialize();
      await this.txAnalyzer.initialize();
      await this.gasEstimator.initialize();
      
      logger.info('Mempool monitoring service initialized successfully');
      return true;
    } catch (error) {
      logger.error('Failed to initialize mempool monitoring service', error);
      throw error;
    }
  }

  /**
   * Start monitoring the mempool
   */
  async start() {
    if (this.isRunning) {
      logger.warn('Mempool monitoring is already running');
      return;
    }

    logger.info('Starting mempool monitoring...');
    this.isRunning = true;

    try {
      // Register handlers for each provider
      for (const [name, provider] of Object.entries(this.providers)) {
        provider.onPendingTransaction(this.handlePendingTransaction.bind(this));
        provider.onError(this.handleProviderError.bind(this, name));
        await provider.startMonitoring();
        logger.info(`Started monitoring with provider: ${name}`);
      }
      
      logger.info('Mempool monitoring started successfully');
    } catch (error) {
      this.isRunning = false;
      logger.error('Failed to start mempool monitoring', error);
      throw error;
    }
  }

  /**
   * Stop monitoring the mempool
   */
  async stop() {
    if (!this.isRunning) {
      logger.warn('Mempool monitoring is not running');
      return;
    }

    logger.info('Stopping mempool monitoring...');
    this.isRunning = false;

    try {
      // Stop all providers
      for (const [name, provider] of Object.entries(this.providers)) {
        await provider.stopMonitoring();
        logger.info(`Stopped monitoring with provider: ${name}`);
      }
      
      logger.info('Mempool monitoring stopped successfully');
    } catch (error) {
      logger.error('Error while stopping mempool monitoring', error);
      throw error;
    }
  }

  /**
   * Handle a pending transaction from the mempool
   * @param {Object} txData Transaction data
   * @param {string} providerName Provider that detected the transaction
   */
  async handlePendingTransaction(txData, providerName) {
    try {
      this.stats.transactionsProcessed++;
      
      // Skip if transaction hash is already processed
      if (this.pendingTxs.has(txData.hash)) {
        return;
      }
      
      // Initial quick filter to avoid processing irrelevant transactions
      if (!this.txFilter.shouldProcess(txData)) {
        return;
      }
      
      // Decode the transaction to understand what it's doing
      const decodedTx = await this.txDecoder.decode(txData);
      
      // Apply more detailed filtering based on decoded data
      if (!this.txFilter.isTargetTransaction(decodedTx)) {
        return;
      }
      
      logger.debug(`Processing potential target transaction: ${txData.hash}`);
      
      // Store the pending transaction
      this.pendingTxs.set(txData.hash, {
        txData,
        decodedTx,
        providerName,
        timestamp: Date.now()
      });
      
      // Analyze the transaction for potential MEV opportunity
      const analysis = await this.txAnalyzer.analyze(decodedTx);
      
      // Check if this is a potential opportunity
      if (analysis.isPotentialOpportunity) {
        // Get optimal gas price for inclusion
        const gasPrice = await this.gasEstimator.estimateOptimalGasPrice(txData);
        
        // Determine the optimal strategy for this opportunity
        const opportunity = await this.opportunityDetector.detectOpportunity(analysis, gasPrice);
        
        if (opportunity) {
          this.stats.opportunitiesDetected++;
          
          // Validate opportunity against risk parameters
          if (this.riskManager.validateOpportunity(opportunity)) {
            // Emit opportunity event
            this.emit('opportunity', opportunity);
            
            // Send notification if significant
            if (opportunity.expectedProfit.gte(this.options.notificationThreshold)) {
              this.notificationService.sendOpportunityAlert(opportunity);
            }
          }
        }
      }
      
      // Clean up old transactions to prevent memory leaks
      this.cleanupOldTransactions();
    } catch (error) {
      logger.error(`Error processing pending transaction ${txData?.hash}:`, error);
    }
  }

  /**
   * Handle provider errors
   * @param {string} providerName Name of the provider
   * @param {Error} error The error
   */
  handleProviderError(providerName, error) {
    logger.error(`Error from mempool provider ${providerName}:`, error);
    
    // Try to reconnect if provider is disconnected
    const provider = this.providers[providerName];
    if (provider && provider.isDisconnected()) {
      logger.info(`Attempting to reconnect to ${providerName}...`);
      provider.reconnect()
        .then(() => logger.info(`Successfully reconnected to ${providerName}`))
        .catch(err => logger.error(`Failed to reconnect to ${providerName}:`, err));
    }
  }

  /**
   * Clean up old transactions to prevent memory leaks
   */
  cleanupOldTransactions() {
    const now = Date.now();
    const maxAge = this.options.txTTL;
    
    for (const [hash, txInfo] of this.pendingTxs.entries()) {
      if (now - txInfo.timestamp > maxAge) {
        this.pendingTxs.delete(hash);
      }
    }
  }

  /**
   * Report current monitoring stats
   */
  reportStats() {
    logger.info('Mempool monitoring stats:', {
      transactionsProcessed: this.stats.transactionsProcessed,
      opportunitiesDetected: this.stats.opportunitiesDetected,
      opportunitiesExecuted: this.stats.opportunitiesExecuted,
      pendingTxsTracked: this.pendingTxs.size
    });
  }

  /**
   * Get current monitoring stats
   */
  getStats() {
    return {
      ...this.stats,
      pendingTxsCount: this.pendingTxs.size,
      isRunning: this.isRunning,
      providersConnected: Object.entries(this.providers)
        .filter(([_, provider]) => provider.isConnected())
        .map(([name]) => name)
    };
  }

  /**
   * Emit an event
   */
  emit(eventName, data) {
    if (this.options.eventEmitter) {
      this.options.eventEmitter.emit(eventName, data);
    }
  }
}

module.exports = {
  MempoolMonitor
};