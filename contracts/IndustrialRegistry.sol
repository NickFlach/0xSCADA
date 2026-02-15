// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title IndustrialRegistry
 * @author 0xSCADA Team
 * @notice Registers industrial sites, assets, and anchors event/maintenance records
 *         to the blockchain as an immutable audit ledger.
 * @dev SAFETY: This contract does NOT control equipment directly. All real-time control
 *      logic stays off-chain. This is purely for identity, registry, and audit.
 *
 *      Security audit remediation applied (QE Phase 2, 2026-02-01):
 *      - H-02: Migrated from string keys to bytes32 (gas + collision fix)
 *      - H-04: Force msg.sender as site owner (authorization fix)
 *      - M-01: Pagination for all ID arrays
 *      - M-03: Documented timestamp usage
 *      - M-05: ReentrancyGuard on state-changing functions
 *      - Locked Solidity version to 0.8.20
 */
contract IndustrialRegistry is ReentrancyGuard {

    struct SiteRecord {
        bytes32 name;            // H-02: bytes32 instead of string
        bytes32 location;        // H-02: bytes32 instead of string
        address owner;
        uint256 registeredAt;    // M-03: block.timestamp — record-keeping only
        bool active;
    }

    struct AssetRecord {
        bytes32 siteId;          // H-02: bytes32 key
        bytes32 assetType;       // H-02: bytes32 instead of string
        bytes32 nameOrTag;       // H-02: bytes32 instead of string
        bool critical;
        uint256 registeredAt;
    }

    struct BatchAnchor {
        bytes32 merkleRoot;
        uint256 eventCount;
        uint256 timestamp;       // M-03: block.timestamp — record-keeping only
        address anchoredBy;
    }

    /// @notice H-02 fix: All mappings use bytes32 keys (keccak256 of off-chain string IDs)
    mapping(bytes32 => SiteRecord) public sites;
    mapping(bytes32 => AssetRecord) public assets;
    mapping(bytes32 => BatchAnchor) public batches;

    bytes32[] public siteIds;
    bytes32[] public assetIds;
    bytes32[] public batchIds;

    // ── Events ──────────────────────────────────────────────────────────

    event SiteRegistered(bytes32 indexed siteId, bytes32 name, address indexed owner, uint256 timestamp);
    event AssetRegistered(bytes32 indexed assetId, bytes32 indexed siteId, bytes32 assetType, uint256 timestamp);
    event EventAnchored(bytes32 indexed assetId, bytes32 eventType, bytes32 payloadHash, uint256 timestamp, address indexed recordedBy);
    event MaintenanceAnchored(bytes32 indexed assetId, bytes32 workOrderId, bytes32 maintenanceType, uint256 timestamp, address indexed performedBy);
    event BatchRootAnchored(bytes32 indexed batchId, bytes32 merkleRoot, uint256 eventCount, uint256 timestamp, address indexed anchoredBy);

    // ── Modifiers ───────────────────────────────────────────────────────

    modifier onlyActiveSite(bytes32 siteId) {
        require(sites[siteId].active, "Site does not exist or is inactive");
        _;
    }

    modifier onlySiteOwner(bytes32 siteId) {
        require(sites[siteId].owner == msg.sender, "Not site owner");
        _;
    }

    // ── Write Functions ─────────────────────────────────────────────────

    /**
     * @notice Register a new industrial site. H-04 fix: msg.sender is forced as owner.
     * @param siteId Unique identifier (bytes32 hash of off-chain string ID)
     * @param name Site name as bytes32
     * @param location Site location as bytes32
     */
    function registerSite(
        bytes32 siteId,
        bytes32 name,
        bytes32 location
    ) external nonReentrant {
        require(!sites[siteId].active && sites[siteId].registeredAt == 0, "Site already registered");
        require(siteId != bytes32(0), "Site ID cannot be empty");

        // H-04 fix: Force msg.sender as owner — no arbitrary owner parameter
        sites[siteId] = SiteRecord({
            name: name,
            location: location,
            owner: msg.sender,
            registeredAt: block.timestamp,
            active: true
        });

        siteIds.push(siteId);
        emit SiteRegistered(siteId, name, msg.sender, block.timestamp);
    }

    /**
     * @notice Register a new asset at an active site. Only site owner can register.
     * @param assetId Unique asset identifier (bytes32)
     * @param siteId The site this asset belongs to
     * @param assetType Type of asset (bytes32)
     * @param nameOrTag Human-readable tag (bytes32)
     * @param critical Whether this is a safety-critical asset
     */
    function registerAsset(
        bytes32 assetId,
        bytes32 siteId,
        bytes32 assetType,
        bytes32 nameOrTag,
        bool critical
    ) external onlyActiveSite(siteId) onlySiteOwner(siteId) nonReentrant {
        require(assets[assetId].registeredAt == 0, "Asset already registered");
        require(assetId != bytes32(0), "Asset ID cannot be empty");

        assets[assetId] = AssetRecord({
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
     * @notice Anchor an industrial event (breaker trip, setpoint change, etc.).
     *         Full payload is stored off-chain; only the hash is anchored here.
     * @param assetId The asset this event is for
     * @param eventType Type of event (bytes32)
     * @param payloadHash Hash of the off-chain event payload
     */
    function anchorEvent(
        bytes32 assetId,
        bytes32 eventType,
        bytes32 payloadHash
    ) external nonReentrant {
        require(assets[assetId].registeredAt > 0, "Asset not registered");
        require(payloadHash != bytes32(0), "Payload hash cannot be empty");

        emit EventAnchored(assetId, eventType, payloadHash, block.timestamp, msg.sender);
    }

    /**
     * @notice Anchor a maintenance record.
     * @param assetId The asset maintained
     * @param workOrderId Work order identifier (bytes32)
     * @param maintenanceType Type of maintenance (bytes32)
     * @param performedAt When the maintenance was performed (off-chain timestamp)
     */
    function anchorMaintenance(
        bytes32 assetId,
        bytes32 workOrderId,
        bytes32 maintenanceType,
        uint256 performedAt
    ) external nonReentrant {
        require(assets[assetId].registeredAt > 0, "Asset not registered");
        require(workOrderId != bytes32(0), "Work order ID cannot be empty");

        emit MaintenanceAnchored(assetId, workOrderId, maintenanceType, performedAt, msg.sender);
    }

    /**
     * @notice Anchor a batch of events as a single Merkle root.
     * @param batchId Unique identifier for this batch
     * @param merkleRoot The Merkle root of all event hashes in the batch
     * @param eventCount Number of events in the batch
     */
    function anchorBatchRoot(
        bytes32 batchId,
        bytes32 merkleRoot,
        uint256 eventCount
    ) external nonReentrant {
        require(batchId != bytes32(0), "Batch ID cannot be empty");
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

    // ── View Functions ──────────────────────────────────────────────────

    /**
     * @notice Verify a Merkle proof for an event in a batch.
     * @param batchId The batch containing the event
     * @param eventHash The hash of the event to verify
     * @param proof The Merkle proof (array of sibling hashes)
     * @return isValid True if the proof is valid
     */
    function verifyEventInBatch(
        bytes32 batchId,
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
     * @notice Get site details.
     * @param siteId The site ID
     * @return The SiteRecord struct
     */
    function getSite(bytes32 siteId) external view returns (SiteRecord memory) {
        return sites[siteId];
    }

    /**
     * @notice Get asset details.
     * @param assetId The asset ID
     * @return The AssetRecord struct
     */
    function getAsset(bytes32 assetId) external view returns (AssetRecord memory) {
        return assets[assetId];
    }

    /**
     * @notice Get batch details.
     * @param batchId The batch ID
     * @return The BatchAnchor struct
     */
    function getBatch(bytes32 batchId) external view returns (BatchAnchor memory) {
        return batches[batchId];
    }

    /**
     * @notice Get total number of registered sites.
     */
    function getSiteCount() external view returns (uint256) {
        return siteIds.length;
    }

    /**
     * @notice Get total number of registered assets.
     */
    function getAssetCount() external view returns (uint256) {
        return assetIds.length;
    }

    /**
     * @notice Get total number of anchored batches.
     */
    function getBatchCount() external view returns (uint256) {
        return batchIds.length;
    }

    /**
     * @notice M-01 fix: Paginated access to site IDs.
     * @param offset Starting index
     * @param limit Maximum items to return
     * @return result Slice of site IDs
     */
    function getSiteIdsPaginated(uint256 offset, uint256 limit)
        external view returns (bytes32[] memory result)
    {
        uint256 total = siteIds.length;
        if (offset >= total) return new bytes32[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        result = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            result[i - offset] = siteIds[i];
        }
    }

    /**
     * @notice M-01 fix: Paginated access to asset IDs.
     * @param offset Starting index
     * @param limit Maximum items to return
     * @return result Slice of asset IDs
     */
    function getAssetIdsPaginated(uint256 offset, uint256 limit)
        external view returns (bytes32[] memory result)
    {
        uint256 total = assetIds.length;
        if (offset >= total) return new bytes32[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        result = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            result[i - offset] = assetIds[i];
        }
    }

    /**
     * @notice M-01 fix: Paginated access to batch IDs.
     * @param offset Starting index
     * @param limit Maximum items to return
     * @return result Slice of batch IDs
     */
    function getBatchIdsPaginated(uint256 offset, uint256 limit)
        external view returns (bytes32[] memory result)
    {
        uint256 total = batchIds.length;
        if (offset >= total) return new bytes32[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        result = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            result[i - offset] = batchIds[i];
        }
    }
}
