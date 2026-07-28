# Automated Remediation Operations

`AutoRemediationEngine` runs only injected, registered actions. It does not
execute arbitrary shell text. Two production adapters are included:

- `createGatewayFailoverAction`: inspect, drain/rebalance, verify tag coverage,
  and restore previous assignments if verification fails;
- `createScaleOutAction`: increase replicas under an operator-supplied hard
  maximum, verify ready replicas, and roll back on failure.

## Required execution sequence

1. Correlate the alert to an incident and choose a stable idempotency key, such
   as `INC-1234:gateway-failover:gw-07`.
2. Run with `dryRun: true`. The engine evaluates the same safety precondition
   used by a real execution but performs no mutation.
3. Review scope, risk, desired state, hard maximum, and available failover
   capacity.
4. Execute with a new apply key, such as
   `INC-1234:gateway-failover:gw-07:apply-1`.
5. Retain the result and engine audit entry with the incident.
6. Escalate any `blocked`, `failed`, or `rolled-back` result.

Reusing the same key and identical request returns the original result without
executing again. Reusing the key for different context is rejected.

## Safety controls

- action allowlist;
- automatic risk ceiling (high-risk actions require `approvedBy`);
- action-specific precondition and hard bounds;
- per-action/resource cooldown;
- global executions-per-hour limit;
- post-change verification;
- rollback where the adapter supports it;
- bounded audit history.

A dry run does not reserve an apply key or bypass cooldown. Use a distinct key
for apply. `approvedBy` is an identity record, not an authorization mechanism;
the caller must authenticate and authorize it before invoking the engine.

## Result handling

| Status | Meaning | Operator response |
|---|---|---|
| `planned` | Dry-run checks passed | Review and apply with a new key |
| `skipped` | Desired state already holds or action changed nothing | Verify alert clears; investigate noisy trigger |
| `blocked` | Allowlist, risk, safety, cooldown, or rate limit stopped action | Do not bypass; escalate to incident commander |
| `succeeded` | Mutation completed and verification passed | Monitor SLI through one full evaluation interval |
| `rolled-back` | Verification failed; prior state restored | Escalate and use manual runbook |
| `failed` | Precheck/execution failed, or rollback unavailable/failed | Treat state as unknown; page owning team |

The process-local audit log is operational telemetry, not durable evidence.
Production integrations must persist each result in the incident/audit store
before acknowledging success.
