# ADR-0002: Merkle Tree Batching for Gas Optimization

## Status

Accepted

## Date

2024-01-18

## Context

With the hybrid architecture (ADR-0001), we need an efficient method to commit off-chain data to the blockchain. Key requirements:

1. **Gas efficiency**: Minimize on-chain storage costs
2. **Verifiability**: Any data point must be provable against the on-chain commitment
3. **Batch flexibility**: Support variable batch sizes based on data volume
4. **Temporal ordering**: Preserve time-series relationships

Naive approaches (storing hashes of individual records) would still be too expensive at industrial data volumes.

## Decision

We implement a **Merkle tree batching system** with the following characteristics:

1. **Batch Formation**:
   - Telemetry data collected over configurable time windows (default: 5 minutes)
   - Data points serialized and hashed as leaf nodes
   - Binary Merkle tree constructed from leaves

2. **On-Chain Commitment**:
   - Only the 32-byte Merkle root stored on-chain
   - Batch metadata: timestamp range, leaf count, data source ID
   - Single transaction per batch regardless of data volume

3. **Proof Generation**:
   - Off-chain service maintains complete tree structure
   - Merkle proofs generated on-demand for any leaf
   - Proofs verify data integrity against on-chain root

4. **Tree Structure**:
   ```
   Root (on-chain)
      /          \
   Hash_01      Hash_23
    /   \        /    \
   H0   H1     H2     H3  (leaf hashes, off-chain)
   |    |      |      |
   D0   D1    D2     D3   (telemetry data points)
   ```

## Consequences

### Positive

- **O(1) on-chain cost**: Single root hash regardless of batch size
- **O(log n) proof size**: Efficient verification without full data
- **Tamper-evident**: Any modification invalidates the root
- **Parallel processing**: Batches are independent

### Negative

- **Proof requires tree access**: Off-chain service must be available
- **Delayed finality**: Data not on-chain until batch commits
- **Storage overhead**: Must store full tree for proof generation
- **Batch boundaries**: Artificial time windows in continuous data

### Neutral

- Industry-standard approach (used by Ethereum, Bitcoin SPV)
- Compatible with future ZK-proof integration

## Alternatives Considered

### Alternative 1: Bloom Filters

Use probabilistic data structures for membership proofs.

Rejected because: False positives unacceptable for security-critical audit trails.

### Alternative 2: Accumulator-Based Proofs

Use cryptographic accumulators (RSA, pairing-based).

Rejected because: More complex, less tooling available, and trusted setup concerns.

### Alternative 3: Simple Hash Chains

Chain hashes sequentially.

Rejected because: O(n) proof size and verification time; doesn't scale.

## References

- [ADR-0001: Hybrid Architecture](ADR-0001-hybrid-on-off-chain-architecture.md)
- [Merkle Tree Implementation](../../src/core/merkle/)
- [Gas Optimization Analysis](../performance/gas-analysis.md)
