/**
 * Eden Network provider for mempool monitoring
 * Connects to Eden Network for transaction submission and monitoring
 */
const ethers = require('ethers');
const { Logger } = require('../../infrastructure/logging');

// Logger setup
const logger = new Logger('EdenProvider');

class EdenProvider {
  constructor(options = {}) {
    this.options = {
      url: 'https://api.edennetwork.io/v1/rpc',
      apiKey: '',
      wsUrl: 'wss://api.edennetwork.io/v1/ws',
      reconnectInterval: 5000,
      ...options
    };
    
    this.provider = null;
    this.wsProvider = null;
    this.isRunning = false;
    this.connected = false;
    this.pendingTxCallback = null;
    this.errorCallback = null;
    this.reconnectTimer = null;
  }

  /**
   * Initialize the Eden Network provider
   */
  async initialize() {
    try {
      logger.info('Initializing Eden Network provider...');
      
      if (!this.options.apiKey) {
        logger.warn('Eden Network provider initialized without API key');
      }
      
      // Setup HTTP provider
      const url = new URL(this.options.url);
      if (this.options.apiKey) {
        url.searchParams.append('api_key', this.options.apiKey);
      }
      
      this.provider = new ethers.providers.JsonRpcProvider(url.toString());
      
      // Test connection
      const blockNumber = await this.provider.getBlockNumber();
      logger.info(`Eden Network provider connected, current block: ${blockNumber}`);
      
      // Setup WebSocket provider if available
      if (this.options.wsUrl) {
        const wsUrl = new URL(this.options.wsUrl);
        if (this.options.apiKey) {
          wsUrl.searchParams.append('api_key', this.options.apiKey);
        }
        
        this.wsProvider = new ethers.providers.WebSocketProvider(wsUrl.toString());
      }
      
      this.connected = true;
      return true;
    } catch (error) {
      logger.error('Failed to initialize Eden Network provider:', error);
      this.connected = false;
      throw error;
    }
  }

  /**
   * Start monitoring for pending transactions via Eden Network
   */
  async startMonitoring() {
    if (this.isRunning) {
      logger.warn('Eden Network monitoring is already running');
      return;
    }

    logger.info('Starting Eden Network monitoring...');
    this.isRunning = true;

    try {
      if (this.wsProvider) {
        // Subscribe to pending transactions via WebSocket
        this.wsProvider.on('pending', this.handlePendingTransaction.bind(this));
        logger.info('Subscribed to pending transactions via WebSocket');
      } else {
        // Fall back to polling
        this.setupPollingFallback();
        logger.info('Using polling fallback for pending transactions');
      }
      
      logger.info('Eden Network monitoring started successfully');
    } catch (error) {
      this.isRunning = false;
      logger.error('Failed to start Eden Network monitoring:', error);
      throw error;
    }
  }

  /**
   * Handle a pending transaction from Eden Network
   * @param {string} txHash Transaction hash
   */
  async handlePendingTransaction(txHash) {
    try {
      // Get full transaction details
      const txData = await this.provider.getTransaction(txHash);
      
      if (txData && this.pendingTxCallback) {
        // Flag as Eden transaction for priority
        txData.edenTransaction = true;
        
        this.pendingTxCallback(txData, 'eden');
      }
    } catch (error) {
      logger.error(`Error handling pending transaction ${txHash}:`, error);
      if (this.errorCallback) {
        this.errorCallback(error);
      }
    }
  }

  /**
   * Set up polling fallback for environments where WebSockets aren't available
   */
  setupPollingFallback() {
    this.pollingInterval = setInterval(async () => {
      try {
        // Use eth_pendingTransactions RPC method specific to Eden Network
        const pendingTxHashes = await this.provider.send('eth_pendingTransactions', []);
        
        if (pendingTxHashes && pendingTxHashes.length > 0) {
          // Process up to 10 transactions per interval to avoid overwhelming
          const txsToProcess = pendingTxHashes.slice(0, 10);
          
          for (const txHash of txsToProcess) {
            this.handlePendingTransaction(txHash);
          }
        }
      } catch (error) {
        logger.error('Error in polling fallback:', error);
        if (this.errorCallback) {
          this.errorCallback(error);
        }
      }
    }, 1000); // Poll every second
  }

  /**
   * Stop monitoring
   */
  async stopMonitoring() {
    if (!this.isRunning) {
      logger.warn('Eden Network monitoring is not running');
      return;
    }

    logger.info('Stopping Eden Network monitoring...');
    this.isRunning = false;

    // Remove event listeners
    if (this.wsProvider) {
      this.wsProvider.removeAllListeners('pending');
      
      // Close WebSocket connection
      this.wsProvider.destroy();
      this.wsProvider = null;
    }
    
    // Clear polling interval
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    
    // Clear reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    logger.info('Eden Network monitoring stopped');
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
      logger.info('Attempting to reconnect to Eden Network...');
      
      // Close existing connections
      if (this.wsProvider) {
        this.wsProvider.destroy();
        this.wsProvider = null;
      }
      
      await this.initialize();
      
      // If we were monitoring, restart monitoring
      if (this.isRunning) {
        await this.stopMonitoring();
        await this.startMonitoring();
      }
      
      logger.info('Successfully reconnected to Eden Network');
      return true;
    } catch (error) {
      logger.error('Failed to reconnect to Eden Network:', error);
      
      // Schedule another reconnection attempt
      this.scheduleReconnect();
      return false;
    }
  }

  /**
   * Schedule a reconnection attempt
   */
  scheduleReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnect();
    }, this.options.reconnectInterval);
  }

  /**
   * Send a bundle of transactions to Eden Network
   * @param {Array} signedTransactions Array of signed transactions
   * @param {number} targetBlockNumber Target block number
   * @returns {Promise} Promise resolving to bundle submission result
   */
  async sendBundle(signedTransactions, targetBlockNumber) {
    try {
      const rawTxs = signedTransactions.map(tx => 
        typeof tx === 'string' ? tx : ethers.utils.hexlify(tx)
      );
      
      // Call Eden-specific RPC method for bundle submission
      const result = await this.provider.send('eth_sendBundle', [{
        txs: rawTxs,
        blockNumber: ethers.utils.hexValue(targetBlockNumber)
      }]);
      
      return result;
    } catch (error) {
      logger.error('Error sending bundle to Eden Network:', error);
      throw error;
    }
  }

  /**
   * Send a transaction with Eden-specific options
   * @param {string} signedTransaction Signed transaction
   * @param {Object} options Eden-specific options
   * @returns {Promise} Promise resolving to transaction hash
   */
  async sendTransaction(signedTransaction, options = {}) {
    try {
      // Send transaction with Eden-specific parameters
      const txHash = await this.provider.send('eth_sendRawTransaction', [
        signedTransaction,
        {
          maxBlockNumber: options.maxBlockNumber,
          privateTransaction: options.privateTransaction || false
        }
      ]);
      
      return txHash;
    } catch (error) {
      logger.error('Error sending transaction to Eden Network:', error);
      throw error;
    }
  }
}

module.exports = {
  EdenProvider
};