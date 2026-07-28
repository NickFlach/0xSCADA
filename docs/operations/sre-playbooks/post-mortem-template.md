# Postmortem: [incident title]

- **Incident id:**
- **Date/time (UTC):**
- **Severity:**
- **Incident commander:**
- **Technical leads:**
- **Site/operator liaison:**
- **Authors/reviewers:**
- **Status:** Draft / Reviewed / Actions accepted

## Executive summary

In plain language: what happened, who/what was affected, duration, root cause,
mitigation, and current risk. Do not assign individual blame.

## Impact

- Sites/tags/subscribers affected:
- Process-safety impact and operator action:
- Data loss or unverified interval:
- Customer/operator-visible symptoms:
- Financial/compliance/security impact:

### SLO impact

| SLO id | Window | Bad/total events | Burn rate | Budget consumed | Good/bad recovery event |
|---|---|---:|---:|---:|---|
| | | | | | |

## Detection and response metrics

| Metric | UTC/duration |
|---|---|
| Failure began / earliest known impact | |
| First detection | |
| Page sent / acknowledged | |
| IC assigned | |
| Mitigation began | |
| Service restored | |
| Integrity/recovery verified | |

Explain any gap between failure, detection, page, mitigation, and verification.

## Timeline (UTC)

| Time | Actor/system | Observation, decision, or action | Evidence/result |
|---|---|---|---|
| | | | |

Include deployment/config revisions and remediation idempotency/execution ids.

## Technical root cause

Describe the failure mechanism and evidence. Distinguish:

- triggering event;
- direct technical cause;
- conditions that allowed the cause to create impact;
- why redundancy or controls did not prevent impact;
- why detection/response took as long as it did.

Avoid “human error” as a root cause; identify the system condition that made an
error possible or harmful.

## Recovery and verification

- mitigation and why it was chosen;
- dry-run/precondition/approval records;
- rollback attempted and result;
- tag freshness, database read/write, queue replay, and integrity verification;
- achieved RTO/RPO;
- how redundancy and alerting were restored.

## What helped / what hindered / where risk remained

### Helped

-

### Hindered

-

### Risk or luck

-

## Corrective actions

| Action | Type (prevent/detect/mitigate) | Owner | Priority | Due | Verification/acceptance test | Status |
|---|---|---|---|---|---|---|
| | | | | | | |

Every action needs one accountable owner and a testable completion condition.
Track actions outside this document and link the records.

## Evidence

Link immutable dashboards/queries, logs, alert payloads, configuration and
deployment revisions, capacity/compliance reports, audit records, and operator
notes. Redact credentials and regulated personal data.

## Review sign-off

- Service owner:
- Incident commander:
- Site/operator representative (when applicable):
- Security/compliance reviewer (when applicable):
- Action tracker:
