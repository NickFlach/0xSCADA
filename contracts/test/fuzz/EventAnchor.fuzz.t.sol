// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../../EventAnchor.sol";

/**
 * @title EventAnchorFuzzTest
 * @notice Fuzz tests for the REAL EventAnchor contract (issue #490).
 * @dev Rewritten: the previous version fuzzed a phantom `anchorBatch(...)` /
 *      `metadataUri` API and imported a non-existent SiteRegistry.sol, so it
 *      could never compile. These fuzz the actual anchor/verify invariants.
 *
 * Dependency-free: the test contract deploys EventAnchor as its own owner.
 * Functions prefixed `testFuzz_` with parameters are fuzzed by forge; expected
 * reverts are checked with try/catch (no forge-std / cheatcodes needed).
 */
contract EventAnchorFuzzTest {
    EventAnchor internal anchor;

    function setUp() public {
        anchor = new EventAnchor(address(this));
    }

    /// Any valid (non-zero root, positive count) anchor at the sequential id
    /// must round-trip through verify() and getAnchor().
    function testFuzz_anchorVerifyRoundTrip(bytes32 root, uint256 eventCount) public {
        // Constrain to the valid domain.
        if (root == bytes32(0)) root = bytes32(uint256(1));
        eventCount = (eventCount % 1_000_000) + 1; // 1..1_000_000

        uint256 expectedBatchId = anchor.getCurrentBatchId();
        anchor.anchor(root, expectedBatchId, eventCount);

        (bool exists, uint256 batchId) = anchor.verify(root);
        require(exists, "fuzz: anchored root must verify");
        require(batchId == expectedBatchId, "fuzz: verify batchId mismatch");

        EventAnchor.AnchorData memory a = anchor.getAnchor(expectedBatchId);
        require(a.exists, "fuzz: anchor must exist");
        require(a.merkleRoot == root, "fuzz: root mismatch");
        require(a.eventCount == eventCount, "fuzz: eventCount mismatch");

        require(anchor.getCurrentBatchId() == expectedBatchId + 1, "fuzz: nextBatchId monotonic");
    }

    /// Anchoring at any batch id other than the current nextBatchId must revert,
    /// and must not advance state.
    function testFuzz_nonSequentialBatchIdReverts(bytes32 root, uint256 wrongBatchId) public {
        if (root == bytes32(0)) root = bytes32(uint256(1));
        uint256 next = anchor.getCurrentBatchId();
        if (wrongBatchId == next) wrongBatchId = next + 1; // ensure it's wrong

        try anchor.anchor(root, wrongBatchId, 1) {
            revert("fuzz: non-sequential batchId must revert");
        } catch {}

        require(anchor.getCurrentBatchId() == next, "fuzz: nextBatchId must be unchanged");
        require(anchor.getAnchoredBatchCount() == 0, "fuzz: nothing anchored");
    }

    /// A zero root or zero event count is always rejected regardless of fuzzed
    /// count / root.
    function testFuzz_invalidInputsRejected(uint256 eventCount, bytes32 root) public {
        // zero root, any positive count → revert
        try anchor.anchor(bytes32(0), 1, (eventCount % 100) + 1) {
            revert("fuzz: zero root must revert");
        } catch {}
        // any non-zero root, zero count → revert
        if (root == bytes32(0)) root = bytes32(uint256(1));
        try anchor.anchor(root, 1, 0) {
            revert("fuzz: zero eventCount must revert");
        } catch {}
        require(anchor.getAnchoredBatchCount() == 0, "fuzz: nothing anchored");
    }

    /// Sequential anchoring of N batches keeps count == nextBatchId - 1 exactly.
    function testFuzz_sequentialCountInvariant(uint8 n) public {
        uint256 count = (uint256(n) % 30) + 1; // 1..30 anchors
        for (uint256 i = 1; i <= count; i++) {
            anchor.anchor(keccak256(abi.encode(root_i(i))), i, i);
        }
        require(anchor.getAnchoredBatchCount() == count, "fuzz: count invariant");
        require(anchor.getCurrentBatchId() == count + 1, "fuzz: nextBatchId invariant");
    }

    function root_i(uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encode("fuzz-root", i));
    }
}
