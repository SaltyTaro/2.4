// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import "./interfaces/IUniswapV2Router.sol";
import "./interfaces/IUniswapV2Pair.sol";
import "./interfaces/IUniswapV2Factory.sol";
import "./interfaces/IAaveFlashLoan.sol";
import "./interfaces/IBalancerFlashLoan.sol";
import "./interfaces/IERC20.sol";
import "./libraries/UniswapV2Library.sol";
import "./libraries/PriceCalculator.sol";
import "./libraries/GasOptimizer.sol";
import "./utils/Ownable.sol";
import "./utils/ReentrancyGuard.sol";
import "./utils/Upgradeable.sol";
import "./FlashLoanReceiver.sol";

/**
 * @title MevStrategy
 * @dev Main contract for executing MEV strategies including sandwich attacks and arbitrage
 * This contract serves as the entry point for all MEV operations
 */
contract MevStrategy is Ownable, ReentrancyGuard, Upgradeable {
    using PriceCalculator for uint256;
    using GasOptimizer for uint256;
    
    // Constants
    uint256 private constant MAX_BPS = 10000; // 100% in basis points
    uint256 private constant MIN_PROFIT_THRESHOLD = 0.05 ether; // Minimum profit to execute
    
    // Interfaces
    IUniswapV2Router02 public uniswapRouter;
    IUniswapV2Factory public uniswapFactory;
    IAaveFlashLoan public aaveFlashLoan;
    IBalancerFlashLoan public balancerFlashLoan;
    
    // Strategy parameters
    struct StrategyParams {
        address[] targetDEXes;      // DEXes to target for MEV opportunities
        address[] targetTokens;     // Tokens to monitor for MEV opportunities
        uint256 maxSlippage;        // Maximum slippage tolerance in BPS
        uint256 profitThreshold;    // Profit threshold to execute in ETH
        uint256 gasPrice;           // Gas price to use for transactions
        uint256 gasLimit;           // Gas limit for MEV transactions
        bool useAave;               // Use Aave for flash loans
        bool useBalancer;           // Use Balancer for flash loans
    }
    
    StrategyParams public strategyParams;
    
    // Events
    event StrategyExecuted(
        address indexed executor,
        address indexed tokenA,
        address indexed tokenB,
        uint256 profit,
        uint256 gasUsed
    );
    
    event FlashLoanInitiated(
        address indexed token,
        uint256 amount,
        string strategyType
    );
    
    event SandwichExecuted(
        address indexed pair,
        uint256 frontRunAmount,
        uint256 backRunAmount,
        uint256 profit
    );
    
    event ArbitrageExecuted(
        address indexed sourcePool,
        address indexed targetPool,
        uint256 amount,
        uint256 profit
    );
    
    event ProfitWithdrawn(
        address indexed token,
        address indexed recipient,
        uint256 amount
    );

    /**
     * @dev Constructor to initialize the MEV strategy contract
     * @param _uniswapRouter Uniswap V2 Router address
     * @param _aaveFlashLoan Aave Lending Pool address for flash loans
     * @param _balancerFlashLoan Balancer Vault address for flash loans
     */
    constructor(
        address _uniswapRouter,
        address _aaveFlashLoan,
        address _balancerFlashLoan
    ) {
        uniswapRouter = IUniswapV2Router02(_uniswapRouter);
        uniswapFactory = IUniswapV2Factory(uniswapRouter.factory());
        aaveFlashLoan = IAaveFlashLoan(_aaveFlashLoan);
        balancerFlashLoan = IBalancerFlashLoan(_balancerFlashLoan);
        
        // Initialize with default parameters
        strategyParams = StrategyParams({
            targetDEXes: new address[](0),
            targetTokens: new address[](0),
            maxSlippage: 50, // 0.5% in BPS
            profitThreshold: MIN_PROFIT_THRESHOLD,
            gasPrice: 0, // Will be set dynamically
            gasLimit: 5000000,
            useAave: true,
            useBalancer: false
        });
    }
    
    /**
     * @dev Updates the strategy parameters
     * @param _params New strategy parameters
     */
    function updateStrategyParams(StrategyParams calldata _params) external onlyOwner {
        strategyParams = _params;
    }
    
    /**
     * @dev Executes a sandwich attack using a flash loan
     * @param pair Uniswap pair address to target
     * @param tokenIn Token to borrow via flash loan
     * @param tokenOut Other token in the pair
     * @param victimAmount Amount the victim is swapping
     * @param victimAmountOutMin Minimum amount out for the victim
     * @param loanAmount Amount to borrow for the sandwich
     */
    function executeSandwich(
        address pair,
        address tokenIn,
        address tokenOut,
        uint256 victimAmount,
        uint256 victimAmountOutMin,
        uint256 loanAmount
    ) external onlyOwner nonReentrant {
        require(loanAmount > 0, "Loan amount must be positive");
        
        // Create flash loan receiver
        FlashLoanReceiver flashLoanReceiver = new FlashLoanReceiver(
            address(this),
            address(uniswapRouter),
            pair,
            tokenIn,
            tokenOut,
            victimAmount,
            victimAmountOutMin
        );
        
        // Get tokens needed for flash loan
        address[] memory tokens = new address[](1);
        tokens[0] = tokenIn;
        
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = loanAmount;
        
        // Initialize flash loan based on selected provider
        if (strategyParams.useAave) {
            // For Aave flash loan
            emit FlashLoanInitiated(tokenIn, loanAmount, "Sandwich-Aave");
            aaveFlashLoan.flashLoan(
                address(flashLoanReceiver),
                tokens,
                amounts,
                new uint256[](1), // 0 = no debt, just flash loan
                address(0), // onBehalfOf
                bytes("SANDWICH"), // params for the receiver
                0 // referral code
            );
        } else if (strategyParams.useBalancer) {
            // For Balancer flash loan
            emit FlashLoanInitiated(tokenIn, loanAmount, "Sandwich-Balancer");
            IERC20[] memory balancerTokens = new IERC20[](1);
            balancerTokens[0] = IERC20(tokenIn);
            
            balancerFlashLoan.flashLoan(
                address(flashLoanReceiver),
                balancerTokens,
                amounts,
                bytes("SANDWICH")
            );
        }
        
        // Get profit
        uint256 profit = IERC20(tokenIn).balanceOf(address(this));
        
        emit SandwichExecuted(
            pair,
            loanAmount,
            0, // Will be updated by the receiver
            profit
        );
    }
    
    /**
     * @dev Helper function to prepare multi-hop flash loan data
     * @param flashLoanReceiver Address of the flash loan receiver
     * @param loanToken Token to borrow
     * @param loanAmount Amount to borrow
     */
    function _prepareMultiHopFlashLoan(
        address flashLoanReceiver,
        address loanToken,
        uint256 loanAmount
    ) private {
        address[] memory tokens = new address[](1);
        tokens[0] = loanToken;
        
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = loanAmount;
        
        emit FlashLoanInitiated(loanToken, loanAmount, "MultiHop-Sandwich");
        aaveFlashLoan.flashLoan(
            flashLoanReceiver,
            tokens,
            amounts,
            new uint256[](1),
            address(0),
            abi.encode("MULTIHOP"),
            0
        );
    }
    
    /**
     * @dev Helper function to encode multi-hop data separately to avoid stack depth issues
     * @param pairs Array of pairs to target
     * @param tokens Array of tokens in the path
     * @param amounts Array of amounts for each hop
     * @return Encoded data for the flash loan
     */
    function _encodeMultiHopData(
        address[] calldata pairs,
        address[] calldata tokens,
        uint256[] calldata amounts
    ) private pure returns (bytes memory) {
        return abi.encode(pairs, tokens, amounts, "MULTIHOP");
    }
    
    /**
     * @dev Executes multi-hop sandwich attack across multiple DEXes
     * @param pairs Array of pairs to target in sequence
     * @param tokens Array of tokens involved in the multi-hop
     * @param amounts Array of amounts for each hop
     * @param loanToken Token to borrow for the flash loan
     * @param loanAmount Amount to borrow
     */
    function executeMultiHopSandwich(
        address[] calldata pairs,
        address[] calldata tokens,
        uint256[] calldata amounts,
        address loanToken,
        uint256 loanAmount
    ) external onlyOwner nonReentrant {
        require(pairs.length >= 2, "Requires at least 2 pairs");
        require(tokens.length == pairs.length + 1, "Invalid tokens array length");
        require(amounts.length == pairs.length, "Invalid amounts array length");
        
        // Create a specialized flash loan receiver for multi-hop
        FlashLoanReceiver flashLoanReceiver = new FlashLoanReceiver(
            address(this),
            address(uniswapRouter),
            pairs[0], // Using first pair as the primary target
            loanToken,
            tokens[1], // Next token in the path
            amounts[0],
            0 // No specific minimum output for multi-hop
        );
        
        // Set up the multi-hop data in the flash loan receiver
        // We use a two-stage process to avoid stack too deep errors
        bytes memory multiHopData = _encodeMultiHopData(pairs, tokens, amounts);
        
        // Encode the data for the flash loan
        aaveFlashLoan.flashLoan(
            address(flashLoanReceiver),
            _getSingleTokenArray(loanToken),
            _getSingleAmountArray(loanAmount),
            new uint256[](1),
            address(0),
            multiHopData,
            0
        );
        
        // Calculate profit
        uint256 profit = IERC20(loanToken).balanceOf(address(this));
        require(profit > strategyParams.profitThreshold, "Insufficient profit");
        
        emit StrategyExecuted(
            msg.sender,
            loanToken,
            tokens[tokens.length - 1],
            profit,
            0 // Gas used would be calculated off-chain
        );
    }
    
    /**
     * @dev Helper function to get a single-token array to reduce stack variables
     * @param token The token to include in the array
     * @return A single-element array containing the token
     */
    function _getSingleTokenArray(address token) private pure returns (address[] memory) {
        address[] memory tokens = new address[](1);
        tokens[0] = token;
        return tokens;
    }
    
    /**
     * @dev Helper function to get a single-amount array to reduce stack variables
     * @param amount The amount to include in the array
     * @return A single-element array containing the amount
     */
    function _getSingleAmountArray(uint256 amount) private pure returns (uint256[] memory) {
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;
        return amounts;
    }
    
    /**
     * @dev Executes arbitrage between two DEXes using flash loans
     * @param sourcePool Source liquidity pool address
     * @param targetPool Target liquidity pool address
     * @param tokenBorrow Token to borrow via flash loan
     * @param amount Amount to borrow
     */
    function executeArbitrage(
        address sourcePool,
        address targetPool,
        address tokenBorrow,
        uint256 amount
    ) external onlyOwner nonReentrant {
        // Create a specialized flash loan receiver for arbitrage
        FlashLoanReceiver flashLoanReceiver = new FlashLoanReceiver(
            address(this),
            address(uniswapRouter),
            sourcePool,
            tokenBorrow,
            address(0), // Will be determined based on the pool
            amount,
            0
        );
        
        // Initialize flash loan using helper functions to reduce stack depth
        if (strategyParams.useAave) {
            emit FlashLoanInitiated(tokenBorrow, amount, "Arbitrage");
            
            bytes memory arbData = abi.encode(targetPool, "ARBITRAGE");
            
            aaveFlashLoan.flashLoan(
                address(flashLoanReceiver),
                _getSingleTokenArray(tokenBorrow),
                _getSingleAmountArray(amount),
                new uint256[](1),
                address(0),
                arbData,
                0
            );
        }
        
        // Calculate profit
        uint256 profit = IERC20(tokenBorrow).balanceOf(address(this));
        require(profit > strategyParams.profitThreshold, "Insufficient profit");
        
        emit ArbitrageExecuted(
            sourcePool,
            targetPool,
            amount,
            profit
        );
    }
    
    /**
     * @dev Helper function to encode combined strategy data
     * @param arbSourcePool Source pool for arbitrage
     * @param arbTargetPool Target pool for arbitrage
     * @return Encoded data for the flash loan
     */
    function _encodeCombinedStrategyData(
        address arbSourcePool,
        address arbTargetPool
    ) private pure returns (bytes memory) {
        return abi.encode(arbSourcePool, arbTargetPool, "COMBINED");
    }
    
    /**
     * @dev Combined strategy executing both sandwich and arbitrage in a single transaction
     * @param sandwichPair Pair to target for sandwich attack
     * @param arbSourcePool Source pool for arbitrage
     * @param arbTargetPool Target pool for arbitrage
     * @param loanToken Token to borrow
     * @param loanAmount Amount to borrow
     */
    function executeCombinedStrategy(
        address sandwichPair,
        address arbSourcePool,
        address arbTargetPool,
        address loanToken,
        uint256 loanAmount
    ) external onlyOwner nonReentrant {
        // Create a specialized flash loan receiver for the combined strategy
        FlashLoanReceiver flashLoanReceiver = new FlashLoanReceiver(
            address(this),
            address(uniswapRouter),
            sandwichPair,
            loanToken,
            address(0), // Will be determined based on the pair
            loanAmount,
            0
        );
        
        // Initialize flash loan using helper functions to reduce stack depth
        if (strategyParams.useAave) {
            emit FlashLoanInitiated(loanToken, loanAmount, "Combined");
            
            bytes memory combinedData = _encodeCombinedStrategyData(arbSourcePool, arbTargetPool);
            
            aaveFlashLoan.flashLoan(
                address(flashLoanReceiver),
                _getSingleTokenArray(loanToken),
                _getSingleAmountArray(loanAmount),
                new uint256[](1),
                address(0),
                combinedData,
                0
            );
        }
        
        // Calculate profit
        uint256 profit = IERC20(loanToken).balanceOf(address(this));
        require(profit > strategyParams.profitThreshold, "Insufficient profit");
        
        emit StrategyExecuted(
            msg.sender,
            loanToken,
            address(0), // Multiple tokens may be involved
            profit,
            0
        );
    }
    
    /**
     * @dev Withdraw profit from the contract
     * @param token Token to withdraw
     * @param amount Amount to withdraw
     * @param recipient Address to receive the tokens
     */
    function withdrawProfit(
        address token,
        uint256 amount,
        address recipient
    ) external onlyOwner {
        require(recipient != address(0), "Invalid recipient");
        require(IERC20(token).balanceOf(address(this)) >= amount, "Insufficient balance");
        
        IERC20(token).transfer(recipient, amount);
        
        emit ProfitWithdrawn(token, recipient, amount);
    }
    
    /**
     * @dev Calculates the expected profit from a sandwich attack
     * @param pair Uniswap pair address
     * @param tokenIn Input token
     * @param tokenOut Output token
     * @param frontRunAmount Amount for front-running
     * @param victimAmount Amount the victim is swapping
     * @return expectedProfit Expected profit from the attack
     */
    function calculateSandwichProfit(
        address pair,
        address tokenIn,
        address tokenOut,
        uint256 frontRunAmount,
        uint256 victimAmount
    ) external view returns (uint256 expectedProfit) {
        // Get reserves
        (uint256 reserve0, uint256 reserve1) = UniswapV2Library.getReserves(
            address(uniswapFactory),
            tokenIn,
            tokenOut
        );
        
        // Calculate price impact and expected profit
        expectedProfit = PriceCalculator.calculateSandwichProfit(
            reserve0,
            reserve1,
            frontRunAmount,
            victimAmount,
            tokenIn < tokenOut
        );
        
        // Account for gas costs
        uint256 gasCost = GasOptimizer.estimateGasCost(
            strategyParams.gasPrice,
            strategyParams.gasLimit
        );
        
        // Only return positive profit after gas costs
        if (expectedProfit > gasCost) {
            return expectedProfit - gasCost;
        }
        return 0;
    }
    
    /**
     * @dev Receive function to accept ETH
     */
    receive() external payable {}
}