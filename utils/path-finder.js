/**
 * Utility functions for finding optimal paths between tokens for multi-hop swaps
 */
const { ethers } = require("hardhat");
const { TOKEN_ADDRESSES, DEX_ADDRESSES } = require("./constants");

/**
 * Find a multi-hop path between two tokens
 * @param {string} tokenIn - Input token address
 * @param {string} tokenOut - Output token address
 * @param {number} maxHops - Maximum number of hops (default: 3)
 * @param {Object} provider - Ethers provider
 * @param {string} factoryAddress - DEX factory address (default: Uniswap V2)
 * @returns {Promise<Array>} - Array of possible paths
 */
async function findMultiHopPath(
  tokenIn,
  tokenOut, 
  maxHops = 3, 
  provider,
  factoryAddress = DEX_ADDRESSES.UNISWAP_V2_FACTORY
) {
  // Normalize addresses
  tokenIn = tokenIn.toLowerCase();
  tokenOut = tokenOut.toLowerCase();
  
  // Create factory contract instance
  const factory = new ethers.Contract(
    factoryAddress,
    ['function getPair(address, address) view returns (address)'],
    provider
  );
  
  // Common intermediate tokens
  const commonTokens = [
    TOKEN_ADDRESSES.WETH.toLowerCase(),
    TOKEN_ADDRESSES.USDC.toLowerCase(),
    TOKEN_ADDRESSES.USDT.toLowerCase(),
    TOKEN_ADDRESSES.DAI.toLowerCase(),
    TOKEN_ADDRESSES.WBTC.toLowerCase()
  ].filter(t => t !== tokenIn && t !== tokenOut);
  
  // Store found paths
  const paths = [];
  
  // Check direct path first
  const directPair = await factory.getPair(tokenIn, tokenOut);
  if (directPair !== ethers.constants.AddressZero) {
    paths.push({
      tokens: [tokenIn, tokenOut],
      pairs: [directPair],
      hops: 1
    });
  }
  
  // If we want multi-hop paths, search for them
  if (maxHops >= 2) {
    // For each common token, check if it can be an intermediate hop
    for (const intermediateToken of commonTokens) {
      const pair1 = await factory.getPair(tokenIn, intermediateToken);
      const pair2 = await factory.getPair(intermediateToken, tokenOut);
      
      // If both pairs exist, we have a valid 2-hop path
      if (pair1 !== ethers.constants.AddressZero && pair2 !== ethers.constants.AddressZero) {
        paths.push({
          tokens: [tokenIn, intermediateToken, tokenOut],
          pairs: [pair1, pair2],
          hops: 2
        });
      }
    }
  }
  
  // If we want 3-hop paths, search for them
  if (maxHops >= 3 && commonTokens.length >= 2) {
    // For each combination of two intermediate tokens
    for (let i = 0; i < commonTokens.length; i++) {
      for (let j = i + 1; j < commonTokens.length; j++) {
        const intermediate1 = commonTokens[i];
        const intermediate2 = commonTokens[j];
        
        const pair1 = await factory.getPair(tokenIn, intermediate1);
        const pair2 = await factory.getPair(intermediate1, intermediate2);
        const pair3 = await factory.getPair(intermediate2, tokenOut);
        
        // If all pairs exist, we have a valid 3-hop path
        if (
          pair1 !== ethers.constants.AddressZero && 
          pair2 !== ethers.constants.AddressZero && 
          pair3 !== ethers.constants.AddressZero
        ) {
          paths.push({
            tokens: [tokenIn, intermediate1, intermediate2, tokenOut],
            pairs: [pair1, pair2, pair3],
            hops: 3
          });
        }
      }
    }
  }
  
  return paths;
}

/**
 * Find arbitrage opportunities between two DEXes
 * @param {string} tokenA - First token address
 * @param {string} tokenB - Second token address
 * @param {string} dex1 - First DEX factory address
 * @param {string} dex2 - Second DEX factory address
 * @param {Object} provider - Ethers provider
 * @returns {Promise<Object>} - Arbitrage opportunity if found
 */
async function findArbitrageOpportunity(
  tokenA,
  tokenB,
  dex1 = DEX_ADDRESSES.UNISWAP_V2_FACTORY,
  dex2 = DEX_ADDRESSES.SUSHISWAP_FACTORY,
  provider
) {
  // Create factory contract instances
  const factory1 = new ethers.Contract(
    dex1,
    ['function getPair(address, address) view returns (address)'],
    provider
  );
  
  const factory2 = new ethers.Contract(
    dex2,
    ['function getPair(address, address) view returns (address)'],
    provider
  );
  
  // Get pair addresses
  const pair1Address = await factory1.getPair(tokenA, tokenB);
  const pair2Address = await factory2.getPair(tokenA, tokenB);
  
  // If either pair doesn't exist, no arbitrage is possible
  if (
    pair1Address === ethers.constants.AddressZero || 
    pair2Address === ethers.constants.AddressZero
  ) {
    return null;
  }
  
  // Get pair contracts
  const pair1 = new ethers.Contract(
    pair1Address,
    [
      'function getReserves() view returns (uint112, uint112, uint32)',
      'function token0() view returns (address)',
      'function token1() view returns (address)'
    ],
    provider
  );
  
  const pair2 = new ethers.Contract(
    pair2Address,
    [
      'function getReserves() view returns (uint112, uint112, uint32)',
      'function token0() view returns (address)',
      'function token1() view returns (address)'
    ],
    provider
  );
  
  // Get reserves and tokens
  const [reserve1_0, reserve1_1] = await pair1.getReserves();
  const [reserve2_0, reserve2_1] = await pair2.getReserves();
  
  const token1_0 = await pair1.token0();
  const token2_0 = await pair2.token0();
  
  // Determine which reserves correspond to which tokens
  const isTokenA0InPair1 = token1_0.toLowerCase() === tokenA.toLowerCase();
  const isTokenA0InPair2 = token2_0.toLowerCase() === tokenA.toLowerCase();
  
  const reserveA1 = isTokenA0InPair1 ? reserve1_0 : reserve1_1;
  const reserveB1 = isTokenA0InPair1 ? reserve1_1 : reserve1_0;
  
  const reserveA2 = isTokenA0InPair2 ? reserve2_0 : reserve2_1;
  const reserveB2 = isTokenA0InPair2 ? reserve2_1 : reserve2_0;
  
  // Calculate prices
  // Price = reserveOut/reserveIn
  const priceAB1 = reserveB1.mul(ethers.constants.WeiPerEther).div(reserveA1);
  const priceAB2 = reserveB2.mul(ethers.constants.WeiPerEther).div(reserveA2);
  
  // Calculate price difference
  const priceDiff = priceAB1.gt(priceAB2) ? 
    priceAB1.sub(priceAB2) : priceAB2.sub(priceAB1);
  
  const priceDiffBps = priceDiff.mul(10000).div(
    priceAB1.gt(priceAB2) ? priceAB1 : priceAB2
  );
  
  // If price difference is too small, no profitable arbitrage
  if (priceDiffBps.lt(10)) { // Less than 0.1%
    return null;
  }
  
  // Determine direction
  const buyOnDex1 = priceAB2.gt(priceAB1);
  
  // Return arbitrage opportunity
  return {
    tokenA,
    tokenB,
    dex1,
    dex2,
    pair1: pair1Address,
    pair2: pair2Address,
    priceDiffBps: priceDiffBps.toNumber(),
    buyOnDex1
  };
}

module.exports = {
  findMultiHopPath,
  findArbitrageOpportunity
};