# Validator Node Health Monitoring & Alerting

## Overview

The validator health monitor (`server/blockchain/validator-health.ts`) tracks validator node status, block production, peer connections, and sync status, alerting on degraded performance.

## Quick Start

```typescript
import { ValidatorHealthMonitor } from '../server/blockchain/validator-health';

const monitor = new ValidatorHealthMonitor();

monitor.addNode({
  name: 'validator-1',
  rpcUrl: 'http://localhost:26657',
  checkIntervalMs: 30000,
  thresholds: {
    minPeers: 3,
    maxBlocksBehind: 10,
    maxBlockAgeSec: 120,
    minUptimePercent: 95,
  },
});

monitor.onAlert((alert, node) => {
  console.log(`[${alert.severity}] ${node}: ${alert.message}`);
});

monitor.startMonitoring();
```

## Monitored Metrics

| Metric | Threshold | Severity |
|--------|-----------|----------|
| Peer count | < minPeers | warning/critical (0 peers = critical) |
| Block age | > maxBlockAgeSec | warning/critical (3x = critical) |
| Sync status | catching_up = true | info |
| Uptime | < minUptimePercent | warning |
| Reachability | connection failure | critical |

## Alert Severities

- **info** — Informational, no action needed (e.g., node syncing)
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
- `startMonitoring(name?)` — Start periodic checks
- `stopMonitoring(name?)` — Stop checks
- `checkNode(name)` — Manual health check
- `getStatus(name)` — Get last known status
- `getAllStatuses()` — All node statuses
- `getUnhealthyNodes()` — Only unhealthy nodes
- `getSummary()` — Overview: total, healthy, unhealthy
