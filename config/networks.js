/**
 * Network configurations for the MEV strategy project
 */
require("dotenv").config();

const INFURA_API_KEY = process.env.INFURA_API_KEY || "";
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || "";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";

/**
 * Network configurations for different Ethereum networks
 */
const networks = {
  // Ethereum Mainnet
  mainnet: {
    chainId: 1,
    name: "Mainnet",
    currency: "ETH",
    explorerUrl: "https://etherscan.io",
    rpcUrls: [
      `https://mainnet.infura.io/v3/${INFURA_API_KEY}`,
      `https://eth-mainnet.alchemyapi.io/v2/${ALCHEMY_API_KEY}`,
      "https://cloudflare-eth.com"
    ],
    privateKey: PRIVATE_KEY ? `0x${PRIVATE_KEY}` : undefined,
    blockTime: 12, // seconds
    confirmations: 2,
    gasMultiplier: 1.2
  },
  
  // Goerli Testnet
  goerli: {
    chainId: 5,
    name: "Goerli",
    currency: "GoerliETH",
    explorerUrl: "https://goerli.etherscan.io",
    rpcUrls: [
      `https://goerli.infura.io/v3/${INFURA_API_KEY}`,
      `https://eth-goerli.alchemyapi.io/v2/${ALCHEMY_API_KEY}`
    ],
    privateKey: PRIVATE_KEY ? `0x${PRIVATE_KEY}` : undefined,
    blockTime: 15, // seconds
    confirmations: 1,
    gasMultiplier: 1.5
  },
  
  // Sepolia Testnet
  sepolia: {
    chainId: 11155111,
    name: "Sepolia",
    currency: "SepoliaETH",
    explorerUrl: "https://sepolia.etherscan.io",
    rpcUrls: [
      `https://sepolia.infura.io/v3/${INFURA_API_KEY}`,
      `https://eth-sepolia.alchemyapi.io/v2/${ALCHEMY_API_KEY}`
    ],
    privateKey: PRIVATE_KEY ? `0x${PRIVATE_KEY}` : undefined,
    blockTime: 15, // seconds
    confirmations: 1,
    gasMultiplier: 1.5
  },
  
  // Local Development
  localhost: {
    chainId: 31337,
    name: "Localhost",
    currency: "ETH",
    rpcUrls: ["http://127.0.0.1:8545"],
    privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // Hardhat default private key
    blockTime: 1, // seconds
    confirmations: 1,
    gasMultiplier: 1
  }
};

/**
 * Get network configuration by chain ID
 * @param {number} chainId - Network chain ID
 * @returns {Object|undefined} - Network configuration
 */
function getNetworkByChainId(chainId) {
  return Object.values(networks).find(net => net.chainId === chainId);
}

/**
 * Get network configuration by name
 * @param {string} name - Network name
 * @returns {Object|undefined} - Network configuration
 */
function getNetworkByName(name) {
  return networks[name.toLowerCase()];
}

/**
 * Check if a network is a testnet
 * @param {number|string} network - Network chain ID or name
 * @returns {boolean} - True if testnet, false otherwise
 */
function isTestnet(network) {
  const config = typeof network === 'number' ? 
    getNetworkByChainId(network) : 
    getNetworkByName(network);
  
  if (!config) return false;
  
  return config.chainId !== 1 && config.chainId !== 31337;
}

module.exports = {
  networks,
  getNetworkByChainId,
  getNetworkByName,
  isTestnet
};