# Resonant Consensus Protocol: Signal → Resonance → Emergence

> Issue #144: [Protocol] Design resonant consensus

## Overview

The Resonant Consensus Protocol (RCP) is a three-phase consensus mechanism inspired by physical resonance phenomena. Validators reach agreement through constructive interference of signals rather than traditional leader-based or voting-based approaches.

## Three Phases

### Phase 1: Signal Collection

Validators broadcast **Signal Messages** containing their proposed state transitions.

```
SignalMessage {
  validator_id:   bytes32
  epoch:          uint64
  proposed_root:  bytes32
  frequency:      uint16       // validator's "natural frequency" (reputation-weighted)
  amplitude:      uint16       // stake-weighted signal strength
  signature:      bytes65
  timestamp:      uint64
}
```

**Duration:** `T_signal = 2Δ` (two network delay bounds)

**State Machine:**
```
IDLE → [epoch tick] → COLLECTING → [T_signal elapsed] → RESONATING
```

Each validator:
1. Computes their proposed state root from the transaction pool
2. Broadcasts a `SignalMessage` to all peers
3. Collects signals from other validators into a local **Signal Buffer**

**Requirements:**
- Must receive signals from ≥ 2f+1 validators (where f = max Byzantine faults)
- Duplicate signals from same validator/epoch are discarded

### Phase 2: Resonance Amplification

Validators identify **resonant clusters** — groups of signals that agree on the same state root.

```
ResonanceMessage {
  validator_id:   bytes32
  epoch:          uint64
  resonant_root:  bytes32      // the root this validator resonates with
  cluster_size:   uint32       // observed cluster size
  coherence:      uint16       // Kuramoto order parameter r × 10000
  echo_count:     uint16       // how many resonance messages seen for this root
  proof:          bytes[]      // aggregated signature or threshold proof
  signature:      bytes65
}
```

**Duration:** `T_resonance = 3Δ`

**Algorithm:**
1. Group collected signals by `proposed_root`
2. For each root, compute **amplitude** = Σ(amplitude_i) for agreeing validators
3. Compute **coherence** using Kuramoto order parameter across signal frequencies
4. Select the root with highest `amplitude × coherence` score
5. Broadcast `ResonanceMessage` for chosen root
6. Collect peer resonance messages; update cluster observations

**Resonance Condition:**
A root `R` achieves resonance when:
- `cluster_size(R) ≥ 2f + 1`
- `coherence(R) ≥ COHERENCE_THRESHOLD` (default: 0.67)
- `amplitude(R) ≥ AMPLITUDE_THRESHOLD` (default: 50% of total stake)

### Phase 3: Emergence Finalization

Once a root achieves resonance, validators finalize by producing an **Emergence Certificate**.

```
EmergenceMessage {
  validator_id:   bytes32
  epoch:          uint64
  finalized_root: bytes32
  certificate:    AggregateSignature
  batch_proof:    MerkleProof   // proof of included transactions
  timestamp:      uint64
}
```

**State Machine:**
```
RESONATING → [resonance condition met] → EMERGING → [certificate assembled] → FINALIZED
                                                   → [timeout]              → FALLBACK
```

**Certificate Construction:**
- Collect `ResonanceMessage` signatures for the resonant root
- Aggregate into a threshold signature (BLS or multi-sig)
- Certificate is valid when ≥ 2f+1 signatures verify
- Any validator can assemble and broadcast the certificate

## Full State Machine

```
           epoch tick
    IDLE ──────────────► COLLECTING
     ▲                       │
     │                  T_signal
     │                       ▼
  FINALIZED ◄────── RESONATING
     ▲       emerge      │    │
     │       cert        │    │ timeout
     │                   │    ▼
     │              EMERGING  FALLBACK ──► (use previous root)
     │                   │
     └───────────────────┘
```

## Byzantine Fault Tolerance

**Model:** n = 3f + 1 validators, at most f Byzantine.

| Attack | Mitigation |
|--------|-----------|
| Equivocation (signal for multiple roots) | Slashing: two conflicting signals = proof of misbehavior |
| Signal withholding | Timeout → fallback; reputation penalty |
| Fake resonance claims | Resonance messages require aggregated proofs; verified on-chain |
| Amplification attack (inflating cluster size) | Cluster size verified against actual signatures received |
| Timing attack (early/late signals) | Strict epoch boundaries; signals outside window are rejected |

**Safety:** If two different roots both achieve emergence certificates in the same epoch, at least f+1 validators signed both, meaning ≥ 1 honest validator equivocated — contradiction. Therefore, at most one root can finalize per epoch.

**Liveness:** If ≥ 2f+1 honest validators are online and network delay ≤ Δ, resonance is achieved within `T_signal + T_resonance = 5Δ`. Emergence certificate assembly takes at most `Δ` additional time.

## Timing Diagram

```
Time ──────────────────────────────────────────────────►

Epoch N:
  │◄── T_signal (2Δ) ──►│◄── T_resonance (3Δ) ──►│◄─ Emergence ─►│
  │                      │                         │               │
  V₁: Signal ──────►    V₁: Resonate ──────►     V₁: Emerge ─►   │
  V₂: Signal ──────►    V₂: Resonate ──────►     V₂: Emerge ─►   │
  V₃: Signal ──────►    V₃: Resonate ──────►     V₃: Emerge ─►   │
  ...                    ...                       Certificate!    │
  │                      │                         │               │
  │◄──────────────── Epoch duration: ~6Δ ─────────────────────────►│
```

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `T_signal` | 2Δ | Signal collection window |
| `T_resonance` | 3Δ | Resonance amplification window |
| `COHERENCE_THRESHOLD` | 0.67 | Min Kuramoto order parameter |
| `AMPLITUDE_THRESHOLD` | 50% | Min stake fraction for resonance |
| `EMERGENCE_SIGS` | 2f+1 | Signatures needed for certificate |
| `FALLBACK_TIMEOUT` | 10Δ | Max time before fallback to previous root |

## Integration with 0xSCADA

- **Signal phase** uses the `EventBatcher` (#152) to batch incoming validator signals
- **Resonance phase** uses the `SublinearSolver` (#143) for fast validation of proposed roots
- **Emergence phase** uses the `EventAnchorBridge` (#153) to submit finalized roots on-chain
- The `ResonantScheduler` (#141) coordinates epoch timing using Kuramoto coupling
