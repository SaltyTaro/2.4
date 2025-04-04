// Deploy script for the MEV Strategy project
const { ethers } = require("hardhat");
const { writeFileSync } = require("fs");
const path = require("path");

async function main() {
  console.log("Starting deployment process...");
  
  // Get deployer account
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying contracts with the account: ${deployer.address}`);
  console.log(`Account balance: ${ethers.utils.formatEther(await deployer.getBalance())}`);
  
  // Deploy MevStrategy contract
  console.log("\nDeploying MevStrategy contract...");
  
  // Define constructor parameters
  // These addresses should be replaced with the actual addresses for the network being deployed to
  const uniswapRouterAddress = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"; // Uniswap V2 Router on Mainnet
  const aaveFlashLoanAddress = "0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9"; // Aave Lending Pool on Mainnet
  const balancerFlashLoanAddress = "0xBA12222222228d8Ba445958a75a0704d566BF2C8"; // Balancer Vault on Mainnet
  
  // Deploy contract
  const MevStrategy = await ethers.getContractFactory("MevStrategy");
  const mevStrategy = await MevStrategy.deploy(
    uniswapRouterAddress,
    aaveFlashLoanAddress,
    balancerFlashLoanAddress
  );
  
  await mevStrategy.deployed();
  console.log(`MevStrategy deployed to: ${mevStrategy.address}`);
  
  // Configure the strategy
  console.log("\nConfiguring strategy parameters...");
  
  // Example target tokens (WETH, USDC, USDT, DAI, WBTC)
  const targetTokens = [
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
    "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
    "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
    "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"  // WBTC
  ];
  
  // Example target DEXes (Uniswap V2, Sushiswap)
  const targetDEXes = [
    "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f", // Uniswap V2 Factory
    "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac"  // Sushiswap Factory
  ];
  
  // Update strategy parameters
  const tx = await mevStrategy.updateStrategyParams({
    targetDEXes: targetDEXes,
    targetTokens: targetTokens,
    maxSlippage: 50, // 0.5% in basis points
    profitThreshold: ethers.utils.parseEther("0.05"), // 0.05 ETH min profit
    gasPrice: 0, // Will be set dynamically
    gasLimit: 500000,
    useAave: true,
    useBalancer: false
  });
  
  await tx.wait();
  console.log("Strategy parameters configured successfully");
  
  // Save deployment info to a file
  const deploymentInfo = {
    mevStrategy: mevStrategy.address,
    network: network.name,
    deploymentTime: new Date().toISOString(),
    deployer: deployer.address,
    uniswapRouter: uniswapRouterAddress,
    aaveFlashLoan: aaveFlashLoanAddress,
    balancerFlashLoan: balancerFlashLoanAddress,
    targetTokens: targetTokens,
    targetDEXes: targetDEXes
  };
  
  const deploymentPath = path.join(__dirname, "..", "deployments");
  writeFileSync(
    `${deploymentPath}/${network.name}.json`,
    JSON.stringify(deploymentInfo, null, 2)
  );
  
  console.log(`\nDeployment info saved to ${deploymentPath}/${network.name}.json`);
  console.log("\nDeployment completed successfully!");
}

// Execute deployment
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });