# Automated Remediation Operations

`AutoRemediationEngine` runs only injected, registered actions. It does not
execute arbitrary shell text. `RemediationRuntime` composes two bounded adapter
contracts:

- `createGatewayFailoverAction`: inspect, drain/rebalance, verify tag coverage,
  and restore previous assignments if verification fails;
- `createScaleOutAction`: increase replicas under an operator-supplied hard
  maximum, verify ready replicas, and roll back on failure.

The runtime remains unavailable until the deployment injects at least one
adapter and a durable `RemediationAuditSink`. Supply this with the
`remediation` option to `registerRoutes`; `JsonlRemediationAuditSink` is the
built-in persistent-volume implementation. An unconfigured runtime returns
503 instead of simulating success.

Execution is exposed at:

```http
POST /api/governance/sre/remediations/execute
X-API-Key: <key with sre.remediate and operator grants>
Content-Type: application/json

{
  "actionId": "scale-out",
  "context": {
    "component": "api",
    "desiredReplicas": 4,
    "maximumReplicas": 6
  },
  "idempotencyKey": "INC-1234:scale-out:api:apply-1",
  "dryRun": false
}
```

The route authenticates and authorizes before parsing the body. `approvedBy`
is bound to the server-owned API-key principal and cannot be supplied by the
caller. Requests default to `dryRun: true`.

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
- bounded audit and idempotency history.

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

The process-local engine audit log is operational telemetry. The production
runtime does not acknowledge a result until its configured durable audit sink
accepts it. If persistence fails after an action, the idempotent result is
preserved so retrying the same key records the original outcome without
re-executing the mutation.
