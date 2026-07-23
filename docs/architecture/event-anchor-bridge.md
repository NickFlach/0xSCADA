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

## NATS Wire Schema (0xSCADA-node path)

Alongside the L2 contract path above, events are published over NATS to the
Rust validator node (`0xSCADA-node`), which anchors them via Kuramoto-BFT
consensus. The canonical wire schema for subject **`scada.events`** is
defined once, in **`shared/wire-schema/scada-event.ts`** (issue #440), and
consumed by `0xSCADA-node/src/bridge.rs` (`ScadaEvent`).

Field names are **snake_case by contract**:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `asset` | string | yes | Asset name/tag, e.g. `TR-MAIN-01` |
| `event_type` | string | yes | e.g. `BREAKER_TRIP` |
| `site_id` | string | yes | Site identifier |
| `timestamp` | string | yes | ISO 8601 |
| `payload` | any JSON | no | blake3-hashed by the node into the anchor merkle root |
| `site_name`, `asset_type`, `details` | string | no | Context only; ignored by the node |

Rules:

- **Publish only through `natsPublisher.publishScadaEvent()`** — it validates
  against the schema and drops (loudly) anything that would fail to parse on
  the Rust side. Never hand-roll the payload.
- The legacy camelCase `AnchorableEvent` shape (`server/bridge/event-anchor.ts`)
  does **not** parse as this schema; convert with `fromAnchorableEvent()`.
  The Rust side carries transitional `#[serde(alias)]` attributes for
  camelCase stragglers — they will be removed.
- The contract is pinned by **twin fixtures** asserted byte-for-byte on both
  sides: `shared/wire-schema/__tests__/scada-event.test.ts` and the
  `test_canonical_wire_fixture` test in `0xSCADA-node/src/bridge.rs`.
  Changing the schema means changing both fixtures in the same commit pair.

## Implementation

See `server/bridge/event-anchor-bridge.ts`.
