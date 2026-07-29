# Horizontal scaling architecture

This document is the executable companion to
[ADR-0014](../decisions/ADR-0014-production-scale-architecture.md) for issue
[#222](https://github.com/NickFlach/0xSCADA/issues/222).

`server/scaling/horizontal.ts` provides four independently bindable runtime
primitives:

- `ConsistentHashRing` assigns gateways with configurable virtual nodes and
  produces explicit `rebalance()` plans. Ring construction and ownership are
  deterministic across processes. Adding a node moves only keys assigned to
  that node; removing a node moves only keys owned by the removed node.
- `ServerLoadBalancer` implements round-robin, smooth weighted round-robin,
  and weight-normalized least-connections. `acquire()` returns an idempotent
  lease so connection accounting cannot be decremented twice.
- `PartitionedHistorian` routes writes by stable tag hash, groups tag-filtered
  reads by partition, federates unfiltered reads, sorts the result, and reports
  unavailable partitions instead of returning a complete-looking partial
  result.
- `PartitionedEventFanout` preserves publication order within each topic
  partition, fans out to every eligible subscriber, and reports consumer
  failures individually.

The implementation depends only on the shared deterministic hashing helpers in
`server/scaling/hash.ts`. Deployments bind the historian and event interfaces to
their database and NATS/Kafka clients; no network or storage implementation is
silently selected by this module.

`server/scaling/horizontal-runtime.ts` makes those bindings reachable from the
running server. Enable it with:

```text
HORIZONTAL_SCALING_ENABLED=true
HORIZONTAL_SCALING_REQUIRED=true
HORIZONTAL_SCALING_BINDINGS_MODULE=/absolute/path/to/horizontal-bindings.mjs
```

The module may export `createHorizontalScaleBindings`,
`horizontalScaleBindings`, or a default bindings object. Startup validates all
four services before accepting traffic and fails closed when an enabled binding
is incomplete. `/health` exposes the binding health and can make it
readiness-critical with `HORIZONTAL_SCALING_REQUIRED=true`.

Changing ring membership is a control-plane operation. Capture the current
assignment, change membership, call `rebalance(tags, oldAssignment)`, move the
listed tags, and only then publish the new ring generation. Two generations
must not write the same historian tag concurrently.

## Verification

Run:

```bash
npx vitest run server/scaling/__tests__/horizontal.test.ts
npx vitest run server/scaling/__tests__/horizontal-runtime.test.ts
npm run typecheck
npm run build
```

The focused suite covers deterministic assignment, membership churn, every
load-balancing mode, historian partial failures, ordered partition fan-out,
idempotent leases, and duplicate-node rejection.
