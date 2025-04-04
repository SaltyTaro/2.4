/**
 * Constants used throughout the MEV strategy project
 */

// Token addresses (Ethereum mainnet)
const TOKEN_ADDRESSES = {
    WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // Wrapped Ether
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USD Coin
    USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7", // Tether
    DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",  // Dai Stablecoin
    WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", // Wrapped Bitcoin
    UNI: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",  // Uniswap Token
    LINK: "0x514910771AF9Ca656af840dff83E8264EcF986CA", // Chainlink Token
    AAVE: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", // Aave Token
    SNX: "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F"   // Synthetix Network Token
  };
  
  // DEX addresses (Ethereum mainnet)
  const DEX_ADDRESSES = {
    // Uniswap V2
    UNISWAP_V2_ROUTER: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    UNISWAP_V2_FACTORY: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
    
    // Sushiswap
    SUSHISWAP_ROUTER: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
    SUSHISWAP_FACTORY: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac",
    
    // Shibaswap
    SHIBASWAP_ROUTER: "0x03f7724180AA6b939894B5Ca4314783B0b36b329",
    SHIBASWAP_FACTORY: "0x115934131916C8b277DD010Ee02de363c09d037c"
  };
  
  // Flash loan provider addresses
  const FLASH_LOAN_ADDRESSES = {
    // Aave V2
    AAVE_LENDING_POOL: "0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9",
    // Balancer V2
    BALANCER_VAULT: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
    // Uniswap V3 (for flash loans)
    UNISWAP_V3_FACTORY: "0x1F98431c8aD98523631AE4a59f267346ea31F984"
  };
  
  // Gas settings
  const GAS_SETTINGS = {
    // Default priority fee (in gwei)
    DEFAULT_PRIORITY_FEE: 2,
    // Maximum priority fee to consider (in gwei)
    MAX_PRIORITY_FEE: 100,
    // Gas limit for sandwich attacks
    SANDWICH_GAS_LIMIT: 500000,
    // Gas limit for arbitrage operations
    ARBITRAGE_GAS_LIMIT: 350000,
    // Gas limit for multi-hop operations
    MULTI_HOP_GAS_LIMIT: 800000
  };
  
  // Strategy parameters
  const STRATEGY_SETTINGS = {
    // Maximum slippage tolerance in basis points (0.5%)
    MAX_SLIPPAGE: 50,
    // Minimum profit threshold in ETH (0.05 ETH)
    MIN_PROFIT_THRESHOLD: "0.05",
    // Maximum percentage of pool reserves to use for front-running (1%)
    MAX_POOL_USAGE_BPS: 100,
    // Minimum ROI for a profitable trade in basis points (0.5%)
    MIN_ROI_BPS: 50,
    // Target tokens to monitor for opportunities
    TARGET_TOKENS: [
      TOKEN_ADDRESSES.WETH,
      TOKEN_ADDRESSES.USDC,
      TOKEN_ADDRESSES.USDT,
      TOKEN_ADDRESSES.DAI,
      TOKEN_ADDRESSES.WBTC,
      TOKEN_ADDRESSES.UNI,
      TOKEN_ADDRESSES.LINK
    ],
    // Target DEXes to monitor for opportunities
    TARGET_DEXES: [
      DEX_ADDRESSES.UNISWAP_V2_FACTORY,
      DEX_ADDRESSES.SUSHISWAP_FACTORY
    ]
  };
  
  // Analysis of target wallet
  const TARGET_WALLET = {
    // Wallet address being analyzed
    ADDRESS: "0xf5213a6a2f0890321712520b8048d9886c1a9900",
    // Tokens frequently traded by this wallet
    FREQUENT_TOKENS: [
      TOKEN_ADDRESSES.WETH,
      TOKEN_ADDRESSES.USDC,
      TOKEN_ADDRESSES.USDT,
      TOKEN_ADDRESSES.DAI
    ],
    // DEXes frequently used by this wallet
    FREQUENT_DEXES: [
      DEX_ADDRESSES.UNISWAP_V2_FACTORY
    ]
  };
  
  module.exports = {
    TOKEN_ADDRESSES,
    DEX_ADDRESSES,
    FLASH_LOAN_ADDRESSES,
    GAS_SETTINGS,
    STRATEGY_SETTINGS,
    TARGET_WALLET
  };