// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import "./Ownable.sol";

/**
 * @title Upgradeable
 * @dev Contract module that provides a basic upgradeability mechanism with a proxy pattern
 * This is a simplified implementation for demonstration purposes
 * In production, use established proxy patterns such as OpenZeppelin's Transparent Proxy
 */
contract Upgradeable is Ownable {
    address private _implementation;
    bool private _initialized;
    bool private _initializing;
    
    /**
     * @dev Emitted when implementation address is updated
     */
    event Upgraded(address indexed implementation);
    
    /**
     * @dev Modifier that prevents functions from being executed if the contract
     * is in the initialization process
     */
    modifier initializer() {
        require(
            !_initialized || _initializing,
            "Upgradeable: contract is already initialized"
        );
        
        bool isTopLevelCall = !_initializing;
        if (isTopLevelCall) {
            _initializing = true;
            _initialized = true;
        }
        
        _;
        
        if (isTopLevelCall) {
            _initializing = false;
        }
    }
    
    /**
     * @dev Modifier that restricts execution to the proxy contract
     */
    modifier onlyProxy() {
        require(address(this) != _implementation, "Upgradeable: function must be called through proxy");
        _;
    }
    
    /**
     * @dev Modifier that restricts execution to the implementation contract
     */
    modifier onlyImplementation() {
        require(address(this) == _implementation, "Upgradeable: function must be called through implementation");
        _;
    }
    
    /**
     * @dev Returns the current implementation address
     */
    function implementation() public view returns (address) {
        return _implementation;
    }
    
    /**
     * @dev Upgrades the contract by setting a new implementation address
     * Only contract owner can call this
     * @param newImplementation Address of the new implementation
     */
    function upgradeTo(address newImplementation) public onlyOwner {
        require(newImplementation != address(0), "Upgradeable: new implementation is the zero address");
        require(newImplementation != _implementation, "Upgradeable: new implementation is the same as current");
        
        _implementation = newImplementation;
        emit Upgraded(newImplementation);
    }
    
    /**
     * @dev Returns whether the contract has been initialized
     */
    function isInitialized() public view returns (bool) {
        return _initialized;
    }
    
    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[50] private __gap;
}