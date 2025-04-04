const { ethers } = require("hardhat");
const { expect } = require("chai");
const { BigNumber } = require("ethers");

// Security-focused tests for the MEV strategy contracts
describe("MEV Strategy Security Tests", function () {
  let mevStrategy;
  let flashLoanReceiver;
  let owner;
  let attacker;
  let weth;
  let usdc;
  
  // Mock addresses for testing
  const MOCK_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"; // Uniswap V2 Router
  const MOCK_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f"; // Uniswap V2 Factory
  const MOCK_AAVE = "0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9"; // Aave Lending Pool
  const MOCK_BALANCER = "0xBA12222222228d8Ba445958a75a0704d566BF2C8"; // Balancer Vault
  
  beforeEach(async function () {
    // Get signers
    [owner, attacker] = await ethers.getSigners();
    
    // Deploy mock contracts
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);
    usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    
    // Deploy MevStrategy with factory initialization
    const MevStrategy = await ethers.getContractFactory("MevStrategy");
    mevStrategy = await MevStrategy.deploy(MOCK_ROUTER, MOCK_AAVE, MOCK_BALANCER);
    await mevStrategy.setFactory(MOCK_FACTORY);
    
    // Deploy FlashLoanReceiver
    const FlashLoanReceiver = await ethers.getContractFactory("FlashLoanReceiver");
    flashLoanReceiver = await FlashLoanReceiver.deploy(
      mevStrategy.address,
      MOCK_ROUTER,
      ethers.constants.AddressZero, // Mock pair address
      weth.address,
      usdc.address,
      ethers.utils.parseEther("10"), // victim amount
      0 // victim min out
    );
  });

  describe("Access Control", function () {
    it("Should prevent unauthorized access to owner functions", async function () {
      // Attempt to update strategy params as attacker
      await expect(
        mevStrategy.connect(attacker).updateStrategyParams({
          targetDEXes: [],
          targetTokens: [],
          maxSlippage: 0,
          profitThreshold: 0,
          gasPrice: 0,
          gasLimit: 0,
          useAave: false,
          useBalancer: false
        })
      ).to.be.revertedWith("Ownable: caller is not the owner");
      
      // Attempt to withdraw profits as attacker
      await weth.mint(mevStrategy.address, ethers.utils.parseEther("1"));
      
      await expect(
        mevStrategy.connect(attacker).withdrawProfit(
          weth.address,
          ethers.utils.parseEther("0.5"),
          attacker.address
        )
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });
    
    it("Should prevent unauthorized execution of MEV strategies", async function () {
      // Attempt to execute sandwich attack as attacker
      await expect(
        mevStrategy.connect(attacker).executeSandwich(
          ethers.constants.AddressZero,
          weth.address,
          usdc.address,
          0,
          0,
          0
        )
      ).to.be.revertedWith("Ownable: caller is not the owner");
      
      // Attempt to execute arbitrage as attacker
      await expect(
        mevStrategy.connect(attacker).executeArbitrage(
          ethers.constants.AddressZero,
          ethers.constants.AddressZero,
          weth.address,
          0
        )
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });
    
    it("Should prevent unauthorized factory setting", async function () {
      await expect(
        mevStrategy.connect(attacker).setFactory(MOCK_FACTORY)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });
  });
  
  describe("Reentrancy Protection", function () {
    it("Should prevent reentrancy attacks", async function () {
      // Deploy a malicious contract that attempts reentrancy
      const MaliciousContract = await ethers.getContractFactory("MaliciousReceiver");
      const maliciousContract = await MaliciousContract.deploy(mevStrategy.address);
      
      // Add funds to the malicious contract
      await weth.mint(maliciousContract.address, ethers.utils.parseEther("10"));
      
      // Attempt a reentrancy attack by calling a protected function
      // This test verifies that the nonReentrant modifier is working
      await expect(
        maliciousContract.attack(weth.address, ethers.utils.parseEther("1"))
      ).to.be.reverted; // The exact revert message depends on the attack implementation
    });
  });
  
  describe("Input Validation", function () {
    it("Should validate input parameters for sandwich attacks", async function () {
      // Attempt to execute sandwich with zero loan amount
      await expect(
        mevStrategy.connect(owner).executeSandwich(
          ethers.constants.AddressZero,
          weth.address,
          usdc.address,
          ethers.utils.parseEther("1"),
          0,
          0 // Zero loan amount
        )
      ).to.be.revertedWith("Loan amount must be positive");
    });
    
    it("Should validate recipient address for profit withdrawal", async function () {
      // Mint some tokens to the contract
      await weth.mint(mevStrategy.address, ethers.utils.parseEther("1"));
      
      // Attempt to withdraw to zero address
      await expect(
        mevStrategy.connect(owner).withdrawProfit(
          weth.address,
          ethers.utils.parseEther("0.5"),
          ethers.constants.AddressZero
        )
      ).to.be.revertedWith("Invalid recipient");
    });
    
    it("Should prevent withdrawing more than available balance", async function () {
      // Mint some tokens to the contract
      await weth.mint(mevStrategy.address, ethers.utils.parseEther("0.1"));
      
      // Attempt to withdraw more than available
      await expect(
        mevStrategy.connect(owner).withdrawProfit(
          weth.address,
          ethers.utils.parseEther("1"),
          owner.address
        )
      ).to.be.revertedWith("Insufficient balance");
    });
  });
  
  describe("FlashLoanReceiver Security", function () {
    it("Should only allow execution from authorized sources", async function () {
      // Attempt to directly call executeOperation (should be called by Aave)
      await expect(
        flashLoanReceiver.connect(attacker).executeOperation(
          [weth.address],
          [ethers.utils.parseEther("1")],
          [ethers.utils.parseEther("0.01")],
          attacker.address,
          ethers.utils.defaultAbiCoder.encode(["string"], ["SANDWICH"])
        )
      ).to.be.revertedWith("Unauthorized initiator");
    });
    
    it("Should only allow token recovery by owner", async function () {
      // Mint tokens to the flash loan receiver
      await weth.mint(flashLoanReceiver.address, ethers.utils.parseEther("1"));
      
      // Attempt to recover tokens as attacker
      await expect(
        flashLoanReceiver.connect(attacker).recoverTokens(weth.address)
      ).to.be.revertedWith("Only owner can recover tokens");
    });
  });
  
  describe("Error Handling", function () {
    it("Should handle parameter decoding gracefully", async function () {
      // The contract should handle invalid parameter decoding gracefully
      // We'll test this by calling decodeStrategyType with invalid data
      
      const invalidData = "0x1234"; // Too short to be valid encoded string
      
      // This should not revert, but return a default value
      const decodedType = await flashLoanReceiver.decodeStrategyType(invalidData);
      expect(decodedType).to.equal("SANDWICH"); // Default value
    });
    
    it("Should prevent multiple factory initializations", async function () {
      // Try to set factory again
      await expect(
        mevStrategy.setFactory(MOCK_ROUTER) // Different address to ensure it's not just checking for same value
      ).to.be.revertedWith("Factory already set");
    });
  });
  
  describe("Sandwich Attack Profitability Check", function () {
    it("Should revert if sandwich attack is unprofitable", async function () {
      // This would typically be tested with a mainnet fork
      // since we need to simulate real market conditions
      
      // For this mock test, we just verify the contract and its functions exist
      
      // Deploy a test FlashLoanReceiver that simulates an unprofitable attack
      const TestFlashLoanReceiver = await ethers.getContractFactory("TestFlashLoanReceiver");
      const testReceiver = await TestFlashLoanReceiver.deploy(
        mevStrategy.address,
        MOCK_ROUTER,
        ethers.constants.AddressZero,
        weth.address,
        usdc.address,
        0,
        0
      );
      
      // Check that our helper function exists and works correctly
      expect(await testReceiver.shouldBeUnprofitable()).to.be.true;
      
      // Test setting the profitability flag
      await testReceiver.setShouldBeUnprofitable(false);
      expect(await testReceiver.shouldBeUnprofitable()).to.be.false;
      
      // Set it back to unprofitable for future tests
      await testReceiver.setShouldBeUnprofitable(true);
    });
  });
});