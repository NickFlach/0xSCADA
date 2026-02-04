// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./EventAnchor.sol";

/**
 * @title RealityAnchor
 * @notice VERITY Architecture: Artifact Attestation Layer
 * 
 * Extends EventAnchor with artifact attestation capabilities for the
 * Reality Artifact Architecture. Stores cryptographic attestations of
 * LFS artifacts (traces, proofs, twins, decisions) on-chain.
 * 
 * See: docs/REALITY_ARTIFACT_ARCHITECTURE.md
 * 
 * Design Principles:
 * - Immutable attestations (artifacts are truth)
 * - Merkle proof verification for batched artifacts
 * - Minimal gas footprint for high-frequency attestations
 * - Site-scoped authorization via inherited SiteRegistry
 */
contract RealityAnchor is EventAnchor {
    
    // ============ Constants ============
    
    /// @notice Artifact type: Kernel/eBPF traces, sensor captures
    uint8 public constant ARTIFACT_TYPE_TRACE = 1;
    
    /// @notice Artifact type: ZK proofs, verification results
    uint8 public constant ARTIFACT_TYPE_PROOF = 2;
    
    /// @notice Artifact type: Digital twin snapshots/checkpoints
    uint8 public constant ARTIFACT_TYPE_TWIN = 3;
    
    /// @notice Artifact type: Agent decision records
    uint8 public constant ARTIFACT_TYPE_DECISION = 4;
    
    // ============ Structs ============
    
    /**
     * @notice Attestation record for a reality artifact
     * @param contentHash SHA-256 hash of the LFS artifact content
     * @param merkleRoot Root of Merkle tree if artifact is part of a batch (0 if standalone)
     * @param artifactType Type of artifact (1=trace, 2=proof, 3=twin, 4=decision)
     * @param timestamp Block timestamp when attestation was recorded
     * @param attester Address that created this attestation
     * @param siteId Site this artifact belongs to (for authorization)
     * @param metadataUri Optional URI pointing to artifact metadata (IPFS, etc.)
     */
    struct ArtifactAttestation {
        bytes32 contentHash;
        bytes32 merkleRoot;
        uint8 artifactType;
        uint64 timestamp;
        address attester;
        bytes32 siteId;
        string metadataUri;
    }
    
    /**
     * @notice Batch attestation for multiple artifacts
     * @param merkleRoot Root of the artifact content hashes
     * @param artifactType Type of all artifacts in batch (must be uniform)
     * @param artifactCount Number of artifacts in the batch
     * @param timestamp Block timestamp of batch attestation
     * @param attester Address that created this batch
     * @param siteId Site this batch belongs to
     */
    struct ArtifactBatch {
        bytes32 merkleRoot;
        uint8 artifactType;
        uint32 artifactCount;
        uint64 timestamp;
        address attester;
        bytes32 siteId;
    }
    
    // ============ State ============
    
    /// @notice Attestation ID => ArtifactAttestation
    mapping(bytes32 => ArtifactAttestation) public attestations;
    
    /// @notice Content hash => Attestation ID (for lookup by content)
    mapping(bytes32 => bytes32) public contentToAttestation;
    
    /// @notice Batch ID => ArtifactBatch
    mapping(bytes32 => ArtifactBatch) public batches;
    
    /// @notice Site ID => list of attestation IDs
    mapping(bytes32 => bytes32[]) public siteAttestations;
    
    /// @notice Site ID => list of batch IDs
    mapping(bytes32 => bytes32[]) public siteBatches;
    
    /// @notice All attestation IDs for enumeration
    bytes32[] public attestationIds;
    
    /// @notice All batch IDs for enumeration
    bytes32[] public batchIds;
    
    // ============ Events ============
    
    event ArtifactAttested(
        bytes32 indexed attestationId,
        bytes32 indexed siteId,
        bytes32 indexed contentHash,
        uint8 artifactType,
        address attester,
        uint64 timestamp
    );
    
    event ArtifactBatchAttested(
        bytes32 indexed batchId,
        bytes32 indexed siteId,
        bytes32 merkleRoot,
        uint8 artifactType,
        uint32 artifactCount,
        address attester,
        uint64 timestamp
    );
    
    // ============ Constructor ============
    
    constructor(address _siteRegistry) EventAnchor(_siteRegistry) {}
    
    // ============ Core Functions ============
    
    /**
     * @notice Attest a single artifact
     * @param siteId Site this artifact belongs to
     * @param contentHash SHA-256 hash of the artifact content (LFS object hash)
     * @param artifactType Type of artifact (1-4)
     * @param metadataUri Optional URI for artifact metadata
     * @return attestationId Unique ID for this attestation
     * 
     * Gas Cost (estimated):
     * - New attestation: ~65,000 gas
     * - With metadata URI (32 chars): ~75,000 gas
     */
    function attestArtifact(
        bytes32 siteId,
        bytes32 contentHash,
        uint8 artifactType,
        string calldata metadataUri
    ) external returns (bytes32 attestationId) {
        // Authorization check
        require(
            siteRegistry.isGatewayAuthorized(siteId, msg.sender) ||
            siteRegistry.isSignerAuthorized(siteId, msg.sender),
            "RealityAnchor: not authorized"
        );
        
        // Validation
        require(contentHash != bytes32(0), "RealityAnchor: invalid content hash");
        require(
            artifactType >= ARTIFACT_TYPE_TRACE && artifactType <= ARTIFACT_TYPE_DECISION,
            "RealityAnchor: invalid artifact type"
        );
        require(
            contentToAttestation[contentHash] == bytes32(0),
            "RealityAnchor: artifact already attested"
        );
        
        // Generate attestation ID
        attestationId = keccak256(abi.encodePacked(
            siteId,
            contentHash,
            artifactType,
            block.timestamp,
            msg.sender
        ));
        
        // Store attestation
        attestations[attestationId] = ArtifactAttestation({
            contentHash: contentHash,
            merkleRoot: bytes32(0),  // Standalone artifact
            artifactType: artifactType,
            timestamp: uint64(block.timestamp),
            attester: msg.sender,
            siteId: siteId,
            metadataUri: metadataUri
        });
        
        // Index mappings
        contentToAttestation[contentHash] = attestationId;
        attestationIds.push(attestationId);
        siteAttestations[siteId].push(attestationId);
        
        emit ArtifactAttested(
            attestationId,
            siteId,
            contentHash,
            artifactType,
            msg.sender,
            uint64(block.timestamp)
        );
        
        return attestationId;
    }
    
    /**
     * @notice Attest a batch of artifacts via Merkle root
     * @param siteId Site this batch belongs to
     * @param merkleRoot Root of Merkle tree of artifact content hashes
     * @param artifactType Type of all artifacts in batch
     * @param artifactCount Number of artifacts in the batch
     * @return batchId Unique ID for this batch
     * 
     * Gas Cost (estimated):
     * - New batch: ~55,000 gas (more efficient than individual attestations)
     */
    function attestArtifactBatch(
        bytes32 siteId,
        bytes32 merkleRoot,
        uint8 artifactType,
        uint32 artifactCount
    ) external returns (bytes32 batchId) {
        // Authorization check
        require(
            siteRegistry.isGatewayAuthorized(siteId, msg.sender) ||
            siteRegistry.isSignerAuthorized(siteId, msg.sender),
            "RealityAnchor: not authorized"
        );
        
        // Validation
        require(merkleRoot != bytes32(0), "RealityAnchor: invalid merkle root");
        require(
            artifactType >= ARTIFACT_TYPE_TRACE && artifactType <= ARTIFACT_TYPE_DECISION,
            "RealityAnchor: invalid artifact type"
        );
        require(artifactCount > 0, "RealityAnchor: empty batch");
        
        // Generate batch ID
        batchId = keccak256(abi.encodePacked(
            siteId,
            merkleRoot,
            artifactType,
            block.timestamp,
            msg.sender
        ));
        
        require(batches[batchId].timestamp == 0, "RealityAnchor: batch already exists");
        
        // Store batch
        batches[batchId] = ArtifactBatch({
            merkleRoot: merkleRoot,
            artifactType: artifactType,
            artifactCount: artifactCount,
            timestamp: uint64(block.timestamp),
            attester: msg.sender,
            siteId: siteId
        });
        
        // Index
        batchIds.push(batchId);
        siteBatches[siteId].push(batchId);
        
        emit ArtifactBatchAttested(
            batchId,
            siteId,
            merkleRoot,
            artifactType,
            artifactCount,
            msg.sender,
            uint64(block.timestamp)
        );
        
        return batchId;
    }
    
    // ============ Verification Functions ============
    
    /**
     * @notice Verify a single artifact was attested
     * @param contentHash Hash of the artifact content
     * @return valid True if artifact has been attested
     * @return attestedAt Timestamp of attestation (0 if not attested)
     * @return attester Address that attested (address(0) if not attested)
     */
    function verifyArtifact(bytes32 contentHash) 
        external 
        view 
        returns (bool valid, uint64 attestedAt, address attester) 
    {
        bytes32 attestationId = contentToAttestation[contentHash];
        if (attestationId == bytes32(0)) {
            return (false, 0, address(0));
        }
        
        ArtifactAttestation memory att = attestations[attestationId];
        return (true, att.timestamp, att.attester);
    }
    
    /**
     * @notice Verify an artifact is included in an attested batch via Merkle proof
     * @param batchId The batch to verify against
     * @param contentHash Hash of the artifact content (leaf)
     * @param merkleProof Array of sibling hashes for proof
     * @param index Index of the artifact in the batch (for proof ordering)
     * @return valid True if proof verifies
     * @return attestedAt Batch attestation timestamp
     * 
     * Gas Cost (estimated):
     * - Verification: ~2,500 + (proof.length * 500) gas
     */
    function verifyArtifactInBatch(
        bytes32 batchId,
        bytes32 contentHash,
        bytes32[] calldata merkleProof,
        uint256 index
    ) external view returns (bool valid, uint64 attestedAt) {
        ArtifactBatch memory batch = batches[batchId];
        
        if (batch.timestamp == 0) {
            return (false, 0);
        }
        
        bool proofValid = _verifyMerkleProof(
            contentHash,
            merkleProof,
            batch.merkleRoot,
            index
        );
        
        return (proofValid, batch.timestamp);
    }
    
    /**
     * @notice Check if content hash exists in any attestation (single or batch)
     * @dev For batch verification, caller should use verifyArtifactInBatch with proof
     * @param contentHash Hash to check
     * @return exists True if attested as standalone artifact
     * @return attestationId The attestation ID if exists
     */
    function isAttested(bytes32 contentHash) 
        external 
        view 
        returns (bool exists, bytes32 attestationId) 
    {
        attestationId = contentToAttestation[contentHash];
        exists = attestationId != bytes32(0);
    }
    
    // ============ View Functions ============
    
    /**
     * @notice Get full attestation details
     */
    function getAttestation(bytes32 attestationId) 
        external 
        view 
        returns (
            bytes32 contentHash,
            bytes32 merkleRoot,
            uint8 artifactType,
            uint64 timestamp,
            address attester,
            bytes32 siteId,
            string memory metadataUri
        ) 
    {
        ArtifactAttestation memory att = attestations[attestationId];
        return (
            att.contentHash,
            att.merkleRoot,
            att.artifactType,
            att.timestamp,
            att.attester,
            att.siteId,
            att.metadataUri
        );
    }
    
    /**
     * @notice Get batch details
     */
    function getBatch(bytes32 batchId) 
        external 
        view 
        returns (
            bytes32 merkleRoot,
            uint8 artifactType,
            uint32 artifactCount,
            uint64 timestamp,
            address attester,
            bytes32 siteId
        ) 
    {
        ArtifactBatch memory batch = batches[batchId];
        return (
            batch.merkleRoot,
            batch.artifactType,
            batch.artifactCount,
            batch.timestamp,
            batch.attester,
            batch.siteId
        );
    }
    
    /**
     * @notice Get total attestation count
     */
    function getAttestationCount() external view returns (uint256) {
        return attestationIds.length;
    }
    
    /**
     * @notice Get total batch count
     */
    function getBatchCount() external view returns (uint256) {
        return batchIds.length;
    }
    
    /**
     * @notice Get attestation count for a site
     */
    function getSiteAttestationCount(bytes32 siteId) external view returns (uint256) {
        return siteAttestations[siteId].length;
    }
    
    /**
     * @notice Get batch count for a site
     */
    function getSiteBatchCount(bytes32 siteId) external view returns (uint256) {
        return siteBatches[siteId].length;
    }
    
    /**
     * @notice Get attestation ID at index for a site
     */
    function getSiteAttestationAt(bytes32 siteId, uint256 index) 
        external 
        view 
        returns (bytes32) 
    {
        return siteAttestations[siteId][index];
    }
    
    /**
     * @notice Get batch ID at index for a site
     */
    function getSiteBatchAt(bytes32 siteId, uint256 index) 
        external 
        view 
        returns (bytes32) 
    {
        return siteBatches[siteId][index];
    }
    
    /**
     * @notice Get artifact type name for display
     */
    function getArtifactTypeName(uint8 artifactType) 
        external 
        pure 
        returns (string memory) 
    {
        if (artifactType == ARTIFACT_TYPE_TRACE) return "trace";
        if (artifactType == ARTIFACT_TYPE_PROOF) return "proof";
        if (artifactType == ARTIFACT_TYPE_TWIN) return "twin";
        if (artifactType == ARTIFACT_TYPE_DECISION) return "decision";
        return "unknown";
    }
}
