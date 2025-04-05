/**
 * Blocknative provider for mempool monitoring
 * Uses Blocknative's Mempool API for real-time transaction monitoring
 */
const { SDK } = require('@blocknative/sdk');
const ethers = require('ethers');
const { Logger } = require('../../infrastructure/logging');

// Logger setup
const logger = new Logger('BlocknativeProvider');

class BlocknativeProvider {
  constructor(options = {}) {
    this.options = {
      dappId: '',
      apiKey: '',
      networkId: 1, // Ethereum mainnet
      transactionHandlerTimeoutMs: 60000, // 60 seconds
      system: 'ethereum',
      ...options
    };
    
    this.blocknative = null;
    this.isRunning = false;
    this.connected = false;
    this.pendingTxCallback = null;
    this.errorCallback = null;
    this.emitter = null;
  }

  /**
   * Initialize the Blocknative provider
   */
  async initialize() {
    try {
      logger.info('Initializing Blocknative provider...');
      
      if (!this.options.dappId) {
        throw new Error('Blocknative provider requires a dappId');
      }
      
      // Create Blocknative SDK instance
      this.blocknative = new SDK({
        dappId: this.options.dappId,
        apiKey: this.options.apiKey,
        networkId: this.options.networkId,
        transactionHandlerTimeoutMs: this.options.transactionHandlerTimeoutMs,
        name: 'MEV Strategy',
        onerror: this.handleError.bind(this)
      });
      
      // Test connection with a configuration call
      await this.getGlobalConfiguration();
      
      logger.info('Blocknative provider initialized successfully');
      this.connected = true;
      return true;
    } catch (error) {
      logger.error('Failed to initialize Blocknative provider:', error);
      this.connected = false;
      throw error;
    }
  }

  /**
   * Get global configuration from Blocknative
   */
  async getGlobalConfiguration() {
    return new Promise((resolve, reject) => {
      this.blocknative.configuration({
        scope: 'global',
        filters: [
          {
            status: 'pending',
            _internalType: 'filter'
          }
        ],
        onConfigurationChange: (config) => {
          logger.debug('Blocknative configuration updated:', config);
          resolve(config);
        }
      });
      
      // Reject after a timeout
      setTimeout(() => {
        reject(new Error('Blocknative configuration request timed out'));
      }, 5000);
    });
  }

  /**
   * Start monitoring for pending transactions via Blocknative
   */
  async startMonitoring() {
    if (this.isRunning) {
      logger.warn('Blocknative monitoring is already running');
      return;
    }

    logger.info('Starting Blocknative monitoring...');
    
    try {
      // Create a global transaction event emitter
      this.emitter = this.blocknative.account();

      // Configure the emitter
      const { emitter } = this.blocknative.configuration({
        scope: 'global',
        filters: [
          {
            status: 'pending',
            _internalType: 'filter'
          }
        ]
      });

      // Subscribe to pending transactions
      emitter.on('txPool', this.handlePendingTransaction.bind(this));

      // Handle connection events
      emitter.on('connect', () => {
        logger.info('Connected to Blocknative Mempool API');
        this.connected = true;
      });

      emitter.on('disconnect', () => {
        logger.warn('Disconnected from Blocknative Mempool API');
        this.connected = false;
      });
      
      emitter.on('error', this.handleError.bind(this));

      this.isRunning = true;
      logger.info('Blocknative monitoring started successfully');
    } catch (error) {
      this.isRunning = false;
      logger.error('Failed to start Blocknative monitoring:', error);
      throw error;
    }
  }

  /**
   * Handle a pending transaction from Blocknative
   * @param {Object} transaction Transaction data from Blocknative
   */
  handlePendingTransaction(transaction) {
    try {
      if (!transaction || !transaction.hash) {
        return;
      }
      
      // Convert Blocknative transaction format to ethers format
      const txData = this.convertToEthersFormat(transaction);
      
      if (txData && this.pendingTxCallback) {
        this.pendingTxCallback(txData, 'blocknative');
      }
    } catch (error) {
      logger.error(`Error handling pending transaction from Blocknative:`, error);
      if (this.errorCallback) {
        this.errorCallback(error);
      }
    }
  }

  /**
   * Convert Blocknative transaction format to ethers format
   * @param {Object} bnTx Blocknative transaction
   * @returns {Object} Transaction in ethers format
   */
  convertToEthersFormat(bnTx) {
    try {
      // Extract the basic transaction data
      const tx = {
        hash: bnTx.hash,
        to: bnTx.to,
        from: bnTx.from,
        nonce: parseInt(bnTx.nonce, 16),
        gasLimit: bnTx.gas ? ethers.BigNumber.from(bnTx.gas) : ethers.BigNumber.from(0),
        gasPrice: bnTx.gasPrice ? ethers.BigNumber.from(bnTx.gasPrice) : null,
        maxFeePerGas: bnTx.maxFeePerGas ? ethers.BigNumber.from(bnTx.maxFeePerGas) : null,
        maxPriorityFeePerGas: bnTx.maxPriorityFeePerGas ? ethers.BigNumber.from(bnTx.maxPriorityFeePerGas) : null,
        data: bnTx.input || '0x',
        value: bnTx.value ? ethers.BigNumber.from(bnTx.value) : ethers.BigNumber.from(0),
        chainId: bnTx.chainId ? parseInt(bnTx.chainId, 16) : null,
        
        // Blocknative specific metadata
        blocknative: {
          monitoring: true,
          pendingTimeStamp: bnTx.timeStamp,
          gasUsed: bnTx.gasUsed,
          blocksPending: bnTx.blocksPending,
          watchedAddress: bnTx.watchedAddress,
          direction: bnTx.direction
        }
      };
      
      return tx;
    } catch (error) {
      logger.error('Error converting Blocknative transaction format:', error);
      return null;
    }
  }

  /**
   * Handle error from Blocknative
   * @param {Error} error Error object
   */
  handleError(error) {
    logger.error('Blocknative error:', error);
    if (this.errorCallback) {
      this.errorCallback(error);
    }
    
    // Check if we need to reconnect
    if (error && error.message && error.message.includes('connection')) {
      this.connected = false;
    }
  }

  /**
   * Stop monitoring
   */
  async stopMonitoring() {
    if (!this.isRunning) {
      logger.warn('Blocknative monitoring is not running');
      return;
    }

    logger.info('Stopping Blocknative monitoring...');
    this.isRunning = false;

    if (this.emitter) {
      this.emitter.removeAllListeners();
      this.emitter = null;
    }
    
    // Unsubscribe from all watchlists
    if (this.blocknative) {
      this.blocknative.unsubscribe({
        scope: 'global'
      });
    }
    
    logger.info('Blocknative monitoring stopped');
  }

  /**
   * Register callback for pending transactions
   * @param {Function} callback Function to call when a pending transaction is detected
   */
  onPendingTransaction(callback) {
    this.pendingTxCallback = callback;
  }

  /**
   * Register callback for errors
   * @param {Function} callback Function to call when an error occurs
   */
  onError(callback) {
    this.errorCallback = callback;
  }

  /**
   * Check if the provider is connected
   * @returns {boolean} Whether the provider is connected
   */
  isConnected() {
    return this.connected;
  }

  /**
   * Check if the provider is disconnected
   * @returns {boolean} Whether the provider is disconnected
   */
  isDisconnected() {
    return !this.connected;
  }

  /**
   * Attempt to reconnect
   */
  async reconnect() {
    try {
      logger.info('Attempting to reconnect to Blocknative...');
      
      // Reset SDK
      this.blocknative = null;
      
      // Reinitialize
      await this.initialize();
      
      // If we were monitoring, restart monitoring
      if (this.isRunning) {
        await this.stopMonitoring();
        await this.startMonitoring();
      }
      
      logger.info('Successfully reconnected to Blocknative');
      return true;
    } catch (error) {
      logger.error('Failed to reconnect to Blocknative:', error);
      return false;
    }
  }
  
  /**
   * Get a transaction from Blocknative by hash
   * @param {string} txHash Transaction hash
   * @returns {Promise} Promise resolving to transaction data
   */
  async getTransaction(txHash) {
    try {
      const tx = await this.blocknative.fetchTransaction({ hash: txHash });
      return this.convertToEthersFormat(tx);
    } catch (error) {
      logger.error(`Error fetching transaction ${txHash} from Blocknative:`, error);
      throw error;
    }
  }
  
  /**
   * Monitor a specific transaction by hash
   * @param {string} txHash Transaction hash
   * @param {Function} callback Function to call when transaction status changes
   * @returns {Object} Emitter for the transaction
   */
  monitorTransaction(txHash, callback) {
    try {
      const { emitter } = this.blocknative.transaction({
        hash: txHash,
        system: this.options.system,
        networkId: this.options.networkId
      });
      
      emitter.on('all', callback);
      
      return emitter;
    } catch (error) {
      logger.error(`Error monitoring transaction ${txHash}:`, error);
      throw error;
    }
  }
}

module.exports = {
  BlocknativeProvider
};