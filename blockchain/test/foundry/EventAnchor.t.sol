// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "./KernelSimulator.sol";

/**
 * @title EventAnchor Tests
 * @notice Foundry tests for the EventAnchor contract with kernel simulation
 * @dev Issue #158 — Foundry tests with kernel simulation
 */

/// @dev Minimal EventAnchor interface for testing
/// In production, import the actual contract
contract EventAnchor {
    struct Batch {
        bytes32 merkleRoot;
        uint256 eventCount;
        address submitter;
        uint256 blockNumber;
        uint256 timestamp;
        bytes metadata;
    }

    address public owner;
    uint256 public batchCount;
    uint256 public totalEventsAnchored;
    bytes32 public latestMerkleRoot;
    uint256 public minBatchSize;
    uint256 public maxBatchSize;

    mapping(uint256 => Batch) public batches;

    event BatchSubmitted(
        uint256 indexed batchId,
        bytes32 indexed merkleRoot,
        uint256 eventCount,
        address submitter
    );

    event ProofVerified(bytes32 indexed root, bytes32 indexed leaf, bool valid);

    error InvalidBatchSize(uint256 size);
    error InvalidMerkleRoot();
    error Unauthorized();

    constructor(address _owner, uint256 _minBatchSize, uint256 _maxBatchSize) {
        owner = _owner;
        minBatchSize = _minBatchSize;
        maxBatchSize = _maxBatchSize;
    }

    function submitBatch(
        bytes32 _merkleRoot,
        uint256 _eventCount,
        bytes calldata _metadata
    ) external returns (uint256) {
        if (_merkleRoot == bytes32(0)) revert InvalidMerkleRoot();
        if (_eventCount < minBatchSize || _eventCount > maxBatchSize)
            revert InvalidBatchSize(_eventCount);

        uint256 batchId = batchCount++;
        batches[batchId] = Batch({
            merkleRoot: _merkleRoot,
            eventCount: _eventCount,
            submitter: msg.sender,
            blockNumber: block.number,
            timestamp: block.timestamp,
            metadata: _metadata
        });

        totalEventsAnchored += _eventCount;
        latestMerkleRoot = _merkleRoot;

        emit BatchSubmitted(batchId, _merkleRoot, _eventCount, msg.sender);
        return batchId;
    }

    function getBatch(uint256 _batchId) external view returns (Batch memory) {
        return batches[_batchId];
    }

    function verifyProof(
        bytes32 _root,
        bytes32 _leaf,
        bytes32[] calldata _proof,
        uint256 _index
    ) external pure returns (bool) {
        bytes32 computedHash = _leaf;

        for (uint256 i = 0; i < _proof.length; i++) {
            if ((_index >> i) & 1 == 1) {
                computedHash = keccak256(abi.encodePacked(_proof[i], computedHash));
            } else {
                computedHash = keccak256(abi.encodePacked(computedHash, _proof[i]));
            }
        }

        return computedHash == _root;
    }
}

contract EventAnchorTest is Test {
    EventAnchor public anchor;
    KernelSimulator public kernel;
    address public owner;
    address public submitter;

    function setUp() public {
        owner = makeAddr("owner");
        submitter = makeAddr("submitter");
        anchor = new EventAnchor(owner, 1, 10000);
        kernel = new KernelSimulator();
    }

    // =========================================================================
    // DEPLOYMENT
    // =========================================================================

    function test_deployment() public view {
        assertEq(anchor.owner(), owner);
        assertEq(anchor.batchCount(), 0);
        assertEq(anchor.totalEventsAnchored(), 0);
        assertEq(anchor.minBatchSize(), 1);
        assertEq(anchor.maxBatchSize(), 10000);
    }

    // =========================================================================
    // BATCH SUBMISSION
    // =========================================================================

    function test_submitBatch() public {
        bytes32 root = keccak256("test-root");

        vm.prank(submitter);
        uint256 batchId = anchor.submitBatch(root, 100, "test-metadata");

        assertEq(batchId, 0);
        assertEq(anchor.batchCount(), 1);
        assertEq(anchor.totalEventsAnchored(), 100);
        assertEq(anchor.latestMerkleRoot(), root);

        EventAnchor.Batch memory batch = anchor.getBatch(0);
        assertEq(batch.merkleRoot, root);
        assertEq(batch.eventCount, 100);
        assertEq(batch.submitter, submitter);
    }

    function test_submitBatch_emitsEvent() public {
        bytes32 root = keccak256("test-root");

        vm.expectEmit(true, true, false, true);
        emit EventAnchor.BatchSubmitted(0, root, 50, submitter);

        vm.prank(submitter);
        anchor.submitBatch(root, 50, "");
    }

    function test_submitBatch_multipleBatches() public {
        vm.startPrank(submitter);
        anchor.submitBatch(keccak256("root-1"), 100, "");
        anchor.submitBatch(keccak256("root-2"), 200, "");
        anchor.submitBatch(keccak256("root-3"), 300, "");
        vm.stopPrank();

        assertEq(anchor.batchCount(), 3);
        assertEq(anchor.totalEventsAnchored(), 600);
        assertEq(anchor.latestMerkleRoot(), keccak256("root-3"));
    }

    function test_submitBatch_revert_zeroRoot() public {
        vm.expectRevert(EventAnchor.InvalidMerkleRoot.selector);
        anchor.submitBatch(bytes32(0), 100, "");
    }

    function test_submitBatch_revert_tooSmall() public {
        vm.expectRevert(abi.encodeWithSelector(EventAnchor.InvalidBatchSize.selector, 0));
        anchor.submitBatch(keccak256("root"), 0, "");
    }

    function test_submitBatch_revert_tooLarge() public {
        vm.expectRevert(abi.encodeWithSelector(EventAnchor.InvalidBatchSize.selector, 10001));
        anchor.submitBatch(keccak256("root"), 10001, "");
    }

    // =========================================================================
    // FUZZ TESTS
    // =========================================================================

    function testFuzz_submitBatch(bytes32 root, uint256 count) public {
        vm.assume(root != bytes32(0));
        count = bound(count, 1, 10000);

        anchor.submitBatch(root, count, "");
        assertEq(anchor.totalEventsAnchored(), count);
    }

    // =========================================================================
    // PROOF VERIFICATION
    // =========================================================================

    function test_verifyProof_singleLeaf() public view {
        bytes32 leaf = keccak256("event-1");
        bytes32[] memory proof = new bytes32[](0);

        // Single leaf is its own root
        bool valid = anchor.verifyProof(leaf, leaf, proof, 0);
        assertTrue(valid);
    }

    function test_verifyProof_twoLeaves() public view {
        bytes32 leaf0 = keccak256("event-0");
        bytes32 leaf1 = keccak256("event-1");
        bytes32 root = keccak256(abi.encodePacked(leaf0, leaf1));

        bytes32[] memory proof = new bytes32[](1);

        // Prove leaf0 (index 0, sibling is leaf1)
        proof[0] = leaf1;
        assertTrue(anchor.verifyProof(root, leaf0, proof, 0));

        // Prove leaf1 (index 1, sibling is leaf0)
        proof[0] = leaf0;
        assertTrue(anchor.verifyProof(root, leaf1, proof, 1));
    }

    function test_verifyProof_invalid() public view {
        bytes32 leaf = keccak256("event-1");
        bytes32 fakeRoot = keccak256("fake");
        bytes32[] memory proof = new bytes32[](0);

        bool valid = anchor.verifyProof(fakeRoot, leaf, proof, 0);
        assertFalse(valid);
    }

    // =========================================================================
    // KERNEL SIMULATION INTEGRATION
    // =========================================================================

    function test_kernelSimulation_eventToAnchor() public {
        // Simulate kernel producing events
        bytes32[] memory eventHashes = new bytes32[](4);
        for (uint256 i = 0; i < 4; i++) {
            eventHashes[i] = kernel.produceEvent(
                string(abi.encodePacked("sensor-", vm.toString(i))),
                abi.encodePacked("reading:", vm.toString(i * 100))
            );
        }

        // Compute Merkle root via kernel simulator
        bytes32 root = kernel.computeMerkleRoot(eventHashes);

        // Anchor on-chain
        uint256 batchId = anchor.submitBatch(root, 4, "kernel-sim");

        assertEq(anchor.getBatch(batchId).merkleRoot, root);
        assertEq(kernel.eventCount(), 4);
    }
}
