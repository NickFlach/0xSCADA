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

    struct BatchAnchor {
        bytes32 merkleRoot;
        uint256 eventCount;
        uint256 timestamp;
        address anchoredBy;
    }

    mapping(string => SiteRegistry) public sites;
    mapping(string => AssetRegistry) public assets;
    mapping(string => BatchAnchor) public batches;
    
    string[] public siteIds;
    string[] public assetIds;
    string[] public batchIds;

    event SiteRegistered(string indexed siteId, string name, address owner, uint256 timestamp);
    event AssetRegistered(string indexed assetId, string siteId, string assetType, uint256 timestamp);
    event EventAnchored(string indexed assetId, string eventType, bytes32 payloadHash, uint256 timestamp, address recordedBy);
    event MaintenanceAnchored(string indexed assetId, string workOrderId, string maintenanceType, uint256 timestamp, address performedBy);
    event BatchRootAnchored(string indexed batchId, bytes32 merkleRoot, uint256 eventCount, uint256 timestamp, address anchoredBy);

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

    /**
     * @notice Anchor a batch of events as a single Merkle root
     * This is the high-volume anchoring solution - instead of anchoring each event
     * individually, multiple events are batched off-chain into a Merkle tree, 
     * and only the root is anchored on-chain.
     * @param batchId Unique identifier for this batch
     * @param merkleRoot The Merkle root of all event hashes in the batch
     * @param eventCount Number of events included in this batch
     */
    function anchorBatchRoot(
        string memory batchId,
        bytes32 merkleRoot,
        uint256 eventCount
    ) external {
        require(bytes(batchId).length > 0, "Batch ID cannot be empty");
        require(merkleRoot != bytes32(0), "Merkle root cannot be empty");
        require(eventCount > 0, "Event count must be greater than 0");
        require(batches[batchId].timestamp == 0, "Batch already anchored");

        batches[batchId] = BatchAnchor({
            merkleRoot: merkleRoot,
            eventCount: eventCount,
            timestamp: block.timestamp,
            anchoredBy: msg.sender
        });

        batchIds.push(batchId);
        emit BatchRootAnchored(batchId, merkleRoot, eventCount, block.timestamp, msg.sender);
    }

    /**
     * @notice Verify a Merkle proof for an event in a batch
     * @param batchId The batch containing the event
     * @param eventHash The hash of the event to verify
     * @param proof The Merkle proof (array of sibling hashes)
     * @return isValid True if the proof is valid
     */
    function verifyEventInBatch(
        string memory batchId,
        bytes32 eventHash,
        bytes32[] memory proof
    ) external view returns (bool isValid) {
        BatchAnchor memory batch = batches[batchId];
        require(batch.timestamp > 0, "Batch not found");

        bytes32 computedHash = eventHash;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 proofElement = proof[i];
            if (computedHash < proofElement) {
                computedHash = keccak256(abi.encodePacked(computedHash, proofElement));
            } else {
                computedHash = keccak256(abi.encodePacked(proofElement, computedHash));
            }
        }

        return computedHash == batch.merkleRoot;
    }

    /**
     * @notice Get batch details
     */
    function getBatch(string memory batchId) external view returns (BatchAnchor memory) {
        return batches[batchId];
    }

    /**
     * @notice Get total number of anchored batches
     */
    function getBatchCount() external view returns (uint256) {
        return batchIds.length;
    }
}
