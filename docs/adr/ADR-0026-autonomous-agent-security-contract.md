# ADR-0026: Autonomous Agent Security and Integration Contract

| Field | Value |
| --- | --- |
| Status | Proposed |
| Date | 2026-07-23 |
| Author | Neel Modha |
| Refines | ADR-0013 |
| Relates | ADR-0008, ADR-0009, ADR-0012 |

## Context

The accepted
[`ADR-0013: Autonomous Agent Architecture`](../decisions/ADR-0013-autonomous-agent-architecture.md)
defines the intelligence-layer architecture. This proposal does not replace,
backdate, or alter the provenance of that decision. It proposes an additional
security and integration contract for implementations governed by ADR-0013.

0xSCADA's event pipeline can ingest, route, and persist sensor data. The
intelligence layer augments operators with anomaly detection, alarm
correlation, simulation, tuning recommendations, natural-language queries, and
coordinated agents without bypassing the established event pipeline.

## Decision

If accepted, ADR-0013 implementations must follow this flow:

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

This table states requirements for conforming implementations. It is not a
claim that the current or proposed modules already satisfy them.

| Module | Input | Output |
| --- | --- | --- |
| Predictive maintenance | Tag time-series | Severity-rated findings |
| Alarm correlation | Raw alarms | Correlated groups and likely root cause |
| Digital twin | Sensor data and models | Predictions and what-if results |
| PID tuning | Process response | Proposal that MUST require an authorized human approval before actuation |
| NL query | Authenticated question | Structured process-data answer |
| Marketplace | Agent manifest that MUST be signature-verified before registration | Registered plugin that MUST execute inside an enforced sandbox |
| ghostmagicOS bridge | Agent state | Coordinated agent behavior |
| Reporting | Historical data | Shift and compliance reports |

### ghostmagicOS coordination

The coordination model maps **Signal** to sensor events, **Resonance** to
correlated patterns, and **Emergence** to decisions. Kuramoto-style coupling
may synchronize recommendations, but synchronization does not grant actuation
authority or bypass approval and envelope checks.

## Current compliance gaps

This ADR is **Proposed** because the current implementation and open
intelligence-layer work do not yet satisfy the contract. Acceptance must not be
interpreted as evidence that these gaps are closed.

| Contract area | Current gap | Acceptance evidence required |
| --- | --- | --- |
| Authentication | Global API-key authentication is not enabled on current `main`; several route-local `requireAuth` functions are no-op placeholders, including `server/routes/alarms.ts` and `server/routes/geometry.ts`. | Authentication fails closed in production and protected-route tests prove unauthenticated requests are rejected. |
| Authorization | Mutating control routes do not consistently enforce separate read, recommend, approve, and actuate scopes. | A route inventory maps every control mutation to a least-privilege scope and tests both allowed and denied principals. |
| Authenticated identity | There is no repository-wide guarantee that operator and approver identities come only from the authenticated principal. | Request schemas reject caller-supplied actor identities and audit tests verify principal-derived attribution. |
| WebSocket access | `server/websocket/types.ts` currently defaults `requireAuth` to `false`, outside Express middleware coverage. | HTTP upgrade authentication and authorization are enabled and tested for `/ws` and `/ws/tags`. |
| Durable approvals | Proposed intelligence services include process-local state; restart-safe approval and audit persistence is not demonstrated for the full 13.x series. | Restart tests prove pending approvals and immutable audit attribution survive process replacement. |
| Marketplace isolation | The proposed marketplace does not yet demonstrate manifest-signature verification or memory/process isolation for plugins. | Invalid signatures are rejected and an isolation test proves a plugin cannot access undeclared host capabilities. |
| Physical actuation | Envelope enforcement and fail-closed behavior are not proven at every physical-output adapter. | Adapter-level tests reject out-of-envelope, stale, unauthenticated, and unauthorized commands before output. |

Each implementation PR governed by ADR-0013 must identify the applicable rows
above and provide the corresponding evidence. Gaps may be closed by separate,
focused PRs; they may not be waived by documentation alone.

## Consequences

The architecture can reduce downtime and alarm fatigue, but it expands the
attack surface and creates durable-state requirements. Autonomous behavior
therefore remains disabled until its capability, certification, persistence,
and physical-output adapter are all explicitly configured and tested.

## Relationship to ADR-0013

ADR-0013 remains the accepted architectural decision and retains its original
authors, date, and status. If repository maintainers accept this proposal,
ADR-0026 becomes the normative security and integration contract that refines
ADR-0013; until then, it records proposed requirements and known gaps only.
