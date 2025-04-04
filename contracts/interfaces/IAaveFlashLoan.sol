// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

/**
 * @title IAaveFlashLoan
 * @dev Interface for the Aave flash loan functionality
 */
interface IAaveFlashLoan {
    /**
     * @dev Allows smart contracts to access the liquidity of the pool within a single transaction,
     * as long as the funds are returned to the pool within the execution of the transaction.
     * Requires the amount of assets to be withdrawn to be equal to or less than the available liquidity
     * @param receiverAddress The address of the contract receiving the funds
     * @param assets The addresses of the assets to flash loan
     * @param amounts The amounts of assets to flash loan
     * @param modes The modes to open the positions:
     *   0 = no debt (flash loan), 1 = stable, 2 = variable
     * @param onBehalfOf The address that will receive the debt in case of mode = 1 or 2
     * @param params Arbitrary bytes-encoded params to pass to the receiver
     * @param referralCode The referral code
     */
    function flashLoan(
        address receiverAddress,
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata modes,
        address onBehalfOf,
        bytes calldata params,
        uint16 referralCode
    ) external;

    /**
     * @dev Returns the fee on flash loans 
     * @return The fee on flash loans
     */
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint256);
}