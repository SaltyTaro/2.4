// Opportunity scanner script to identify MEV opportunities in real-time
const { ethers } = require("hardhat");
const { BigNumber } = require("ethers");
const fs = require("fs");
const path = require("path");

// Import utility functions and constants
const { TOKEN_ADDRESSES, DEX_ADDRESSES } = require("../utils/constants");
const { formatTokenAmount, getTokenSymbol } = require("../utils/helpers");
const { getGasPrice } = require("../utils/gas-price-manager");

// Main scanning function
async function scanForOpportunities() {
  console.log("Starting MEV opportunity scanner...");
  console.log(`Network: ${network.name}`);
  console.log(`Block number: ${await ethers.provider.getBlockNumber()}`);
  console.log(`Time: ${new Date().toISOString()}`);
  
  // Get signers
  const [deployer] = await ethers.getSigners();
  console.log(`Using account: ${deployer.address}`);
  
  // Load deployment information
  const deploymentPath = path.join(__dirname, "..", "deployments", network.name + ".json");
  if (!fs.existsSync(deploymentPath)) {
    console.error(`Deployment file not found for network ${network.name}. Please deploy the contracts first.`);
    return;
  }
  
  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  
  // Connect to deployed contracts
  const mevStrategy = await ethers.getContractAt("MevStrategy", deploymentInfo.mevStrategy);
  const uniswapRouter = await ethers.getContractAt("IUniswapV2Router02", deploymentInfo.uniswapRouter);
  const uniswapFactory = await ethers.getContractAt("IUniswapV2Factory", await uniswapRouter.factory());
  
  // Target token pairs to monitor
  const targetPairs = [];
  
  // Build pairs from target tokens in the deployment
  for (let i = 0; i < deploymentInfo.targetTokens.length; i++) {
    for (let j = i + 1; j < deploymentInfo.targetTokens.length; j++) {
      const tokenA = deploymentInfo.targetTokens[i];
      const tokenB = deploymentInfo.targetTokens[j];
      
      // Check if pair exists on each DEX
      for (const dex of deploymentInfo.targetDEXes) {
        const factory = await ethers.getContractAt("IUniswapV2Factory", dex);
        const pairAddress = await factory.getPair(tokenA, tokenB);
        
        if (pairAddress !== ethers.constants.AddressZero) {
          // Get token symbols for logging
          const tokenASymbol = await getTokenSymbol(tokenA);
          const tokenBSymbol = await getTokenSymbol(tokenB);
          
          targetPairs.push({
            tokenA,
            tokenB,
            tokenASymbol,
            tokenBSymbol,
            factory: dex,
            pair: pairAddress
          });
        }
      }
    }
  }
  
  console.log(`Found ${targetPairs.length} target pairs to monitor`);
  
  // Get current gas price
  const gasInfo = await getGasPrice();
  console.log(`\nCurrent gas price: ${ethers.utils.formatUnits(gasInfo.gasPrice, "gwei")} gwei`);
  console.log(`Base fee: ${ethers.utils.formatUnits(gasInfo.baseFee, "gwei")} gwei`);
  console.log(`Priority fee: ${ethers.utils.formatUnits(gasInfo.priorityFee, "gwei")} gwei`);
  
  // Scan for sandwich opportunities
  console.log("\n--- Scanning for Sandwich Opportunities ---");
  for (const pairInfo of targetPairs) {
    console.log(`\nAnalyzing ${pairInfo.tokenASymbol}-${pairInfo.tokenBSymbol} pair on ${getDexName(pairInfo.factory)}...`);
    
    // Get pair contract
    const pairContract = await ethers.getContractAt("IUniswapV2Pair", pairInfo.pair);
    
    // Get reserves and token info
    const [reserve0, reserve1] = await pairContract.getReserves();
    const token0 = await pairContract.token0();
    const token1 = await pairContract.token1();
    
    // Simulated victim transaction sizes to analyze
    const victimSizes = [
      ethers.utils.parseEther("0.5"),   // 0.5 ETH
      ethers.utils.parseEther("1"),     // 1 ETH
      ethers.utils.parseEther("5"),     // 5 ETH
      ethers.utils.parseEther("10"),    // 10 ETH
      ethers.utils.parseEther("50")     // 50 ETH
    ];
    
    // Simulated front-run sizes as multiples of victim transaction
    const frontRunMultiples = [0.5, 1, 2, 3];
    
    // For each victim size
    for (const victimAmount of victimSizes) {
      // Determine optimal front-run multiple
      let bestProfit = BigNumber.from(0);
      let bestMultiple = 0;
      let bestFrontRunAmount = BigNumber.from(0);
      
      for (const multiple of frontRunMultiples) {
        const frontRunAmount = victimAmount.mul(Math.floor(multiple * 100)).div(100);
        
        try {
          // Estimate profit using the contract's function
          const profit = await mevStrategy.calculateSandwichProfit(
            pairInfo.pair,
            token0,
            token1,
            frontRunAmount,
            victimAmount
          );
          
          if (profit.gt(bestProfit)) {
            bestProfit = profit;
            bestMultiple = multiple;
            bestFrontRunAmount = frontRunAmount;
          }
        } catch (error) {
          // Skip this combination if there's an error
          continue;
        }
      }
      
      // If we found a profitable opportunity
      if (bestProfit.gt(0)) {
        // Calculate gas costs
        const gasLimit = BigNumber.from(500000); // Estimated gas for sandwich
        const gasCost = gasInfo.gasPrice.mul(gasLimit);
        
        // Check if profit exceeds gas cost
        if (bestProfit.gt(gasCost)) {
          const netProfit = bestProfit.sub(gasCost);
          const roi = bestFrontRunAmount.gt(0) ? 
            netProfit.mul(10000).div(bestFrontRunAmount) : BigNumber.from(0);
          
          console.log(`✅ PROFITABLE SANDWICH OPPORTUNITY:`);
          console.log(`   Pair: ${pairInfo.tokenASymbol}-${pairInfo.tokenBSymbol}`);
          console.log(`   Victim size: ${ethers.utils.formatEther(victimAmount)} ETH`);
          console.log(`   Optimal front-run: ${ethers.utils.formatEther(bestFrontRunAmount)} ETH (${bestMultiple}x)`);
          console.log(`   Expected profit: ${ethers.utils.formatEther(bestProfit)} ETH`);
          console.log(`   Gas cost: ${ethers.utils.formatEther(gasCost)} ETH`);
          console.log(`   Net profit: ${ethers.utils.formatEther(netProfit)} ETH`);
          console.log(`   ROI: ${(roi.toNumber() / 100).toFixed(2)}%`);
          
          // Save opportunity to a file for potential execution
          const opportunityInfo = {
            type: "sandwich",
            timestamp: Date.now(),
            pair: pairInfo.pair,
            tokenA: pairInfo.tokenA,
            tokenB: pairInfo.tokenB,
            tokenASymbol: pairInfo.tokenASymbol,
            tokenBSymbol: pairInfo.tokenBSymbol,
            victimAmount: victimAmount.toString(),
            frontRunAmount: bestFrontRunAmount.toString(),
            expectedProfit: bestProfit.toString(),
            gasCost: gasCost.toString(),
            netProfit: netProfit.toString(),
            roi: roi.toNumber() / 100
          };
          
          const opportunitiesDir = path.join(__dirname, "..", "opportunities");
          if (!fs.existsSync(opportunitiesDir)) {
            fs.mkdirSync(opportunitiesDir);
          }
          
          fs.writeFileSync(
            path.join(opportunitiesDir, `sandwich_${Date.now()}.json`),
            JSON.stringify(opportunityInfo, null, 2)
          );
        } else {
          console.log(`❌ Unprofitable after gas: Victim size ${ethers.utils.formatEther(victimAmount)} ETH, profit ${ethers.utils.formatEther(bestProfit)} ETH, gas ${ethers.utils.formatEther(gasCost)} ETH`);
        }
      } else {
        console.log(`❌ No profitable sandwich for victim size ${ethers.utils.formatEther(victimAmount)} ETH`);
      }
    }
  }
  
  // Scan for arbitrage opportunities between DEXes
  console.log("\n--- Scanning for Arbitrage Opportunities ---");
  
  // Group pairs by token combination
  const pairsByTokens = {};
  for (const pairInfo of targetPairs) {
    const key = [pairInfo.tokenA, pairInfo.tokenB].sort().join('-');
    if (!pairsByTokens[key]) {
      pairsByTokens[key] = [];
    }
    pairsByTokens[key].push(pairInfo);
  }
  
  // Check for arbitrage between DEXes for the same token pair
  for (const key in pairsByTokens) {
    const pairs = pairsByTokens[key];
    
    // Need at least 2 DEXes for arbitrage
    if (pairs.length < 2) continue;
    
    console.log(`\nAnalyzing arbitrage for ${pairs[0].tokenASymbol}-${pairs[0].tokenBSymbol}...`);
    
    // Compare prices across DEXes
    const priceData = [];
    
    for (const pairInfo of pairs) {
      const pairContract = await ethers.getContractAt("IUniswapV2Pair", pairInfo.pair);
      const [reserve0, reserve1] = await pairContract.getReserves();
      const token0 = await pairContract.token0();
      
      // Calculate price (token1 per token0)
      const is0A = token0.toLowerCase() === pairInfo.tokenA.toLowerCase();
      const price = is0A ? 
        reserve1.mul(ethers.utils.parseEther("1")).div(reserve0) : 
        reserve0.mul(ethers.utils.parseEther("1")).div(reserve1);
      
      priceData.push({
        dex: getDexName(pairInfo.factory),
        factory: pairInfo.factory,
        pair: pairInfo.pair,
        token0,
        token1: token0.toLowerCase() === pairInfo.tokenA.toLowerCase() ? pairInfo.tokenB : pairInfo.tokenA,
        reserve0,
        reserve1,
        price
      });
    }
    
    // Find best arbitrage opportunity
    let bestArb = null;
    let bestProfitBps = 0;
    
    for (let i = 0; i < priceData.length; i++) {
      for (let j = i + 1; j < priceData.length; j++) {
        const dex1 = priceData[i];
        const dex2 = priceData[j];
        
        // Calculate price difference in basis points
        let priceDiffBps;
        let buyOnFirst;
        
        if (dex1.price.gt(dex2.price)) {
          priceDiffBps = dex1.price.sub(dex2.price).mul(10000).div(dex2.price);
          buyOnFirst = false;
        } else {
          priceDiffBps = dex2.price.sub(dex1.price).mul(10000).div(dex1.price);
          buyOnFirst = true;
        }
        
        // If this is the best opportunity so far
        if (priceDiffBps.gt(bestProfitBps)) {
          bestProfitBps = priceDiffBps;
          bestArb = {
            buy: buyOnFirst ? dex1 : dex2,
            sell: buyOnFirst ? dex2 : dex1,
            priceDiffBps
          };
        }
      }
    }
    
    // If we found an arbitrage opportunity with significant profit potential
    if (bestArb && bestArb.priceDiffBps.gt(10)) { // More than 0.1% difference
      console.log(`✅ ARBITRAGE OPPORTUNITY DETECTED:`);
      console.log(`   ${pairs[0].tokenASymbol}-${pairs[0].tokenBSymbol}`);
      console.log(`   Buy on: ${bestArb.buy.dex}, price: ${ethers.utils.formatEther(bestArb.buy.price)}`);
      console.log(`   Sell on: ${bestArb.sell.dex}, price: ${ethers.utils.formatEther(bestArb.sell.price)}`);
      console.log(`   Price difference: ${bestArb.priceDiffBps.toNumber() / 100}%`);
      
      // Simulate arbitrage with different amounts
      const arbAmounts = [
        ethers.utils.parseEther("1"),     // 1 ETH
        ethers.utils.parseEther("5"),     // 5 ETH
        ethers.utils.parseEther("10"),    // 10 ETH
        ethers.utils.parseEther("50"),    // 50 ETH
        ethers.utils.parseEther("100")    // 100 ETH
      ];
      
      let bestAmount = BigNumber.from(0);
      let bestNetProfit = BigNumber.from(0);
      let bestRoi = BigNumber.from(0);
      
      for (const amount of arbAmounts) {
        // Estimate arbitrage profit
        const buyTokenIndex = bestArb.buy.token0.toLowerCase() === pairs[0].tokenA.toLowerCase() ? 0 : 1;
        const sellTokenIndex = buyTokenIndex === 0 ? 1 : 0;
        
        // Calculate output from first swap
        const amountOut = calculateAmountOut(
          amount,
          buyTokenIndex === 0 ? bestArb.buy.reserve0 : bestArb.buy.reserve1,
          buyTokenIndex === 0 ? bestArb.buy.reserve1 : bestArb.buy.reserve0
        );
        
        // Calculate output from second swap (back to original token)
        const finalAmount = calculateAmountOut(
          amountOut,
          sellTokenIndex === 0 ? bestArb.sell.reserve0 : bestArb.sell.reserve1,
          sellTokenIndex === 0 ? bestArb.sell.reserve1 : bestArb.sell.reserve0
        );
        
        // Calculate profit
        const profit = finalAmount.sub(amount);
        
        // Calculate gas costs
        const gasLimit = BigNumber.from(350000); // Estimated gas for arbitrage
        const gasCost = gasInfo.gasPrice.mul(gasLimit);
        
        // Check if profit exceeds gas cost
        if (profit.gt(gasCost)) {
          const netProfit = profit.sub(gasCost);
          const roi = netProfit.mul(10000).div(amount);
          
          if (netProfit.gt(bestNetProfit)) {
            bestAmount = amount;
            bestNetProfit = netProfit;
            bestRoi = roi;
          }
        }
      }
      
      if (bestNetProfit.gt(0)) {
        console.log(`   Optimal amount: ${ethers.utils.formatEther(bestAmount)} ETH`);
        console.log(`   Expected net profit: ${ethers.utils.formatEther(bestNetProfit)} ETH`);
        console.log(`   ROI: ${bestRoi.toNumber() / 100}%`);
        
        // Save opportunity to a file for potential execution
        const opportunityInfo = {
          type: "arbitrage",
          timestamp: Date.now(),
          tokenA: pairs[0].tokenA,
          tokenB: pairs[0].tokenB,
          tokenASymbol: pairs[0].tokenASymbol,
          tokenBSymbol: pairs[0].tokenBSymbol,
          buyDex: bestArb.buy.dex,
          sellDex: bestArb.sell.dex,
          buyPair: bestArb.buy.pair,
          sellPair: bestArb.sell.pair,
          priceDiff: bestArb.priceDiffBps.toString(),
          amount: bestAmount.toString(),
          netProfit: bestNetProfit.toString(),
          roi: bestRoi.toNumber() / 100
        };
        
        const opportunitiesDir = path.join(__dirname, "..", "opportunities");
        if (!fs.existsSync(opportunitiesDir)) {
          fs.mkdirSync(opportunitiesDir);
        }
        
        fs.writeFileSync(
          path.join(opportunitiesDir, `arbitrage_${Date.now()}.json`),
          JSON.stringify(opportunityInfo, null, 2)
        );
      } else {
        console.log(`   No profitable amount found after gas costs.`);
      }
    } else if (bestArb) {
      console.log(`❌ Small price difference (${bestArb.priceDiffBps.toNumber() / 100}%) - not worth arbitrage`);
    } else {
      console.log(`❌ No arbitrage opportunity found`);
    }
  }
  
  console.log("\nOpportunity scanning complete!");
}

// Helper: Get DEX name from factory address
function getDexName(factoryAddress) {
  switch (factoryAddress.toLowerCase()) {
    case DEX_ADDRESSES.UNISWAP_V2_FACTORY.toLowerCase():
      return "Uniswap V2";
    case DEX_ADDRESSES.SUSHISWAP_FACTORY.toLowerCase():
      return "Sushiswap";
    default:
      return "Unknown DEX";
  }
}

// Helper: Calculate output amount for a swap
function calculateAmountOut(amountIn, reserveIn, reserveOut) {
  const amountInWithFee = amountIn.mul(997);
  const numerator = amountInWithFee.mul(reserveOut);
  const denominator = reserveIn.mul(1000).add(amountInWithFee);
  return numerator.div(denominator);
}

// Execute opportunity scanner
scanForOpportunities()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });