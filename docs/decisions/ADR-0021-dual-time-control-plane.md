# ADR-0021: Dual-Time Control Plane Architecture

**Status:** Proposed  
**Date:** 2026-02-27  
**Deciders:** 0xSCADA Core Team, NickFlach  
**References:** [ADR-0014 (Production Scale Architecture)](ADR-0014-production-scale-architecture.md), [ADR-0015 (Flux Integration)](ADR-0015-flux-integration.md), [kernel-fork-plan.md](../architecture/kernel-fork-plan.md), [Issue #306](https://github.com/NickFlach/0xSCADA/issues/306)

## Context

Industrial control systems require both **deterministic real-time response** for safety-critical operations and **cryptographic immutability** for audit trails and compliance. These two requirements operate on fundamentally different time horizons:

- **Real-time domain:** Microsecond-level determinism for control loops (PLCs, actuators, safety systems)
- **Immutable domain:** Batch processing for blockchain anchoring, compliance records, and audit trails

Traditional SCADA systems handle real-time control well but lack cryptographic integrity. Blockchain systems provide immutability but cannot meet real-time control requirements. 0xSCADA bridges this gap through a **dual-time control plane** that separates these concerns while maintaining seamless integration.

The architecture consists of three specialized kernel subsystems, each optimized for its specific temporal and cryptographic requirements.

## Decision

### 1. Three-Kernel Architecture

The 0xSCADA control plane is implemented as three cooperating kernel subsystems:

#### Event Kernel
- **Purpose:** Real-time event ingestion and deterministic processing
- **Latency target:** < 50 µs (x86_64), < 100 µs (ARM64)
- **Implementation:** Kernel-space ring buffer with lock-free publish/subscribe
- **Location:** `kernel/drivers/oxscada/event/`
- **Key features:**
  - PREEMPT_RT scheduling for deterministic timing
  - Lock-free circular buffer design
  - Direct hardware interrupt handling
  - Netlink interface for userspace event injection
  - `/proc/oxscada/events` monitoring interface

#### Merkle Kernel  
- **Purpose:** Cryptographic proof generation and verification
- **Performance target:** O(log n) proof verification
- **Implementation:** Kernel-space Merkle tree operations with hardware acceleration
- **Location:** `kernel/drivers/oxscada/crypto/`
- **Key features:**
  - SHA-256 / Keccak-256 hardware acceleration hooks
  - Sparse Merkle tree support
  - Batch verification for throughput optimization
  - PKCS#11 HSM bridge integration
  - Memory-mapped proof cache for performance

#### Anchor Kernel
- **Purpose:** L2 blockchain state synchronization and anchoring
- **Consistency model:** Eventually consistent with configurable finality depth
- **Implementation:** Bidirectional L2 state sync driver
- **Location:** `kernel/drivers/oxscada/bridge/`
- **Key features:**
  - Memory-mapped state root storage
  - DMA-based batch transfer to userspace
  - Automatic retry logic with exponential backoff
  - Finality tracking (default: 64 blocks)
  - State import verification with proof validation

### 2. Dual-Time Pipeline Flow

The architecture separates time-critical and time-tolerant operations into distinct processing pipelines:

```
REAL-TIME PIPELINE (Event Kernel)
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│ Sensor/PLC  │───▶│ Event Ring  │───▶│ Control     │
│ Hardware    │ µs │ Buffer      │ µs │ Logic       │
│ Interrupts  │    │ (Lock-free) │    │ (RT Sched)  │
└─────────────┘    └─────────────┘    └─────────────┘
                           │
                           ▼ (async)
BATCH PIPELINE (Merkle + Anchor Kernels)
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│ Event       │───▶│ Merkle Tree │───▶│ L2 Anchor   │
│ Batching    │ s  │ Generation  │ s  │ Submission  │
│ (5s/100 ev) │    │ + Proofs    │    │ (Gas Opt)   │
└─────────────┘    └─────────────┘    └─────────────┘
```

### 3. Temporal Separation Strategy

| Concern | Time Domain | Kernel | Guarantees |
|---------|-------------|--------|------------|
| **Safety Control** | Real-time (µs) | Event | Deterministic latency, preemptible |
| **Process Monitoring** | Real-time (µs) | Event | Lock-free data structures |
| **Event Integrity** | Batch (seconds) | Merkle | Cryptographic proofs, O(log n) verification |
| **Audit Trails** | Batch (seconds) | Merkle + Anchor | Immutable, tamper-evident |
| **Compliance Records** | Batch (minutes) | Anchor | Blockchain finality, regulatory compliance |
| **Cross-site Sync** | Eventual (minutes) | Anchor | Byzantine-tolerant consensus |

### 4. Flow Integration Points

#### Event → Merkle Flow
- Events accumulate in Event Kernel ring buffer
- Batch threshold triggers (default: 100 events OR 5 seconds)
- Merkle Kernel consumes batches, computes tree, generates proofs
- Individual events remain verifiable via inclusion proofs

#### Merkle → Anchor Flow  
- Merkle roots queued for L2 submission
- Anchor Kernel handles gas optimization and retry logic
- L2 transaction confirmation tracked with configurable finality depth
- State roots imported back for cross-system verification

#### Real-time Bypass
- Critical control decisions bypass batch pipeline entirely
- Safety systems operate on Event Kernel data exclusively
- Immutable records created asynchronously without blocking control

### 5. Configuration Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| **Event Kernel** | | |
| `EVENT_RING_SIZE` | 65536 | Ring buffer size (power of 2) |
| `RT_PRIORITY` | 80 | Real-time thread priority (SCHED_FIFO) |
| `MAX_EVENT_LATENCY_US` | 50 | SLA for event processing (x86_64) |
| **Merkle Kernel** | | |
| `BATCH_SIZE_EVENTS` | 100 | Events per Merkle batch |
| `BATCH_TIMEOUT_MS` | 5000 | Force-flush timeout |
| `PROOF_CACHE_SIZE` | 1024 | Cached proofs (LRU) |
| **Anchor Kernel** | | |
| `FINALITY_DEPTH_BLOCKS` | 64 | Blocks for L2 finality |
| `ANCHOR_RETRY_COUNT` | 3 | Retry attempts before failure |
| `STATE_IMPORT_INTERVAL_MS` | 5000 | L2 state polling interval |

## Consequences

### Positive
- **Real-time guarantees:** Sub-100µs deterministic response for safety-critical control
- **Immutable integrity:** All events cryptographically anchored without blocking real-time operations
- **Scalable batching:** 95-99% gas savings through Merkle batch anchoring
- **Temporal isolation:** Real-time and batch concerns fully separated
- **Hardware acceleration:** Kernel-space crypto operations with HSM integration
- **Fault tolerance:** Independent kernel subsystems with graceful degradation
- **Regulatory compliance:** Immutable audit trails meet IEC 62443 / NIST CSF requirements

### Negative
- **Complexity increase:** Three kernel subsystems require careful coordination
- **Development overhead:** Kernel module development is more complex than userspace
- **Testing challenges:** Real-time validation requires specialized test infrastructure
- **Platform dependency:** Requires PREEMPT_RT kernel support

### Risks
- **Kernel stability:** Custom modules could impact system stability (mitigated: extensive testing, gradual rollout)
- **Performance regression:** Kernel-space processing could introduce overhead (mitigated: benchmarking, profiling)
- **Maintenance burden:** Kernel modules require ongoing maintenance across kernel versions (mitigated: LTS kernel base)

## Implementation Roadmap

1. **Phase 1:** Event Kernel implementation with ring buffer and Netlink interface
2. **Phase 2:** Merkle Kernel with O(log n) verification and proof cache
3. **Phase 3:** Anchor Kernel with L2 state sync and finality tracking
4. **Phase 4:** Integration testing with full dual-time pipeline validation
5. **Phase 5:** Production deployment with monitoring and observability

## Related Work

- [Flux Integration (ADR-0015)](ADR-0015-flux-integration.md) — World state engine integration
- [Production Scale Architecture (ADR-0014)](ADR-0014-production-scale-architecture.md) — Overall system architecture
- [Kernel Fork Plan](../architecture/kernel-fork-plan.md) — Linux kernel customization strategy
- [Event Batching](../architecture/event-batching.md) — Merkle batch implementation details
- [Bidirectional Sync](../architecture/bidirectional-sync.md) — L2 state synchronization
- [Proof Verification](../architecture/proof-verification.md) — O(log n) verification algorithms