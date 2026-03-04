// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title EventAnchor
 * @notice Blockchain anchoring contract for 0xSCADA event integrity verification
 * @dev Stores Merkle roots on-chain to enable cryptographic proof of event authenticity
 * 
 * This contract is part of the 0xSCADA integrity system. It receives signed Merkle roots
 * from the HSM-backed relayer service and stores them on-chain for later verification.
 * Events can then be cryptographically proven to be part of a specific batch using
 * Merkle inclusion proofs.
 * 
 * Key Features:
 * - Stores Merkle roots with batch metadata
 * - Provides verification of anchored roots
 * - Retrieval of anchor data by batch ID
 * - Owner-controlled access for security
 * - Event emission for off-chain indexing
 */
contract EventAnchor is Ownable {

    // ═══════════════════════════════════════════════════════════════════
    // STRUCTS & STORAGE
    // ═══════════════════════════════════════════════════════════════════

    struct AnchorData {
        bytes32 merkleRoot;     // The Merkle root of the event batch
        uint256 eventCount;     // Number of events in this batch
        uint256 timestamp;      // When this anchor was created
        bool exists;            // Whether this anchor exists
    }

    /// @dev Mapping from batch ID to anchor data
    mapping(uint256 => AnchorData) public anchors;

    /// @dev Mapping from Merkle root to batch ID for reverse lookup
    mapping(bytes32 => uint256) public rootToBatch;

    /// @dev Counter for the next batch ID
    uint256 public nextBatchId = 1;

    // ═══════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Emitted when a new Merkle root is anchored
    /// @param batchId The unique identifier for this batch
    /// @param merkleRoot The Merkle root of the event batch
    /// @param eventCount Number of events in the batch
    /// @param timestamp When the anchor was created
    event Anchored(
        uint256 indexed batchId,
        bytes32 merkleRoot,
        uint256 eventCount,
        uint256 timestamp
    );

    // ═══════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Initialize the contract with the deployer as owner
    /// @param initialOwner Address to set as the contract owner
    constructor(address initialOwner) Ownable(initialOwner) {}

    // ═══════════════════════════════════════════════════════════════════
    // EXTERNAL FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Anchor a Merkle root on-chain with batch metadata
     * @dev Only the contract owner can call this function (typically the relayer service)
     * @param merkleRoot The Merkle root to anchor
     * @param batchId The batch identifier (must be sequential)
     * @param eventCount The number of events in this batch
     * 
     * Requirements:
     * - Caller must be the contract owner
     * - batchId must be the next expected batch ID
     * - merkleRoot must not be zero
     * - eventCount must be greater than zero
     */
    function anchor(
        bytes32 merkleRoot,
        uint256 batchId,
        uint256 eventCount
    ) external onlyOwner {
        require(merkleRoot != bytes32(0), "EventAnchor: Merkle root cannot be zero");
        require(eventCount > 0, "EventAnchor: Event count must be greater than zero");
        require(batchId == nextBatchId, "EventAnchor: Invalid batch ID, must be sequential");
        require(!anchors[batchId].exists, "EventAnchor: Batch already anchored");

        uint256 timestamp = block.timestamp;

        // Store the anchor data
        anchors[batchId] = AnchorData({
            merkleRoot: merkleRoot,
            eventCount: eventCount,
            timestamp: timestamp,
            exists: true
        });

        // Store reverse mapping
        rootToBatch[merkleRoot] = batchId;

        // Increment next batch ID
        nextBatchId++;

        // Emit event for off-chain indexing
        emit Anchored(batchId, merkleRoot, eventCount, timestamp);
    }

    /**
     * @notice Verify if a Merkle root has been anchored
     * @param merkleRoot The Merkle root to verify
     * @return exists Whether the root has been anchored
     * @return batchId The batch ID containing this root (0 if not found)
     */
    function verify(bytes32 merkleRoot) external view returns (bool exists, uint256 batchId) {
        batchId = rootToBatch[merkleRoot];
        exists = batchId != 0 && anchors[batchId].exists;
        return (exists, batchId);
    }

    /**
     * @notice Get anchor data for a specific batch ID
     * @param batchId The batch ID to query
     * @return anchor The complete anchor data for this batch
     * 
     * Note: Check anchor.exists before using the data
     */
    function getAnchor(uint256 batchId) external view returns (AnchorData memory anchor) {
        return anchors[batchId];
    }

    // ═══════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Get the current next batch ID
     * @return The next batch ID that will be used for anchoring
     */
    function getCurrentBatchId() external view returns (uint256) {
        return nextBatchId;
    }

    /**
     * @notice Check if a specific batch ID has been anchored
     * @param batchId The batch ID to check
     * @return Whether this batch ID has been anchored
     */
    function isBatchAnchored(uint256 batchId) external view returns (bool) {
        return anchors[batchId].exists;
    }

    /**
     * @notice Get the total number of anchored batches
     * @return The number of batches that have been anchored
     */
    function getAnchoredBatchCount() external view returns (uint256) {
        return nextBatchId - 1;
    }
}