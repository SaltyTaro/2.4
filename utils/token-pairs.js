/**
 * Configuration for token pairs to target in MEV strategies
 */
const { TOKEN_ADDRESSES } = require("./constants");

/**
 * Priority tiers for token pairs
 * Tier 1: Highest priority, most liquid pairs
 * Tier 2: Medium priority, good liquidity
 * Tier 3: Lower priority, backup pairs
 */
const TOKEN_PAIR_TIERS = {
  TIER_1: [
    // ETH-Stablecoin pairs (highest priority)
    {
      tokenA: TOKEN_ADDRESSES.WETH,
      tokenB: TOKEN_ADDRESSES.USDC,
      description: "WETH-USDC"
    },
    {
      tokenA: TOKEN_ADDRESSES.WETH,
      tokenB: TOKEN_ADDRESSES.USDT,
      description: "WETH-USDT"
    },
    {
      tokenA: TOKEN_ADDRESSES.WETH,
      tokenB: TOKEN_ADDRESSES.DAI,
      description: "WETH-DAI"
    },
    // BTC-ETH pair (high priority)
    {
      tokenA: TOKEN_ADDRESSES.WBTC,
      tokenB: TOKEN_ADDRESSES.WETH,
      description: "WBTC-WETH"
    }
  ],
  
  TIER_2: [
    // Stablecoin pairs
    {
      tokenA: TOKEN_ADDRESSES.USDC,
      tokenB: TOKEN_ADDRESSES.USDT,
      description: "USDC-USDT"
    },
    {
      tokenA: TOKEN_ADDRESSES.USDC,
      tokenB: TOKEN_ADDRESSES.DAI,
      description: "USDC-DAI"
    },
    {
      tokenA: TOKEN_ADDRESSES.USDT,
      tokenB: TOKEN_ADDRESSES.DAI,
      description: "USDT-DAI"
    },
    // Other major token pairs
    {
      tokenA: TOKEN_ADDRESSES.WETH,
      tokenB: TOKEN_ADDRESSES.UNI,
      description: "WETH-UNI"
    },
    {
      tokenA: TOKEN_ADDRESSES.WETH,
      tokenB: TOKEN_ADDRESSES.LINK,
      description: "WETH-LINK"
    }
  ],
  
  TIER_3: [
    // Less liquid pairs but still potentially profitable
    {
      tokenA: TOKEN_ADDRESSES.WETH,
      tokenB: TOKEN_ADDRESSES.AAVE,
      description: "WETH-AAVE"
    },
    {
      tokenA: TOKEN_ADDRESSES.WETH,
      tokenB: TOKEN_ADDRESSES.SNX,
      description: "WETH-SNX"
    },
    {
      tokenA: TOKEN_ADDRESSES.WBTC,
      tokenB: TOKEN_ADDRESSES.USDC,
      description: "WBTC-USDC"
    },
    {
      tokenA: TOKEN_ADDRESSES.WBTC,
      tokenB: TOKEN_ADDRESSES.USDT,
      description: "WBTC-USDT"
    }
  ]
};

/**
 * Get all token pairs from all tiers
 * @returns {Array} - All token pairs
 */
function getAllTokenPairs() {
  return [
    ...TOKEN_PAIR_TIERS.TIER_1,
    ...TOKEN_PAIR_TIERS.TIER_2,
    ...TOKEN_PAIR_TIERS.TIER_3
  ];
}

/**
 * Get token pairs by tier
 * @param {number} tier - Tier number (1, 2, or 3)
 * @returns {Array} - Token pairs in the specified tier
 */
function getTokenPairsByTier(tier) {
  switch (tier) {
    case 1:
      return TOKEN_PAIR_TIERS.TIER_1;
    case 2:
      return TOKEN_PAIR_TIERS.TIER_2;
    case 3:
      return TOKEN_PAIR_TIERS.TIER_3;
    default:
      return [];
  }
}

/**
 * Get token pairs containing a specific token
 * @param {string} tokenAddress - Address of the token to filter by
 * @returns {Array} - Token pairs containing the specified token
 */
function getTokenPairsByToken(tokenAddress) {
  const allPairs = getAllTokenPairs();
  
  return allPairs.filter(pair => 
    pair.tokenA.toLowerCase() === tokenAddress.toLowerCase() ||
    pair.tokenB.toLowerCase() === tokenAddress.toLowerCase()
  );
}

/**
 * Get pairs analyzed from the target wallet address
 * Based on transaction history analysis of 0xf5213a6a2f0890321712520b8048d9886c1a9900
 * @returns {Array} - Token pairs frequently traded by the target wallet
 */
function getTargetWalletPairs() {
  // Pairs frequently used by the target wallet based on analysis
  return [
    // Core pairs with high activity
    {
      tokenA: TOKEN_ADDRESSES.WETH,
      tokenB: TOKEN_ADDRESSES.USDC,
      description: "WETH-USDC",
      frequency: "high"
    },
    {
      tokenA: TOKEN_ADDRESSES.WETH,
      tokenB: TOKEN_ADDRESSES.USDT,
      description: "WETH-USDT",
      frequency: "high"
    },
    {
      tokenA: TOKEN_ADDRESSES.WETH,
      tokenB: TOKEN_ADDRESSES.DAI,
      description: "WETH-DAI",
      frequency: "medium"
    },
    {
      tokenA: TOKEN_ADDRESSES.WBTC,
      tokenB: TOKEN_ADDRESSES.WETH,
      description: "WBTC-WETH",
      frequency: "medium"
    },
    {
      tokenA: TOKEN_ADDRESSES.USDC,
      tokenB: TOKEN_ADDRESSES.USDT,
      description: "USDC-USDT",
      frequency: "low"
    }
  ];
}

module.exports = {
  TOKEN_PAIR_TIERS,
  getAllTokenPairs,
  getTokenPairsByTier,
  getTokenPairsByToken,
  getTargetWalletPairs
};