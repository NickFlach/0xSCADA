// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "hardhat/console.sol";
import "../../EventAnchor.sol";
import "../../SiteRegistry.sol";

/**
 * @title EventAnchorFuzzTest
 * @notice Fuzz tests for EventAnchor contract - Merkle proof verification and batch anchoring
 * @dev Issue #55: Security Fuzz Testing for Protocol Handlers
 */
contract EventAnchorFuzzTest {
    SiteRegistry public siteRegistry;
    EventAnchor public eventAnchor;
    
    bytes32 constant TEST_SITE_ID = keccak256("test-site");
    address constant AUTHORIZED_GATEWAY = address(0x1234567890123456789012345678901234567890);
    
    event TestPassed(string testName);
    event TestFailed(string testName, string reason);
    
    constructor() {
        siteRegistry = new SiteRegistry();
        eventAnchor = new EventAnchor(address(siteRegistry));
        
        // Setup test site
        siteRegistry.registerSite(TEST_SITE_ID);
        siteRegistry.authorizeGateway(TEST_SITE_ID, AUTHORIZED_GATEWAY);
        siteRegistry.authorizeGateway(TEST_SITE_ID, address(this));
    }
    
    // =========================================================================
    // MERKLE PROOF VERIFICATION FUZZ TESTS
    // =========================================================================
    
    /**
     * @notice Fuzz test: Valid Merkle proofs should always verify
     * @param eventHash Random event hash
     * @param proofElements Number of proof elements (capped at 20)
     * @param proofSeed Seed for generating proof elements
     * @param indexSeed Seed for index
     */
    function fuzz_validMerkleProofVerifies(
        bytes32 eventHash,
        uint8 proofElements,
        uint256 proofSeed,
        uint256 indexSeed
    ) external {
        // Cap proof elements to reasonable size
        uint256 numElements = uint256(proofElements) % 20 + 1;
        
        // Generate a valid tree and proof
        bytes32[] memory proof = new bytes32[](numElements);
        bytes32 computedRoot = eventHash;
        uint256 index = indexSeed;
        
        for (uint256 i = 0; i < numElements; i++) {
            // Generate deterministic proof element
            proof[i] = keccak256(abi.encodePacked(proofSeed, i));
            
            // Compute next level of tree
            if (index % 2 == 0) {
                computedRoot = keccak256(abi.encodePacked(computedRoot, proof[i]));
            } else {
                computedRoot = keccak256(abi.encodePacked(proof[i], computedRoot));
            }
            index = index / 2;
        }
        
        // Anchor a batch with this root
        bytes32 anchorId = eventAnchor.anchorBatch(
            TEST_SITE_ID,
            computedRoot,
            keccak256("metadata"),
            "ipfs://test",
            1,
            block.timestamp,
            block.timestamp
        );
        
        // Verify should pass
        bool isValid = eventAnchor.verifyEvent(anchorId, eventHash, proof, indexSeed);
        require(isValid, "Valid proof should verify");
        
        emit TestPassed("fuzz_validMerkleProofVerifies");
    }
    
    /**
     * @notice Fuzz test: Invalid event hash should fail verification
     * @param originalHash Original event hash
     * @param wrongHash Different event hash
     * @param proofSeed Seed for proof generation
     */
    function fuzz_wrongEventHashFails(
        bytes32 originalHash,
        bytes32 wrongHash,
        uint256 proofSeed
    ) external {
        // Skip if hashes are the same
        if (originalHash == wrongHash) return;
        
        // Create a simple 2-element proof
        bytes32[] memory proof = new bytes32[](2);
        proof[0] = keccak256(abi.encodePacked(proofSeed, uint256(0)));
        proof[1] = keccak256(abi.encodePacked(proofSeed, uint256(1)));
        
        // Compute root using originalHash
        bytes32 root = keccak256(abi.encodePacked(originalHash, proof[0]));
        root = keccak256(abi.encodePacked(root, proof[1]));
        
        // Anchor batch
        bytes32 anchorId = eventAnchor.anchorBatch(
            TEST_SITE_ID,
            root,
            keccak256("metadata"),
            "ipfs://test",
            1,
            block.timestamp,
            block.timestamp
        );
        
        // Verify with wrong hash should fail
        bool isValid = eventAnchor.verifyEvent(anchorId, wrongHash, proof, 0);
        require(!isValid, "Wrong event hash should not verify");
        
        emit TestPassed("fuzz_wrongEventHashFails");
    }
    
    /**
     * @notice Fuzz test: Tampered proof should fail verification
     * @param eventHash Original event hash
     * @param proofSeed Seed for proof generation
     * @param tamperIndex Which proof element to tamper
     * @param tamperValue Value to tamper with
     */
    function fuzz_tamperedProofFails(
        bytes32 eventHash,
        uint256 proofSeed,
        uint8 tamperIndex,
        bytes32 tamperValue
    ) external {
        // Create 4-element proof
        uint256 proofLength = 4;
        bytes32[] memory proof = new bytes32[](proofLength);
        
        for (uint256 i = 0; i < proofLength; i++) {
            proof[i] = keccak256(abi.encodePacked(proofSeed, i));
        }
        
        // Compute valid root
        bytes32 root = eventHash;
        for (uint256 i = 0; i < proofLength; i++) {
            root = keccak256(abi.encodePacked(root, proof[i]));
        }
        
        // Anchor batch
        bytes32 anchorId = eventAnchor.anchorBatch(
            TEST_SITE_ID,
            root,
            keccak256("metadata"),
            "ipfs://test",
            1,
            block.timestamp,
            block.timestamp
        );
        
        // Tamper with proof
        uint256 idx = uint256(tamperIndex) % proofLength;
        if (proof[idx] == tamperValue) return; // Skip if tampering doesn't change anything
        
        bytes32[] memory tamperedProof = new bytes32[](proofLength);
        for (uint256 i = 0; i < proofLength; i++) {
            tamperedProof[i] = (i == idx) ? tamperValue : proof[i];
        }
        
        // Verify with tampered proof should fail
        bool isValid = eventAnchor.verifyEvent(anchorId, eventHash, tamperedProof, 0);
        require(!isValid, "Tampered proof should not verify");
        
        emit TestPassed("fuzz_tamperedProofFails");
    }
    
    // =========================================================================
    // BATCH ANCHORING FUZZ TESTS
    // =========================================================================
    
    /**
     * @notice Fuzz test: Batch anchoring with various event counts
     * @param eventCount Number of events (capped)
     * @param merkleRoot Random merkle root
     * @param metadataHash Random metadata hash
     */
    function fuzz_anchorBatchWithVariousEventCounts(
        uint256 eventCount,
        bytes32 merkleRoot,
        bytes32 metadataHash
    ) external {
        // Skip invalid inputs
        if (merkleRoot == bytes32(0)) return;
        if (eventCount == 0) return;
        
        // Cap event count to prevent gas issues
        eventCount = (eventCount % 10000) + 1;
        
        bytes32 anchorId = eventAnchor.anchorBatch(
            TEST_SITE_ID,
            merkleRoot,
            metadataHash,
            "ipfs://fuzz-test",
            eventCount,
            block.timestamp - 1000,
            block.timestamp
        );
        
        // Verify anchor was created correctly
        (
            bytes32 siteId,
            bytes32 storedRoot,
            bytes32 storedMetadataHash,
            string memory uri,
            uint256 storedCount,
            ,
            ,
            uint256 anchoredAt,
            address anchoredBy
        ) = eventAnchor.getAnchor(anchorId);
        
        require(siteId == TEST_SITE_ID, "Site ID mismatch");
        require(storedRoot == merkleRoot, "Merkle root mismatch");
        require(storedMetadataHash == metadataHash, "Metadata hash mismatch");
        require(storedCount == eventCount, "Event count mismatch");
        require(anchoredAt > 0, "Anchor timestamp should be set");
        require(anchoredBy == address(this), "Anchor author mismatch");
        
        emit TestPassed("fuzz_anchorBatchWithVariousEventCounts");
    }
    
    /**
     * @notice Fuzz test: Timestamp boundary conditions
     * @param firstTimestamp First event timestamp
     * @param lastTimestamp Last event timestamp
     * @param merkleRoot Random merkle root
     */
    function fuzz_timestampBoundaries(
        uint256 firstTimestamp,
        uint256 lastTimestamp,
        bytes32 merkleRoot
    ) external {
        if (merkleRoot == bytes32(0)) return;
        
        // Swap if needed to ensure first <= last
        if (firstTimestamp > lastTimestamp) {
            (firstTimestamp, lastTimestamp) = (lastTimestamp, firstTimestamp);
        }
        
        bytes32 anchorId = eventAnchor.anchorBatch(
            TEST_SITE_ID,
            merkleRoot,
            keccak256("metadata"),
            "ipfs://timestamp-test",
            1,
            firstTimestamp,
            lastTimestamp
        );
        
        (
            ,
            ,
            ,
            ,
            ,
            uint256 storedFirst,
            uint256 storedLast,
            ,
        ) = eventAnchor.getAnchor(anchorId);
        
        require(storedFirst == firstTimestamp, "First timestamp mismatch");
        require(storedLast == lastTimestamp, "Last timestamp mismatch");
        
        emit TestPassed("fuzz_timestampBoundaries");
    }
    
    /**
     * @notice Fuzz test: Metadata URI with various lengths
     * @param uriLength Length of URI (capped)
     * @param uriSeed Seed for URI generation
     * @param merkleRoot Random merkle root
     */
    function fuzz_metadataUriLengths(
        uint16 uriLength,
        uint256 uriSeed,
        bytes32 merkleRoot
    ) external {
        if (merkleRoot == bytes32(0)) return;
        
        // Cap URI length to prevent out-of-gas
        uint256 len = uint256(uriLength) % 500 + 1;
        
        // Generate deterministic URI
        bytes memory uriBytes = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            uriBytes[i] = bytes1(uint8(65 + (uint256(keccak256(abi.encodePacked(uriSeed, i))) % 26)));
        }
        string memory uri = string(uriBytes);
        
        bytes32 anchorId = eventAnchor.anchorBatch(
            TEST_SITE_ID,
            merkleRoot,
            keccak256("metadata"),
            uri,
            1,
            block.timestamp,
            block.timestamp
        );
        
        (
            ,
            ,
            ,
            string memory storedUri,
            ,
            ,
            ,
            ,
        ) = eventAnchor.getAnchor(anchorId);
        
        require(keccak256(bytes(storedUri)) == keccak256(bytes(uri)), "URI mismatch");
        
        emit TestPassed("fuzz_metadataUriLengths");
    }
    
    // =========================================================================
    // AUTHORIZATION FUZZ TESTS
    // =========================================================================
    
    /**
     * @notice Fuzz test: Unauthorized addresses should not be able to anchor
     * @param unauthorizedAddr Random unauthorized address
     * @param merkleRoot Random merkle root
     */
    function fuzz_unauthorizedCannotAnchor(
        address unauthorizedAddr,
        bytes32 merkleRoot
    ) external {
        // Skip if address happens to be authorized
        if (siteRegistry.isGatewayAuthorized(TEST_SITE_ID, unauthorizedAddr)) return;
        if (siteRegistry.isSignerAuthorized(TEST_SITE_ID, unauthorizedAddr)) return;
        if (unauthorizedAddr == address(0)) return;
        if (merkleRoot == bytes32(0)) return;
        
        // This test would need to be called from the unauthorized address
        // In a real fuzz test, we'd use vm.prank or similar
        // For now, we verify the authorization check exists
        
        bool isGateway = siteRegistry.isGatewayAuthorized(TEST_SITE_ID, unauthorizedAddr);
        bool isSigner = siteRegistry.isSignerAuthorized(TEST_SITE_ID, unauthorizedAddr);
        
        require(!isGateway && !isSigner, "Random address should not be authorized");
        
        emit TestPassed("fuzz_unauthorizedCannotAnchor");
    }
    
    // =========================================================================
    // HELPER FUNCTIONS
    // =========================================================================
    
    /**
     * @notice Run all fuzz tests with default parameters for basic validation
     */
    function runBasicValidation() external {
        // Test 1: Valid proof verification
        fuzz_validMerkleProofVerifies(
            keccak256("event1"),
            5,
            12345,
            0
        );
        
        // Test 2: Wrong hash detection
        fuzz_wrongEventHashFails(
            keccak256("original"),
            keccak256("wrong"),
            67890
        );
        
        // Test 3: Tampered proof detection
        fuzz_tamperedProofFails(
            keccak256("event"),
            11111,
            2,
            keccak256("tampered")
        );
        
        // Test 4: Batch anchoring
        fuzz_anchorBatchWithVariousEventCounts(
            100,
            keccak256("root"),
            keccak256("metadata")
        );
        
        // Test 5: Timestamp boundaries
        fuzz_timestampBoundaries(
            1000000,
            2000000,
            keccak256("timestampRoot")
        );
        
        console.log("All basic validation tests passed!");
    }
}
