// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title KernelSimulator
 * @notice Mock kernel interface for Foundry testing
 * @dev Simulates the 0xSCADA kernel event pipeline in Solidity
 *      for integration testing with on-chain contracts.
 *
 * Issue #158 — Foundry tests with kernel simulation
 */
contract KernelSimulator {
    struct KernelEvent {
        uint256 id;
        string eventType;
        bytes data;
        bytes32 hash;
        uint256 timestamp;
    }

    KernelEvent[] public events;
    mapping(bytes32 => bool) public eventExists;

    event EventProduced(uint256 indexed id, bytes32 indexed hash, string eventType);
    event MerkleRootComputed(bytes32 root, uint256 leafCount);

    /**
     * @notice Simulate a kernel event being produced
     * @param eventType The event type identifier
     * @param data Raw event data
     * @return eventHash The hash of the produced event
     */
    function produceEvent(
        string calldata eventType,
        bytes calldata data
    ) external returns (bytes32 eventHash) {
        uint256 id = events.length;
        eventHash = keccak256(abi.encodePacked(id, eventType, data, block.timestamp));

        events.push(KernelEvent({
            id: id,
            eventType: eventType,
            data: data,
            hash: eventHash,
            timestamp: block.timestamp
        }));

        eventExists[eventHash] = true;
        emit EventProduced(id, eventHash, eventType);
    }

    /**
     * @notice Compute Merkle root from an array of leaf hashes
     * @dev Standard binary Merkle tree construction
     * @param leaves Array of leaf hashes
     * @return root The computed Merkle root
     */
    function computeMerkleRoot(bytes32[] memory leaves) public pure returns (bytes32 root) {
        require(leaves.length > 0, "Empty leaves");

        uint256 n = leaves.length;

        // Work in-place on a copy
        bytes32[] memory layer = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            layer[i] = leaves[i];
        }

        while (n > 1) {
            uint256 nextN = (n + 1) / 2;
            for (uint256 i = 0; i < nextN; i++) {
                uint256 left = i * 2;
                uint256 right = left + 1 < n ? left + 1 : left;
                layer[i] = keccak256(abi.encodePacked(layer[left], layer[right]));
            }
            n = nextN;
        }

        return layer[0];
    }

    /**
     * @notice Verify a Merkle inclusion proof
     * @param root Expected Merkle root
     * @param leaf Leaf to verify
     * @param proof Sibling hashes along the path
     * @param index Leaf index (determines left/right at each level)
     */
    function verifyProof(
        bytes32 root,
        bytes32 leaf,
        bytes32[] calldata proof,
        uint256 index
    ) external pure returns (bool) {
        bytes32 computedHash = leaf;

        for (uint256 i = 0; i < proof.length; i++) {
            if ((index >> i) & 1 == 1) {
                computedHash = keccak256(abi.encodePacked(proof[i], computedHash));
            } else {
                computedHash = keccak256(abi.encodePacked(computedHash, proof[i]));
            }
        }

        return computedHash == root;
    }

    /**
     * @notice Get total number of simulated events
     */
    function eventCount() external view returns (uint256) {
        return events.length;
    }

    /**
     * @notice Get all event hashes for batch anchoring
     */
    function getAllEventHashes() external view returns (bytes32[] memory) {
        bytes32[] memory hashes = new bytes32[](events.length);
        for (uint256 i = 0; i < events.length; i++) {
            hashes[i] = events[i].hash;
        }
        return hashes;
    }

    /**
     * @notice Simulate kernel state snapshot (hash of all events)
     */
    function stateSnapshot() external view returns (bytes32) {
        if (events.length == 0) return bytes32(0);

        bytes32 state = events[0].hash;
        for (uint256 i = 1; i < events.length; i++) {
            state = keccak256(abi.encodePacked(state, events[i].hash));
        }
        return state;
    }
}
