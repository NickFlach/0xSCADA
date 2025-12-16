// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IndustrialRegistry
 * @notice Smart contract for registering industrial sites, assets, and anchoring
 * event/maintenance records to the blockchain as an immutable audit ledger.
 * 
 * SAFETY: This contract does NOT control equipment directly. All real-time control
 * logic stays off-chain. This is purely for identity, registry, and audit.
 */
contract IndustrialRegistry {
    
    struct SiteRegistry {
        string name;
        string location;
        address owner;
        uint256 registeredAt;
        bool active;
    }

    struct AssetRegistry {
        string siteId;
        string assetType;
        string nameOrTag;
        bool critical;
        uint256 registeredAt;
    }

    struct EventAnchor {
        string assetId;
        string eventType;
        bytes32 payloadHash;
        uint256 timestamp;
        address recordedBy;
    }

    struct MaintenanceAnchor {
        string assetId;
        string workOrderId;
        string maintenanceType;
        uint256 performedAt;
        address performedBy;
    }

    mapping(string => SiteRegistry) public sites;
    mapping(string => AssetRegistry) public assets;
    
    string[] public siteIds;
    string[] public assetIds;

    event SiteRegistered(string indexed siteId, string name, address owner, uint256 timestamp);
    event AssetRegistered(string indexed assetId, string siteId, string assetType, uint256 timestamp);
    event EventAnchored(string indexed assetId, string eventType, bytes32 payloadHash, uint256 timestamp, address recordedBy);
    event MaintenanceAnchored(string indexed assetId, string workOrderId, string maintenanceType, uint256 timestamp, address performedBy);

    modifier onlyActiveSite(string memory siteId) {
        require(sites[siteId].active, "Site does not exist or is inactive");
        _;
    }

    /**
     * @notice Register a new industrial site
     */
    function registerSite(
        string memory siteId,
        string memory name,
        string memory location,
        address owner
    ) external {
        require(!sites[siteId].active, "Site already registered");
        require(bytes(siteId).length > 0, "Site ID cannot be empty");
        require(owner != address(0), "Owner cannot be zero address");

        sites[siteId] = SiteRegistry({
            name: name,
            location: location,
            owner: owner,
            registeredAt: block.timestamp,
            active: true
        });

        siteIds.push(siteId);
        emit SiteRegistered(siteId, name, owner, block.timestamp);
    }

    /**
     * @notice Register a new asset at a site
     */
    function registerAsset(
        string memory assetId,
        string memory siteId,
        string memory assetType,
        string memory nameOrTag,
        bool critical
    ) external onlyActiveSite(siteId) {
        require(bytes(assets[assetId].assetType).length == 0, "Asset already registered");
        require(bytes(assetId).length > 0, "Asset ID cannot be empty");

        assets[assetId] = AssetRegistry({
            siteId: siteId,
            assetType: assetType,
            nameOrTag: nameOrTag,
            critical: critical,
            registeredAt: block.timestamp
        });

        assetIds.push(assetId);
        emit AssetRegistered(assetId, siteId, assetType, block.timestamp);
    }

    /**
     * @notice Anchor an industrial event (breaker trip, setpoint change, etc.)
     * The full payload is stored off-chain, only the hash is anchored here.
     */
    function anchorEvent(
        string memory assetId,
        string memory eventType,
        bytes32 payloadHash
    ) external {
        require(bytes(assets[assetId].assetType).length > 0, "Asset not registered");
        require(payloadHash != bytes32(0), "Payload hash cannot be empty");

        emit EventAnchored(assetId, eventType, payloadHash, block.timestamp, msg.sender);
    }

    /**
     * @notice Anchor a maintenance record
     */
    function anchorMaintenance(
        string memory assetId,
        string memory workOrderId,
        string memory maintenanceType,
        uint256 performedAt
    ) external {
        require(bytes(assets[assetId].assetType).length > 0, "Asset not registered");
        require(bytes(workOrderId).length > 0, "Work order ID cannot be empty");

        emit MaintenanceAnchored(assetId, workOrderId, maintenanceType, performedAt, msg.sender);
    }

    /**
     * @notice Get site details
     */
    function getSite(string memory siteId) external view returns (SiteRegistry memory) {
        return sites[siteId];
    }

    /**
     * @notice Get asset details
     */
    function getAsset(string memory assetId) external view returns (AssetRegistry memory) {
        return assets[assetId];
    }

    /**
     * @notice Get total number of registered sites
     */
    function getSiteCount() external view returns (uint256) {
        return siteIds.length;
    }

    /**
     * @notice Get total number of registered assets
     */
    function getAssetCount() external view returns (uint256) {
        return assetIds.length;
    }
}
