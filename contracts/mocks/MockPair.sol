// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

/**
 * @title MockPair
 * @dev Mock implementation of Uniswap V2 Pair for testing
 */
contract MockPair {
    address public token0;
    address public token1;
    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;
    
    /**
     * @dev Constructor that sets token addresses
     */
    constructor(address _token0, address _token1) {
        require(_token0 != address(0), "MockPair: ZERO_ADDRESS");
        require(_token1 != address(0), "MockPair: ZERO_ADDRESS");
        require(_token0 != _token1, "MockPair: IDENTICAL_ADDRESSES");
        
        // Sort tokens
        (token0, token1) = _token0 < _token1 ? (_token0, _token1) : (_token1, _token0);
        
        // Initialize reserves
        reserve0 = 0;
        reserve1 = 0;
        blockTimestampLast = uint32(block.timestamp);
    }
    
    /**
     * @dev Returns the current reserves
     */
    function getReserves() public view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast) {
        _reserve0 = reserve0;
        _reserve1 = reserve1;
        _blockTimestampLast = blockTimestampLast;
    }
    
    /**
     * @dev Sets the reserves (for testing purposes)
     */
    function setReserves(uint112 _reserve0, uint112 _reserve1) public {
        reserve0 = _reserve0;
        reserve1 = _reserve1;
        blockTimestampLast = uint32(block.timestamp);
    }
    
    /**
     * @dev Mock swap function
     */
    function swap(uint amount0Out, uint amount1Out, address to, bytes calldata data) external {
        require(amount0Out > 0 || amount1Out > 0, "MockPair: INSUFFICIENT_OUTPUT_AMOUNT");
        
        // Not implementing actual swap logic for mock
        // Just update reserves as if the swap happened
        if (amount0Out > 0) {
            require(reserve0 >= amount0Out, "MockPair: INSUFFICIENT_LIQUIDITY");
            reserve0 = uint112(uint(reserve0) - amount0Out);
        }
        
        if (amount1Out > 0) {
            require(reserve1 >= amount1Out, "MockPair: INSUFFICIENT_LIQUIDITY");
            reserve1 = uint112(uint(reserve1) - amount1Out);
        }
    }
}