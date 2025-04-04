/**
 * Configuration settings for the MEV strategy
 */
const { TOKEN_ADDRESSES, DEX_ADDRESSES, FLASH_LOAN_ADDRESSES } = require("../utils/constants");
const { getAllTokenPairs, getTokenPairsByTier } = require("../utils/token-pairs");

// Strategy configuration
const strategyConfig = {
  // General settings
  general: {
    maxSlippage: 50, // 0.5% in basis points
    profitThreshold: "0.05", // 0.05 ETH min profit
    maxPoolUsageBps: 100, // 1% maximum pool reserves usage
    minRoiBps: 50, // 0.5% minimum ROI
    useFallbackProvider: true, // Use backup provider if primary fails
  },
  
  // Flash loan settings
  flashLoan: {
    useAave: true,
    useBalancer: false,
    maxAmount: "1000", // Maximum 1000 ETH per flash loan
    preferredToken: TOKEN_ADDRESSES.WETH // Preferred token for flash loans
  },
  
  // Gas settings
  gas: {
    maxGasPrice: "500", // Maximum gas price in gwei
    priorityFeeMultiplier: 1.5, // Multiplier for priority fee
    gasLimitBuffer: 1.2, // Buffer for gas limit estimations
  },
  
  // Sandwich attack settings
  sandwich: {
    enabled: true,
    minVictimAmount: "1", // Minimum victim transaction size in ETH
    maxFrontRunAmount: "100", // Maximum front-run amount in ETH
    frontRunMultiplier: 2, // Multiply victim amount by this for front-run
    targetPairs: getTokenPairsByTier(1) // Tier 1 pairs for sandwich attacks
  },
  
  // Arbitrage settings
  arbitrage: {
    enabled: true,
    minPriceImpactBps: 10, // Minimum price impact in basis points
    maxTradeAmount: "50", // Maximum trade amount in ETH
    targetDexes: [
      DEX_ADDRESSES.UNISWAP_V2_FACTORY,
      DEX_ADDRESSES.SUSHISWAP_FACTORY,
      DEX_ADDRESSES.SHIBASWAP_FACTORY
    ]
  },
  
  // Multi-hop settings
  multiHop: {
    enabled: true,
    maxHops: 3, // Maximum number of hops
    minProfitPerHop: "0.03", // Minimum profit per hop in ETH
    targetDexes: [
      DEX_ADDRESSES.UNISWAP_V2_FACTORY,
      DEX_ADDRESSES.SUSHISWAP_FACTORY
    ]
  },
  
  // Security settings
  security: {
    maxExposure: "100", // Maximum total exposure in ETH
    maxWalletUsage: 0.9, // Maximum wallet usage (90%)
    emergencyWithdrawalAddress: "0x0000000000000000000000000000000000000000", // Set this to your actual address
    timeoutBlocks: 5 // Maximum blocks to wait for transaction confirmation
  },
  
  // Monitoring settings
  monitoring: {
    logLevel: "info", // Log level: debug, info, warn, error
    reportingInterval: 3600, // Reporting interval in seconds
    persistResults: true, // Save results to disk
    alertThresholdProfit: "1", // Minimum profit to trigger alert
  }
};

// Network-specific configurations
const networkConfigs = {
  // Mainnet configuration
  mainnet: {
    ...strategyConfig,
    flashLoan: {
      ...strategyConfig.flashLoan,
      aaveLendingPool: FLASH_LOAN_ADDRESSES.AAVE_LENDING_POOL,
      balancerVault: FLASH_LOAN_ADDRESSES.BALANCER_VAULT
    }
  },
  
  // Goerli configuration (testnet)
  goerli: {
    ...strategyConfig,
    // Override with testnet-specific settings
    general: {
      ...strategyConfig.general,
      profitThreshold: "0.001" // Lower threshold for testnet
    },
    flashLoan: {
      ...strategyConfig.flashLoan,
      maxAmount: "10", // Lower amount for testnet
      // Update with testnet addresses
      aaveLendingPool: "0x4bd5643ac6f66a5237E18bfA7d47cF22f1c9F210", // Goerli Aave
      balancerVault: "0xBA12222222228d8Ba445958a75a0704d566BF2C8" // Goerli Balancer
    }
  },
  
  // Local development (hardhat) configuration
  localhost: {
    ...strategyConfig,
    // Local development settings
    general: {
      ...strategyConfig.general,
      profitThreshold: "0.0001", // Very low threshold for testing
      maxSlippage: 500 // Higher slippage for testing (5%)
    },
    monitoring: {
      ...strategyConfig.monitoring,
      logLevel: "debug" // More verbose logging for local development
    }
  }
};

/**
 * Get configuration for a specific network
 * @param {string} networkName - Network name (mainnet, goerli, localhost)
 * @returns {Object} - Network-specific configuration
 */
function getNetworkConfig(networkName) {
  return networkConfigs[networkName] || networkConfigs.localhost;
}

module.exports = {
  strategyConfig,
  networkConfigs,
  getNetworkConfig
};