# Foundry Tests — Kernel Simulation

> Issue #158 — Foundry tests with kernel simulation

## Overview

Foundry test suite for the EventAnchor contract using a `KernelSimulator` mock that replicates the kernel event pipeline in Solidity.

## Files

| File | Description |
|------|-------------|
| `blockchain/test/foundry/EventAnchor.t.sol` | Test suite for EventAnchor |
| `blockchain/test/foundry/KernelSimulator.sol` | Mock kernel for testing |

## Test Coverage

### EventAnchor Tests
- **Deployment:** Owner, batch count, size limits
- **Batch submission:** Single/multiple batches, event counting, root tracking
- **Revert cases:** Zero root, batch too small, batch too large
- **Fuzz tests:** Random roots and counts within bounds
- **Proof verification:** Single leaf, two-leaf tree, invalid proof
- **Kernel integration:** Events from simulator → Merkle root → anchor

### KernelSimulator
- `produceEvent(type, data)` → Creates event with keccak hash
- `computeMerkleRoot(leaves)` → Standard binary Merkle tree
- `verifyProof(root, leaf, proof, index)` → O(log n) verification
- `stateSnapshot()` → Hash chain of all events
- `getAllEventHashes()` → Batch export for anchoring

## Running

```bash
# Run all tests
forge test --match-path test/foundry/*.t.sol -vvv

# Run with gas reporting
forge test --match-path test/foundry/*.t.sol --gas-report

# Run specific test
forge test --match-test test_kernelSimulation_eventToAnchor -vvv

# Fuzz with more runs
forge test --match-test testFuzz --fuzz-runs 10000
```

## Gas Benchmarks

Expected gas costs (approximate):
- `submitBatch`: ~80k gas (first batch), ~60k (subsequent)
- `verifyProof` (8-deep): ~15k gas
- `computeMerkleRoot` (256 leaves): ~120k gas
