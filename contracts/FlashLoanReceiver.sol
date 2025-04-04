// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import "./interfaces/IUniswapV2Router.sol";
import "./interfaces/IUniswapV2Pair.sol";
import "./interfaces/IAaveFlashLoan.sol";
import "./interfaces/IBalancerFlashLoan.sol";
import "./interfaces/IERC20.sol";
import "./libraries/UniswapV2Library.sol";
import "./libraries/PriceCalculator.sol";

/**
 * @title FlashLoanReceiver
 * @dev Contract to receive and execute flash loan operations for MEV strategies
 * This contract handles the execution logic for different MEV strategies
 */
contract FlashLoanReceiver {
    using PriceCalculator for uint256;
    
    // Constants
    uint256 private constant AAVE_FEE = 9; // 0.09% fee
    uint256 private constant BALANCER_FEE = 0; // No fee for Balancer
    uint256 private constant MAX_BPS = 10000; // 100%
    
    // State variables
    address public owner;
    address public uniswapRouter;
    address public targetPair;
    address public tokenIn;
    address public tokenOut;
    uint256 public victimAmount;
    uint256 public victimMinOut;
    bool public strategyCompleted;
    
    // Events
    event FrontRunExecuted(
        address indexed pair,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );
    
    event BackRunExecuted(
        address indexed pair,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 profit
    );
    
    event ArbitrageExecuted(
        address indexed sourcePool,
        address indexed targetPool,
        address tokenIn,
        uint256 amountIn,
        uint256 profit
    );
    
    /**
     * @dev Constructor to initialize the flash loan receiver
     * @param _owner Owner address (MEV strategy contract)
     * @param _uniswapRouter Uniswap router address
     * @param _targetPair Target Uniswap pair for the strategy
     * @param _tokenIn Input token
     * @param _tokenOut Output token
     * @param _victimAmount Expected victim swap amount
     * @param _victimMinOut Victim's minimum amount out
     */
    constructor(
        address _owner,
        address _uniswapRouter,
        address _targetPair,
        address _tokenIn,
        address _tokenOut,
        uint256 _victimAmount,
        uint256 _victimMinOut
    ) {
        owner = _owner;
        uniswapRouter = _uniswapRouter;
        targetPair = _targetPair;
        tokenIn = _tokenIn;
        tokenOut = _tokenOut;
        victimAmount = _victimAmount;
        victimMinOut = _victimMinOut;
        strategyCompleted = false;
    }
    
    /**
     * @dev Callback function for Aave flash loans
     * @param assets Array of asset addresses
     * @param amounts Array of amounts
     * @param premiums Array of premiums (fees)
     * @param initiator Flash loan initiator
     * @param params Additional parameters for strategy execution
     * @return boolean indicating success
     */
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external virtual returns (bool) {
        require(initiator == owner, "Unauthorized initiator");
        require(!strategyCompleted, "Strategy already completed");
        
        // Decode strategy type from params
        string memory strategyType = abi.decode(params, (string));
        
        if (keccak256(bytes(strategyType)) == keccak256(bytes("SANDWICH"))) {
            // Execute sandwich attack
            executeSandwich(assets[0], amounts[0], premiums[0]);
        } else if (keccak256(bytes(strategyType)) == keccak256(bytes("ARBITRAGE"))) {
            // Execute arbitrage
            address targetPool = abi.decode(params, (address));
            executeArbitrage(assets[0], amounts[0], premiums[0], targetPool);
        } else if (keccak256(bytes(strategyType)) == keccak256(bytes("MULTIHOP"))) {
            // Execute multi-hop sandwich
            (address[] memory pairs, address[] memory tokens, uint256[] memory hopAmounts) = 
                abi.decode(params, (address[], address[], uint256[]));
            executeMultiHopSandwich(
                assets[0],
                amounts[0],
                premiums[0],
                pairs,
                tokens,
                hopAmounts
            );
        } else if (keccak256(bytes(strategyType)) == keccak256(bytes("COMBINED"))) {
            // Execute combined strategy
            (address arbSourcePool, address arbTargetPool) = 
                abi.decode(params, (address, address));
            executeCombinedStrategy(
                assets[0],
                amounts[0],
                premiums[0],
                arbSourcePool,
                arbTargetPool
            );
        }
        
        // Approve repayment of flash loan with premium
        uint256 amountOwing = amounts[0] + premiums[0];
        IERC20(assets[0]).approve(msg.sender, amountOwing);
        
        strategyCompleted = true;
        return true;
    }
    
    /**
     * @dev Callback function for Balancer flash loans
     * @param tokens Array of tokens
     * @param amounts Array of amounts
     * @param feeAmounts Array of fee amounts
     * @param userData Additional user data for strategy execution
     */
    function receiveFlashLoan(
        IERC20[] calldata tokens,
        uint256[] calldata amounts,
        uint256[] calldata feeAmounts,
        bytes calldata userData
    ) external virtual {
        require(msg.sender == address(uniswapRouter), "Unauthorized sender");
        require(!strategyCompleted, "Strategy already completed");
        
        // Decode strategy type
        string memory strategyType = abi.decode(userData, (string));
        
        address token = address(tokens[0]);
        uint256 amount = amounts[0];
        uint256 fee = feeAmounts[0];
        
        if (keccak256(bytes(strategyType)) == keccak256(bytes("SANDWICH"))) {
            // Execute sandwich attack
            executeSandwich(token, amount, fee);
        } else if (keccak256(bytes(strategyType)) == keccak256(bytes("ARBITRAGE"))) {
            // Execute arbitrage
            address targetPool = abi.decode(userData, (address));
            executeArbitrage(token, amount, fee, targetPool);
        } else if (keccak256(bytes(strategyType)) == keccak256(bytes("MULTIHOP"))) {
            // Execute multi-hop sandwich
            (address[] memory pairs, address[] memory pathTokens, uint256[] memory hopAmounts) = 
                abi.decode(userData, (address[], address[], uint256[]));
            executeMultiHopSandwich(
                token,
                amount,
                fee,
                pairs,
                pathTokens,
                hopAmounts
            );
        }
        
        // Approve repayment of flash loan with fee
        uint256 amountOwing = amount + fee;
        IERC20(token).approve(msg.sender, amountOwing);
        
        strategyCompleted = true;
    }
    
    /**
     * @dev Executes a sandwich attack
     * @param token Token borrowed from flash loan
     * @param amount Amount borrowed
     * @param premium Flash loan fee
     */
    function executeSandwich(
        address token,
        uint256 amount,
        uint256 premium
    ) internal virtual {
        require(token == tokenIn, "Invalid token");
        
        // Approve router to spend tokens
        IERC20(tokenIn).approve(uniswapRouter, amount);
        
        // 1. Execute front-run trade
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        
        // Calculate optimal amount for front-run based on victim's transaction
        uint256 frontRunAmount = amount / 2; // Simplified, would use more complex calculation
        
        // Execute front-run swap
        uint256[] memory amountsOut = IUniswapV2Router02(uniswapRouter).swapExactTokensForTokens(
            frontRunAmount,
            0, // No minimum output for front-run
            path,
            address(this),
            block.timestamp + 300
        );
        
        uint256 frontRunOutputAmount = amountsOut[amountsOut.length - 1];
        
        emit FrontRunExecuted(
            targetPair,
            tokenIn,
            tokenOut,
            frontRunAmount,
            frontRunOutputAmount
        );
        
        // 2. Wait for victim's transaction (in a real scenario)
        // Here we simulate the price impact from victim's transaction
        
        // 3. Execute back-run trade
        path[0] = tokenOut;
        path[1] = tokenIn;
        
        // Approve router to spend output tokens
        IERC20(tokenOut).approve(uniswapRouter, frontRunOutputAmount);
        
        // Execute back-run swap
        uint256[] memory backRunAmounts = IUniswapV2Router02(uniswapRouter).swapExactTokensForTokens(
            frontRunOutputAmount,
            0, // No minimum output for back-run
            path,
            address(this),
            block.timestamp + 300
        );
        
        uint256 backRunOutputAmount = backRunAmounts[backRunAmounts.length - 1];
        
        // Calculate profit
        uint256 profit = 0;
        if (backRunOutputAmount > frontRunAmount) {
            profit = backRunOutputAmount - frontRunAmount;
        }
        
        // Account for flash loan premium
        if (profit > premium) {
            profit -= premium;
        } else {
            revert("Unprofitable sandwich");
        }
        
        emit BackRunExecuted(
            targetPair,
            tokenOut,
            tokenIn,
            frontRunOutputAmount,
            backRunOutputAmount,
            profit
        );
        
        // Transfer profit to owner
        IERC20(tokenIn).transfer(owner, profit);
    }
    
    /**
     * @dev Helper function for the first swap in arbitrage
     * @param token Token to swap from
     * @param arbTokenOut Token to swap to
     * @param amount Amount to swap
     * @return Amount received from swap
     */
    function _executeFirstSwap(
        address token,
        address arbTokenOut,
        uint256 amount
    ) internal virtual returns (uint256) {
        // Approve router to spend tokens
        IERC20(token).approve(uniswapRouter, amount);
        
        // Create swap path
        address[] memory path = new address[](2);
        path[0] = token;
        path[1] = arbTokenOut;
        
        // Execute swap
        uint256[] memory amountsOut = IUniswapV2Router02(uniswapRouter).swapExactTokensForTokens(
            amount,
            0, // No minimum output
            path,
            address(this),
            block.timestamp + 300
        );
        
        return amountsOut[amountsOut.length - 1];
    }
    
    /**
     * @dev Helper function for the second swap in arbitrage
     * @param token Token to swap to
     * @param arbTokenOut Token to swap from
     * @param midAmount Amount to swap
     * @return Amount received from swap
     */
    function _executeSecondSwap(
        address token,
        address arbTokenOut,
        uint256 midAmount
    ) internal virtual returns (uint256) {
        // Approve router to spend intermediate tokens
        IERC20(arbTokenOut).approve(uniswapRouter, midAmount);
        
        // Create swap path
        address[] memory path = new address[](2);
        path[0] = arbTokenOut;
        path[1] = token;
        
        // Execute swap
        uint256[] memory finalAmounts = IUniswapV2Router02(uniswapRouter).swapExactTokensForTokens(
            midAmount,
            0, // No minimum output
            path,
            address(this),
            block.timestamp + 300
        );
        
        return finalAmounts[finalAmounts.length - 1];
    }
    
    /**
     * @dev Executes an arbitrage between two pools
     * @param token Token borrowed from flash loan
     * @param amount Amount borrowed
     * @param premium Flash loan fee
     * @param targetPool Target pool for arbitrage
     */
    function executeArbitrage(
        address token,
        uint256 amount,
        uint256 premium,
        address targetPool
    ) internal virtual {
        // Get token0 and token1 from the source pair
        IUniswapV2Pair sourcePair = IUniswapV2Pair(targetPair);
        address token0 = sourcePair.token0();
        address token1 = sourcePair.token1();
        
        // Determine tokenOut based on tokenIn
        address arbTokenOut = (token == token0) ? token1 : token0;
        
        // Validate target pool
        IUniswapV2Pair targetPairContract = IUniswapV2Pair(targetPool);
        require(
            (targetPairContract.token0() == token && targetPairContract.token1() == arbTokenOut) ||
            (targetPairContract.token0() == arbTokenOut && targetPairContract.token1() == token),
            "Invalid target pool"
        );
        
        // Execute swaps using helper functions
        uint256 midAmount = _executeFirstSwap(token, arbTokenOut, amount);
        uint256 finalAmount = _executeSecondSwap(token, arbTokenOut, midAmount);
        
        // Calculate profit
        uint256 profit = 0;
        if (finalAmount > amount) {
            profit = finalAmount - amount;
        }
        
        // Account for flash loan premium
        if (profit > premium) {
            profit -= premium;
        } else {
            revert("Unprofitable arbitrage");
        }
        
        // Use a helper function to finalize the arbitrage to reduce stack depth
        _finalizeArbitrage(targetPool, token, amount, profit);
    }
    
    /**
     * @dev Helper function to finalize arbitrage (emit event and transfer profit)
     * @param targetPool Target pool for arbitrage
     * @param token Token borrowed from flash loan
     * @param amount Amount borrowed
     * @param profit Profit from arbitrage
     */
    function _finalizeArbitrage(
        address targetPool,
        address token,
        uint256 amount,
        uint256 profit
    ) internal virtual {
        emit ArbitrageExecuted(
            targetPair,
            targetPool,
            token,
            amount,
            profit
        );
        
        // Transfer profit to owner
        IERC20(token).transfer(owner, profit);
    }
    
    /**
     * @dev Executes a multi-hop sandwich attack
     * @param token Token borrowed from flash loan
     * @param amount Amount borrowed
     * @param premium Flash loan fee
     * @param pairs Array of pairs to target in sequence
     * @param tokens Array of tokens in the path
     * @param hopAmounts Array of amounts for each hop
     */
    function executeMultiHopSandwich(
        address token,
        uint256 amount,
        uint256 premium,
        address[] memory pairs,
        address[] memory tokens,
        uint256[] memory hopAmounts
    ) internal virtual {
        // This is a simplified implementation of a multi-hop sandwich
        // A full implementation would be more complex
        
        require(pairs.length >= 2, "At least 2 pairs required");
        require(tokens.length == pairs.length + 1, "Invalid tokens array length");
        require(hopAmounts.length == pairs.length, "Invalid amounts array length");
        require(tokens[0] == token, "First token must match flash loan token");
        
        // Front-run: Execute multi-hop swap
        uint256 remainingAmount = amount;
        uint256 outputAmount = 0;
        
        for (uint256 i = 0; i < pairs.length; i++) {
            // Approve router to spend tokens
            IERC20(tokens[i]).approve(uniswapRouter, remainingAmount);
            
            // Create path for this hop
            address[] memory path = new address[](2);
            path[0] = tokens[i];
            path[1] = tokens[i + 1];
            
            // Calculate amount for this hop
            uint256 hopAmount = (i == 0) ? hopAmounts[i] : remainingAmount;
            
            // Execute swap
            uint256[] memory amountsOut = IUniswapV2Router02(uniswapRouter).swapExactTokensForTokens(
                hopAmount,
                0, // No minimum output
                path,
                address(this),
                block.timestamp + 300
            );
            
            // Update remaining amount for next hop
            remainingAmount = amountsOut[amountsOut.length - 1];
            
            // If this is the last hop, save the output amount
            if (i == pairs.length - 1) {
                outputAmount = remainingAmount;
            }
        }
        
        // Wait for victim's transaction (simulated in real scenario)
        
        // Back-run: Reverse the path
        remainingAmount = outputAmount;
        
        for (uint256 i = pairs.length; i > 0; i--) {
            // Approve router to spend tokens
            IERC20(tokens[i]).approve(uniswapRouter, remainingAmount);
            
            // Create path for this hop
            address[] memory path = new address[](2);
            path[0] = tokens[i];
            path[1] = tokens[i - 1];
            
            // Execute swap
            uint256[] memory amountsOut = IUniswapV2Router02(uniswapRouter).swapExactTokensForTokens(
                remainingAmount,
                0, // No minimum output
                path,
                address(this),
                block.timestamp + 300
            );
            
            // Update remaining amount for next hop
            remainingAmount = amountsOut[amountsOut.length - 1];
        }
        
        // Calculate profit
        uint256 finalAmount = remainingAmount;
        uint256 profit = 0;
        
        if (finalAmount > amount) {
            profit = finalAmount - amount;
        }
        
        // Account for flash loan premium
        if (profit > premium) {
            profit -= premium;
        } else {
            revert("Unprofitable multi-hop sandwich");
        }
        
        // Transfer profit to owner
        IERC20(token).transfer(owner, profit);
    }
    
    /**
     * @dev Helper function for executing first part of combined strategy (sandwich)
     * @param token Token to use
     * @param sandwichAmount Amount to use for sandwich
     * @return Final amount after sandwich
     */
    function _executeSandwichPart(
        address token,
        uint256 sandwichAmount
    ) private returns (uint256) {
        IERC20(token).approve(uniswapRouter, sandwichAmount);
        
        address[] memory path = new address[](2);
        path[0] = token;
        path[1] = tokenOut;
        
        // Front-run
        uint256[] memory sandwichAmountsOut = IUniswapV2Router02(uniswapRouter).swapExactTokensForTokens(
            sandwichAmount,
            0,
            path,
            address(this),
            block.timestamp + 300
        );
        
        uint256 sandwichMidAmount = sandwichAmountsOut[sandwichAmountsOut.length - 1];
        
        // Simulate victim transaction
        
        // Back-run
        path[0] = tokenOut;
        path[1] = token;
        
        IERC20(tokenOut).approve(uniswapRouter, sandwichMidAmount);
        
        uint256[] memory backRunAmounts = IUniswapV2Router02(uniswapRouter).swapExactTokensForTokens(
            sandwichMidAmount,
            0,
            path,
            address(this),
            block.timestamp + 300
        );
        
        return backRunAmounts[backRunAmounts.length - 1];
    }
    
    /**
     * @dev Helper function for executing second part of combined strategy (arbitrage)
     * @param token Token to use
     * @param arbAmount Amount to use for arbitrage
     * @param arbSourcePool Source pool for arbitrage
     * @param arbTargetPool Target pool for arbitrage
     * @return Final amount after arbitrage
     */
    function _executeArbitragePart(
        address token,
        uint256 arbAmount,
        address arbSourcePool,
        address arbTargetPool
    ) private returns (uint256) {
        IUniswapV2Pair sourcePair = IUniswapV2Pair(arbSourcePool);
        address token0 = sourcePair.token0();
        address token1 = sourcePair.token1();
        
        // Determine tokenOut based on tokenIn
        address arbTokenOut = (token == token0) ? token1 : token0;
        
        IERC20(token).approve(uniswapRouter, arbAmount);
        
        // Swap in source pool
        address[] memory path = new address[](2);
        path[0] = token;
        path[1] = arbTokenOut;
        
        uint256[] memory arbAmountsOut = IUniswapV2Router02(uniswapRouter).swapExactTokensForTokens(
            arbAmount,
            0,
            path,
            address(this),
            block.timestamp + 300
        );
        
        uint256 arbMidAmount = arbAmountsOut[arbAmountsOut.length - 1];
        
        // Swap in target pool
        path[0] = arbTokenOut;
        path[1] = token;
        
        IERC20(arbTokenOut).approve(uniswapRouter, arbMidAmount);
        
        uint256[] memory arbFinalAmounts = IUniswapV2Router02(uniswapRouter).swapExactTokensForTokens(
            arbMidAmount,
            0,
            path,
            address(this),
            block.timestamp + 300
        );
        
        return arbFinalAmounts[arbFinalAmounts.length - 1];
    }
    
    /**
     * @dev Executes a combined sandwich and arbitrage strategy
     * @param token Token borrowed from flash loan
     * @param amount Amount borrowed
     * @param premium Flash loan fee
     * @param arbSourcePool Source pool for arbitrage
     * @param arbTargetPool Target pool for arbitrage
     */
    function executeCombinedStrategy(
        address token,
        uint256 amount,
        uint256 premium,
        address arbSourcePool,
        address arbTargetPool
    ) internal virtual {
        // Split the borrowed amount between sandwich and arbitrage
        uint256 sandwichAmount = amount / 2;
        uint256 arbAmount = amount - sandwichAmount;
        
        // Execute sandwich part of the strategy using helper
        uint256 sandwichFinalAmount = _executeSandwichPart(token, sandwichAmount);
        
        // Execute arbitrage part of the strategy using helper
        uint256 arbFinalAmount = _executeArbitragePart(token, arbAmount, arbSourcePool, arbTargetPool);
        
        // Calculate profits
        uint256 sandwichProfit = (sandwichFinalAmount > sandwichAmount) ? 
            (sandwichFinalAmount - sandwichAmount) : 0;
            
        uint256 arbProfit = (arbFinalAmount > arbAmount) ? 
            (arbFinalAmount - arbAmount) : 0;
            
        uint256 totalProfit = sandwichProfit + arbProfit;
        
        // Account for flash loan premium
        if (totalProfit > premium) {
            totalProfit -= premium;
        } else {
            revert("Unprofitable combined strategy");
        }
        
        // Transfer profit to owner
        IERC20(token).transfer(owner, totalProfit);
    }
    
    /**
     * @dev Allows owner to recover any tokens left in this contract
     * @param token Token to recover
     */
    function recoverTokens(address token) external {
        require(msg.sender == owner, "Only owner can recover tokens");
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token).transfer(owner, balance);
        }
    }
}