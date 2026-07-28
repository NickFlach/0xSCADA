# Scaling Runbook

Use this runbook for sustained saturation, forecasted growth, or reduced
failover reserve. Prefer horizontal scale-out. Scale-down and storage changes
need explicit review because they can reduce redundancy or destroy data.

## Triggers

| Signal | Trigger | Required duration/action |
|---|---:|---|
| Tags per gateway | 70% of planned limit | Plan another gateway before 80% |
| CPU | 70% | Scale after 15 minutes if queue/latency agrees |
| Memory | 75% | Scale after 15 minutes; investigate leak first |
| Storage | 70% | Provision before 80%; do not wait for exhaustion |
| Error budget | 50% consumed | Freeze nonessential load; review capacity |
| Queue age/depth | Increasing for 10 minutes | Scale consumers if downstream is healthy |

A single hot metric is not sufficient. Confirm it correlates with queueing,
latency, workload, or forecast growth.

## Build the plan

Send observed workload and history to
`POST /api/governance/capacity/plan`. Review all three strategies and replace
reference cloud rates with contracted rates before financial approval. For
production, default to balanced; use performance for rapid/low-confidence
growth, and cost-optimized only for stable, high-confidence demand.

## Automated scale-out

`createScaleOutAction` requires `component`, `desiredReplicas`, and
`maximumReplicas`.

1. Confirm current desired/ready replicas and per-instance load.
2. Check quotas, placement capacity, database/event-bus connection limits, and
   certificate/secret availability.
3. Dry-run with a stable incident/change idempotency key.
4. Verify desired replicas do not exceed the approved maximum.
5. Apply with a distinct key.
6. The action succeeds only when ready replicas reach desired state; otherwise
   it restores the previous replica count.

## Component checks

### Gateway

Register the new identity/certificate, prove device-network reachability, start
drained, move a canary shard, then rebalance. Verify no tag has multiple active
owners and no historian duplicates are introduced.

### API/WebSocket

Add the instance to the correct consumer group, start outside the load-balancer
pool, pass readiness, then admit a small traffic percentage. Verify session
reconnects, event ordering, p95/p99 latency, and connection distribution.

### Historian

Provision storage/partition/replica through the database platform. Verify
backup policy, retention, query federation, integrity proofs, and IOPS before
routing writes. Do not use application replica scaling as a substitute for
database capacity.

## Scale-down

1. Confirm the 30-day forecast plus failover reserve still fits.
2. Freeze rebalancing and capture current assignments.
3. Drain one instance; wait for connections/partitions/shards to reach zero.
4. Observe one full SLI interval.
5. Remove the instance from discovery, then deprovision.
6. Stop immediately if error budget, queue age, or per-instance utilization
   crosses its trigger.

Never scale below two gateway/API instances in an HA workload or remove the
last verified database replica.

## Completion

Update the retained capacity plan with actual replica count and cost, verify all
critical SLOs, restore alerting, and record plan/automation ids in the change or
incident.
