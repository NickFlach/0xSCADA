# ADR-0022: Constellation Unification — Absorbing SIN & QuantumSingularity into 0xSCADA

**Status:** Accepted  
**Date:** 2026-03-04  
**Supersedes:** None  
**Superseded by:** None  

## Context

Three separate repositories have been evolving in parallel, each addressing different facets of industrial control, AI verification, and agent-to-agent communication:

| Repository | Status | Description |
|---|---|---|
| **SIN** | DEAD — organ donor | 5 SCADA vendor adapters (Rockwell, Siemens, Emerson, Yokogawa, Schneider), East/West/NULL_ISLAND regional topology, Neo N3 smart contract governance, 5-layer verification pipeline (OT → Consciousness → AI Agents → Blockchain → Audio), Paradox Conflict Resolver, MusicPortal sonification |
| **QuantumSingularity** | DEAD — organ donor | ~40k lines TypeScript. SINGULARIS PRIME language (parser/compiler/interpreter), G.L.Y.P.H. DSL, Paradox Resolution Engine, AI Verification, Explainability Monitor, Human Oversight Manager, Self-Optimizing Loops, Decoherence Scheduler, Distributed Quantum Memory Graph |
| **SpaceChildCollective** | ALIVE — integration partner | SingularisPrime protocol (agent-to-agent structured blocks: RESONANCE, AWAIT, TRACE, EXPERIMENT, GR::PONG/LISTEN/EMIT), Consciousness Experiment Service (6-phase scientific framework with real statistics), Consciousness Integration (IIT Phi, temporal processing) |

These repos share overlapping concerns — event integrity, conflict resolution, verification pipelines, and agent communication — but developed independently. The result is duplicated patterns, divergent implementations, and no shared integration surface.

0xSCADA (this repo) already has a mature foundation: the BaseAdapter pattern (PR #313), the Dual-Time Control Plane (ADR-0021), Merkle/HSM anchoring, and Hardhat v3 blockchain integration.

## Decision

**0xSCADA absorbs the best concepts from SIN and QuantumSingularity. SpaceChildCollective stays separate but integrates via the shared SingularisPrime protocol published through Flux Universe (`pure-jade` namespace).**

SIN and QuantumSingularity are retired after extraction. Their repos become read-only archives.

## What Gets Extracted

### From SIN

1. **5 Vendor Adapter Interfaces** — Rockwell, Siemens, Emerson, Yokogawa, Schneider protocol adapters. 0xSCADA's existing `BaseAdapter` pattern (PR #313) provides the integration surface; SIN's adapters become concrete implementations.

2. **Regional Topology Model** — East / West / NULL_ISLAND zone abstraction for geographically distributed SCADA networks. Enables regional failover, jurisdiction-aware compliance, and latency-optimized routing.

3. **5-Layer Verification Pipeline** — A structured pipeline where every critical SCADA change passes through:
   - **Layer 1: OT Validation** — Physical plausibility checks against process models
   - **Layer 2: AI Analysis** — Pattern recognition and anomaly scoring
   - **Layer 3: Governance Approval** — Multi-party authorization for high-risk changes
   - **Layer 4: Blockchain Anchoring** — Immutable commit to Ethereum (Hardhat v3)
   - **Layer 5: Audit Sonification** — Audio representation of verification events for human monitoring

4. **Governance Gate Pattern** — Critical SCADA changes require multi-layer approval before commit. Maps naturally onto ADR-0021's integrity verification plane.

### From QuantumSingularity

1. **Paradox Resolution Engine** → Event ordering and conflict resolution for ADR-0021's event integrity pipeline. When two controllers issue contradictory commands simultaneously, this engine determines precedence using causal ordering, priority hierarchies, and safety constraints.

2. **Explainability Monitor** → Every automated decision receives an explanation score. Directly supports CFR 21 Part 11 audit compliance — regulators can trace any action back to its reasoning chain.

3. **Self-Optimizing Loops** → PID controller auto-tuning via pattern recognition. Observes process response curves, identifies drift from optimal parameters, and suggests (or auto-applies with approval) tuning adjustments.

4. **Decoherence Scheduler** → Models sensor drift and equipment aging over time. Generates proactive maintenance schedules and adjusts confidence intervals on readings from aging sensors.

5. **G.L.Y.P.H. DSL Concepts** → Compact symbolic notation for SCADA control logic. Not the full language — the *notation patterns* for expressing control sequences, alarm conditions, and state transitions concisely.

### From SpaceChildCollective (Integration, Not Extraction)

SpaceChildCollective remains an independent, living project. 0xSCADA integrates with it via the SingularisPrime protocol over Flux Universe:

1. **SingularisPrime Protocol Blocks** — Standard event format for all 0xSCADA events published to Flux. Structured blocks (RESONANCE, AWAIT, TRACE, EXPERIMENT) replace ad-hoc JSON schemas.

2. **TRACE Blocks** — Sensor data provenance: signal type, confidence score, observation metadata. Every reading carries its lineage.

3. **EXPERIMENT Framework** — A/B testing for control strategies. Run two PID configurations side-by-side on parallel process lines with statistical significance testing before promoting the winner.

4. **GR::LISTEN detect/reject** — Alert filtering at the protocol level. Distinguishes real anomalies from noise before they reach human operators.

5. **Statistical Process Control** — z-scores, p-values, Cohen's h for anomaly detection. Replaces threshold-based alarms with statistically grounded detection.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           0xSCADA                                   │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │   Vendor     │  │  Verification│  │  Paradox Resolution      │  │
│  │  Adapters    │  │  Pipeline    │  │  + Explainability         │  │
│  │  (5 vendors) │  │  (5 layers)  │  │  + Self-Optimizing Loops │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────────┘  │
│         │                 │                      │                  │
│         └─────────────────┼──────────────────────┘                  │
│                           │                                         │
│                           ▼                                         │
│              ┌────────────────────────┐                             │
│              │  SingularisPrime Event │                             │
│              │  Formatter             │                             │
│              └───────────┬────────────┘                             │
│                          │                                          │
└──────────────────────────┼──────────────────────────────────────────┘
                           │
                           ▼
              ┌────────────────────────┐
              │  Flux Universe         │
              │  pure-jade/scada-*     │
              └───────────┬────────────┘
                          │
                          ▼
              ┌────────────────────────┐
              │  SpaceChildCollective  │
              │  (subscribes, runs     │
              │   experiments against  │
              │   live SCADA data)     │
              └────────────────────────┘
```

### Key Architectural Decisions

- **Ethereum (Hardhat v3) stays as the blockchain anchoring layer.** Neo N3 from SIN is NOT carried forward. One chain, one source of truth.
- **All new modules are feature-flagged** and incrementally integrated. No big-bang migration.
- **SingularisPrime protocol is the shared contract** between 0xSCADA and SpaceChildCollective. Published as a versioned schema in `pure-jade` namespace.
- **Regional topology (East/West/NULL_ISLAND)** maps onto 0xSCADA's existing multi-site deployment model.

## Implementation Waves

### Wave 1: Vendor Adapters + Regional Model (from SIN)
- Implement 5 vendor adapter interfaces extending `BaseAdapter`
- Port East/West/NULL_ISLAND regional topology
- Integration tests against simulated vendor endpoints
- **Depends on:** PR #313 (BaseAdapter pattern)

### Wave 2: Verification Pipeline + Governance (from SIN)
- Build 5-layer verification pipeline as middleware chain
- Implement governance gate requiring multi-party approval for critical changes
- Wire into ADR-0021's integrity verification plane
- **Depends on:** Wave 1 (adapters produce events for the pipeline)

### Wave 3: Paradox Resolution + Explainability (from QuantumSingularity)
- Port Paradox Resolution Engine for event conflict resolution
- Implement Explainability Monitor with explanation scoring
- CFR 21 Part 11 compliance validation
- **Depends on:** Wave 2 (verification pipeline provides the decision points to explain)

### Wave 4: SingularisPrime Event Format + Flux Integration (with SpaceChildCollective)
- Define SingularisPrime event schema for SCADA domain
- Publish events to Flux Universe `pure-jade/scada-*` topics
- Implement TRACE blocks for sensor provenance
- GR::LISTEN for alert filtering
- **Depends on:** Wave 2 (events must be verified before publishing)

### Wave 5: Self-Optimizing Loops + Decoherence Scheduler (from QuantumSingularity)
- Port Self-Optimizing Loops for PID auto-tuning
- Implement Decoherence Scheduler for sensor drift modeling
- Wire EXPERIMENT framework for A/B testing control strategies
- Statistical process control (z-scores, p-values, Cohen's h) for anomaly detection
- **Depends on:** Wave 3 (explainability required for auto-tuning decisions), Wave 4 (experiments publish to Flux)

## What Gets Left Behind

Not everything migrates. These are explicitly **not** carried forward:

- **SINGULARIS PRIME language** (parser/compiler/interpreter) — Too complex, too niche. The *concepts* inform G.L.Y.P.H. notation but the full language runtime is not needed.
- **Neo N3 smart contracts** — Replaced by Ethereum/Hardhat v3. One blockchain layer.
- **MusicPortal sonification** — Layer 5 (audit sonification) takes the *concept* but not the MusicPortal implementation.
- **Distributed Quantum Memory Graph** — Interesting but not applicable to industrial SCADA.
- **Full G.L.Y.P.H. DSL runtime** — Only the notation patterns, not the execution engine.

## Consequences

### Positive
- Single repo for all SCADA concerns — vendor adapters, verification, compliance, event publishing
- SpaceChildCollective gains a real-world data source for consciousness experiments
- 5-layer verification pipeline provides defense-in-depth for critical infrastructure
- Paradox resolution solves a real problem in distributed SCADA (conflicting commands)
- Explainability monitor directly addresses regulatory requirements

### Negative
- Large integration effort across 5 waves
- Risk of scope creep as more QuantumSingularity concepts look "useful"
- Feature flag complexity increases during transition period
- Two dead repos to archive and redirect

### Risks
- SIN's vendor adapters may need significant refactoring to fit BaseAdapter pattern
- QuantumSingularity code is ~40k lines — extraction requires careful selection, not wholesale copy
- SpaceChildCollective integration depends on Flux Universe stability
- Wave dependencies create a serial bottleneck if any wave slips

## References

- [ADR-0021: Dual-Time Control Plane with Merkle/HSM Anchoring](../ADR-0021.md)
- [PR #313: BaseAdapter Pattern](https://github.com/NickFlach/0xSCADA/pull/313)
- [Flux Universe — pure-jade namespace](https://flux-universe.com/docs)
- QuantumSingularity repo (archived after extraction)
- SIN repo (archived after extraction)
- SpaceChildCollective repo (active integration partner)
