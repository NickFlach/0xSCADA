// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./SiteRegistry.sol";

/**
 * @title EventAnchor
 * @notice PRD Section 7.2: Event Anchor Contract
 * 
 * Stores:
 * - Merkle roots
 * - Metadata pointer (IPFS / content hash)
 * - Timestamp
 * 
 * Only authorized gateways or signers can anchor events.
 */
contract EventAnchor {
    
    SiteRegistry public immutable siteRegistry;
    
    struct Anchor {
        bytes32 siteId;
        bytes32 merkleRoot;
        bytes32 metadataHash;      // Hash of batch metadata
        string metadataUri;         // IPFS URI or other storage pointer
        uint256 eventCount;
        uint256 firstEventTimestamp;
        uint256 lastEventTimestamp;
        uint256 anchoredAt;
        address anchoredBy;
    }
    
    // Anchor ID => Anchor
    mapping(bytes32 => Anchor) public anchors;
    
    // Site ID => list of anchor IDs
    mapping(bytes32 => bytes32[]) public siteAnchors;
    
    // Track all anchor IDs
    bytes32[] public anchorIds;
    
    // Events
    event BatchAnchored(
        bytes32 indexed anchorId,
        bytes32 indexed siteId,
        bytes32 merkleRoot,
        uint256 eventCount,
        uint256 timestamp,
        address indexed anchoredBy
    );
    
    constructor(address _siteRegistry) {
        siteRegistry = SiteRegistry(_siteRegistry);
    }
    
    /**
     * @notice Anchor a batch of events
     * @param siteId The site this batch belongs to
     * @param merkleRoot The Merkle root of the event hashes
     * @param metadataHash Hash of the batch metadata
     * @param metadataUri URI pointing to full batch data (IPFS, etc.)
     * @param eventCount Number of events in the batch
     * @param firstEventTimestamp Timestamp of first event in batch
     * @param lastEventTimestamp Timestamp of last event in batch
     */
    function anchorBatch(
        bytes32 siteId,
        bytes32 merkleRoot,
        bytes32 metadataHash,
        string calldata metadataUri,
        uint256 eventCount,
        uint256 firstEventTimestamp,
        uint256 lastEventTimestamp
    ) external returns (bytes32 anchorId) {
        // Verify caller is authorized
        require(
            siteRegistry.isGatewayAuthorized(siteId, msg.sender) ||
            siteRegistry.isSignerAuthorized(siteId, msg.sender),
            "Not authorized to anchor for this site"
        );
        
        require(merkleRoot != bytes32(0), "Invalid Merkle root");
        require(eventCount > 0, "Event count must be positive");
        
        // Generate unique anchor ID
        anchorId = keccak256(abi.encodePacked(
            siteId,
            merkleRoot,
            block.timestamp,
            msg.sender
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
    
    /**
     * @notice Verify an event is included in an anchored batch
     * @param anchorId The anchor to verify against
     * @param eventHash The hash of the event
     * @param proof The Merkle proof
     * @param index The index of the event in the batch
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
     * @notice Internal Merkle proof verification
     */
    function _verifyMerkleProof(
        bytes32 leaf,
        bytes32[] calldata proof,
        bytes32 root,
        uint256 index
    ) internal pure returns (bool) {
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
    
    // View functions
    
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
    
    function getAnchorCount() external view returns (uint256) {
        return anchorIds.length;
    }
    
    function getSiteAnchorCount(bytes32 siteId) external view returns (uint256) {
        return siteAnchors[siteId].length;
    }
    
    function getSiteAnchorAt(bytes32 siteId, uint256 index) external view returns (bytes32) {
        return siteAnchors[siteId][index];
    }
}
