# Decentralized Orchestration

> Issue #147 — Container orchestration without central coordinator

## Overview

Replace centralized Kubernetes-style orchestration with a peer-to-peer system where nodes self-organize via gossip protocol, elect leaders for scheduling, and distribute workloads without a single point of failure.

## Architecture

```
┌──────────┐    gossip     ┌──────────┐    gossip     ┌──────────┐
│  Node A  │◄────────────►│  Node B  │◄────────────►│  Node C  │
│ (leader) │               │ (follower)│              │ (follower)│
│          │               │          │               │          │
│ Scheduler│               │ Worker   │               │ Worker   │
└──────────┘               └──────────┘               └──────────┘
     ▲ gossip                   ▲ gossip
     │                          │
┌────▼─────┐              ┌────▼─────┐
│  Node D  │◄────────────►│  Node E  │
│ (follower)│              │ (follower)│
└──────────┘               └──────────┘
```

## Components

### Gossip Protocol
- UDP-based message dissemination with configurable fanout (default: 3)
- Message types: heartbeat, join, leave, workload, election, vote, leader
- TTL-based message forwarding prevents infinite loops
- Deduplication via sender+timestamp message IDs

### Leader Election (Raft-inspired)
- Term-based election with randomized timeouts (5–10s)
- Majority vote required to become leader
- Leader sends periodic heartbeats to prevent re-election
- Automatic step-down on higher term discovery

### Workload Scheduler
- Only the elected leader schedules workloads
- Bin-packing: sort candidates by load, assign to least-loaded
- Constraint support: capability, affinity, anti-affinity, max-load
- Replicas distributed across qualifying nodes

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `gossipIntervalMs` | 1000 | Gossip round frequency |
| `heartbeatIntervalMs` | 3000 | Leader heartbeat interval |
| `electionTimeoutMinMs` | 5000 | Min election timeout |
| `electionTimeoutMaxMs` | 10000 | Max election timeout |
| `nodeTimeoutMs` | 15000 | Node considered dead after |
| `maxGossipFanout` | 3 | Peers to forward to per round |

## Usage

```typescript
import { DecentralizedOrchestrator } from "../server/orchestration/decentralized-orchestrator";

const orch = new DecentralizedOrchestrator({
  listenPort: 9400,
  seedNodes: ["192.168.1.10:9400"],
}, ["gpu", "scada-io"]);

orch.on("becameLeader", (term) => console.log(`Leader in term ${term}`));
orch.start();
```

## Failure Modes

- **Leader crash:** Followers detect missing heartbeats, trigger re-election
- **Network partition:** Each partition elects its own leader; reunification defers to higher term
- **Split brain:** Prevented by majority requirement — minority partition cannot elect a leader
