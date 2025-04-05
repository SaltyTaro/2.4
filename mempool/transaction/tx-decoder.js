/**
 * Transaction decoder for MEV monitoring
 * Decodes transaction data to identify swap parameters and value
 */
const ethers = require('ethers');
const { DEX_ADDRESSES, TOKEN_ADDRESSES } = require('../../utils/constants');
const { getPriceInEth, getPriceInUsd } = require('../../utils/price-utils');
const { Logger } = require('../../infrastructure/logging');

// Import ABI fragments
const UNISWAP_V2_ROUTER_ABI = require('../../abi/UniswapV2Router.json');
const UNISWAP_V3_ROUTER_ABI = require('../../abi/UniswapV3Router.json');
const SUSHISWAP_ROUTER_ABI = require('../../abi/SushiswapRouter.json');
const ERC20_ABI = require('../../abi/ERC20.json');
const AAVE_LENDING_POOL_ABI = require('../../abi/AaveLendingPool.json');
const BALANCER_VAULT_ABI = require('../../abi/BalancerVault.json');

// Logger setup
const logger = new Logger('TxDecoder');

class TxDecoder {
  constructor(options = {}) {
    this.options = {
      supportedDexes: {
        [DEX_ADDRESSES.UNISWAP_V2_ROUTER.toLowerCase()]: {
          type: 'UniswapV2',
          interface: new ethers.utils.Interface(UNISWAP_V2_ROUTER_ABI)
        },
        [DEX_ADDRESSES.UNISWAP_V3_ROUTER.toLowerCase()]: {
          type: 'UniswapV3',
          interface: new ethers.utils.Interface(UNISWAP_V3_ROUTER_ABI)
        },
        [DEX_ADDRESSES.SUSHISWAP_ROUTER.toLowerCase()]: {
          type: 'Sushiswap',
          interface: new ethers.utils.Interface(SUSHISWAP_ROUTER_ABI)
        }
      },
      ...options
    };
    
    // Create interfaces for different protocols
    this.erc20Interface = new ethers.utils.Interface(ERC20_ABI);
    this.aaveInterface = new ethers.utils.Interface(AAVE_LENDING_POOL_ABI);
    this.balancerInterface = new ethers.utils.Interface(BALANCER_VAULT_ABI);
    
    this.provider = null;
    this.tokenCache = new Map(); // Cache of token information
    this.priceCache = new Map(); // Cache of token prices
    this.priceCacheTTL = 60000; // 1 minute cache for prices
  }

  /**
   * Initialize the decoder
   */
  async initialize() {
    try {
      logger.info('Initializing transaction decoder...');
      
      // Create provider from environment variable or default
      const rpcUrl = process.env.ETH_RPC_URL || 'https://eth-mainnet.alchemyapi.io/v2/your-api-key';
      this.provider = new ethers.providers.JsonRpcProvider(rpcUrl);
      
      // Pre-cache common token information
      await this.precacheTokenInfo();
      
      logger.info('Transaction decoder initialized successfully');
      return true;
    } catch (error) {
      logger.error('Failed to initialize transaction decoder:', error);
      throw error;
    }
  }

  /**
   * Pre-cache information for common tokens
   */
  async precacheTokenInfo() {
    const commonTokens = [
      TOKEN_ADDRESSES.WETH,
      TOKEN_ADDRESSES.USDC,
      TOKEN_ADDRESSES.USDT,
      TOKEN_ADDRESSES.DAI,
      TOKEN_ADDRESSES.WBTC
    ];
    
    for (const address of commonTokens) {
      try {
        await this.getTokenInfo(address);
      } catch (error) {
        logger.warn(`Failed to pre-cache token info for ${address}:`, error);
      }
    }
  }

  /**
   * Get token information (symbol, decimals)
   * @param {string} tokenAddress Token address
   * @returns {Promise<Object>} Token information
   */
  async getTokenInfo(tokenAddress) {
    // Check cache first
    if (this.tokenCache.has(tokenAddress.toLowerCase())) {
      return this.tokenCache.get(tokenAddress.toLowerCase());
    }
    
    try {
      // Special case for ETH
      if (tokenAddress.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
        const ethInfo = {
          address: tokenAddress,
          symbol: 'ETH',
          decimals: 18,
          isETH: true
        };
        this.tokenCache.set(tokenAddress.toLowerCase(), ethInfo);
        return ethInfo;
      }
      
      // Get token contract
      const tokenContract = new ethers.Contract(
        tokenAddress,
        [
          'function symbol() view returns (string)',
          'function decimals() view returns (uint8)'
        ],
        this.provider
      );
      
      // Get symbol and decimals
      const [symbol, decimals] = await Promise.all([
        tokenContract.symbol(),
        tokenContract.decimals()
      ]);
      
      const tokenInfo = {
        address: tokenAddress,
        symbol,
        decimals,
        isETH: false
      };
      
      // Cache the result
      this.tokenCache.set(tokenAddress.toLowerCase(), tokenInfo);
      
      return tokenInfo;
    } catch (error) {
      logger.error(`Error getting token info for ${tokenAddress}:`, error);
      
      // Fallback to common tokens if lookup fails
      const fallbackInfo = this.getFallbackTokenInfo(tokenAddress);
      if (fallbackInfo) {
        this.tokenCache.set(tokenAddress.toLowerCase(), fallbackInfo);
        return fallbackInfo;
      }
      
      throw error;
    }
  }

  /**
   * Get fallback token information for common tokens
   * @param {string} tokenAddress Token address
   * @returns {Object|null} Token information or null if not known
   */
  getFallbackTokenInfo(tokenAddress) {
    const address = tokenAddress.toLowerCase();
    
    // Common token fallbacks
    const fallbacks = {
      [TOKEN_ADDRESSES.WETH.toLowerCase()]: { symbol: 'WETH', decimals: 18 },
      [TOKEN_ADDRESSES.USDC.toLowerCase()]: { symbol: 'USDC', decimals: 6 },
      [TOKEN_ADDRESSES.USDT.toLowerCase()]: { symbol: 'USDT', decimals: 6 },
      [TOKEN_ADDRESSES.DAI.toLowerCase()]: { symbol: 'DAI', decimals: 18 },
      [TOKEN_ADDRESSES.WBTC.toLowerCase()]: { symbol: 'WBTC', decimals: 8 }
    };
    
    if (fallbacks[address]) {
      return {
        address: tokenAddress,
        ...fallbacks[address],
        isETH: false
      };
    }
    
    return null;
  }

  /**
   * Decode a transaction
   * @param {Object} txData Transaction data
   * @returns {Promise<Object>} Decoded transaction information
   */
  async decode(txData) {
    try {
      // Basic transaction info
      const decodedTx = {
        hash: txData.hash,
        from: txData.from,
        to: txData.to,
        value: txData.value ? ethers.BigNumber.from(txData.value) : ethers.constants.Zero,
        gasPrice: txData.gasPrice ? ethers.BigNumber.from(txData.gasPrice) : null,
        maxFeePerGas: txData.maxFeePerGas ? ethers.BigNumber.from(txData.maxFeePerGas) : null,
        maxPriorityFeePerGas: txData.maxPriorityFeePerGas ? ethers.BigNumber.from(txData.maxPriorityFeePerGas) : null,
        nonce: txData.nonce,
        data: txData.data,
        
        // Default flags
        isSwap: false,
        isFlashLoan: false,
        isLiquidation: false,
        isERC20Transfer: false
      };
      
      // If there's no input data, it's a simple ETH transfer
      if (!txData.data || txData.data === '0x') {
        decodedTx.isETHTransfer = true;
        
        // Add ETH value in USD
        if (decodedTx.value.gt(0)) {
          decodedTx.valueETH = ethers.utils.formatEther(decodedTx.value);
          decodedTx.valueUSD = await this.estimateValueInUSD(TOKEN_ADDRESSES.WETH, decodedTx.value);
        }
        
        return decodedTx;
      }
      
      // Try to decode based on destination address
      if (txData.to) {
        const toAddressLower = txData.to.toLowerCase();
        
        // Check if it's a DEX transaction
        if (this.options.supportedDexes[toAddressLower]) {
          const dexInfo = this.options.supportedDexes[toAddressLower];
          const dexDecoded = await this.decodeDexTransaction(txData, dexInfo);
          
          if (dexDecoded) {
            return {
              ...decodedTx,
              ...dexDecoded
            };
          }
        }
        
        // Check if it's an ERC20 transfer
        const erc20Decoded = await this.decodeERC20Transaction(txData);
        if (erc20Decoded) {
          return {
            ...decodedTx,
            ...erc20Decoded
          };
        }
        
        // Check if it's a flash loan
        const flashLoanDecoded = await this.decodeFlashLoanTransaction(txData);
        if (flashLoanDecoded) {
          return {
            ...decodedTx,
            ...flashLoanDecoded
          };
        }
        
        // Check if it's a liquidation
        const liquidationDecoded = await this.decodeLiquidationTransaction(txData);
        if (liquidationDecoded) {
          return {
            ...decodedTx,
            ...liquidationDecoded
          };
        }
      }
      
      // If we couldn't decode specifically, try a generic decode of the function selector
      decodedTx.functionSelector = txData.data.slice(0, 10);
      
      return decodedTx;
    } catch (error) {
      logger.error(`Error decoding transaction ${txData.hash}:`, error);
      
      // Return basic information
      return {
        hash: txData.hash,
        from: txData.from,
        to: txData.to,
        value: txData.value ? ethers.BigNumber.from(txData.value) : ethers.constants.Zero,
        decodingError: true,
        error: error.message
      };
    }
  }

  /**
   * Decode a DEX transaction (Uniswap, Sushiswap, etc.)
   * @param {Object} txData Transaction data
   * @param {Object} dexInfo DEX information
   * @returns {Promise<Object|null>} Decoded DEX transaction or null if not applicable
   */
  async decodeDexTransaction(txData, dexInfo) {
    try {
      const data = txData.data;
      const functionSelector = data.slice(0, 10).toLowerCase();
      
      // Try to decode function signature
      let functionFragment;
      try {
        functionFragment = dexInfo.interface.getFunction(functionSelector);
      } catch (error) {
        return null;
      }
      
      if (!functionFragment) {
        return null;
      }
      
      // Decode function parameters
      const decoded = dexInfo.interface.decodeFunctionData(functionFragment, data);
      
      // Check if it's a swap function
      const isSwap = functionFragment.name.toLowerCase().includes('swap');
      
      if (isSwap) {
        // Extract common swap parameters
        const result = {
          isSwap: true,
          dexType: dexInfo.type,
          method: functionFragment.name
        };
        
        // Handle different swap methods
        switch (functionFragment.name) {
          case 'swapExactTokensForTokens':
          case 'swapExactTokensForTokensSupportingFeeOnTransferTokens':
            result.amountIn = decoded.amountIn;
            result.amountOutMin = decoded.amountOutMin;
            result.path = decoded.path;
            result.tokenIn = decoded.path[0];
            result.tokenOut = decoded.path[decoded.path.length - 1];
            result.deadline = decoded.deadline;
            break;
            
          case 'swapTokensForExactTokens':
            result.amountOut = decoded.amountOut;
            result.amountInMax = decoded.amountInMax;
            result.path = decoded.path;
            result.tokenIn = decoded.path[0];
            result.tokenOut = decoded.path[decoded.path.length - 1];
            result.deadline = decoded.deadline;
            break;
            
          case 'swapExactETHForTokens':
          case 'swapExactETHForTokensSupportingFeeOnTransferTokens':
            result.amountIn = txData.value;
            result.amountOutMin = decoded.amountOutMin;
            result.path = decoded.path;
            result.tokenIn = TOKEN_ADDRESSES.WETH;
            result.tokenOut = decoded.path[decoded.path.length - 1];
            result.deadline = decoded.deadline;
            break;
            
          case 'swapExactTokensForETH':
          case 'swapExactTokensForETHSupportingFeeOnTransferTokens':
            result.amountIn = decoded.amountIn;
            result.amountOutMin = decoded.amountOutMin;
            result.path = decoded.path;
            result.tokenIn = decoded.path[0];
            result.tokenOut = TOKEN_ADDRESSES.WETH;
            result.deadline = decoded.deadline;
            break;
            
          case 'swapETHForExactTokens':
            result.amountOut = decoded.amountOut;
            result.amountIn = txData.value;
            result.path = decoded.path;
            result.tokenIn = TOKEN_ADDRESSES.WETH;
            result.tokenOut = decoded.path[decoded.path.length - 1];
            result.deadline = decoded.deadline;
            break;
            
          case 'swapTokensForExactETH':
            result.amountOut = decoded.amountOut;
            result.amountInMax = decoded.amountInMax;
            result.path = decoded.path;
            result.tokenIn = decoded.path[0];
            result.tokenOut = TOKEN_ADDRESSES.WETH;
            result.deadline = decoded.deadline;
            break;
            
          // Uniswap V3 specific methods
          case 'exactInputSingle':
            result.tokenIn = decoded.params.tokenIn;
            result.tokenOut = decoded.params.tokenOut;
            result.amountIn = decoded.params.amountIn;
            result.amountOutMin = decoded.params.amountOutMinimum;
            result.sqrtPriceLimitX96 = decoded.params.sqrtPriceLimitX96;
            result.isUniswapV3 = true;
            break;
            
          case 'exactInput':
            result.tokenIn = decoded.params.path.slice(0, 20); // First 20 bytes are the first token
            result.tokenOut = decoded.params.path.slice(-20); // Last 20 bytes are the last token
            result.amountIn = decoded.params.amountIn;
            result.amountOutMin = decoded.params.amountOutMinimum;
            result.isUniswapV3 = true;
            break;
            
          default:
            // Unknown swap method
            logger.debug(`Unknown swap method: ${functionFragment.name}`);
            return null;
        }
        
        // Collect token information
        try {
          const [tokenInInfo, tokenOutInfo] = await Promise.all([
            this.getTokenInfo(result.tokenIn),
            this.getTokenInfo(result.tokenOut)
          ]);
          
          result.tokenInInfo = tokenInInfo;
          result.tokenOutInfo = tokenOutInfo;
          
          // Format amounts with proper decimals
          if (result.amountIn) {
            result.amountInFormatted = ethers.utils.formatUnits(
              result.amountIn,
              tokenInInfo.decimals
            );
          }
          
          if (result.amountOut) {
            result.amountOutFormatted = ethers.utils.formatUnits(
              result.amountOut,
              tokenOutInfo.decimals
            );
          }
          
          // Estimate value in ETH and USD
          if (result.amountIn) {
            const valueInETH = await this.estimateValueInETH(result.tokenIn, result.amountIn);
            result.valueETH = ethers.utils.formatEther(valueInETH);
            
            const valueInUSD = await this.estimateValueInUSD(result.tokenIn, result.amountIn);
            result.valueUSD = valueInUSD;
          }
        } catch (error) {
          logger.warn(`Error collecting token information for swap: ${error.message}`);
        }
        
        return result;
      }
      
      // It's a DEX transaction but not a swap (e.g., liquidity provision, etc.)
      return {
        isDexTransaction: true,
        dexType: dexInfo.type,
        method: functionFragment.name,
        decodedParams: decoded
      };
    } catch (error) {
      logger.debug(`Error decoding DEX transaction: ${error.message}`);
      return null;
    }
  }

  /**
   * Decode an ERC20 transaction
   * @param {Object} txData Transaction data
   * @returns {Promise<Object|null>} Decoded ERC20 transaction or null if not applicable
   */
  async decodeERC20Transaction(txData) {
    try {
      const data = txData.data;
      const functionSelector = data.slice(0, 10).toLowerCase();
      
      // Common ERC20 function selectors
      const transferSelector = ethers.utils.id('transfer(address,uint256)').slice(0, 10).toLowerCase();
      const transferFromSelector = ethers.utils.id('transferFrom(address,address,uint256)').slice(0, 10).toLowerCase();
      const approveSelector = ethers.utils.id('approve(address,uint256)').slice(0, 10).toLowerCase();
      
      if (![transferSelector, transferFromSelector, approveSelector].includes(functionSelector)) {
        return null;
      }
      
      // Try to decode ERC20 function
      let functionFragment;
      try {
        functionFragment = this.erc20Interface.getFunction(functionSelector);
      } catch (error) {
        return null;
      }
      
      if (!functionFragment) {
        return null;
      }
      
      // Decode function parameters
      const decoded = this.erc20Interface.decodeFunctionData(functionFragment, data);
      
      // Build result based on function type
      const result = {
        isERC20Transfer: true,
        method: functionFragment.name,
        tokenAddress: txData.to
      };
      
      switch (functionFragment.name) {
        case 'transfer':
          result.from = txData.from;
          result.to = decoded.to || decoded.recipient || decoded.dst || decoded[0];
          result.amount = decoded.amount || decoded.value || decoded.wad || decoded[1];
          break;
          
        case 'transferFrom':
          result.from = decoded.from || decoded.sender || decoded.src || decoded[0];
          result.to = decoded.to || decoded.recipient || decoded.dst || decoded[1];
          result.amount = decoded.amount || decoded.value || decoded.wad || decoded[2];
          break;
          
        case 'approve':
          result.isERC20Approval = true;
          result.isERC20Transfer = false;
          result.owner = txData.from;
          result.spender = decoded.spender || decoded[0];
          result.amount = decoded.amount || decoded.value || decoded.wad || decoded[1];
          break;
      }
      
      // Collect token information
      try {
        const tokenInfo = await this.getTokenInfo(txData.to);
        result.tokenInfo = tokenInfo;
        
        // Format amount with proper decimals
        if (result.amount) {
          result.amountFormatted = ethers.utils.formatUnits(
            result.amount,
            tokenInfo.decimals
          );
        }
        
        // Estimate value in ETH and USD
        if (result.amount) {
          const valueInETH = await this.estimateValueInETH(txData.to, result.amount);
          result.valueETH = ethers.utils.formatEther(valueInETH);
          
          const valueInUSD = await this.estimateValueInUSD(txData.to, result.amount);
          result.valueUSD = valueInUSD;
        }
      } catch (error) {
        logger.warn(`Error collecting token information for ERC20 transfer: ${error.message}`);
      }
      
      return result;
    } catch (error) {
      logger.debug(`Error decoding ERC20 transaction: ${error.message}`);
      return null;
    }
  }

  /**
   * Decode a flash loan transaction
   * @param {Object} txData Transaction data
   * @returns {Promise<Object|null>} Decoded flash loan transaction or null if not applicable
   */
  async decodeFlashLoanTransaction(txData) {
    try {
      const data = txData.data;
      const functionSelector = data.slice(0, 10).toLowerCase();
      
      // Flash loan function selectors
      const aaveFlashLoanSelector = ethers.utils.id('flashLoan(address,address[],uint256[],uint256[],address,bytes,uint16)').slice(0, 10).toLowerCase();
      const balancerFlashLoanSelector = ethers.utils.id('flashLoan(address,address[],uint256[],bytes)').slice(0, 10).toLowerCase();
      
      if (![aaveFlashLoanSelector, balancerFlashLoanSelector].includes(functionSelector)) {
        return null;
      }
      
      // Result object
      const result = {
        isFlashLoan: true
      };
      
      // Decode based on protocol
      if (functionSelector === aaveFlashLoanSelector) {
        // Aave flash loan
        const decoded = this.aaveInterface.decodeFunctionData('flashLoan', data);
        
        result.protocol = 'Aave';
        result.receiver = decoded.receiverAddress;
        result.tokens = decoded.assets;
        result.amounts = decoded.amounts;
        result.modes = decoded.modes;
        result.onBehalfOf = decoded.onBehalfOf;
        result.params = decoded.params;
        
        // Calculate total value
        let totalValueETH = ethers.constants.Zero;
        
        for (let i = 0; i < result.tokens.length; i++) {
          const token = result.tokens[i];
          const amount = result.amounts[i];
          
          const valueInETH = await this.estimateValueInETH(token, amount);
          totalValueETH = totalValueETH.add(valueInETH);
        }
        
        result.totalValueETH = ethers.utils.formatEther(totalValueETH);
        result.totalValueUSD = await this.estimateValueInUSD(TOKEN_ADDRESSES.WETH, totalValueETH);
      } else if (functionSelector === balancerFlashLoanSelector) {
        // Balancer flash loan
        const decoded = this.balancerInterface.decodeFunctionData('flashLoan', data);
        
        result.protocol = 'Balancer';
        result.receiver = decoded.recipient;
        result.tokens = decoded.tokens;
        result.amounts = decoded.amounts;
        result.userData = decoded.userData;
        
        // Calculate total value
        let totalValueETH = ethers.constants.Zero;
        
        for (let i = 0; i < result.tokens.length; i++) {
          const token = result.tokens[i];
          const amount = result.amounts[i];
          
          const valueInETH = await this.estimateValueInETH(token, amount);
          totalValueETH = totalValueETH.add(valueInETH);
        }
        
        result.totalValueETH = ethers.utils.formatEther(totalValueETH);
        result.totalValueUSD = await this.estimateValueInUSD(TOKEN_ADDRESSES.WETH, totalValueETH);
      }
      
      return result;
    } catch (error) {
      logger.debug(`Error decoding flash loan transaction: ${error.message}`);
      return null;
    }
  }

  /**
   * Decode a liquidation transaction
   * @param {Object} txData Transaction data
   * @returns {Promise<Object|null>} Decoded liquidation transaction or null if not applicable
   */
  async decodeLiquidationTransaction(txData) {
    try {
      const data = txData.data;
      const functionSelector = data.slice(0, 10).toLowerCase();
      
      // Liquidation function selectors
      const aaveLiquidationSelector = ethers.utils.id('liquidationCall(address,address,address,uint256,bool)').slice(0, 10).toLowerCase();
      
      if (functionSelector !== aaveLiquidationSelector) {
        return null;
      }
      
      // Decode Aave liquidation
      const decoded = this.aaveInterface.decodeFunctionData('liquidationCall', data);
      
      const result = {
        isLiquidation: true,
        protocol: 'Aave',
        collateralAsset: decoded.collateralAsset,
        debtAsset: decoded.debtAsset,
        user: decoded.user,
        debtToCover: decoded.debtToCover,
        receiveAToken: decoded.receiveAToken
      };
      
      // Collect token information
      try {
        const [collateralInfo, debtInfo] = await Promise.all([
          this.getTokenInfo(result.collateralAsset),
          this.getTokenInfo(result.debtAsset)
        ]);
        
        result.collateralInfo = collateralInfo;
        result.debtInfo = debtInfo;
        
        // Format amount with proper decimals
        if (result.debtToCover) {
          result.debtToCoverFormatted = ethers.utils.formatUnits(
            result.debtToCover,
            debtInfo.decimals
          );
        }
        
        // Estimate value in ETH and USD
        const valueInETH = await this.estimateValueInETH(result.debtAsset, result.debtToCover);
        result.valueETH = ethers.utils.formatEther(valueInETH);
        
        const valueInUSD = await this.estimateValueInUSD(result.debtAsset, result.debtToCover);
        result.valueUSD = valueInUSD;
      } catch (error) {
        logger.warn(`Error collecting token information for liquidation: ${error.message}`);
      }
      
      return result;
    } catch (error) {
      logger.debug(`Error decoding liquidation transaction: ${error.message}`);
      return null;
    }
  }

  /**
   * Estimate value of tokens in ETH
   * @param {string} tokenAddress Token address
   * @param {BigNumber} amount Amount in token decimals
   * @returns {Promise<BigNumber>} Value in ETH (18 decimals)
   */
  async estimateValueInETH(tokenAddress, amount) {
    try {
      // If token is ETH or WETH, return amount directly
      if (
        tokenAddress.toLowerCase() === TOKEN_ADDRESSES.WETH.toLowerCase() ||
        tokenAddress.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
      ) {
        return amount;
      }
      
      // Get token info for decimals
      const tokenInfo = await this.getTokenInfo(tokenAddress);
      
      // Get token price in ETH
      const priceInEth = await getPriceInEth(tokenAddress, this.provider);
      
      // Calculate value in ETH (normalize decimals)
      const valueInEth = amount.mul(priceInEth).div(
        ethers.BigNumber.from(10).pow(tokenInfo.decimals)
      );
      
      return valueInEth;
    } catch (error) {
      logger.debug(`Error estimating value in ETH: ${error.message}`);
      return ethers.constants.Zero;
    }
  }

  /**
   * Estimate value of tokens in USD
   * @param {string} tokenAddress Token address
   * @param {BigNumber} amount Amount in token decimals
   * @returns {Promise<string>} Value in USD as a string with 2 decimal places
   */
  async estimateValueInUSD(tokenAddress, amount) {
    try {
      // Get ETH price in USD
      const ethPriceInUsd = await getPriceInUsd(TOKEN_ADDRESSES.WETH, this.provider);
      
      // Convert token amount to ETH
      const valueInEth = await this.estimateValueInETH(tokenAddress, amount);
      
      // Calculate USD value
      const valueInUsd = parseFloat(ethers.utils.formatEther(valueInEth)) * ethPriceInUsd;
      
      // Return formatted USD value
      return valueInUsd.toFixed(2);
    } catch (error) {
      logger.debug(`Error estimating value in USD: ${error.message}`);
      return '0.00';
    }
  }
}

module.exports = {
  TxDecoder
};