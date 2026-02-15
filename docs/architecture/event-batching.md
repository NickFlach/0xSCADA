# Kernel-Space Event Batching

> Issue #152: [Kernel] Implement kernel-space event batching

## Overview

High-performance event batching collects kernel events and groups them into Merkle-proved batches for on-chain anchoring. Batches are flushed by either count threshold or time threshold, whichever fires first.

## Architecture

```
Events ──► EventBatcher ──► [batch] ──► EventAnchorBridge ──► L2 Contract
               │                              │
               │ Merkle tree                   │ Submit root
               ▼                              ▼
         MerkleSyscalls              BatchSubmitter
```

## Batch Lifecycle

1. **Ingest:** Events arrive via `ingest()`. Each event has id, timestamp, type, payload, source.
2. **Accumulate:** Events buffer until `maxBatchSize` (default 100) or `maxBatchAgeMs` (default 5s).
3. **Flush:** Pending events are serialized, hashed into a Merkle tree, and emitted as an `EventBatch`.
4. **Compress:** Batch payloads are zlib-compressed for efficient storage/transport.
5. **Prove:** Individual events can be proved via Merkle inclusion proofs.

## Event Serialization

```
serialized = "${id}:${timestamp}:${type}:${source}:${payload_hex}"
leaf_hash = SHA-256(serialized)
```

## Merkle Proof Generation

For any event at index `i` in a batch, `proveEvent(batch, i)` returns a Merkle inclusion proof that can be verified on-chain against the batch's `merkleRoot`.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| maxBatchSize | 100 | Events per batch before auto-flush |
| maxBatchAgeMs | 5000 | Max ms before time-triggered flush |
| compress | true | Enable zlib compression |
| compressionLevel | 6 | zlib level (1-9) |

## Implementation

See `server/kernel/event-batcher.ts`.
