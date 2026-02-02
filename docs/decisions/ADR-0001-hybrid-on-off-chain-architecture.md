# ADR-0001: Hybrid On-Chain/Off-Chain Architecture

## Status

Accepted

## Date

2024-01-15

## Context

SCADA (Supervisory Control and Data Acquisition) systems generate massive amounts of telemetry data—often millions of data points per second across industrial facilities. Storing all this data directly on-chain would be:

1. **Prohibitively expensive**: Gas costs for storing raw telemetry would exceed operational budgets
2. **Too slow**: Block confirmation times cannot meet real-time control requirements (<100ms)
3. **Impractical**: Blockchain storage is not designed for high-frequency time-series data

However, we need blockchain's guarantees for:
- Immutable audit trails of critical events
- Transparent governance decisions
- Cryptographic verification of data integrity
- Decentralized consensus on system state

## Decision

We adopt a **hybrid architecture** where:

1. **Off-chain components** handle:
   - Real-time telemetry collection and processing
   - Time-series data storage (TimescaleDB/InfluxDB)
   - Control loop execution with sub-millisecond latency
   - Local caching and edge computing

2. **On-chain components** handle:
   - Merkle root commitments of batched telemetry
   - Critical event attestations (alarms, state changes)
   - Governance votes and configuration changes
   - Asset ownership and access control

3. **Bridge mechanism**:
   - Periodic commitment of data hashes to blockchain
   - Off-chain data can be verified against on-chain roots
   - Oracle network for critical threshold alerts

## Consequences

### Positive

- Real-time performance preserved for control operations
- Cost-effective operation with predictable gas usage
- Maintains cryptographic auditability via Merkle proofs
- Scales to industrial data volumes

### Negative

- Increased system complexity (two subsystems to maintain)
- Requires trust in off-chain data availability
- Verification requires access to off-chain data store
- Potential for off-chain/on-chain state divergence

### Neutral

- Standard pattern in blockchain-based IoT systems
- Aligns with industry trends (L2 solutions, data availability layers)

## Alternatives Considered

### Alternative 1: Full On-Chain Storage

Store all telemetry data directly on blockchain.

Rejected because: Gas costs would be astronomical (~$100+ per data point at peak), and latency would be unacceptable for control systems.

### Alternative 2: Pure Off-Chain with Signing

Use traditional architecture with cryptographic signatures only.

Rejected because: Loses decentralization benefits and transparent governance that blockchain enables.

### Alternative 3: Layer 2 Rollups Only

Use a dedicated L2 for all operations.

Rejected because: Even L2s cannot match the <10ms latency required for real-time control, and operational complexity increases significantly.

## References

- [0xSCADA Architecture Overview](../architecture.md)
- [Merkle Tree Implementation](../../src/core/merkle/)
- Issue #1: Initial architecture discussion
