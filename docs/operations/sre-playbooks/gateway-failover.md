# Gateway Failover Runbook

**Objective:** restore fresh telemetry for all affected shards within 60
seconds of confirmed heartbeat loss (`gateway-failover-rto`).

## Trigger and false-positive checks

Trigger after three missed heartbeat intervals or confirmed process exit.
Before failover, check:

- monitoring path is healthy and time is synchronized;
- the gateway is not in an approved maintenance/drain window;
- failure is not a shared device-network outage;
- at least one healthy peer has capacity for every affected shard;
- store-and-forward is active at disconnected edge nodes.

If no healthy peer has capacity, automation must block. Page the incident
commander and use the site's degraded-operation procedure.

## Capture before mutation

Record gateway id, certificate expiry, last heartbeat, assigned shards, tag
freshness, queue depth, peer capacity, and current routing/assignment version.
Preserve gateway logs. Do not restart before this evidence is captured unless a
site safety procedure requires it.

## Automated path

Use `createGatewayFailoverAction` through the configured
`AutoRemediationEngine`:

1. dry-run with `INCIDENT:gateway-failover:GATEWAY:plan`;
2. confirm the plan reports affected shards and a healthy peer count ≥ 2;
3. apply with `INCIDENT:gateway-failover:GATEWAY:apply-1`;
4. retain the result in the incident.

The action drains/rebalances, verifies coverage, and restores previous
assignments if verification fails. `blocked`, `failed`, or `rolled-back`
requires manual escalation.

## Manual path

1. Mark the failed gateway unavailable in the authoritative shard/routing
   control plane.
2. Reassign only its shards to healthy peers within their capacity limits.
3. Confirm new owners have the correct device credentials and network reach.
4. Start or confirm store-and-forward replay using sequence/integrity checks.
5. Quarantine the failed gateway from routing until its root cause is known.
6. Repair/restart it, but reintroduce it in a drained state.
7. Move a small canary shard back; verify freshness and duplicate suppression.
8. Rebalance the remaining shards gradually.

Do not manually edit multiple replicas of assignment state. Use the
authoritative control plane and retain its before/after revision.

## Verification

- every shard has exactly one active owner;
- critical tags are fresh and good quality;
- `gateway-failover-rto` records a good event, or the miss is recorded;
- no duplicate or out-of-order historian writes;
- Merkle/integrity verification passes across replayed events;
- edge queues decrease monotonically;
- WebSocket reconnect/error rate returns to baseline;
- HA capacity is restored after the failed node returns.

If any verification fails, stop rebalancing, preserve current state, and
escalate. Do not repeatedly cycle failover with new idempotency keys.

## Common causes

- expired/revoked gateway certificate: rotate through the approved PKI flow and
  validate mTLS before reintroduction;
- device-network outage: keep local autonomy/store-and-forward active and
  involve the site network owner;
- process crash/resource exhaustion: collect dump/resource metrics, then use
  the [scaling runbook](scaling-runbook.md);
- bad deployment: roll back the deployment before returning shards.
