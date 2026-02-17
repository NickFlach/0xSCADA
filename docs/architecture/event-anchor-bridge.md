# Event Anchor Bridge

> Issue #153: [Bridge] Connect kernel event batches to EventAnchor contracts

## Overview

The Event Anchor Bridge connects the kernel's `EventBatcher` to the on-chain `EventAnchor` smart contract via the `BatchSubmitter`. It orchestrates the flow: kernel events → batches → Merkle roots → L2 anchoring.

## Architecture

```
┌──────────────┐     batch     ┌──────────────────┐     submit    ┌────────────────┐
│ EventBatcher │ ──────────► │ EventAnchorBridge │ ──────────► │ BatchSubmitter │
│  (#152)      │              │  (#153)           │              │  (#154)        │
└──────────────┘              └──────────────────┘              └───────┬────────┘
                                                                        │
                                                                        ▼
                                                               ┌────────────────┐
                                                               │  EventAnchor   │
                                                               │  Contract (L2) │
                                                               └────────────────┘
```

## Features

- **Auto-submit:** Batches are automatically forwarded to the submitter on arrival
- **Min batch size:** Skip tiny batches below a threshold
- **Root aggregation:** Optionally buffer multiple batch roots and submit as one aggregated root
- **State tracking:** Tracks pending, submitted, confirmed, and failed batches
- **Event-driven:** Emits `anchored`, `anchor:failed`, `connected`, `disconnected` events

## Aggregation Mode

When `aggregateRoots = true`, the bridge buffers batch Merkle roots and creates an aggregate root (root-of-roots) for a single L2 transaction, reducing gas costs.

```
Batch₁.root ─┐
Batch₂.root ─┼─► SHA-256(root₁ || root₂ || ... || rootₙ) ──► L2 submit
Batch₃.root ─┘
```

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| contractAddress | 0x0... | EventAnchor contract address |
| chainId | 1 | Target chain ID |
| autoSubmit | true | Auto-forward batches |
| minBatchSize | 1 | Min events to submit |
| aggregateRoots | false | Buffer and aggregate roots |
| maxAggregateCount | 10 | Max roots before force-flush |

## Implementation

See `server/bridge/event-anchor-bridge.ts`.
