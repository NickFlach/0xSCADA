# Validator Node Health Monitoring & Alerting

## Overview

The validator health monitor (`server/blockchain/validator-health.ts`) polls
**oxscada validator nodes** (0xSCADA-node) over their HTTP JSON-RPC surface and
alerts on degraded validators.

An oxscada node serves RPC on port **9090** (not Tendermint's 26657 — see
issue #442) with three endpoints:

| Endpoint | Purpose |
|----------|---------|
| `GET /status` | Node status: height, role, peers, mempool, Kuramoto phase data |
| `GET /events` | Last 50 bridged SCADA events |
| `GET /health` | Liveness: `{"ok":true}` |

The authoritative `/status` schema lives in `0xSCADA-node/src/rpc.rs`:

```json
{
  "node_id": "hex",
  "height": 1042,
  "role": "validator",
  "order_parameter": 0.97,
  "mean_phase": 1.234,
  "local_phase": 1.229,
  "peer_phases": [
    { "node_id": "hex", "phase": 1.24, "natural_freq": 0.5, "last_updated": 1748810000 }
  ],
  "peers": 2,
  "mempool": 7,
  "uptime_ticks": 123456
}
```

## Quick Start

```typescript
import { ValidatorHealthMonitor } from '../server/blockchain/validator-health';

const monitor = new ValidatorHealthMonitor();

monitor.addNode({
  name: 'validator-1',
  rpcUrl: 'http://localhost:9090',
  checkIntervalMs: 30000,
  thresholds: {
    minPeers: 1,            // 0 peers is always critical
    minOrderParameter: 0.8, // Kuramoto coherence floor
    maxHeightLag: 10,       // blocks behind the highest observed height
    maxStalledChecks: 3,    // checks without height progress
  },
});

monitor.onAlert((alert, node) => {
  console.log(`[${alert.severity}] ${node}: ${alert.message}`);
});

monitor.startMonitoring();
```

## Monitored Conditions

| Condition | Alert code | Severity |
|-----------|------------|----------|
| RPC unreachable / HTTP error | `unreachable` | critical |
| `/status` shape mismatch (schema drift) | `bad-status-shape` | critical |
| Zero connected peers | `no-peers` | critical |
| Peers below `minPeers` | `low-peers` | warning |
| Kuramoto order parameter below `minOrderParameter` | `decoherent` | warning |
| Height trails cluster max by more than `maxHeightLag` | `height-lag` | warning |
| Height unchanged for `maxStalledChecks` checks | `height-stalled` | warning |
| Node returned to health | `recovered` | info |

## Prometheus Metrics

Exported through the shared registry (`server/metrics/prometheus.ts`,
`scada_` prefix) and served at `/metrics`, all labeled by `validator`:

- `scada_blockchain_validator_up` — 1 when reachable and parseable, else 0
- `scada_blockchain_validator_height`
- `scada_blockchain_validator_peers`
- `scada_blockchain_validator_mempool_size`
- `scada_blockchain_validator_order_parameter` — Kuramoto coherence (0–1)
- `scada_blockchain_validator_last_seen_timestamp_seconds`

Dashboards: point Grafana at these series; alert on
`scada_blockchain_validator_up == 0` and
`scada_blockchain_validator_order_parameter < 0.8`.

## Alert Severities

- **info** — Informational, no action needed (e.g. recovery)
- **warning** — Degraded, investigate soon
- **critical** — Action required immediately

## Integration with Alerting Systems

```typescript
monitor.onAlert((alert, node) => {
  if (alert.severity === 'critical') {
    // Send to PagerDuty, Slack, etc.
    sendSlackAlert(`🚨 ${node}: ${alert.message}`);
  }
});
```

## API

- `addNode(config)` — Register a validator node
- `removeNode(name)` — Unregister and stop monitoring a node
- `startMonitoring(name?)` — Start periodic checks
- `stopMonitoring(name?)` — Stop checks
- `checkNode(name)` — Manual health check (returns the node status)
- `getStatus(name)` — Get last known status
- `getAllStatuses()` — All node statuses
- `getUnhealthyNodes()` — Only unhealthy nodes
- `getSummary()` — Overview: total, healthy, unhealthy
