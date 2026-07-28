# Offline and edge resilience

This document is the executable companion to
[ADR-0014](../decisions/ADR-0014-production-scale-architecture.md) for issue
[#224](https://github.com/NickFlach/0xSCADA/issues/224).

`server/gateway/store-and-forward.ts` preserves the existing
`StoreAndForwardService.store(data, driverId)` entry point while making the
queue durable and the reconnect path verifiable:

- `JsonFileEdgeQueue` persists snapshots using fsync plus atomic rename; a
  `DurableEdgeQueue` port permits SQLite or another local store.
- Capacity is fail-closed: unacknowledged records are never silently evicted.
- Every recovered record is checked with SHA-256, and every forwarded batch
  requires the upstream to echo its Merkle root before records are removed.
- Reconnect attempts use capped exponential backoff.
- Telemetry conflicts use deterministic last-writer-wins ordering.
  Configuration conflicts merge independently versioned leaf fields.
- `LocalEdgeProcessor` hooks run after the local durable commit even while the
  upstream is unavailable.
- Divergences are emitted and can be sent to an injected durable
  `DivergenceReporter`.

Only JSON values that round-trip without coercion are accepted. Non-finite
numbers, dates, maps, class instances, cycles, accessors, symbols,
prototype-mutating keys, and dotted configuration field names are rejected
before commit.

Production must inject an `EdgeUpstreamTransport`. The default environment
transport contains no socket and reports reachable only during development or
when connectivity simulation is explicitly enabled. Upstream outages are
degraded health while local durability remains available; queue corruption,
capacity exhaustion, failed initialization, and persistence errors are hard
health failures.

## Verification

Run:

```bash
npx vitest run server/gateway/__tests__/store-and-forward.test.ts
npm run typecheck
npm run build
```

The focused suite covers restart recovery, tamper detection, capacity,
reconnect backoff, acknowledgment validation, Merkle mismatch, offline local
processing, conflict resolution, queue serialization safety, and persistence
failure handling.
