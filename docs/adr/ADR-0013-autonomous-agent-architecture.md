# ADR-0013: Autonomous Agent Architecture

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-02-15 |
| Deciders | Nick Flach, flaukowski |
| Relates | ADR-0008, ADR-0009, ADR-0012 |

## Context

0xSCADA's event pipeline can ingest, route, and persist sensor data. The
intelligence layer augments operators with anomaly detection, alarm
correlation, simulation, tuning recommendations, natural-language queries, and
coordinated agents without bypassing the established event pipeline.

## Decision

The intelligence layer is built on the following flow:

```text
Sensor Data -> Event Pipeline -> Intelligence Layer -> Recommendation
                                      |
                             Human approval gate
                                      |
                                Action / Alert
```

It contains predictive maintenance, alarm correlation, digital-twin
simulation, PID tuning, natural-language querying, the agent marketplace,
ghostmagicOS coordination, and reporting.

### Safety and security invariants

1. **Human approval is the default.** Agents may recommend changes, but
   control-output or controller-parameter mutations require an authenticated
   operator with an authorized control-plane role.
2. **Identity comes from authentication.** Audit `operator`, `approver`, and
   actor fields must be derived from the authenticated principal, never from a
   request body or a caller-controlled header.
3. **Least privilege applies to every module.** Read, recommend, approve, and
   actuate are separate capabilities. Possessing one never implies another.
4. **Operational envelopes are enforced at the actuation boundary.** A tuning
   or control request outside its envelope fails closed.
5. **Intelligence modules consume the event pipeline.** They may not create a
   hidden sensor-data or control-output path.
6. **Pending approvals and audit records are durable.** Restarting or
   redeploying the API must not silently approve, discard, or rewrite them.
7. **Optional integrations fail closed and do not crash the SCADA API.**
   Misconfigured brokers, plugins, and agent runtimes are reported unhealthy
   without taking down unrelated control or monitoring paths.

### Modules

| Module | Input | Output |
| --- | --- | --- |
| Predictive maintenance | Tag time-series | Severity-rated findings |
| Alarm correlation | Raw alarms | Correlated groups and likely root cause |
| Digital twin | Sensor data and models | Predictions and what-if results |
| PID tuning | Process response | Human-approved tuning proposal |
| NL query | Authenticated question | Structured process-data answer |
| Marketplace | Signed agent manifest | Sandboxed registered plugin |
| ghostmagicOS bridge | Agent state | Coordinated agent behavior |
| Reporting | Historical data | Shift and compliance reports |

### ghostmagicOS coordination

The coordination model maps **Signal** to sensor events, **Resonance** to
correlated patterns, and **Emergence** to decisions. Kuramoto-style coupling
may synchronize recommendations, but synchronization does not grant actuation
authority or bypass approval and envelope checks.

## Consequences

The architecture can reduce downtime and alarm fatigue, but it expands the
attack surface and creates durable-state requirements. Autonomous behavior
therefore remains disabled until its capability, certification, persistence,
and physical-output adapter are all explicitly configured and tested.

## Canonical source

This file is the normative security and integration contract for ADR-0013.
The longer architectural narrative remains in
[`docs/decisions/ADR-0013-autonomous-agent-architecture.md`](../decisions/ADR-0013-autonomous-agent-architecture.md).
