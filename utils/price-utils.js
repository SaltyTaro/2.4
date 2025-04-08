/**
 * Utility functions for price calculations and conversions
 */
const { ethers } = require("hardhat");
const { BigNumber } = require("ethers");
const { TOKEN_ADDRESSES } = require("./constants");

// Cache for token prices to avoid excessive RPC calls
const priceCache = {
  prices: new Map(),
  ttl: 60000 // 1 minute
};

/**
 * Gets the price of a token in ETH
 * @param {string} tokenAddress - Token address
 * @param {Object} provider - Ethers provider
 * @returns {Promise<BigNumber>} - Token price in ETH (18 decimals)
 */
async function getPriceInEth(tokenAddress, provider) {
  // If token is ETH/WETH, return 1
  if (
    tokenAddress.toLowerCase() === TOKEN_ADDRESSES.WETH.toLowerCase() ||
    tokenAddress.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  ) {
    return ethers.utils.parseEther("1");
  }
  
  // Check cache
  const cacheKey = tokenAddress.toLowerCase();
  const cachedPrice = priceCache.prices.get(cacheKey);
  
  if (cachedPrice && Date.now() - cachedPrice.timestamp < priceCache.ttl) {
    return cachedPrice.price;
  }
  
  try {
    // Use Uniswap V2 to get token price against WETH
    const uniswapFactory = new ethers.Contract(
      "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f", // Uniswap V2 Factory
      ["function getPair(address, address) view returns (address)"],
      provider
    );
    
    const pairAddress = await uniswapFactory.getPair(tokenAddress, TOKEN_ADDRESSES.WETH);
    
    // If pair doesn't exist, try another method
    if (pairAddress === ethers.constants.AddressZero) {
      return await getPriceFromChainlinkOracle(tokenAddress, provider);
    }
    
    // Get reserves from the pair
    const pair = new ethers.Contract(
      pairAddress,
      [
        "function getReserves() view returns (uint112, uint112, uint32)",
        "function token0() view returns (address)",
        "function token1() view returns (address)"
      ],
      provider
    );
    
    const [reserve0, reserve1] = await pair.getReserves();
    const token0 = await pair.token0();
    
    // Get token decimals
    const token = new ethers.Contract(
      tokenAddress,
      ["function decimals() view returns (uint8)"],
      provider
    );
    
    const decimals = await token.decimals();
    
    // Calculate price based on reserves
    let price;
    if (token0.toLowerCase() === tokenAddress.toLowerCase()) {
      // token0 is our token, token1 is WETH
      price = reserve1.mul(ethers.utils.parseUnits("1", decimals)).div(reserve0);
    } else {
      // token1 is our token, token0 is WETH
      price = reserve0.mul(ethers.utils.parseUnits("1", decimals)).div(reserve1);
    }
    
    // Cache the result
    priceCache.prices.set(cacheKey, {
      price,
      timestamp: Date.now()
    });
    
    return price;
  } catch (error) {
    console.error(`Error getting ETH price for ${tokenAddress}:`, error);
    return ethers.BigNumber.from(0);
  }
}

/**
 * Gets the price of a token in USD
 * @param {string} tokenAddress - Token address
 * @param {Object} provider - Ethers provider
 * @returns {Promise<string>} - Token price in USD
 */
async function getPriceInUsd(tokenAddress, provider) {
  try {
    // Get ETH price in USD from Chainlink
    const ethPriceInUsd = await getEthPriceInUsd(provider);
    if (ethPriceInUsd === 0) {
      return "0.00";
    }
    
    // Get token price in ETH
    const priceInEth = await getPriceInEth(tokenAddress, provider);
    
    // Convert to USD
    const priceInUsd = parseFloat(ethers.utils.formatEther(priceInEth)) * ethPriceInUsd;
    return priceInUsd.toFixed(2);
  } catch (error) {
    console.error(`Error getting USD price for ${tokenAddress}:`, error);
    return "0.00";
  }
}

/**
 * Gets the current ETH price in USD from Chainlink oracle
 * @param {Object} provider - Ethers provider
 * @returns {Promise<number>} - ETH price in USD
 */
async function getEthPriceInUsd(provider) {
  try {
    // Chainlink ETH/USD Price Feed address
    const ETH_USD_FEED = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
    
    const aggregator = new ethers.Contract(
      ETH_USD_FEED,
      [
        "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)"
      ],
      provider
    );
    
    const { answer } = await aggregator.latestRoundData();
    
    // Chainlink ETH/USD has 8 decimals
    return parseFloat(ethers.utils.formatUnits(answer, 8));
  } catch (error) {
    console.error("Error getting ETH price in USD:", error);
    return 2000; // Default fallback price
  }
}

/**
 * Gets token price from Chainlink oracle
 * @param {string} tokenAddress - Token address
 * @param {Object} provider - Ethers provider
 * @returns {Promise<BigNumber>} - Token price in ETH
 */
async function getPriceFromChainlinkOracle(tokenAddress, provider) {
  // Mapping of token addresses to Chainlink feed addresses
  const chainlinkFeeds = {
    [TOKEN_ADDRESSES.USDC.toLowerCase()]: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6", // USDC/USD
    [TOKEN_ADDRESSES.USDT.toLowerCase()]: "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D", // USDT/USD
    [TOKEN_ADDRESSES.DAI.toLowerCase()]: "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9", // DAI/USD
    [TOKEN_ADDRESSES.WBTC.toLowerCase()]: "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c" // BTC/USD
  };
  
  const feedAddress = chainlinkFeeds[tokenAddress.toLowerCase()];
  if (!feedAddress) {
    return ethers.BigNumber.from(0);
  }
  
  try {
    const aggregator = new ethers.Contract(
      feedAddress,
      [
        "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
        "function decimals() view returns (uint8)"
      ],
      provider
    );
    
    const [{ answer }, decimals] = await Promise.all([
      aggregator.latestRoundData(),
      aggregator.decimals()
    ]);
    
    // Get ETH price in USD
    const ethPriceInUsd = await getEthPriceInUsd(provider);
    if (ethPriceInUsd === 0) {
      return ethers.BigNumber.from(0);
    }
    
    // Convert USD price to ETH price
    const tokenPriceInUsd = parseFloat(ethers.utils.formatUnits(answer, decimals));
    const tokenPriceInEth = tokenPriceInUsd / ethPriceInUsd;
    
    return ethers.utils.parseEther(tokenPriceInEth.toString());
  } catch (error) {
    console.error(`Error getting Chainlink price for ${tokenAddress}:`, error);
    return ethers.BigNumber.from(0);
  }
}

/**
 * Calculates the price impact of a swap
 * @param {BigNumber} amountIn - Input amount
 * @param {BigNumber} reserveIn - Input token reserve
 * @param {BigNumber} reserveOut - Output token reserve
 * @returns {number} - Price impact as a decimal (0.01 = 1%)
 */
function getPriceImpact(amountIn, reserveIn, reserveOut) {
  // Skip calculation if inputs are invalid
  if (amountIn.isZero() || reserveIn.isZero() || reserveOut.isZero()) {
    return 0;
  }
  
  // Calculate spot price
  const spotPrice = reserveOut.mul(ethers.constants.WeiPerEther).div(reserveIn);
  
  // Calculate output amount
  const amountInWithFee = amountIn.mul(997);
  const numerator = amountInWithFee.mul(reserveOut);
  const denominator = reserveIn.mul(1000).add(amountInWithFee);
  const amountOut = numerator.div(denominator);
  
  if (amountOut.isZero()) {
    return 0;
  }
  
  // Calculate execution price
  const executionPrice = amountOut.mul(ethers.constants.WeiPerEther).div(amountIn);
  
  // Calculate price impact
  if (spotPrice.lte(executionPrice)) {
    return 0;
  }
  
  const impact = spotPrice.sub(executionPrice).mul(10000).div(spotPrice);
  return impact.toNumber() / 10000; // Convert to decimal
}

module.exports = {
  getPriceInEth,
  getPriceInUsd,
  getEthPriceInUsd,
  getPriceImpact
};