# ADR-0012: End-to-End Integration

## Status

Accepted

## Date

2026-02-15

## Context

0xSCADA has grown organically across multiple PRs, adding OPC-UA/Modbus drivers, an event batcher, blockchain anchor bridge, historian connector, P&ID renderer, RBAC, audit logging, and more. These components exist as standalone modules but are not wired into a unified pipeline. There is no single path from a field device event to a rendered dashboard update, no shared configuration system, no migration runner, and no CI/CD pipeline that validates everything together.

Wave 1 ("Integration & End-to-End") addresses this by connecting all existing components into a cohesive, tested, deployable system.

## Decision

Wire all components into a unified event pipeline with the following data flow:

```
Gateway (OPC-UA / Modbus)
  → EventPipeline (orchestrator with backpressure)
    → EventBatcher (Merkle batching)
      → EventAnchorBridge (blockchain anchoring)
    → HistorianConnector (time-series persistence)
  → WebSocket → Frontend (live dashboard)
```

Specifically, Wave 1 delivers:

1. **Unified Event Pipeline** — Orchestrator connecting OpcUaSubscriptionManager → EventBatcher → EventAnchorBridge → HistorianConnector with health monitoring and backpressure
2. **API Gateway & Rate Limiting** — Express middleware for rate limiting, API key auth, request validation, versioned routes
3. **Database Migrations & Schema** — Numbered migration files for RBAC, audit logs, alarms, historian, recipes with a migration runner
4. **Real-Time Dashboard** — Live dashboard connecting WebSocket tag data to P&ID components
5. **CI/CD Pipeline** — GitHub Actions: lint → type-check → test → build → docker → integration-test
6. **E2E Integration Tests** — End-to-end test scenarios validating full pipeline flows
7. **Configuration Management** — Zod-validated config with environment variable mapping and startup validation
8. **Service Health & Readiness** — /healthz and /readyz endpoints aggregating all service dependencies

## Consequences

### Positive

- All components are exercised together, catching integration bugs early
- New contributors can run one pipeline and see the full flow
- CI/CD prevents regressions across packages
- Structured migrations make database changes reproducible
- Health endpoints enable Kubernetes readiness/liveness probes

### Negative

- Increased coupling between previously independent modules
- Migration runner adds operational complexity
- Full pipeline requires all services running (mitigated by health checks and graceful degradation)

### Neutral

- Existing standalone module tests remain valid and useful
- Individual modules can still be developed in isolation

## Alternatives Considered

### Alternative 1: Microservice Event Bus (NATS/Kafka)

A message broker would decouple services further but adds infrastructure complexity inappropriate for the current project stage. Can be revisited in Wave 3.

### Alternative 2: Monorepo Build Tool (Turborepo/Nx)

Would improve build orchestration but doesn't address runtime integration. CI/CD pipeline achieves the build-time goals; runtime integration is the priority.

## Future Work — Wave 2: Intelligence & Autonomy

Wave 2 will build on this integrated foundation:

- **AI/ML Anomaly Detection** — Feed historian data into ML models for predictive maintenance
- **Autonomous Agent Governance** — Agents that can propose and execute operational changes within guardrails (ADR-0007, ADR-0009)
- **Advanced Consensus** — Resonant consensus (Kuramoto-BFT, shipped in 0xSCADA-node — see its ADR-0001) and sublinear solver integration for multi-site coordination
- **Digital Twin Simulation** — Use the unified pipeline to drive real-time digital twin models
- **Federated Learning** — Cross-site model training without centralizing sensitive process data

## References

- [ADR-0001: Hybrid On/Off-Chain Architecture](ADR-0001-hybrid-on-off-chain-architecture.md)
- [ADR-0005: OPC-UA Protocol Driver](ADR-0005-opcua-protocol-driver.md)
- [ADR-0006: PostgreSQL Event Persistence](ADR-0006-postgresql-event-persistence.md)
- [ADR-0007: Agent-Based Governance](ADR-0007-agent-based-governance.md)
- [Event Anchor Bridge Architecture](../architecture/event-anchor-bridge.md)
- [Event Batching Architecture](../architecture/event-batching.md)
- [Historian Integration](../integrations/historian.md)
