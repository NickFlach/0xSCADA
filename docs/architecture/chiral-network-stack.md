# Chiral Network Stack: Byzantine-Resistant Routing

> Issue #142: [Kernel] Design chiral network stack for Byzantine-resistant routing

## Overview

The Chiral Network Stack introduces **asymmetric (chiral) routing** where forward and return paths are deliberately different, making it cryptographically expensive for Byzantine nodes to intercept, modify, or censor messages in both directions.

## Core Concept: Chirality

In chemistry, chirality means a molecule is not superimposable on its mirror image. In networking:

- **Left-handed path (L-path):** The route from A → B
- **Right-handed path (R-path):** The route from B → A
- **Chirality constraint:** L-path ∩ R-path must share < k nodes (default k = 1)

This ensures that a Byzantine node on the forward path cannot also intercept the return path, requiring an attacker to control nodes on BOTH paths to perform a full MITM attack.

## Architecture

```
        ┌─────────────────────────────────────┐
        │         Chiral Routing Layer         │
        │  ┌─────────┐      ┌─────────┐       │
        │  │ L-Table  │      │ R-Table  │       │
        │  │ (forward)│      │ (return) │       │
        │  └────┬─────┘      └────┬─────┘       │
        │       │    ┌────────┐   │             │
        │       └──► │Chirality│◄──┘             │
        │            │Verifier │                │
        │            └───┬────┘                 │
        │                │                      │
        │  ┌─────────────▼───────────────────┐  │
        │  │    Path Validation Engine        │  │
        │  │  • Signature chain verification  │  │
        │  │  • Chirality proof generation    │  │
        │  │  • Byzantine node detection      │  │
        │  └─────────────────────────────────┘  │
        └─────────────────────────────────────┘
```

## Routing Tables

Each node maintains two routing tables:

### L-Table (Left/Forward Routes)
```typescript
interface LTableEntry {
  destination: NodeId;
  nextHop: NodeId;
  pathHash: Hash;        // hash of full L-path
  hopCount: number;
  lastUpdated: number;
  reputation: number;    // accumulated delivery success rate
}
```

### R-Table (Right/Return Routes)
```typescript
interface RTableEntry {
  destination: NodeId;
  nextHop: NodeId;
  pathHash: Hash;        // hash of full R-path
  hopCount: number;
  chiralityProof: ChiralityProof;  // proves L-path ∩ R-path < k
  lastUpdated: number;
  reputation: number;
}
```

### Route Discovery Protocol

1. **L-Path Discovery:** Source floods a `ROUTE_DISCOVER_L` message. Each relay appends its ID and signs. Destination receives candidate L-paths.
2. **R-Path Discovery:** Destination initiates `ROUTE_DISCOVER_R` with the constraint that R-path must not overlap with selected L-path (beyond threshold k).
3. **Chirality Verification:** Both endpoints verify the chirality constraint using the path proofs.

## Chirality Proofs

A chirality proof demonstrates that two paths share fewer than k nodes:

```typescript
interface ChiralityProof {
  lPathCommitment: Hash;    // Merkle root of L-path node IDs
  rPathCommitment: Hash;    // Merkle root of R-path node IDs
  overlapBound: number;     // k: max allowed overlap
  // Zero-knowledge proof that |L ∩ R| < k
  // Uses set intersection cardinality proof
  proof: Uint8Array;
}
```

**Construction:**
1. Both paths are committed as sorted Merkle trees of node IDs
2. A ZK proof demonstrates that the intersection cardinality is below threshold
3. Verifiable by any third party without revealing the full paths

## Path Validation

Every message carries a **signature chain**:

```typescript
interface ChiralMessage {
  payload: Uint8Array;
  pathType: 'L' | 'R';
  signatureChain: Array<{
    nodeId: NodeId;
    signature: Signature;  // signs (prev_sig || payload_hash || timestamp)
    timestamp: number;
  }>;
}
```

Each relay:
1. Verifies the previous signature in the chain
2. Appends its own signature
3. Forwards to the next hop

If any signature is invalid, the message is dropped and the offending node is reported.

## Byzantine Detection

| Behavior | Detection Method |
|----------|-----------------|
| Message dropping | Heartbeat probes on both L and R paths; if L works but R doesn't, R-path node is suspect |
| Message modification | Signature chain breaks at the modifying node |
| Route poisoning | Chirality proof fails; path overlap exceeds k |
| Sybil nodes | Reputation system + stake requirements for routing participation |
| Eclipse attack | Chirality ensures at least 2 independent paths; eclipsing requires controlling both |

## Reputation System

Each node maintains per-peer reputation scores:

```
reputation(peer) = α × delivery_rate + β × latency_score + γ × uptime
```

- Nodes below threshold are excluded from route discovery
- Reputation decays over time (cold start protection)
- Sudden reputation drops trigger re-routing

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| k (overlap bound) | 1 | Max shared nodes between L and R paths |
| max_hop_count | 8 | Maximum path length |
| route_ttl | 300s | Route entry lifetime |
| reputation_threshold | 0.5 | Min reputation to participate in routing |
| heartbeat_interval | 10s | Path liveness probe frequency |
| re_route_threshold | 3 | Failed heartbeats before re-routing |

## Integration with 0xSCADA

- Validator-to-validator communication uses chiral routing for consensus messages
- The `ResonantConsensus` protocol (#144) sends Signal/Resonance/Emergence messages over chiral paths
- Event batches (#152) are transmitted via L-paths; acknowledgments via R-paths
- Byzantine detection feeds into the consensus reputation/slashing system
