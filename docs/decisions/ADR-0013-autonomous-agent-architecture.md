# ADR-0013: Autonomous Agent Architecture

| Field     | Value                          |
| --------- | ------------------------------ |
| Status    | Accepted                       |
| Date      | 2026-02-15                     |
| Deciders  | Nick Flach, flaukowski         |
| Relates   | ADR-0008, ADR-0009, ADR-0012  |

## Context

With the end-to-end integration pipeline established (ADR-0012), 0xSCADA can ingest, route, and persist sensor data reliably. The next evolution is adding an **intelligence layer** — autonomous agents that observe process data, detect anomalies, correlate alarms, simulate outcomes, and take (or recommend) corrective actions.

Industrial control systems generate massive volumes of data. Human operators face alarm fatigue, delayed fault detection, and difficulty optimizing complex multi-variable processes. Autonomous agents can augment human decision-making by providing predictive maintenance alerts, root-cause analysis, digital twin simulations, and natural language querying.

## Decision

We will build an **intelligence and autonomy layer** on top of the integration pipeline with the following architecture:

```
Sensor Data → Event Pipeline → Intelligence Layer → Agent Decision → Action / Alert
                                     │
                            ┌────────┼────────┐
                            │        │        │
                       Predictive  Alarm   Digital
                       Maintenance Corr.   Twin
                            │        │        │
                            └────────┼────────┘
                                     │
                              Agent Orchestrator
                              (GhostOS Bridge)
                                     │
                            ┌────────┼────────┐
                            │        │        │
                        PID Auto  NL Query  Reporting
                        Tuner     Engine    Engine
```

### Core Principles

1. **Operational Envelopes (ADR-0009)**: Every agent operates within defined safety boundaries. No agent can exceed its measured emergence guardrails. PID auto-tuning, for example, requires human approval before applying parameter changes.

2. **Zero-Trust Capability Tokens (ADR-0008)**: Agent permissions are governed by capability tokens. An agent that reads sensor data cannot write control outputs unless explicitly granted that capability. Tokens are scoped, time-limited, and auditable.

3. **Human-in-the-Loop by Default**: Agents recommend actions; humans approve. Only after certification (ADR-0010) and within strict envelopes can agents act autonomously.

4. **Pipeline Integration (ADR-0012)**: All intelligence modules consume events from the existing event pipeline. They do not bypass the established data flow.

### Intelligence Modules

| Module | Purpose | Input | Output |
|--------|---------|-------|--------|
| Predictive Maintenance | Detect anomalies before failure | Tag time-series | Severity-rated alerts |
| Alarm Correlator | Reduce alarm fatigue | Raw alarms | Correlated alarm groups + root cause |
| Digital Twin Runtime | Simulate process state | Live sensor data + models | Predictions, what-if results |
| PID Auto-Tuner | Optimize controller parameters | Process response data | Tuning recommendations (human-approved) |
| NL Query Engine | Natural language process queries | User questions | Structured answers from tag data |
| Agent Marketplace | Plugin system for agents | Agent manifests | Installed, sandboxed agent instances |
| GhostOS Bridge | Multi-agent coordination | Agent states | Synchronized agent behavior (Kuramoto) |
| Reporting Engine | Automated report generation | Historical data | Shift reports, compliance summaries |

### Agent Marketplace & Extensibility

A plugin system allows third-party and internal agents to be registered, installed, and run in sandboxed contexts. Each plugin declares its required capabilities, and the zero-trust system grants only what's needed.

### GhostOS Integration

The consciousness stack concepts map to practical implementations:
- **Signal** → Raw sensor data and events
- **Resonance** → Correlated patterns across multiple signals
- **Emergence** → Autonomous decisions arising from pattern recognition

Kuramoto-model coupling synchronizes multi-agent behavior, preventing conflicting actions and enabling coordinated response to complex scenarios.

## Consequences

### Positive
- Proactive fault detection reduces unplanned downtime
- Alarm correlation dramatically reduces operator fatigue
- Digital twin enables safe "what-if" analysis before real changes
- Natural language queries make process data accessible to non-experts
- Plugin marketplace enables community-driven innovation

### Negative
- Increased system complexity and attack surface
- Agents require careful testing and certification before deployment
- ML models need training data and ongoing validation
- Additional compute resources for simulation and inference

### Risks
- Autonomous actions without proper guardrails could cause process upsets
- Over-reliance on agent recommendations without human verification
- Model drift in predictive maintenance without retraining

## Future Work (Wave 3: Production Readiness & Scale)

- Kubernetes operator for distributed agent deployment
- Federated learning across multiple plant sites
- Real-time model retraining pipelines
- Formal verification of agent safety properties
- NERC CIP and IEC 62443 compliance certification
- Multi-site digital twin federation
- Edge deployment for latency-critical agents
