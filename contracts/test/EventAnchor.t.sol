// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../EventAnchor.sol";

/// @notice Non-owner caller used to prove onlyOwner gating on `anchor`.
contract Outsider {
    function tryAnchor(EventAnchor target, bytes32 root, uint256 batchId, uint256 count) external returns (bool) {
        try target.anchor(root, batchId, count) {
            return true;
        } catch {
            return false;
        }
    }
}

/// @title EventAnchor tests against the REAL contract ABI (issue #490)
/// @dev Dependency-free forge tests: the test contract deploys EventAnchor with
///      itself as owner, so it can call the onlyOwner `anchor`. The prior test
///      files tested a fictional `submitBatch`/`anchorBatch` API that this
///      contract does not have.
contract EventAnchorTest {
    EventAnchor internal anchor;

    bytes32 internal constant ROOT_A = keccak256("root-a");
    bytes32 internal constant ROOT_B = keccak256("root-b");

    function setUp() public {
        anchor = new EventAnchor(address(this));
    }

    // ── happy path: anchor → verify → getAnchor ─────────────────────────────

    function test_anchorStoresDataAndEmitsSequentially() public {
        require(anchor.getCurrentBatchId() == 1, "initial nextBatchId should be 1");
        require(anchor.getAnchoredBatchCount() == 0, "initial count should be 0");

        anchor.anchor(ROOT_A, 1, 10);

        // getAnchor returns the full struct
        EventAnchor.AnchorData memory a = anchor.getAnchor(1);
        require(a.exists, "anchor should exist");
        require(a.merkleRoot == ROOT_A, "root mismatch");
        require(a.eventCount == 10, "eventCount mismatch");
        require(a.timestamp == block.timestamp, "timestamp mismatch");

        require(anchor.getCurrentBatchId() == 2, "nextBatchId should advance to 2");
        require(anchor.getAnchoredBatchCount() == 1, "count should be 1");
        require(anchor.isBatchAnchored(1), "batch 1 anchored");
        require(!anchor.isBatchAnchored(2), "batch 2 not yet anchored");
    }

    function test_verifyRoundTripAndReverseLookup() public {
        anchor.anchor(ROOT_A, 1, 5);

        (bool exists, uint256 batchId) = anchor.verify(ROOT_A);
        require(exists, "anchored root should verify");
        require(batchId == 1, "verify should return batch 1");
        require(anchor.rootToBatch(ROOT_A) == 1, "reverse lookup mismatch");

        (bool existsUnknown, uint256 batchUnknown) = anchor.verify(ROOT_B);
        require(!existsUnknown, "unanchored root must not verify");
        require(batchUnknown == 0, "unanchored root batchId should be 0");
    }

    function test_multipleSequentialAnchors() public {
        anchor.anchor(ROOT_A, 1, 3);
        anchor.anchor(ROOT_B, 2, 7);

        require(anchor.getAnchoredBatchCount() == 2, "two batches");
        require(anchor.getCurrentBatchId() == 3, "nextBatchId is 3");
        (, uint256 b1) = anchor.verify(ROOT_A);
        (, uint256 b2) = anchor.verify(ROOT_B);
        require(b1 == 1 && b2 == 2, "batch ids sequential");
    }

    // ── require() guards ────────────────────────────────────────────────────

    function test_rejectsZeroRoot() public {
        try anchor.anchor(bytes32(0), 1, 5) {
            revert("zero root should revert");
        } catch {}
        require(anchor.getCurrentBatchId() == 1, "no anchor recorded");
    }

    function test_rejectsZeroEventCount() public {
        try anchor.anchor(ROOT_A, 1, 0) {
            revert("zero eventCount should revert");
        } catch {}
        require(anchor.getCurrentBatchId() == 1, "no anchor recorded");
    }

    function test_rejectsNonSequentialBatchId() public {
        // nextBatchId is 1; anchoring at 2 must revert.
        try anchor.anchor(ROOT_A, 2, 5) {
            revert("non-sequential batchId should revert");
        } catch {}
        require(anchor.getCurrentBatchId() == 1, "nextBatchId unchanged");

        // 0 is also non-sequential.
        try anchor.anchor(ROOT_A, 0, 5) {
            revert("batchId 0 should revert");
        } catch {}
    }

    function test_rejectsDuplicateBatch() public {
        anchor.anchor(ROOT_A, 1, 5);
        // batch 1 now exists; nextBatchId is 2, so re-anchoring batch 1 fails the
        // sequential check first — anchoring the SAME root again at the correct
        // next id still succeeds (roots aren't unique-constrained), so assert the
        // sequential guard prevents re-writing an existing batch id.
        try anchor.anchor(ROOT_B, 1, 5) {
            revert("re-anchoring existing batch id should revert");
        } catch {}
    }

    // ── onlyOwner gating ────────────────────────────────────────────────────

    function test_onlyOwnerCanAnchor() public {
        // A fresh anchor owned by a DIFFERENT address; this test contract is not
        // the owner, and neither is the Outsider helper.
        EventAnchor owned = new EventAnchor(address(0xBEEF));
        Outsider outsider = new Outsider();

        bool succeeded = outsider.tryAnchor(owned, ROOT_A, 1, 5);
        require(!succeeded, "non-owner must not anchor");
        require(owned.getCurrentBatchId() == 1, "no anchor from non-owner");

        // This contract is also not the owner of `owned`.
        try owned.anchor(ROOT_A, 1, 5) {
            revert("non-owner (this) should revert");
        } catch {}
    }

    // ── invariant: nextBatchId == anchoredCount + 1, timestamps recorded ─────

    function test_countInvariantAcrossManyAnchors() public {
        for (uint256 i = 1; i <= 20; i++) {
            anchor.anchor(keccak256(abi.encode("root", i)), i, i);
            require(anchor.getCurrentBatchId() == i + 1, "nextBatchId tracks");
            require(anchor.getAnchoredBatchCount() == i, "count tracks");
        }
    }
}
