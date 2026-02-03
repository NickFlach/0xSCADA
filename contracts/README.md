# 0xSCADA Smart Contracts

## Overview

This directory contains the Solidity smart contracts for the 0xSCADA platform's blockchain anchoring layer.

## Contracts

### SiteRegistry.sol
Site registration and authorization management. Manages:
- Site ownership
- Authorized gateways
- Authorized signers

### EventAnchor.sol
Batch event anchoring with Merkle proof verification. Stores:
- Merkle roots of event batches
- Metadata pointers (IPFS)
- Timestamps and attribution

### RealityAnchor.sol (VERITY Architecture)
**Extends EventAnchor** with artifact attestation capabilities for the Reality Artifact Architecture.

#### Features
- Single artifact attestation
- Batch artifact attestation via Merkle root
- Merkle proof verification for batch membership
- Four artifact types: trace, proof, twin, decision

#### Artifact Types
| Type | Value | Description |
|------|-------|-------------|
| TRACE | 1 | Kernel traces, eBPF captures, sensor data |
| PROOF | 2 | ZK proofs, verification results |
| TWIN | 3 | Digital twin snapshots/checkpoints |
| DECISION | 4 | Agent decision records |

### IndustrialRegistry.sol
Industrial equipment and asset registration.

### ChangeIntent.sol
Change management and intent declaration.

---

## Gas Cost Analysis (RealityAnchor)

Estimated gas costs based on Solidity 0.8.20 with optimizer (200 runs):

### Write Operations

| Operation | Gas Estimate | Notes |
|-----------|-------------|-------|
| `attestArtifact()` (no URI) | ~65,000 | First-time attestation |
| `attestArtifact()` (with URI) | ~75,000 | 32-char metadata URI |
| `attestArtifact()` (long URI) | ~90,000 | 128+ char URI |
| `attestArtifactBatch()` | ~55,000 | Any batch size (fixed cost) |

### Read Operations (View Functions)

| Operation | Gas Estimate | Notes |
|-----------|-------------|-------|
| `verifyArtifact()` | ~3,500 | Single lookup |
| `verifyArtifactInBatch()` | ~2,500 + (depth × 500) | Merkle verification |
| `isAttested()` | ~2,800 | Simple lookup |
| `getAttestation()` | ~5,000 | Full struct retrieval |
| `getBatch()` | ~4,000 | Batch struct retrieval |

### Cost Comparison

For 100 artifacts:
- **Individual attestations**: 100 × 65,000 = **6,500,000 gas**
- **Single batch attestation**: 55,000 = **55,000 gas** (118× cheaper!)

**Recommendation**: Use batch attestation for high-frequency scenarios. Individual attestation is appropriate for high-value, infrequent artifacts that need immediate on-chain presence.

### Merkle Proof Depth vs Gas

| Tree Size | Proof Depth | Verification Gas |
|-----------|-------------|------------------|
| 2-4 | 2 | ~3,500 |
| 5-8 | 3 | ~4,000 |
| 9-16 | 4 | ~4,500 |
| 17-32 | 5 | ~5,000 |
| 33-64 | 6 | ~5,500 |
| 65-128 | 7 | ~6,000 |
| 129-256 | 8 | ~6,500 |
| 257-512 | 9 | ~7,000 |
| 513-1024 | 10 | ~7,500 |

---

## Development

### Compile Contracts
```bash
npx hardhat compile --config hardhat.config.cts
```

### Run Tests
```bash
npx hardhat test --config hardhat.config.cts test/RealityAnchor.test.ts
```

### Gas Report
```bash
REPORT_GAS=true npx hardhat test --config hardhat.config.cts
```

---

## Architecture

See [docs/REALITY_ARTIFACT_ARCHITECTURE.md](../docs/REALITY_ARTIFACT_ARCHITECTURE.md) for the full VERITY architecture specification.

```
┌─────────────────────────────────────────────────────────────────┐
│                      LFS (Off-Chain)                            │
│  • Traces, proofs, twins, decisions                             │
│  • Content-addressed by SHA-256                                 │
└────────────────────────────┬────────────────────────────────────┘
                             │ Content Hash
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                  RealityAnchor (On-Chain)                       │
│  • Attestation records                                          │
│  • Batch Merkle roots                                           │
│  • Timestamp + attester attribution                             │
│  • Immutable audit trail                                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Security Considerations

1. **Authorization**: Only site-authorized gateways/signers can attest
2. **Immutability**: Attestations cannot be modified or deleted
3. **Uniqueness**: Same content hash cannot be attested twice (prevents replay)
4. **Merkle Security**: Standard binary Merkle tree with index-based ordering

---

## Status

- [x] Contract design complete
- [x] Tests written
- [ ] Compilation verified (blocked by α.1)
- [ ] Deployment (blocked by α.1)
- [ ] Gas profiling on testnet
