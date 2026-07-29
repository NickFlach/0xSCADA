# Historian Database Recovery Runbook

**Objectives:** verified read/write service within 15 minutes and recovery
point no older than 60 seconds (`database-recovery-rto`).

Database promotion, destructive repair, and point-in-time restore are high-risk
actions. The incident commander and data-platform owner must approve them.

## Stabilize

1. Declare the incident and notify site operators of historian/control impact.
2. Freeze schema changes, retention jobs, and deploys.
3. If split brain or corruption is possible, fence writes before failover.
4. Keep the event pipeline/store-and-forward accepting durable queued events.
5. Capture UTC time, primary/replica roles, replication lag, WAL position,
   connection count, disk/inode usage, and last verified backup.

Never promote a replica until the old primary is fenced or independently
confirmed down.

## Diagnose

Classify the failure:

- **pool exhaustion:** database accepts direct queries but application
  connections are saturated;
- **capacity:** disk/inodes/connections/IOPS exhausted;
- **primary loss:** primary unreachable, replica healthy and within RPO;
- **logical corruption:** queries succeed but data or integrity proof is wrong;
- **regional/storage loss:** neither primary nor local replica is usable.

For PostgreSQL, capture read-only diagnostics such as `pg_stat_activity`,
`pg_stat_replication`, recovery state, replay timestamp, and database size.
Use credential-safe tooling; never paste secrets into incident chat.

## Recovery paths

### Pool exhaustion

1. Identify leaking/long-running clients and stop the source.
2. Cancel only confirmed non-critical queries.
3. Recycle the application pool once; do not repeatedly restart it.
4. Verify connection count, query latency, and new historian writes.
5. Use the capacity plan before raising connection limits.

### Primary failover

1. Fence the old primary.
2. Confirm candidate replay lag meets the 60-second RPO.
3. Record promotion approval and candidate WAL/replay position.
4. Promote exactly one candidate using the database platform's supported flow.
5. Route a canary writer, then verify read-after-write and integrity proof.
6. Switch production writers and readers.
7. Rebuild redundancy; never attach the old primary as writable.

### Point-in-time restore

1. Restore the last verified backup into an isolated target.
2. Replay logs to the last consistent point before corruption.
3. Compare restored Merkle roots/anchors and sample business-critical tags.
4. Record the exact recovery point and quantified loss window.
5. Fence the corrupt system, approve the cutover, and route canary traffic.
6. Replay queued events with deduplication and sequence validation.

## Verification

- new writes are durable and readable from the normal API path;
- sample queries cover critical tags and retention boundaries;
- Merkle roots/proofs verify before and after queued replay;
- replication is healthy and a new recovery point exists;
- queued-event age and depth decrease;
- achieved RTO/RPO is recorded as a good or bad SLO event;
- site operator confirms historian-dependent workflows.

If integrity cannot be proven, service is not recovered even if queries return.
Escalate as SEV-1 and involve the security/integrity owner.

## Follow-up

Verify a fresh backup, restore HA, remove temporary routing, rotate exposed
credentials, and attach diagnostic/recovery evidence to the postmortem.
