// Profitability analysis script for MEV strategies
const { ethers } = require("hardhat");
const { BigNumber } = require("ethers");
const fs = require("fs");
const path = require("path");

// Import utility functions and constants
const { TOKEN_ADDRESSES, DEX_ADDRESSES } = require("../utils/constants");
const { formatTokenAmount } = require("../utils/helpers");

// Calculate profitability of sandwich attacks
async function analyzeSandwichProfitability() {
  console.log("Analyzing sandwich attack profitability...");
  
  // Get signers
  const [deployer] = await ethers.getSigners();
  
  // Load deployment information
  const deploymentPath = path.join(__dirname, "..", "deployments", network.name + ".json");
  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  
  // Connect to contracts
  const mevStrategy = await ethers.getContractAt("MevStrategy", deploymentInfo.mevStrategy);
  const uniswapRouter = await ethers.getContractAt("IUniswapV2Router02", deploymentInfo.uniswapRouter);
  const uniswapFactory = await ethers.getContractAt("IUniswapV2Factory", await uniswapRouter.factory());
  
  // Tokens to analyze
  const tokens = [
    { symbol: "WETH", address: TOKEN_ADDRESSES.WETH, decimals: 18 },
    { symbol: "USDC", address: TOKEN_ADDRESSES.USDC, decimals: 6 },
    { symbol: "DAI", address: TOKEN_ADDRESSES.DAI, decimals: 18 },
    { symbol: "WBTC", address: TOKEN_ADDRESSES.WBTC, decimals: 8 }
  ];
  
  // Create pairs to analyze
  const pairs = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      pairs.push({
        tokenA: tokens[i],
        tokenB: tokens[j]
      });
    }
  }
  
  // Gas price scenarios (in gwei)
  const gasPriceScenarios = [30, 50, 100, 200];
  
  // Victim swap amount scenarios (in ETH or equivalent)
  const victimAmountScenarios = [1, 5, 10, 20, 50];
  
  // Front-run amount scenarios (as percentage of victim amount)
  const frontRunPercentages = [50, 100, 200, 300];
  
  // Results table
  console.log("\n----- Sandwich Attack Profitability Analysis -----");
  console.log("Pair\tVictim Amt\tFront %\tGas (gwei)\tProfit (ETH)\tROI %\tProfit After Gas");
  console.log("-------------------------------------------------------------------------------");
  
  // Analyze each pair
  for (const pair of pairs) {
    const pairAddress = await uniswapFactory.getPair(pair.tokenA.address, pair.tokenB.address);
    
    // Skip if pair doesn't exist
    if (pairAddress === ethers.constants.AddressZero) {
      continue;
    }
    
    const pairContract = await ethers.getContractAt("IUniswapV2Pair", pairAddress);
    const [reserve0, reserve1] = await pairContract.getReserves();
    const token0 = await pairContract.token0();
    const token1 = await pairContract.token1();
    
    // Determine which token is WETH (for pricing)
    let wethToken, otherToken;
    let wethReserve, otherReserve;
    
    if (token0.toLowerCase() === TOKEN_ADDRESSES.WETH.toLowerCase()) {
      wethToken = token0;
      otherToken = token1;
      wethReserve = reserve0;
      otherReserve = reserve1;
    } else if (token1.toLowerCase() === TOKEN_ADDRESSES.WETH.toLowerCase()) {
      wethToken = token1;
      otherToken = token0;
      wethReserve = reserve1;
      otherReserve = reserve0;
    } else {
      // If neither token is WETH, use token0 as base
      wethToken = token0;
      otherToken = token1;
      wethReserve = reserve0;
      otherReserve = reserve1;
    }
    
    // For each victim amount scenario
    for (const victimEth of victimAmountScenarios) {
      const victimAmount = ethers.utils.parseEther(victimEth.toString());
      
      // For each front-run percentage
      for (const frontRunPct of frontRunPercentages) {
        const frontRunAmount = victimAmount.mul(frontRunPct).div(100);
        
        // Calculate expected profit
        try {
          const expectedProfit = await mevStrategy.calculateSandwichProfit(
            pairAddress,
            wethToken,
            otherToken,
            frontRunAmount,
            victimAmount
          );
          
          // For each gas price scenario
          for (const gasPriceGwei of gasPriceScenarios) {
            const gasPrice = ethers.utils.parseUnits(gasPriceGwei.toString(), "gwei");
            const gasLimit = BigNumber.from(500000); // Estimated gas limit
            const gasCost = gasPrice.mul(gasLimit);
            
            const profitAfterGas = expectedProfit.gt(gasCost) ? 
              expectedProfit.sub(gasCost) : BigNumber.from(0);
            
            // Calculate ROI
            const roi = frontRunAmount.gt(0) ? 
              expectedProfit.mul(10000).div(frontRunAmount) : BigNumber.from(0);
            
            // Format output
            const pairName = `${pair.tokenA.symbol}-${pair.tokenB.symbol}`;
            const profitEth = ethers.utils.formatEther(expectedProfit);
            const profitAfterGasEth = ethers.utils.formatEther(profitAfterGas);
            const roiFormatted = (roi.toNumber() / 100).toFixed(2);
            
            console.log(`${pairName}\t${victimEth} ETH\t${frontRunPct}%\t${gasPriceGwei}\t${profitEth}\t${roiFormatted}%\t${profitAfterGasEth}`);
          }
        } catch (error) {
          console.log(`Error calculating profit for ${pair.tokenA.symbol}-${pair.tokenB.symbol}: ${error.message}`);
        }
      }
    }
  }
  
  console.log("\nAnalysis complete!");
}

// Calculate profitability of arbitrage between DEXes
async function analyzeArbitrageProfitability() {
  console.log("\n----- Arbitrage Profitability Analysis -----");
  
  // Connect to contracts
  const uniswapFactory = await ethers.getContractAt("IUniswapV2Factory", DEX_ADDRESSES.UNISWAP_V2_FACTORY);
  const sushiswapFactory = await ethers.getContractAt("IUniswapV2Factory", DEX_ADDRESSES.SUSHISWAP_FACTORY);
  
  // Tokens to analyze
  const tokens = [
    { symbol: "WETH", address: TOKEN_ADDRESSES.WETH, decimals: 18 },
    { symbol: "USDC", address: TOKEN_ADDRESSES.USDC, decimals: 6 },
    { symbol: "DAI", address: TOKEN_ADDRESSES.DAI, decimals: 18 },
    { symbol: "WBTC", address: TOKEN_ADDRESSES.WBTC, decimals: 8 }
  ];
  
  // Create pairs to analyze
  const pairs = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      pairs.push({
        tokenA: tokens[i],
        tokenB: tokens[j]
      });
    }
  }
  
  // Arbitrage amount scenarios (in ETH or equivalent)
  const arbAmountScenarios = [1, 5, 10, 20, 50, 100];
  
  // Gas price scenarios (in gwei)
  const gasPriceScenarios = [30, 50, 100];
  
  // Results table
  console.log("\nPair\tAmount\tGas (gwei)\tUni Price\tSushi Price\tDiff %\tProfit (ETH)\tROI %");
  console.log("------------------------------------------------------------------------------------");
  
  // Analyze each pair
  for (const pair of pairs) {
    const uniPairAddress = await uniswapFactory.getPair(pair.tokenA.address, pair.tokenB.address);
    const sushiPairAddress = await sushiswapFactory.getPair(pair.tokenA.address, pair.tokenB.address);
    
    // Skip if either pair doesn't exist
    if (uniPairAddress === ethers.constants.AddressZero || sushiPairAddress === ethers.constants.AddressZero) {
      continue;
    }
    
    // Get pair contracts
    const uniPair = await ethers.getContractAt("IUniswapV2Pair", uniPairAddress);
    const sushiPair = await ethers.getContractAt("IUniswapV2Pair", sushiPairAddress);
    
    // Get reserves
    const [uniReserve0, uniReserve1] = await uniPair.getReserves();
    const [sushiReserve0, sushiReserve1] = await sushiPair.getReserves();
    
    // Get token addresses
    const uniToken0 = await uniPair.token0();
    const uniToken1 = await uniPair.token1();
    const sushiToken0 = await sushiPair.token0();
    const sushiToken1 = await sushiPair.token1();
    
    // Calculate price on Uniswap
    const uniPrice = calculatePrice(
      uniReserve0, 
      uniReserve1, 
      uniToken0.toLowerCase() === pair.tokenA.address.toLowerCase(),
      pair.tokenA.decimals,
      pair.tokenB.decimals
    );
    
    // Calculate price on Sushiswap
    const sushiPrice = calculatePrice(
      sushiReserve0, 
      sushiReserve1, 
      sushiToken0.toLowerCase() === pair.tokenA.address.toLowerCase(),
      pair.tokenA.decimals,
      pair.tokenB.decimals
    );
    
    // Calculate price difference
    const priceDiff = uniPrice.gt(sushiPrice) ? 
      uniPrice.sub(sushiPrice) : sushiPrice.sub(uniPrice);
    const priceDiffPercent = priceDiff.mul(10000).div(uniPrice.gt(sushiPrice) ? uniPrice : sushiPrice);
    
    // If price difference is too small, skip detailed analysis
    if (priceDiffPercent.lt(5)) { // Less than 0.05% difference
      console.log(`${pair.tokenA.symbol}-${pair.tokenB.symbol}\tSKIP\tSKIP\t${formatTokenAmount(uniPrice, 8)}\t${formatTokenAmount(sushiPrice, 8)}\t${priceDiffPercent.toNumber() / 100}%\tToo small\tN/A`);
      continue;
    }
    
    // For each arbitrage amount
    for (const arbAmount of arbAmountScenarios) {
      const amount = ethers.utils.parseEther(arbAmount.toString());
      
      // Determine direction (buy on cheaper DEX, sell on more expensive)
      const buyOnUniswap = sushiPrice.gt(uniPrice);
      
      // Simplified arbitrage profit calculation
      let expectedProfit;
      if (buyOnUniswap) {
        // Buy on Uniswap, sell on Sushiswap
        const amountOut = calculateAmountOut(
          amount,
          uniReserve0,
          uniReserve1,
          uniToken0.toLowerCase() === pair.tokenA.address.toLowerCase()
        );
        
        const finalAmount = calculateAmountOut(
          amountOut,
          sushiReserve1,
          sushiReserve0,
          sushiToken0.toLowerCase() !== pair.tokenA.address.toLowerCase()
        );
        
        expectedProfit = finalAmount.gt(amount) ? finalAmount.sub(amount) : BigNumber.from(0);
      } else {
        // Buy on Sushiswap, sell on Uniswap
        const amountOut = calculateAmountOut(
          amount,
          sushiReserve0,
          sushiReserve1,
          sushiToken0.toLowerCase() === pair.tokenA.address.toLowerCase()
        );
        
        const finalAmount = calculateAmountOut(
          amountOut,
          uniReserve1,
          uniReserve0,
          uniToken0.toLowerCase() !== pair.tokenA.address.toLowerCase()
        );
        
        expectedProfit = finalAmount.gt(amount) ? finalAmount.sub(amount) : BigNumber.from(0);
      }
      
      // Gas cost (for highest gas price scenario only to save output space)
      const gasPrice = ethers.utils.parseUnits(gasPriceScenarios[gasPriceScenarios.length - 1].toString(), "gwei");
      const gasLimit = BigNumber.from(350000); // Lower estimate for arbitrage
      const gasCost = gasPrice.mul(gasLimit);
      
      // Profitability check
      const profitAfterGas = expectedProfit.gt(gasCost) ? expectedProfit.sub(gasCost) : BigNumber.from(0);
      
      // Calculate ROI
      const roi = expectedProfit.mul(10000).div(amount);
      
      // Format and output results
      const pairName = `${pair.tokenA.symbol}-${pair.tokenB.symbol}`;
      const profitEth = ethers.utils.formatEther(profitAfterGas);
      const direction = buyOnUniswap ? "Uni→Sushi" : "Sushi→Uni";
      const roiFormatted = (roi.toNumber() / 100).toFixed(2);
      
      console.log(`${pairName}\t${arbAmount} ETH\t${gasPriceScenarios[gasPriceScenarios.length - 1]}\t${formatTokenAmount(uniPrice, 6)}\t${formatTokenAmount(sushiPrice, 6)}\t${priceDiffPercent.toNumber() / 100}%\t${profitEth}\t${roiFormatted}%`);
    }
  }
  
  console.log("\nArbitrage analysis complete!");
}

// Helper: Calculate price given reserves
function calculatePrice(reserve0, reserve1, zeroForOne, decimals0, decimals1) {
  if (zeroForOne) {
    // Price of token0 in terms of token1
    return reserve1.mul(ethers.utils.parseUnits("1", decimals0)).div(reserve0);
  } else {
    // Price of token1 in terms of token0
    return reserve0.mul(ethers.utils.parseUnits("1", decimals1)).div(reserve1);
  }
}

// Helper: Calculate output amount for a swap
function calculateAmountOut(amountIn, reserveIn, reserveOut, zeroForOne) {
  const amountInWithFee = amountIn.mul(997);
  const numerator = amountInWithFee.mul(reserveOut);
  const denominator = reserveIn.mul(1000).add(amountInWithFee);
  return numerator.div(denominator);
}

// Main function
async function main() {
  await analyzeSandwichProfitability();
  await analyzeArbitrageProfitability();
}

// Execute script
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });