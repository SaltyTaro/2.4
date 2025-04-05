/**
 * Transaction filtering for mempool monitoring
 * Filters pending transactions to identify potential MEV opportunities
 */
const ethers = require('ethers');
const { TOKEN_ADDRESSES, DEX_ADDRESSES } = require('../../utils/constants');
const { getTokenPairsByTier } = require('../../utils/token-pairs');
const { Logger } = require('../../infrastructure/logging');

// Import ABI fragments for method signature detection
const UNISWAP_ROUTER_ABI = require('../../abi/UniswapV2Router.json');
const ERC20_ABI = require('../../abi/ERC20.json');

// Logger setup
const logger = new Logger('TxFilter');

class TxFilter {
  constructor(options = {}) {
    this.options = {
      targetPairs: getTokenPairsByTier(1), // Default to Tier 1 pairs
      targetDEXes: [
        DEX_ADDRESSES.UNISWAP_V2_ROUTER.toLowerCase(),
        DEX_ADDRESSES.SUSHISWAP_ROUTER.toLowerCase()
      ],
      minValueThreshold: ethers.utils.parseEther('1'), // 1 ETH
      includeERC20Transfers: true,
      includeSwaps: true,
      includeFlashLoans: true,
      includeLiquidations: true,
      ...options
    };
    
    // Prepare method signatures for quick filtering
    this.prepareMethodSignatures();
    
    // Track processed transaction hashes to avoid duplicates
    this.processedTxHashes = new Set();
    
    // Set max size for processed tx cache to prevent memory leaks
    this.maxProcessedTxCache = 10000;
  }

  /**
   * Prepare method signatures for DEX interactions
   */
  prepareMethodSignatures() {
    this.methodSignatures = {
      // Uniswap/Sushiswap methods
      swapMethods: [
        'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
        'swapTokensForExactTokens(uint256,uint256,address[],address,uint256)',
        'swapExactETHForTokens(uint256,address[],address,uint256)',
        'swapTokensForExactETH(uint256,uint256,address[],address,uint256)',
        'swapExactTokensForETH(uint256,uint256,address[],address,uint256)',
        'swapETHForExactTokens(uint256,address[],address,uint256)'
      ],
      // ERC20 methods
      erc20Methods: [
        'transfer(address,uint256)',
        'transferFrom(address,address,uint256)',
        'approve(address,uint256)'
      ],
      // Flash loan methods
      flashLoanMethods: [
        'flashLoan(address,address[],uint256[],bytes)',
        'executeOperation(address[],uint256[],uint256[],address,bytes)'
      ],
      // Aave liquidation methods
      liquidationMethods: [
        'liquidationCall(address,address,address,uint256,bool)'
      ]
    };
    
    // Convert method signatures to function selectors (first 4 bytes of the hash)
    this.functionSelectors = {};
    
    for (const [category, methods] of Object.entries(this.methodSignatures)) {
      this.functionSelectors[category] = methods.map(method => {
        return ethers.utils.id(method).slice(0, 10);
      });
    }
    
    // Create DEX router interfaces for decoding
    this.uniswapInterface = new ethers.utils.Interface(UNISWAP_ROUTER_ABI);
    this.erc20Interface = new ethers.utils.Interface(ERC20_ABI);
  }

  /**
   * Quick check if transaction should be processed further
   * @param {Object} txData Transaction data
   * @returns {boolean} Whether the transaction should be processed
   */
  shouldProcess(txData) {
    // Skip if already processed
    if (this.processedTxHashes.has(txData.hash)) {
      return false;
    }
    
    // Add to processed set
    this.processedTxHashes.add(txData.hash);
    
    // Limit the size of processed tx cache
    if (this.processedTxHashes.size > this.maxProcessedTxCache) {
      // Remove oldest entries (convert to array, slice, convert back to set)
      this.processedTxHashes = new Set(
        Array.from(this.processedTxHashes).slice(-Math.floor(this.maxProcessedTxCache / 2))
      );
    }
    
    // Must have a destination address (not contract creation)
    if (!txData.to) {
      return false;
    }
    
    // Check value threshold for ETH transfers
    const value = ethers.BigNumber.from(txData.value || '0');
    const minValue = ethers.BigNumber.from(this.options.minValueThreshold);
    
    // Quick check if transaction is to a target DEX
    const isTargetDex = this.options.targetDEXes.includes(txData.to.toLowerCase());
    
    // If it's a DEX and passes value threshold, process it
    if (isTargetDex && value.gte(minValue)) {
      return true;
    }
    
    // If it doesn't have input data, skip it
    if (!txData.data || txData.data === '0x') {
      return false;
    }
    
    // Check the function selector against our known methods
    const functionSelector = txData.data.slice(0, 10).toLowerCase();
    
    // Check each category of methods
    for (const [category, selectors] of Object.entries(this.functionSelectors)) {
      if (selectors.includes(functionSelector)) {
        switch (category) {
          case 'swapMethods':
            return this.options.includeSwaps;
          case 'erc20Methods':
            return this.options.includeERC20Transfers;
          case 'flashLoanMethods':
            return this.options.includeFlashLoans;
          case 'liquidationMethods':
            return this.options.includeLiquidations;
        }
      }
    }
    
    // By default, skip transactions that don't match our criteria
    return false;
  }

  /**
   * Detailed check if transaction is a target for MEV opportunity
   * @param {Object} decodedTx Decoded transaction
   * @returns {boolean} Whether the transaction is a target
   */
  isTargetTransaction(decodedTx) {
    try {
      // If not a swap, skip
      if (!decodedTx.isSwap) {
        return false;
      }
      
      // Check if involves target pairs
      const isTargetPair = this.isTargetTokenPair(decodedTx.tokenIn, decodedTx.tokenOut);
      if (!isTargetPair) {
        return false;
      }
      
      // Check minimum value threshold
      if (ethers.BigNumber.from(decodedTx.valueUSD || '0').lt(this.options.minValueUsdThreshold)) {
        return false;
      }
      
      // Additional checks can be added here based on specific strategy needs
      
      return true;
    } catch (error) {
      logger.error('Error in isTargetTransaction:', error);
      return false;
    }
  }

  /**
   * Check if token pair is in target pairs
   * @param {string} tokenA First token address
   * @param {string} tokenB Second token address
   * @returns {boolean} Whether the pair is a target
   */
  isTargetTokenPair(tokenA, tokenB) {
    if (!tokenA || !tokenB) {
      return false;
    }
    
    // Normalize addresses to lowercase
    const addressA = tokenA.toLowerCase();
    const addressB = tokenB.toLowerCase();
    
    // Check if pair exists in target pairs
    return this.options.targetPairs.some(pair => {
      const pairA = pair.tokenA.toLowerCase();
      const pairB = pair.tokenB.toLowerCase();
      
      return (
        (addressA === pairA && addressB === pairB) ||
        (addressA === pairB && addressB === pairA)
      );
    });
  }

  /**
   * Decode swap parameters from transaction data
   * @param {Object} txData Transaction data
   * @returns {Object} Decoded swap parameters or null if not a swap
   */
  decodeSwapParameters(txData) {
    try {
      if (!txData.data || txData.data === '0x') {
        return null;
      }
      
      const functionSelector = txData.data.slice(0, 10).toLowerCase();
      
      // Check if it's a swap
      if (!this.functionSelectors.swapMethods.includes(functionSelector)) {
        return { isSwap: false };
      }
      
      // Try to decode as Uniswap transaction
      const uniswapResult = this.decodeUniswapTransaction(txData);
      if (uniswapResult) {
        return {
          ...uniswapResult,
          isSwap: true,
          protocol: 'uniswap'
        };
      }
      
      // If decoding fails, return a generic swap indicator
      return { isSwap: true, protocol: 'unknown' };
    } catch (error) {
      logger.error('Error decoding swap parameters:', error);
      return { isSwap: false };
    }
  }

  /**
   * Decode Uniswap transaction
   * @param {Object} txData Transaction data
   * @returns {Object} Decoded transaction or null if not decodable
   */
  decodeUniswapTransaction(txData) {
    try {
      // Try to decode the function
      const functionFragment = this.uniswapInterface.getFunction(txData.data.slice(0, 10));
      if (!functionFragment) {
        return null;
      }
      
      // Decode parameters
      const decoded = this.uniswapInterface.decodeFunctionData(
        functionFragment.name,
        txData.data
      );
      
      // Extract common parameters
      let result = {
        method: functionFragment.name,
        path: decoded.path || [],
        deadline: decoded.deadline ? decoded.deadline.toString() : null
      };
      
      // Add method-specific parameters
      switch (functionFragment.name) {
        case 'swapExactTokensForTokens':
          result = {
            ...result,
            amountIn: decoded.amountIn.toString(),
            amountOutMin: decoded.amountOutMin.toString(),
            tokenIn: decoded.path[0],
            tokenOut: decoded.path[decoded.path.length - 1]
          };
          break;
          
        case 'swapTokensForExactTokens':
          result = {
            ...result,
            amountOut: decoded.amountOut.toString(),
            amountInMax: decoded.amountInMax.toString(),
            tokenIn: decoded.path[0],
            tokenOut: decoded.path[decoded.path.length - 1]
          };
          break;
          
        case 'swapExactETHForTokens':
          result = {
            ...result,
            amountIn: txData.value.toString(),
            amountOutMin: decoded.amountOutMin.toString(),
            tokenIn: TOKEN_ADDRESSES.WETH,
            tokenOut: decoded.path[decoded.path.length - 1]
          };
          break;
          
        case 'swapExactTokensForETH':
          result = {
            ...result,
            amountIn: decoded.amountIn.toString(),
            amountOutMin: decoded.amountOutMin.toString(),
            tokenIn: decoded.path[0],
            tokenOut: TOKEN_ADDRESSES.WETH
          };
          break;
          
        default:
          // Handle other methods or unknown methods
          return null;
      }
      
      return result;
    } catch (error) {
      logger.debug('Error decoding Uniswap transaction:', error);
      return null;
    }
  }
}

module.exports = {
  TxFilter
};