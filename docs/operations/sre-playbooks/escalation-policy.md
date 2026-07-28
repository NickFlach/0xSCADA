# On-Call Escalation Policy

## Roles

- **Primary on-call:** acknowledges, triages, and starts the incident record.
- **Secondary on-call:** joins when the primary does not acknowledge or when a
  second technical workstream is needed.
- **Incident commander (IC):** owns severity, safety, coordination, and
  communication; does not perform risky repair while commanding.
- **Site/operator liaison:** coordinates control-room impact and confirms
  process safety.
- **Communications lead:** owns internal/external updates for SEV-1 and SEV-2.
- **Service owner:** supplies component expertise and owns follow-up actions.

## Severity and response targets

| Severity | Examples | Acknowledge | IC assigned | Update cadence |
|---|---|---:|---:|---:|
| SEV-1 | Safety impact, confirmed data loss, multi-site control loss, integrity compromise | 5 min | 10 min | 15 min |
| SEV-2 | Critical path unavailable/degraded, SLO exhausted, single-site failover failure | 15 min | 20 min | 30 min |
| SEV-3 | Limited degradation with safe workaround | 60 min | As needed | 2 hours |
| SEV-4 | No production impact | 1 business day | No | At resolution |

## Escalation ladder

1. Page primary and create the incident record.
2. At half the acknowledgement target, page secondary.
3. At the target, page the service owner and on-call manager; assign an IC.
4. For SEV-1, or any possible process-safety impact, notify the site/operator
   liaison immediately. The operator retains authority over physical process
   control.
5. At twice the target without mitigation, escalate to engineering leadership
   and the continuity/security lead as applicable.
6. Engage the security lead immediately for credential compromise, unexpected
   cross-zone access, integrity proof failure, or suspected malicious activity.
7. Engage legal/privacy/compliance through the approved internal channel when
   notification obligations may apply; engineers do not make disclosure
   determinations themselves.

If paging infrastructure is unavailable, use the maintained offline call tree.
The call tree contains personal data and is intentionally not stored in this
repository.

## Handoff requirements

The outgoing responder must state:

- incident id, severity, IC, and current owner;
- affected sites/tags and process-safety state;
- current hypothesis and evidence;
- actions attempted, idempotency keys, and exact results;
- SLO/error-budget impact;
- next action and next update deadline.

SEV-1/2 incidents require a postmortem within 48 hours. SEV-3 incidents require
one when the same failure recurs, the budget impact is material, or the service
owner requests it.
