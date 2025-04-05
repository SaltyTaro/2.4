/**
 * Configuration settings for mempool monitoring
 */
const { TOKEN_ADDRESSES } = require('../utils/constants');
const { getAllTokenPairs, getTokenPairsByTier } = require('../utils/token-pairs');
require('dotenv').config();

// Target pairs for monitoring (Tier 1 by default)
const targetPairs = getTokenPairsByTier(1);

// Default configuration for mempool monitoring
const mempoolConfig = {
  // Provider settings
  useFlashbots: true,
  useEden: true,
  useBlocknative: true,
  
  // Provider-specific configurations
  flashbots: {
    relayUrl: 'https://relay.flashbots.net',
    signingKey: process.env.FLASHBOTS_SIGNING_KEY || '',
  },
  
  eden: {
    rpcUrl: process.env.EDEN_RPC_URL || 'https://api.edennetwork.io/v1/rpc',
    apiKey: process.env.EDEN_API_KEY || '',
  },
  
  blocknative: {
    dappId: process.env.BLOCKNATIVE_DAPP_ID || '',
    apiKey: process.env.BLOCKNATIVE_API_KEY || '',
    networkId: 1, // Ethereum mainnet
  },
  
  // Transaction filtering
  targetPairs: targetPairs,
  minValueThreshold: '1', // Only monitor transactions with value >= 1 ETH (or equivalent)
  includeERC20Transfers: true,
  includeSwaps: true,
  includeLiquidityOperations: false,
  
  // Target DEXes
  targetDEXes: [
    '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // Uniswap V2 Router
    '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F', // Sushiswap Router
    '0xE592427A0AEce92De3Edee1F18E0157C05861564', // Uniswap V3 Router
  ],
  
  // Target methods to monitor
  targetMethods: [
    'swapExactTokensForTokens',
    'swapTokensForExactTokens',
    'swapExactETHForTokens',
    'swapTokensForExactETH',
    'swapExactTokensForETH',
    'swapETHForExactTokens',
  ],
  
  // Gas pricing
  gasMultiplier: 1.2, // Multiply pending tx gas price for inclusion
  maxGasPrice: '500', // Maximum gas price in gwei
  priorityFeeMultiplier: 1.5, // Multiplier for priority fee
  
  // General settings
  txTTL: 60000, // Time to track pending transactions (60 seconds)
  opportunityTTL: 10000, // Time to track potential opportunities (10 seconds)
  statsReportingInterval: 60000, // Report stats every 60 seconds
  reconnectInterval: 5000, // Time between reconnection attempts
  notificationThreshold: '0.1', // Notify about opportunities with profit >= 0.1 ETH
  
  // Performance tuning
  maxPendingTxs: 1000, // Maximum number of pending txs to keep in memory
  maxConcurrentAnalysis: 10, // Maximum number of concurrent transaction analyses
  batchProcessingInterval: 200, // Process pending txs in batches every 200ms
};

module.exports = {
  mempoolConfig,
};