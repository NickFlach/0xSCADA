# Zero-downtime upgrade system

This document is the executable companion to
[ADR-0014](../decisions/ADR-0014-production-scale-architecture.md) for issue
[#227](https://github.com/NickFlach/0xSCADA/issues/227).

`server/scaling/upgrade.ts` provides:

- `VersionCompatibilityMatrix`, which fails closed for every transition that
  has not been deliberately certified.
- `TypedFeatureFlags<Schema>`, with runtime validators, stable subject
  hashing, percentage rollout, site targeting, and include/exclude overrides.
- `ReversibleMigrationRunner`, whose append-only journal records migration and
  rollback boundaries. A failed run rolls back the failing migration and every
  migration applied in that run in reverse order.
- `RollingCanaryOrchestrator`, which validates compatibility before its first
  side effect, upgrades deterministic canaries, applies health gates, rolls the
  remaining nodes, and restores every touched node to its original version
  after failure.
- `JsonFileUpgradeJournal`, an fsync-backed journal for a single controller.

Startup recovery classifies incomplete migration and rollout journal entries
before beginning new work. Journal write failures never skip a safety rollback.
A controller restart health-checks a target-version node left drained, restores
traffic only when healthy, and otherwise rolls it back to its recorded original
version.

Deployment adapters must make `drain`, `restoreTraffic`, and `rollback`
idempotent because a call can fail after partially changing external state.
Multi-controller deployments must bind the journal interfaces to a
transactional store with leader election; the included JSON journal is for one
controller and the in-memory journals are for tests or embedded use.

## Verification

Run:

```bash
npx vitest run server/scaling/__tests__/upgrade.test.ts
npm run typecheck
npm run build
```

The focused suite covers compatibility rejection before side effects, typed
feature rollout, forward and reverse migrations, incomplete-journal recovery,
journal failures, canary health failure, rollout restart recovery, and durable
journal persistence.
