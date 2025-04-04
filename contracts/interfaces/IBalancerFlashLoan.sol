// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import "./IERC20.sol";

/**
 * @title IBalancerFlashLoan
 * @dev Interface for the Balancer flash loan functionality
 */
interface IBalancerFlashLoan {
    /**
     * @dev Performs a flash loan
     * @param recipient The address which will receive the token amounts
     * @param tokens Array of token addresses for the flash loan
     * @param amounts Array of token amounts to be flash-loaned
     * @param userData Arbitrary user data to be passed to the recipient
     */
    function flashLoan(
        address recipient,
        IERC20[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
    
    /**
     * @dev Returns the fee applied on flash loans
     * @return The fee applied on flash loans, expressed as a percentage of the loan
     */
    function getFlashLoanFeePercentage() external view returns (uint256);
}