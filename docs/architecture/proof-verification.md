# Proof Verification — O(log n) Kernel-Space Verification

> Issue #155 — Verify L2 proofs in kernel space with O(log n)

## Overview

Merkle proof verification optimized for kernel-space execution. Supports standard and sparse Merkle trees, proof compression for bandwidth efficiency, batch verification for throughput, and result caching.

## Complexity

| Operation | Time | Space |
|-----------|------|-------|
| Single proof verification | O(log n) | O(log n) |
| Batch verification (k proofs) | O(k log n) | O(k + cache) |
| Sparse tree insert | O(log n) | O(log n) per entry |
| Compressed proof verify | O(log n) | O(compressed siblings) |

## Components

### MerkleTree
Standard binary Merkle tree. Builds all layers on construction, generates inclusion proofs for any leaf.

### SparseMerkleTree
Fixed-depth tree (default 32 levels = 2^32 leaves). Empty subtrees use precomputed default hashes — no storage needed for empty regions. Ideal for large address spaces with sparse population.

**Compression:** Proofs omit default siblings (receiver can reconstruct). For a tree with k non-empty leaves, compressed proofs average O(log k) siblings instead of O(depth).

### ProofVerifier
Stateless verifier with LRU cache. Accepts standard or compressed proofs and walks the sibling path to reconstruct the root.

## Proof Format

```
Standard:   { leaf, leafIndex, siblings[], path (bitmap), root }
Compressed: { leaf, leafIndex, compressedSiblings[{depth, hash}], path, root, treeDepth }
```

The `path` bitmap encodes the leaf's position: bit i = 1 means the leaf is the right child at depth i.

## Batch Verification

```typescript
const verifier = new ProofVerifier(sha256Hash, 4096);
const result = verifier.batchVerify(proofs);
// { total: 1000, valid: 998, invalid: 2, durationMs: 12, results: [...] }
```

Results are cached by `leaf:root:path` key. Cache auto-evicts when full (FIFO, 25% eviction).

## Hash Functions

- **SHA-256** — Default, hardware-accelerated on modern CPUs (SHA-NI)
- **Keccak-256** — Ethereum compatibility (SHA3-256 as stand-in until @noble/hashes)

## Integration with L2 Bridge

The proof verifier is used by the bridge's state sync module to validate L2 state roots before importing them into the kernel. Flow:

1. L2 submits state root + Merkle proof
2. Bridge calls `ProofVerifier.verify(proof)` — O(log n)
3. If valid, state root is imported into kernel memory-mapped store
4. Kernel events can reference the verified L2 state
