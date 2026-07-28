# Production-scale runtime primitives

This document is the executable companion to
[ADR-0014](../decisions/ADR-0014-production-scale-architecture.md). It covers
issues [#222](https://github.com/NickFlach/0xSCADA/issues/222),
[#223](https://github.com/NickFlach/0xSCADA/issues/223),
[#224](https://github.com/NickFlach/0xSCADA/issues/224), and
[#227](https://github.com/NickFlach/0xSCADA/issues/227).

The implementation deliberately separates distributed-system algorithms from
network, database, and service-discovery clients. The code in
`server/scaling/` is executable in-process; deployments bind its interfaces to
NATS/Kafka, mDNS, a site registry, the historian database, and their deployment
controller.

## Horizontal scaling

`server/scaling/horizontal.ts` provides:

- `ConsistentHashRing`, with configurable virtual nodes and explicit
  `rebalance()` plans. Ring construction and ownership are deterministic across
  processes. On join, only keys now owned by the joining node move; on leave,
  only keys previously owned by the departing node move.
- `ServerLoadBalancer`, supporting round-robin, smooth weighted round-robin,
  and weight-normalized least-connections. `acquire()` returns an idempotent
  lease whose `release()` updates connection accounting.
- `PartitionedHistorian`, which routes writes by stable tag hash, groups
  tag-filtered reads by owning partition, federates unfiltered reads, sorts the
  result, and reports unavailable shards instead of silently returning a
  complete-looking result.
- `PartitionedEventFanout`, which preserves publication order within each
  topic partition, fans out to all eligible subscribers, and reports individual
  consumer failures.

Changing ring membership is a control-plane operation. Capture the current
assignment, change membership, call `rebalance(tags, oldAssignment)`, move the
listed tags, then publish the new ring generation. A deployment should not let
two ring generations write the same historian tag concurrently.

## Multi-site federation

`server/scaling/federation.ts` defines both registry and mDNS discovery
adapters. `FederatedSiteDiscovery` deduplicates their results and applies
`MutualTlsSiteIdentityPolicy` before returning a peer. The identity contract is:

1. the endpoint uses HTTPS;
2. the certificate is inside its validity interval;
3. its issuer fingerprint is trusted;
4. the claimed site matches the certificate identity;
5. the SAN contains `urn:0xscada:site:<site-id>`; and
6. an optional site certificate pin matches.

If two sources advertise different certificates for one site namespace, that
namespace fails closed for the discovery pass.

`CrossSiteTagReference` is the parser and canonical formatter for
`site:area/tag`. `FederatedAlarmView` and `FederatedReporting` query all sites
concurrently and return `{data, failures}` so a disconnected site is always
visible. `ReplicatedConfiguration` is a Lamport-clocked LWW-map CRDT with
retained tombstones and deterministic actor tie-breaking. Its merge is
associative, commutative, and idempotent; same-clock writes are also exposed as
conflicts for operators.

The discovery interfaces receive an `AbortSignal`. An mDNS/registry binding
must return the peer certificate observed by the mTLS transport, not
certificate metadata supplied only by an unauthenticated advertisement.

## Offline edge operation

`server/gateway/store-and-forward.ts` retains the existing
`StoreAndForwardService.store(data, driverId)` entry point and adds:

- `JsonFileEdgeQueue`, an atomic-rename durable queue, plus a
  `DurableEdgeQueue` port for SQLite or another local store;
- fail-closed capacity handling (old records are never evicted);
- SHA-256 record checksums checked during recovery;
- Merkle roots for every forwarded batch and mandatory upstream root echo;
- capped exponential reconnect backoff;
- explicit telemetry LWW and per-field configuration merge rules;
- divergence events and an injectable durable/alerting `DivergenceReporter`;
  and
- `LocalEdgeProcessor` hooks that run after the local durable commit even when
  the upstream is unreachable.

Production must inject an `EdgeUpstreamTransport`. The default environment
transport contains no socket and reports reachable only in development or when
`SIMULATE_CONNECTIVITY=true`; this prevents a production process from deleting
records based on a fake acknowledgement.

Forward acknowledgements are accepted only for IDs in the offered batch. A
Merkle mismatch keeps the full batch, increments retry state, emits an
integrity divergence, and disconnects the transport. Telemetry conflicts choose
the newest timestamp (then origin and canonical value). Configuration conflicts
merge independently versioned leaf fields and keep the merged record queued
until the peer acknowledges it.

## Zero-downtime upgrades

`server/scaling/upgrade.ts` provides:

- `VersionCompatibilityMatrix`, which fails closed for every transition not
  explicitly certified;
- `TypedFeatureFlags<Schema>`, with runtime validators, stable subject hashing,
  percentage rollout, site targeting, and include/exclude overrides;
- `ReversibleMigrationRunner`, whose append-only `MigrationJournal` records
  start, success, failure, rollback start, rollback success, and rollback
  failure. A failing migration and all migrations applied in the same run are
  rolled back in reverse order; and
- `RollingCanaryOrchestrator`, which validates every current-to-target version
  before its first side effect, upgrades deterministic canaries, applies health
  gates, rolls the remainder, and restores every touched node to its original
  version after a failure.

Deployment adapters must make `drain`, `restoreTraffic`, and `rollback`
idempotent. A controller call can fail after partially changing external state,
so the orchestrator marks a node rollback-eligible before crossing each drain
or deploy boundary. The journal implementation used in production must be
durable (normally an append-only database table); the included in-memory
implementation is useful for tests and embedded controllers.

## Verification

Focused deterministic tests live in:

- `server/scaling/__tests__/horizontal.test.ts`
- `server/scaling/__tests__/federation.test.ts`
- `server/gateway/__tests__/store-and-forward.test.ts`
- `server/scaling/__tests__/upgrade.test.ts`

They cover membership churn, all load-balancing modes, historian partial
failure, partition fan-out, mTLS rejection, conflicting discovery identities,
cross-site aggregation, CRDT convergence/tombstones, restart durability,
tamper detection, reconnect backoff, Merkle mismatch, offline local processing,
conflict rules, migration rollback, canary health failure, and compatibility
rejection before side effects.
