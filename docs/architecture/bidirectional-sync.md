# Bidirectional L2 State Sync

> Issue #156 — Bidirectional L2 state sync to kernel

## Overview

Two-way synchronization between the 0xSCADA kernel and Ethereum L2:

- **Kernel → L2:** Batch kernel events, compute Merkle root, anchor on-chain
- **L2 → Kernel:** Import L2 state roots, verify proofs, confirm finality

## Architecture

```
KERNEL SPACE                          L2 CHAIN
┌─────────────────┐                  ┌─────────────────┐
│  Event Pipeline  │                  │  EventAnchor    │
│                  │─── batch ───────▶│  Contract       │
│  Sensor events   │   anchor tx      │                 │
│  Actuator cmds   │                  │  submitBatch()  │
└─────────────────┘                  └─────────────────┘
                                            │
┌─────────────────┐                         │ state root
│  State Store     │◀── import ─────────────┘
│                  │   + verify proof
│  Verified roots  │
│  Finality track  │
└─────────────────┘
```

## Kernel → L2 (Event Anchoring)

1. Events accumulate in buffer (max `anchorBatchSize` or `anchorIntervalMs`)
2. Merkle root computed over event hashes
3. `submitBatch(merkleRoot, eventCount)` called on EventAnchor contract
4. Transaction monitored for confirmation (receipt + block depth)
5. After `anchorConfirmationBlocks`, status → "finalized"
6. Retry logic: up to 3 attempts before marking failed

## L2 → Kernel (State Import)

1. Poll L2 contract for latest state root at `stateImportIntervalMs`
2. Verify inclusion proof using `ProofVerifier` (O(log n))
3. If valid, import state root into kernel memory-mapped store
4. Track block depth; once `finalityDepth` blocks pass → finalized
5. Kernel modules can reference finalized L2 state for decision-making

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `anchorBatchSize` | 256 | Max events per batch |
| `anchorIntervalMs` | 10,000 | Flush interval |
| `anchorConfirmationBlocks` | 64 | Blocks for confirmation |
| `stateImportIntervalMs` | 5,000 | L2 poll interval |
| `finalityDepth` | 64 | Blocks for finality |
| `maxPendingImports` | 100 | Max tracked state roots |

## Status Monitoring

```typescript
const sync = new BidirectionalSync(config);
sync.start();

const status = sync.getStatus();
// { anchorStatus: { pendingCount, confirmedCount, ... },
//   importStatus: { pendingCount, confirmedCount, ... } }
```
