# ADR-0022 — GitHub Issues for Implementation Waves

> **Review before creating.** These are drafts. Adjust labels, assignees, and milestones as needed.

---

## Wave 1: Vendor Adapters + Regional Model

### Issue 1.1: Implement Rockwell vendor adapter
**Labels:** `wave-1`, `vendor-adapter`, `from-sin`

Implement Rockwell/Allen-Bradley protocol adapter extending `BaseAdapter` (PR #313). Port interface definitions and protocol handling from SIN repo. Include:
- EtherNet/IP and CIP protocol support
- Tag-based read/write operations
- Connection management and failover
- Integration tests against simulated Rockwell endpoint

### Issue 1.2: Implement Siemens vendor adapter
**Labels:** `wave-1`, `vendor-adapter`, `from-sin`

Implement Siemens S7/TIA protocol adapter extending `BaseAdapter`. Port from SIN repo. Include:
- S7comm and S7comm-plus protocol support
- DB/input/output/marker area access
- Integration tests against simulated Siemens endpoint

### Issue 1.3: Implement Emerson vendor adapter
**Labels:** `wave-1`, `vendor-adapter`, `from-sin`

Implement Emerson DeltaV/Ovation protocol adapter extending `BaseAdapter`. Port from SIN repo. Include:
- OPC UA integration for DeltaV
- Modbus TCP fallback
- Integration tests

### Issue 1.4: Implement Yokogawa vendor adapter
**Labels:** `wave-1`, `vendor-adapter`, `from-sin`

Implement Yokogawa CENTUM VP protocol adapter extending `BaseAdapter`. Port from SIN repo. Include:
- Vnet/IP protocol support
- OPC UA integration
- Integration tests

### Issue 1.5: Implement Schneider vendor adapter
**Labels:** `wave-1`, `vendor-adapter`, `from-sin`

Implement Schneider Electric EcoStruxure protocol adapter extending `BaseAdapter`. Port from SIN repo. Include:
- Modbus TCP/RTU support
- EcoStruxure API integration
- Integration tests

### Issue 1.6: Port regional topology model (East/West/NULL_ISLAND)
**Labels:** `wave-1`, `infrastructure`, `from-sin`

Implement the East/West/NULL_ISLAND regional zone abstraction from SIN:
- Zone configuration and discovery
- Regional failover logic
- Jurisdiction-aware compliance routing
- Latency-optimized command routing
- Unit tests for zone transitions and failover scenarios

---

## Wave 2: Verification Pipeline + Governance

### Issue 2.1: Build 5-layer verification pipeline framework
**Labels:** `wave-2`, `verification`, `from-sin`

Implement the verification pipeline as a composable middleware chain:
- Layer 1: OT Validation (physical plausibility checks)
- Layer 2: AI Analysis (pattern recognition, anomaly scoring)
- Layer 3: Governance Approval (multi-party auth gate)
- Layer 4: Blockchain Anchoring (Ethereum/Hardhat v3)
- Layer 5: Audit Sonification (audio representation)

Each layer must be independently toggleable via feature flags. Pipeline must integrate with ADR-0021's integrity verification plane.

### Issue 2.2: Implement governance gate pattern
**Labels:** `wave-2`, `governance`, `from-sin`

Multi-layer approval mechanism for critical SCADA changes:
- Define criticality levels (routine / elevated / critical / emergency)
- Approval requirements per level (auto / single / multi-party / emergency override)
- Approval timeout and escalation
- Audit trail for all approval decisions
- Integration with verification pipeline Layer 3

**Depends on:** #2.1

---

## Wave 3: Paradox Resolution + Explainability

### Issue 3.1: Port Paradox Resolution Engine
**Labels:** `wave-3`, `conflict-resolution`, `from-quantumsingularity`

Extract and adapt the Paradox Resolution Engine from QuantumSingularity for SCADA event conflict resolution:
- Causal ordering of simultaneous commands
- Priority hierarchy (safety > operator > automated)
- Conflict detection and resolution strategies
- Integration with ADR-0021 event integrity pipeline
- Unit tests with concurrent conflicting command scenarios

### Issue 3.2: Implement Explainability Monitor
**Labels:** `wave-3`, `compliance`, `from-quantumsingularity`

Port Explainability Monitor from QuantumSingularity:
- Every automated decision receives an explanation score (0.0–1.0)
- Reasoning chain capture for audit trail
- CFR 21 Part 11 compliance validation
- Integration with verification pipeline (decisions at each layer get explanations)
- Dashboard endpoint for compliance officers

**Depends on:** #2.1

---

## Wave 4: SingularisPrime Event Format + Flux Integration

### Issue 4.1: Define SingularisPrime event schema for SCADA domain
**Labels:** `wave-4`, `protocol`, `spacechild-integration`

Define SCADA-specific SingularisPrime protocol blocks:
- RESONANCE blocks for normal telemetry
- TRACE blocks for sensor data provenance (signal type, confidence, observations)
- EXPERIMENT blocks for A/B test results
- AWAIT blocks for pending approvals
- GR::EMIT for outbound SCADA events
- Schema versioning strategy

Coordinate with SpaceChildCollective repo for protocol compatibility.

### Issue 4.2: Publish SCADA events to Flux Universe
**Labels:** `wave-4`, `flux`, `spacechild-integration`

Implement Flux Universe publisher for `pure-jade/scada-*` topics:
- Event serialization to SingularisPrime format
- Flux Universe `pure-jade` namespace authentication
- Topic partitioning strategy (per-zone, per-vendor, per-criticality)
- Backpressure and retry handling
- Feature flag to enable/disable publishing

**Depends on:** #4.1

### Issue 4.3: Implement GR::LISTEN alert filtering
**Labels:** `wave-4`, `alerting`, `spacechild-integration`

Port GR::LISTEN detect/reject pattern for alert filtering:
- Subscribe to inbound alert streams
- Statistical pre-filtering (distinguish anomalies from noise)
- detect/reject classification
- Integration with verification pipeline Layer 2 (AI Analysis)

**Depends on:** #4.1

---

## Wave 5: Self-Optimizing Loops + Decoherence Scheduler

### Issue 5.1: Port Self-Optimizing Loops for PID auto-tuning
**Labels:** `wave-5`, `optimization`, `from-quantumsingularity`

Extract Self-Optimizing Loops from QuantumSingularity:
- Process response curve observation
- Drift detection from optimal parameters
- Auto-tuning suggestions with confidence scores
- Auto-apply mode (requires governance approval via Wave 2 gate)
- EXPERIMENT framework integration for A/B testing tuning changes
- Explainability scores for every tuning decision

**Depends on:** #2.2, #3.2, #4.1

### Issue 5.2: Implement Decoherence Scheduler
**Labels:** `wave-5`, `maintenance`, `from-quantumsingularity`

Port Decoherence Scheduler from QuantumSingularity:
- Sensor drift modeling over time
- Equipment aging curves
- Proactive maintenance schedule generation
- Dynamic confidence interval adjustment for aging sensors
- TRACE block metadata updates as sensor confidence degrades

**Depends on:** #4.1

### Issue 5.3: Statistical process control for anomaly detection
**Labels:** `wave-5`, `analytics`, `spacechild-integration`

Implement statistical anomaly detection replacing threshold-based alarms:
- z-score based detection for continuous signals
- p-value significance testing for change detection
- Cohen's h effect size for binary state changes
- Integration with GR::LISTEN filtering
- Dashboard for statistical alarm tuning

**Depends on:** #4.3
