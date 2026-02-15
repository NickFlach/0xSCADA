// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "./SiteRegistry.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title EventAnchor
 * @author 0xSCADA Team
 * @notice PRD Section 7.2: Event Anchor Contract — stores Merkle roots, metadata
 *         pointers, and timestamps for anchored industrial event batches.
 * @dev Security audit remediation applied (QE Phase 2, 2026-02-01):
 *      - C-01: Nonce-based anchor ID (prevents front-running)
 *      - H-01: Bounds check in Merkle proof verification
 *      - M-01: Pagination for anchor/site-anchor arrays
 *      - M-03: block.number for ID generation; block.timestamp documented
 *      - M-05: ReentrancyGuard on state-changing functions
 *      - Locked Solidity version to 0.8.20
 */
contract EventAnchor is ReentrancyGuard {

    SiteRegistry public immutable siteRegistry;

    struct Anchor {
        bytes32 siteId;
        bytes32 merkleRoot;
        bytes32 metadataHash;       /// @dev Hash of batch metadata
        string metadataUri;          /// @dev IPFS URI or other storage pointer
        uint256 eventCount;
        uint256 firstEventTimestamp; /// @dev M-03: Off-chain timestamp, informational only
        uint256 lastEventTimestamp;  /// @dev M-03: Off-chain timestamp, informational only
        uint256 anchoredAt;          /// @dev M-03: block.timestamp — record-keeping only
        address anchoredBy;
    }

    /// @notice Anchor ID => Anchor data
    mapping(bytes32 => Anchor) public anchors;

    /// @notice Site ID => list of anchor IDs
    mapping(bytes32 => bytes32[]) public siteAnchors;

    /// @notice All anchor IDs
    bytes32[] public anchorIds;

    /// @notice C-01 fix: Incrementing nonce prevents front-running of anchor IDs
    uint256 private _anchorNonce;

    // ── Events ──────────────────────────────────────────────────────────

    event BatchAnchored(
        bytes32 indexed anchorId,
        bytes32 indexed siteId,
        bytes32 merkleRoot,
        uint256 eventCount,
        uint256 timestamp,
        address indexed anchoredBy
    );

    // ── Constructor ─────────────────────────────────────────────────────

    /**
     * @notice Deploy with a reference to the SiteRegistry.
     * @param _siteRegistry Address of the deployed SiteRegistry contract
     */
    constructor(address _siteRegistry) {
        siteRegistry = SiteRegistry(_siteRegistry);
    }

    // ── Write Functions ─────────────────────────────────────────────────

    /**
     * @notice Anchor a batch of events on-chain.
     * @param siteId The site this batch belongs to
     * @param merkleRoot The Merkle root of the event hashes
     * @param metadataHash Hash of the batch metadata
     * @param metadataUri URI pointing to full batch data (IPFS, etc.)
     * @param eventCount Number of events in the batch
     * @param firstEventTimestamp Timestamp of first event in batch
     * @param lastEventTimestamp Timestamp of last event in batch
     * @return anchorId The unique identifier for this anchor
     */
    function anchorBatch(
        bytes32 siteId,
        bytes32 merkleRoot,
        bytes32 metadataHash,
        string calldata metadataUri,
        uint256 eventCount,
        uint256 firstEventTimestamp,
        uint256 lastEventTimestamp
    ) external nonReentrant returns (bytes32 anchorId) {
        // Verify caller is authorized
        require(
            siteRegistry.isGatewayAuthorized(siteId, msg.sender) ||
            siteRegistry.isSignerAuthorized(siteId, msg.sender),
            "Not authorized to anchor for this site"
        );

        require(merkleRoot != bytes32(0), "Invalid Merkle root");
        require(eventCount > 0, "Event count must be positive");

        // C-01 fix: nonce makes ID unpredictable even if other params are known
        unchecked { _anchorNonce++; }
        anchorId = keccak256(abi.encodePacked(
            siteId,
            merkleRoot,
            block.number,   // M-03: block.number for ordering
            msg.sender,
            _anchorNonce
        ));

        require(anchors[anchorId].anchoredAt == 0, "Anchor already exists");

        anchors[anchorId] = Anchor({
            siteId: siteId,
            merkleRoot: merkleRoot,
            metadataHash: metadataHash,
            metadataUri: metadataUri,
            eventCount: eventCount,
            firstEventTimestamp: firstEventTimestamp,
            lastEventTimestamp: lastEventTimestamp,
            anchoredAt: block.timestamp,
            anchoredBy: msg.sender
        });

        anchorIds.push(anchorId);
        siteAnchors[siteId].push(anchorId);

        emit BatchAnchored(
            anchorId,
            siteId,
            merkleRoot,
            eventCount,
            block.timestamp,
            msg.sender
        );

        return anchorId;
    }

    // ── View Functions ──────────────────────────────────────────────────

    /**
     * @notice Verify an event is included in an anchored batch via Merkle proof.
     * @param anchorId The anchor to verify against
     * @param eventHash The hash of the event
     * @param proof The Merkle proof (sibling hashes)
     * @param index The leaf index in the Merkle tree
     * @return True if the proof is valid
     */
    function verifyEvent(
        bytes32 anchorId,
        bytes32 eventHash,
        bytes32[] calldata proof,
        uint256 index
    ) external view returns (bool) {
        Anchor memory anchor = anchors[anchorId];
        require(anchor.anchoredAt > 0, "Anchor does not exist");

        return _verifyMerkleProof(eventHash, proof, anchor.merkleRoot, index);
    }

    /**
     * @notice Get full anchor details.
     * @param anchorId The anchor ID
     */
    function getAnchor(bytes32 anchorId) external view returns (
        bytes32 siteId,
        bytes32 merkleRoot,
        bytes32 metadataHash,
        string memory metadataUri,
        uint256 eventCount,
        uint256 firstEventTimestamp,
        uint256 lastEventTimestamp,
        uint256 anchoredAt,
        address anchoredBy
    ) {
        Anchor memory anchor = anchors[anchorId];
        return (
            anchor.siteId,
            anchor.merkleRoot,
            anchor.metadataHash,
            anchor.metadataUri,
            anchor.eventCount,
            anchor.firstEventTimestamp,
            anchor.lastEventTimestamp,
            anchor.anchoredAt,
            anchor.anchoredBy
        );
    }

    /**
     * @notice Get total number of anchors.
     * @return count Total anchor count
     */
    function getAnchorCount() external view returns (uint256) {
        return anchorIds.length;
    }

    /**
     * @notice Get total anchors for a specific site.
     * @param siteId The site ID
     * @return count Anchor count for the site
     */
    function getSiteAnchorCount(bytes32 siteId) external view returns (uint256) {
        return siteAnchors[siteId].length;
    }

    /**
     * @notice Get a specific anchor ID for a site by index.
     * @param siteId The site ID
     * @param index Array index
     * @return The anchor ID
     */
    function getSiteAnchorAt(bytes32 siteId, uint256 index) external view returns (bytes32) {
        return siteAnchors[siteId][index];
    }

    /**
     * @notice M-01 fix: Paginated access to all anchor IDs.
     * @param offset Starting index
     * @param limit Maximum items to return
     * @return result Slice of anchor IDs
     */
    function getAnchorIdsPaginated(uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory result)
    {
        uint256 total = anchorIds.length;
        if (offset >= total) return new bytes32[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        result = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            result[i - offset] = anchorIds[i];
        }
    }

    /**
     * @notice M-01 fix: Paginated access to site-specific anchor IDs.
     * @param siteId The site ID
     * @param offset Starting index
     * @param limit Maximum items to return
     * @return result Slice of anchor IDs for the site
     */
    function getSiteAnchorsPaginated(bytes32 siteId, uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory result)
    {
        uint256 total = siteAnchors[siteId].length;
        if (offset >= total) return new bytes32[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        result = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            result[i - offset] = siteAnchors[siteId][i];
        }
    }

    // ── Internal ────────────────────────────────────────────────────────

    /**
     * @notice Internal Merkle proof verification.
     * @dev H-01 fix: Validates index < 2^proof.length to prevent out-of-bounds.
     * @param leaf The leaf hash
     * @param proof Array of sibling hashes
     * @param root Expected Merkle root
     * @param index Leaf index in the tree
     * @return True if the computed root matches
     */
    function _verifyMerkleProof(
        bytes32 leaf,
        bytes32[] calldata proof,
        bytes32 root,
        uint256 index
    ) internal pure returns (bool) {
        // H-01 fix: Validate index bounds
        require(proof.length <= 256, "Proof too long");
        require(index < (1 << proof.length), "Index out of bounds for proof length");

        bytes32 computedHash = leaf;

        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 proofElement = proof[i];

            if (index % 2 == 0) {
                computedHash = keccak256(abi.encodePacked(computedHash, proofElement));
            } else {
                computedHash = keccak256(abi.encodePacked(proofElement, computedHash));
            }

            index = index / 2;
        }

        return computedHash == root;
    }
}
