# ADR-0014: Production Scale Architecture

**Status:** Accepted  
**Date:** 2026-02-15  
**Deciders:** 0xSCADA Core Team  
**Supersedes:** —  
**References:** [ADR-0012 (CI/CD Pipeline)](ADR-0012-cicd-pipeline-architecture.md), [ADR-0013 (Autonomous Intelligence)](ADR-0013-autonomous-agent-architecture.md)

## Context

With the foundational CI/CD pipeline (ADR-0012) and autonomous intelligence layer (ADR-0013) in place, 0xSCADA has matured from a proof-of-concept SCADA platform into a feature-rich industrial monitoring system with blockchain-backed integrity, AI-driven analytics, and a robust development pipeline.

The next — and final foundational — challenge is preparing the platform for **production deployment at enterprise scale**. Real-world SCADA deployments range from hundreds to millions of tags, span multiple geographic sites, must operate in degraded network conditions, and face stringent regulatory requirements (IEC 62443, NIST CSF). The platform must scale horizontally, federate across sites, remain resilient offline, and provide the operational tooling teams need to run it in production with confidence.

## Decision

We will implement a comprehensive production-readiness layer comprising:

### 1. Performance Benchmarking Suite
Automated benchmarks at 10k, 100k, and 1M tag scales measuring event throughput, query latency (p50/p95/p99), WebSocket fan-out capacity, and blockchain anchoring rate. Regression detection ensures performance never silently degrades.

### 2. Horizontal Scaling Architecture
- **Sharded Gateways:** Consistent hashing assigns tags to gateway instances, with automatic rebalancing on node join/leave.
- **Server-Side Load Balancing:** Round-robin, weighted, and least-connections strategies for API and WebSocket traffic.
- **Distributed Historian:** Partitioned time-series storage with query federation across shards.
- **Event Pipeline Fan-Out:** The event pipeline from ADR-0012 scales horizontally via partitioned topics.

### 3. Multi-Site Federation Protocol
Multiple 0xSCADA instances connect as a federation:
- **Site Discovery:** mDNS + registry-based discovery with TLS mutual authentication.
- **Cross-Site Tag References:** Namespace-qualified tag addressing (`site:area/tag`).
- **Federated Alarm Views:** Unified alarm console aggregating across sites.
- **Unified Reporting:** Cross-site analytics and compliance reporting.
- **CRDTs:** Conflict-free replicated data types for configuration state that must merge without coordination.

### 4. Offline/Edge Resilience
- **Store-and-Forward:** Persistent local event queue when cloud connectivity is lost.
- **Automatic Sync:** Exponential-backoff reconnection with Merkle-root integrity verification.
- **Conflict Resolution:** Last-writer-wins for telemetry, merge for configuration, alert on divergence.
- **Edge Autonomy:** Local alarm evaluation and operator interface continue operating independently.

### 5. Compliance Certification Toolkit
- IEC 62443 security level assessment with automated checklist evaluation.
- NIST Cybersecurity Framework control mapping.
- Automated evidence collection and gap analysis.
- Audit report generation for certification bodies.

### 6. Production Monitoring & SRE Playbooks
- SLO/SLI definitions for all critical paths.
- Runbooks for common incidents (gateway failover, database recovery, scaling).
- Automated remediation for self-healing.
- Post-mortem templates and escalation procedures.

### 7. Zero-Downtime Upgrade System
- Rolling deployment orchestrator with canary stages.
- Database migration framework with automatic rollback.
- Feature flag system for gradual rollout.
- Version compatibility matrix enforcement.

### 8. Capacity Planning & Cost Modeling
- Resource estimation calculator (CPU, memory, storage, bandwidth per tag).
- Cloud cost projections for AWS, Azure, and GCP.
- Growth forecasting based on historical tag-count trends.
- Scaling recommendations with cost/performance trade-off analysis.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Federation Layer                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                 │
│  │  Site A   │──│  Site B   │──│  Site C   │  (CRDT sync)   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                 │
│       │              │              │                        │
├───────┼──────────────┼──────────────┼────────────────────────┤
│       ▼              ▼              ▼                        │
│  ┌─────────────────────────────────────────┐                │
│  │           Load Balancer                  │                │
│  │  (round-robin / weighted / least-conn)   │                │
│  └─────────────┬───────────────────────────┘                │
│                │                                             │
│  ┌─────────────┼───────────────────────────┐                │
│  │  ┌──────┐ ┌──────┐ ┌──────┐            │                │
│  │  │ GW-1 │ │ GW-2 │ │ GW-N │  Sharded   │                │
│  │  │(tags │ │(tags │ │(tags │  Gateways   │                │
│  │  │ 0-3k)│ │3k-6k)│ │6k-N) │            │                │
│  │  └──┬───┘ └──┬───┘ └──┬───┘            │                │
│  │     │        │        │                  │                │
│  │  ┌──▼────────▼────────▼──┐              │                │
│  │  │  Event Pipeline       │              │                │
│  │  │  (partitioned topics) │              │                │
│  │  └───────────┬───────────┘              │                │
│  │              │                           │                │
│  │  ┌───────────▼───────────┐              │                │
│  │  │  Distributed Historian │              │                │
│  │  │  (time-partitioned)    │              │                │
│  │  └────────────────────────┘              │                │
│  └──────────────────────────────────────────┘                │
│                                                              │
│  ┌──────────────────────┐  ┌────────────────────────┐       │
│  │  Edge/Offline Node    │  │  Compliance & SRE      │       │
│  │  ┌─────────────────┐ │  │  ┌──────────────────┐  │       │
│  │  │ Store & Forward  │ │  │  │ Compliance Scan  │  │       │
│  │  │ (local queue)    │ │  │  │ Auto-Remediation │  │       │
│  │  │ Merkle verify    │ │  │  │ Capacity Planner │  │       │
│  │  └─────────────────┘ │  │  └──────────────────┘  │       │
│  └──────────────────────┘  └────────────────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

## Integration with Existing Architecture

- **Health Manager (Wave 1):** All scaling components report health via the existing `HealthManager`. Shard status, federation heartbeats, edge sync state, and upgrade progress are all surfaced as health indicators.
- **Event Pipeline (ADR-0012):** Horizontal scaling partitions the existing event pipeline. Federation extends it cross-site.
- **Intelligence Layer (ADR-0013):** Predictive maintenance and anomaly detection operate per-shard with federated model aggregation.

## Consequences

### Positive
- Platform can scale from pilot (100 tags) to enterprise (1M+ tags) without architectural changes
- Multi-site federation enables global deployments with local autonomy
- Offline resilience makes the platform suitable for remote/hostile network environments
- Compliance toolkit accelerates certification for regulated industries
- SRE tooling reduces mean-time-to-recovery and operational burden
- Zero-downtime upgrades eliminate maintenance windows

### Negative
- Significant implementation complexity in distributed systems (CRDTs, consensus, partitioning)
- Federation protocol requires careful security design to prevent cross-site attack propagation
- Offline/online state reconciliation can produce surprising merge results
- Compliance mappings require ongoing maintenance as standards evolve

### Risks
- Over-engineering for current deployment scale — mitigated by progressive enablement via feature flags
- Federation security attack surface — mitigated by mutual TLS and signed message envelopes
- CRDT merge semantics may not suit all data types — mitigated by per-type conflict resolution strategy selection

## Future Work

This ADR represents the capstone of the foundational architecture. With Waves 1–3 complete, 0xSCADA has:
- A secure, blockchain-backed SCADA platform (core)
- A robust CI/CD and event pipeline (ADR-0012)
- An autonomous intelligence layer (ADR-0013)
- Production-scale operational readiness (this ADR)

Future directions beyond these foundations include:
- **Global Deployment:** Multi-region cloud deployment with data sovereignty controls
- **Regulatory Expansion:** NERC CIP, FDA 21 CFR Part 11, EU NIS2 compliance mappings
- **Community Ecosystem:** Open plugin API, community marketplace for agents and integrations, public protocol specification for federation interoperability
- **Autonomous Operations:** Closed-loop control where AI agents not only detect but autonomously remediate process anomalies within operator-defined safety envelopes
