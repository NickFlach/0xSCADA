// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title SiteRegistry
 * @notice PRD Section 7.1: Site Registry Contract
 * 
 * Stores:
 * - siteId → owner
 * - authorized gateways
 * - authorized signers
 * 
 * Contracts are:
 * - Minimal
 * - Non-upgradeable
 * - Gas-efficient
 * - Auditable
 */
contract SiteRegistry {
    
    struct Site {
        address owner;
        bool active;
        uint256 registeredAt;
    }
    
    // siteId => Site
    mapping(bytes32 => Site) public sites;
    
    // siteId => gateway address => authorized
    mapping(bytes32 => mapping(address => bool)) public authorizedGateways;
    
    // siteId => signer address => authorized
    mapping(bytes32 => mapping(address => bool)) public authorizedSigners;
    
    // Track all site IDs
    bytes32[] public siteIds;
    
    // Events
    event SiteRegistered(bytes32 indexed siteId, address indexed owner, uint256 timestamp);
    event SiteOwnershipTransferred(bytes32 indexed siteId, address indexed previousOwner, address indexed newOwner);
    event SiteDeactivated(bytes32 indexed siteId, uint256 timestamp);
    event GatewayAuthorized(bytes32 indexed siteId, address indexed gateway, uint256 timestamp);
    event GatewayRevoked(bytes32 indexed siteId, address indexed gateway, uint256 timestamp);
    event SignerAuthorized(bytes32 indexed siteId, address indexed signer, uint256 timestamp);
    event SignerRevoked(bytes32 indexed siteId, address indexed signer, uint256 timestamp);
    
    // Modifiers
    modifier onlySiteOwner(bytes32 siteId) {
        require(sites[siteId].owner == msg.sender, "Not site owner");
        _;
    }
    
    modifier siteExists(bytes32 siteId) {
        require(sites[siteId].active, "Site does not exist or inactive");
        _;
    }
    
    /**
     * @notice Register a new site
     * @param siteId Unique identifier for the site (hash of off-chain ID)
     */
    function registerSite(bytes32 siteId) external {
        require(!sites[siteId].active, "Site already registered");
        require(siteId != bytes32(0), "Invalid site ID");
        
        sites[siteId] = Site({
            owner: msg.sender,
            active: true,
            registeredAt: block.timestamp
        });
        
        siteIds.push(siteId);
        
        // Owner is automatically an authorized signer
        authorizedSigners[siteId][msg.sender] = true;
        
        emit SiteRegistered(siteId, msg.sender, block.timestamp);
        emit SignerAuthorized(siteId, msg.sender, block.timestamp);
    }
    
    /**
     * @notice Transfer site ownership
     */
    function transferOwnership(bytes32 siteId, address newOwner) 
        external 
        onlySiteOwner(siteId) 
        siteExists(siteId) 
    {
        require(newOwner != address(0), "Invalid new owner");
        
        address previousOwner = sites[siteId].owner;
        sites[siteId].owner = newOwner;
        
        // New owner becomes authorized signer
        authorizedSigners[siteId][newOwner] = true;
        
        emit SiteOwnershipTransferred(siteId, previousOwner, newOwner);
        emit SignerAuthorized(siteId, newOwner, block.timestamp);
    }
    
    /**
     * @notice Deactivate a site
     */
    function deactivateSite(bytes32 siteId) 
        external 
        onlySiteOwner(siteId) 
        siteExists(siteId) 
    {
        sites[siteId].active = false;
        emit SiteDeactivated(siteId, block.timestamp);
    }
    
    /**
     * @notice Authorize a gateway for a site
     */
    function authorizeGateway(bytes32 siteId, address gateway) 
        external 
        onlySiteOwner(siteId) 
        siteExists(siteId) 
    {
        require(gateway != address(0), "Invalid gateway address");
        require(!authorizedGateways[siteId][gateway], "Gateway already authorized");
        
        authorizedGateways[siteId][gateway] = true;
        emit GatewayAuthorized(siteId, gateway, block.timestamp);
    }
    
    /**
     * @notice Revoke a gateway's authorization
     */
    function revokeGateway(bytes32 siteId, address gateway) 
        external 
        onlySiteOwner(siteId) 
        siteExists(siteId) 
    {
        require(authorizedGateways[siteId][gateway], "Gateway not authorized");
        
        authorizedGateways[siteId][gateway] = false;
        emit GatewayRevoked(siteId, gateway, block.timestamp);
    }
    
    /**
     * @notice Authorize a signer for a site
     */
    function authorizeSigner(bytes32 siteId, address signer) 
        external 
        onlySiteOwner(siteId) 
        siteExists(siteId) 
    {
        require(signer != address(0), "Invalid signer address");
        require(!authorizedSigners[siteId][signer], "Signer already authorized");
        
        authorizedSigners[siteId][signer] = true;
        emit SignerAuthorized(siteId, signer, block.timestamp);
    }
    
    /**
     * @notice Revoke a signer's authorization
     */
    function revokeSigner(bytes32 siteId, address signer) 
        external 
        onlySiteOwner(siteId) 
        siteExists(siteId) 
    {
        require(signer != sites[siteId].owner, "Cannot revoke owner");
        require(authorizedSigners[siteId][signer], "Signer not authorized");
        
        authorizedSigners[siteId][signer] = false;
        emit SignerRevoked(siteId, signer, block.timestamp);
    }
    
    // View functions
    
    function isGatewayAuthorized(bytes32 siteId, address gateway) external view returns (bool) {
        return authorizedGateways[siteId][gateway];
    }
    
    function isSignerAuthorized(bytes32 siteId, address signer) external view returns (bool) {
        return authorizedSigners[siteId][signer];
    }
    
    function getSiteCount() external view returns (uint256) {
        return siteIds.length;
    }
    
    function getSite(bytes32 siteId) external view returns (
        address owner,
        bool active,
        uint256 registeredAt
    ) {
        Site memory site = sites[siteId];
        return (site.owner, site.active, site.registeredAt);
    }
}
