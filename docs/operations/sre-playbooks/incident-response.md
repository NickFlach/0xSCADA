# Incident Response Runbook

Use this runbook for production alerts, operator reports, and exhausted critical
SLO budgets. Process safety takes priority over service restoration. Site
operators retain authority over physical control and safe-state decisions.

## First five minutes

1. Acknowledge the page and create an incident id.
2. Record UTC start time, alert source, affected site(s), and current operator.
3. If process safety may be affected, contact the site/operator liaison and
   follow the site's safe-state procedure before changing software.
4. Assign severity using the
   [escalation policy](escalation-policy.md); page secondary at half the
   acknowledgement target.
5. Freeze deployments to affected components. Preserve logs and avoid restarts
   until volatile evidence and current assignments are captured.

## Severity

| Level | Impact | Acknowledge |
|---|---|---:|
| SEV-1 | Safety impact, confirmed data loss, integrity compromise, or multi-site control loss | 5 min |
| SEV-2 | Critical path unavailable/degraded, exhausted SLO, or failed site failover | 15 min |
| SEV-3 | Limited degradation with a safe workaround | 60 min |
| SEV-4 | No production impact | 1 business day |

## Establish blast radius

Record:

- sites, gateways, shards, tags, and subscribers affected;
- earliest and latest known-good event timestamps;
- store-and-forward queue depth and oldest queued event;
- database read/write status and last verified backup;
- relevant SLO id, SLI, burn rate, and remaining budget;
- recent deploy/config/certificate/network changes;
- whether telemetry itself is absent (`no-data` is not healthy).

Use `/api/health`, component metrics, and
`GET /api/governance/sre/slos`. Evaluate known counter deltas with
`POST /api/governance/sre/slos/:sloId/evaluate`.

## Mitigate

Choose the narrowest reversible action:

- stale tags or gateway heartbeat loss:
  [gateway failover](gateway-failover.md);
- database write/read failure:
  [database recovery](database-recovery.md);
- sustained capacity saturation:
  [scaling](scaling-runbook.md);
- supported self-healing action:
  [automated remediation](automated-remediation.md).

Always dry-run automation first. A blocked precondition is a safety decision,
not an obstacle to bypass. High-risk remediation requires an authenticated
approver and IC acknowledgement.

## Communicate

Every update states:

- UTC timestamp and incident severity;
- user/operator impact and process-safety state;
- affected scope;
- mitigation completed and its verification;
- current hypothesis, confidence, and next action;
- next update time.

SEV-1 updates are every 15 minutes; SEV-2 every 30 minutes. Never state that
data is intact until historian reads and integrity proofs are verified.

## Recovery and closure

Do not resolve until:

1. the affected SLI remains at baseline for one evaluation interval;
2. all shards/tags are fresh and store-and-forward queues are draining;
3. historian writes are readable and integrity-verifiable;
4. rollback/failover state is documented and redundancy restored;
5. the site operator confirms normal operating state;
6. monitoring and paging are active;
7. the IC records remaining risk and owns follow-up.

Schedule a SEV-1/2 review within 48 hours using
[the postmortem template](post-mortem-template.md). Attach remediation
idempotency keys and audit results.
