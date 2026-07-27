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

## Operator Dashboard — `GET /api/validators` (issue #453)

The React Validator Dashboard (`/validators`) does **not** talk to `:9090`. The
browser makes a single same-origin request to `GET /api/validators`; the server
polls the nodes listed in `ANCHOR_NODE_URLS` and returns an aggregate. Two
reasons this is a proxy and not a direct browser fetch:

- **TLS.** A dashboard served over `https` cannot fetch `http://node:9090` —
  browsers block it as mixed content.
- **CORS.** A direct fetch would require every node to serve permissive
  cross-origin headers.

`ANCHOR_NODE_URLS` is deliberately **not** `VITE_`-prefixed, so node URLs never
enter the client bundle. With it unset the route makes no outbound request and
answers `{"configured": false, ...}`.

### Authorization

The route is guarded by `requireControlPlaneAccess({ scopes: ['validators.read'] })`
and fails closed: anonymous callers get 401, an out-of-scope key gets 403. Grant
it in `API_KEYS`, e.g. `somekey:validator-reader:validators.read`.

### Provenance — read this before acting on the data

`/status` responses are **unsigned**, and this repository holds no registry of
validator public keys. Nothing in the aggregate is cryptographically verified: a
node can report an arbitrary validator set, arbitrary phases and an arbitrary
order parameter. Every response therefore carries

```json
"provenance": { "verified": false, "method": "none", "detail": "..." }
```

and the dashboard renders it as a permanent banner. Per-node
response-signature verification is issue #454's work; when it lands, this field
becomes a real per-node result instead of a fixed value. Until then the surface
is diagnostic telemetry, not attested fact.

Because reports are unverified, the aggregate does **not** average conflicting
phases: a validator whose phase is reported differently by two nodes is flagged
`disputed`, and the dashboard shows the largest gap between the coherence
derived from the published phases and each node's self-reported
`order_parameter`.

### Bounded server-side fetching

A slow or hostile node cannot hang the API:

| Bound | Default | Env |
|-------|---------|-----|
| Per-node request timeout (covers the body read) | 3000 ms | `VALIDATOR_RPC_TIMEOUT_MS` (250–10000) |
| Concurrent node fetches | 4 | `VALIDATOR_RPC_MAX_CONCURRENCY` (1–16) |
| Aggregate cache TTL (also de-duplicates concurrent requests) | 2000 ms | `VALIDATOR_RPC_CACHE_TTL_MS` (0–60000) |
| Response body cap | 256 KiB | fixed |
| Configured nodes | 32 | fixed |
| Retries | **none** — exactly one attempt per node per poll | — |

Only `http:` and `https:` URLs are accepted; other schemes are dropped. A node
that fails becomes one errored row rather than a failed request.

### Metrics this RPC cannot supply

Sub-wave 2a asked for per-round attestation health and anchor-batch throughput.
The oxscada `:9090` surface exposes neither — `/status` has no attest/miss record
and `/events` carries bridged SCADA events, not consensus attestations. Rather
than synthesise them, the response lists them in `unavailableMetrics` and the
dashboard renders that list, so an empty panel is never mistaken for "zero".

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
