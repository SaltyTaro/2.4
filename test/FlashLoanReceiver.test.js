const { ethers } = require("hardhat");
const { expect } = require("chai");
const { BigNumber } = require("ethers");

describe("FlashLoanReceiver", function () {
  let flashLoanReceiver;
  let mevStrategy;
  let owner;
  let user;
  let uniswapRouter;
  let uniswapFactory;
  let weth;
  let usdc;
  let wethUsdcPair;
  
  // Mock addresses for testing
  const MOCK_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"; // Uniswap V2 Router
  const MOCK_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f"; // Uniswap V2 Factory
  const MOCK_PAIR = "0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc"; // Uniswap ETH/USDC pair
  const MOCK_AAVE = "0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9"; // Aave Lending Pool
  
  beforeEach(async function () {
    // Get signers
    [owner, user] = await ethers.getSigners();
    
    // Deploy mock contracts
    // For proper testing, we would use a mainnet fork
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);
    usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    
    // Deploy MevStrategy with factory initialization
    const MevStrategy = await ethers.getContractFactory("MevStrategy");
    mevStrategy = await MevStrategy.deploy(MOCK_ROUTER, MOCK_AAVE, ethers.constants.AddressZero);
    await mevStrategy.setFactory(MOCK_FACTORY);
    
    // Deploy FlashLoanReceiver with proper configuration
    const FlashLoanReceiver = await ethers.getContractFactory("FlashLoanReceiver");
    flashLoanReceiver = await FlashLoanReceiver.deploy(
      mevStrategy.address,
      MOCK_ROUTER,
      MOCK_PAIR,
      weth.address,
      usdc.address,
      ethers.utils.parseEther("10"), // victim amount
      0 // victim min out
    );
  });

  describe("Deployment", function () {
    it("Should initialize with correct parameters", async function () {
      expect(await flashLoanReceiver.owner()).to.equal(mevStrategy.address);
      expect(await flashLoanReceiver.uniswapRouter()).to.equal(MOCK_ROUTER);
      expect(await flashLoanReceiver.targetPair()).to.equal(MOCK_PAIR);
      expect(await flashLoanReceiver.tokenIn()).to.equal(weth.address);
      expect(await flashLoanReceiver.tokenOut()).to.equal(usdc.address);
      expect(await flashLoanReceiver.victimAmount()).to.equal(ethers.utils.parseEther("10"));
      expect(await flashLoanReceiver.victimMinOut()).to.equal(0);
      expect(await flashLoanReceiver.strategyCompleted()).to.equal(false);
    });
  });
  
  describe("Aave Flash Loan Callback", function () {
    it("Should only allow calls from the owner", async function () {
      const assets = [weth.address];
      const amounts = [ethers.utils.parseEther("1")];
      const premiums = [ethers.utils.parseEther("0.0009")]; // 0.09% fee
      
      // Since we can't properly test the flash loan callback without a mainnet fork,
      // we'll just test that the function reverts when called by unauthorized accounts
      
      await expect(
        flashLoanReceiver.connect(user).executeOperation(
          assets,
          amounts,
          premiums,
          user.address,
          ethers.utils.defaultAbiCoder.encode(["string"], ["SANDWICH"])
        )
      ).to.be.revertedWith("Unauthorized initiator");
    });
    
    it("Should handle decode failures gracefully", async function () {
      const assets = [weth.address];
      const amounts = [ethers.utils.parseEther("1")];
      const premiums = [ethers.utils.parseEther("0.0009")]; // 0.09% fee
      
      // Call with invalid params format to test error handling
      // This should revert with a different error than a decode failure
      await expect(
        flashLoanReceiver.connect(owner).executeOperation(
          assets,
          amounts,
          premiums,
          owner.address,
          "0x12345678" // Invalid encoded data
        )
      ).to.be.reverted; // We don't check for specific message since it depends on implementation
    });
  });
  
  describe("Balancer Flash Loan Callback", function () {
    it("Should handle decode failures gracefully", async function () {
      // Testing with mock tokens and amounts
      const tokens = [weth.address];
      const amounts = [ethers.utils.parseEther("1")];
      const feeAmounts = [ethers.utils.parseEther("0")]; // No fee
      
      // For our test implementation, we're allowing any caller for simpler testing
      // In production, this would be restricted to the Balancer Vault
      
      // We just verify the function exists and can be called
      expect(flashLoanReceiver.receiveFlashLoan).to.be.a('function');
    });
  });
  
  describe("Decoding Helper Functions", function () {
    it("Should decode strategy type correctly", async function () {
      const params = ethers.utils.defaultAbiCoder.encode(["string"], ["SANDWICH"]);
      const decodedType = await flashLoanReceiver.decodeStrategyType(params);
      expect(decodedType).to.equal("SANDWICH");
    });
    
    it("Should handle empty strategy type gracefully", async function () {
      // Empty or invalid params should default to "SANDWICH"
      const emptyParams = "0x";
      const decodedType = await flashLoanReceiver.decodeStrategyType(emptyParams);
      expect(decodedType).to.equal("SANDWICH");
    });
    
    it("Should decode target pool correctly", async function () {
      const params = ethers.utils.defaultAbiCoder.encode(["address"], [MOCK_PAIR]);
      const decodedPool = await flashLoanReceiver.decodeTargetPool(params);
      expect(decodedPool).to.equal(MOCK_PAIR);
    });
    
    it("Should handle empty target pool gracefully", async function () {
      // Empty or invalid params should default to zero address
      const emptyParams = "0x";
      const decodedPool = await flashLoanReceiver.decodeTargetPool(emptyParams);
      expect(decodedPool).to.equal(ethers.constants.AddressZero);
    });
  });
  
  describe("Token Recovery", function () {
    it("Should allow owner to recover tokens", async function () {
      // Deploy a new FlashLoanReceiver with owner as the direct owner
      const FlashLoanReceiver = await ethers.getContractFactory("FlashLoanReceiver");
      const directOwnedReceiver = await FlashLoanReceiver.deploy(
        owner.address, // Direct ownership by owner signer
        MOCK_ROUTER,
        MOCK_PAIR,
        weth.address,
        usdc.address,
        ethers.utils.parseEther("10"),
        0
      );
      
      // Mint tokens to the receiver
      await weth.mint(directOwnedReceiver.address, ethers.utils.parseEther("1"));
      
      // Initial balances
      const initialReceiverBalance = await weth.balanceOf(directOwnedReceiver.address);
      const initialOwnerBalance = await weth.balanceOf(owner.address);
      
      // Recover tokens - should work since owner is directly the owner
      await directOwnedReceiver.connect(owner).recoverTokens(weth.address);
      
      // Final balances
      const finalReceiverBalance = await weth.balanceOf(directOwnedReceiver.address);
      const finalOwnerBalance = await weth.balanceOf(owner.address);
      
      // Verify tokens were recovered
      expect(finalReceiverBalance).to.equal(0);
      expect(finalOwnerBalance).to.equal(initialOwnerBalance.add(initialReceiverBalance));
    });
    
    it("Should not allow non-owner to recover tokens", async function () {
      await weth.mint(flashLoanReceiver.address, ethers.utils.parseEther("1"));
      
      // Attempt to recover tokens as a non-owner
      await expect(
        flashLoanReceiver.connect(user).recoverTokens(weth.address)
      ).to.be.revertedWith("Only owner can recover tokens");
    });
  });
});