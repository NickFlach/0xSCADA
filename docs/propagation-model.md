# ghostmagicOS (gmOS) Propagation Model Specification

> **Version**: 1.0.0
> **Status**: Draft
> **Parent Epic**: [#161](https://github.com/The-ESCO-Group/0xSCADA/issues/161)
> **Last Updated**: February 2026

---

## 1. Purpose

This specification defines the **ghostmagicOS (gmOS) Propagation Model**, a formal framework for how autonomous agents within 0xSCADA propagate intent, make decisions, and coordinate actions across distributed industrial control systems.

The propagation model ensures:

1. **Safety**: Uncertain or high-risk intents halt safely (SAFE_HOLD)
2. **Explainability**: All decisions include measurable rationale
3. **Coherence**: Actions maintain system-wide consistency
4. **Adaptability**: Behavior adjusts to changing conditions

---

## 2. Scope

### In Scope

- Intent propagation between agents and services
- Mode selection based on coupling and loss metrics
- Safety guardrails and human escalation
- Telemetry emission for operational visibility
- Conformance testing requirements

### Out of Scope

- Real-time control loop timing (handled by PREEMPT_RT kernel)
- Blockchain anchoring mechanics (see [ANCHORING.md](./ANCHORING.md))
- Agent capability definitions (see agent framework in `server/agents/`)
- Protocol-level communication (Modbus, OPC-UA, etc.)

---

## 3. Definitions

| Term | Definition |
|------|------------|
| **Intent** | A structured request for action, encapsulated in an Intent Packet |
| **Propagation** | The process of an intent traveling through the system to effect change |
| **Coupling (C)** | Measure of how strongly an intent connects to its target (0.0 - 1.0) |
| **Loss (L)** | Degradation of intent fidelity during propagation (0.0 - 1.0) |
| **Coherence** | System-wide consistency of state after propagation |
| **Mode** | The operational strategy for propagation (M1-M4) |
| **SAFE_HOLD** | A protective state where propagation halts pending human review |
| **Resonance** | Successful alignment between intent and system response |

---

## 4. Propagation Modes

The propagation model defines four operational modes, selected based on coupling strength, loss estimates, and policy constraints.

### Mode Selection Matrix

| Mode | Code | Coupling (C) | Loss (L) | Use Case |
|------|------|--------------|----------|----------|
| **LOCAL_COHERENCE** | M1 | C > 0.8 | L < 0.2 | High-confidence local actions |
| **REMOTE_COHERENCE** | M2 | C > 0.5 | L < 0.4 | Distributed coordination |
| **SAFE_HOLD** | M3 | C < 0.5 OR L > 0.4 | Any | Uncertain/risky scenarios |
| **EXPLORATION** | M4 | Any | Any | Learning and discovery (non-critical) |

### 4.1 M1: LOCAL_COHERENCE

**Description**: Intent propagates within local scope with high confidence.

**Conditions**:
```
C > C_threshold_local (default: 0.8)
L < L_threshold_local (default: 0.2)
d < d_local (distance within local boundary)
```

**Behavior**:
- Execute intent directly within local agent scope
- No human approval required for routine operations
- Full telemetry emission
- Automatic rollback on failure

**Example**: An Ops Agent summarizing local site telemetry.

### 4.2 M2: REMOTE_COHERENCE

**Description**: Intent propagates across distributed nodes requiring coordination.

**Conditions**:
```
C > C_threshold_remote (default: 0.5)
L < L_threshold_remote (default: 0.4)
d >= d_local AND d < d_0 (distance within coordination boundary)
```

**Behavior**:
- Coordinate with remote agents before execution
- May require quorum agreement for critical actions
- Enhanced telemetry with cross-site correlation
- Phased rollback with distributed compensation

**Example**: A ChangeControl Agent deploying code across multiple sites.

### 4.3 M3: SAFE_HOLD

**Description**: Intent propagation halts, awaiting human review.

**Conditions**:
```
C < C_threshold_remote (default: 0.5)
OR L > L_threshold_remote (default: 0.4)
OR policy_risk_flag == true
OR authority_required > agent_authority
```

**Behavior**:
- Halt all propagation immediately
- Capture full evidence payload
- Route to human approval workflow
- Emit SAFE_HOLD telemetry event
- No timeout - requires explicit approval or rejection

**Example**: A Compliance Agent detecting a potential regulatory violation.

### 4.4 M4: EXPLORATION

**Description**: Intent propagates in learning/discovery mode for non-critical operations.

**Conditions**:
```
intent.mode == EXPLORATION
AND target.criticality < CRITICAL
AND environment.allows_exploration == true
```

**Behavior**:
- Execute with enhanced observability
- Capture detailed cause-effect telemetry
- No changes to critical systems
- Automatic reversion on anomaly detection

**Example**: An AI agent testing new anomaly detection thresholds on historical data.

---

## 5. Intent Packet Schema

All propagation operations use a standardized **Intent Packet** contract.

### 5.1 Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `intent_id` | `string (UUID)` | Unique identifier for tracing |
| `target_selector` | `TargetSelector` | Specifies target scope (sites, assets, agents) |
| `mode` | `PropagationMode` | Requested mode (M1, M2, M3, M4) |
| `constraints` | `Constraint[]` | Execution constraints and limits |
| `confidence` | `number (0.0-1.0)` | Originator's confidence in intent validity |
| `authority_required` | `AuthorityLevel` | Minimum authority to execute |
| `ttl` | `number (ms)` | Time-to-live before automatic expiration |
| `expected_observables` | `Observable[]` | Expected outcomes for validation |
| `fallback_plan` | `FallbackPlan` | Actions if propagation fails |
| `telemetry_hooks` | `TelemetryHook[]` | Custom telemetry emission points |

### 5.2 Target Selector

```typescript
interface TargetSelector {
  // Scope selection (at least one required)
  allSites?: boolean;
  siteIds?: string[];
  allAssets?: boolean;
  assetIds?: string[];
  assetTypes?: AssetType[];
  agentIds?: string[];

  // Filtering
  tags?: string[];
  criticality?: CriticalityLevel;
}
```

### 5.3 Constraints

```typescript
interface Constraint {
  type: 'MAX_IMPACT' | 'MAX_DURATION' | 'REQUIRE_QUORUM' | 'EXCLUDE_CRITICAL' | 'CUSTOM';
  value: unknown;
  enforcement: 'STRICT' | 'ADVISORY';
}
```

### 5.4 Fallback Plan

```typescript
interface FallbackPlan {
  strategy: 'ROLLBACK' | 'COMPENSATE' | 'ESCALATE' | 'ABORT';
  compensation_actions?: Action[];
  escalation_target?: string;
  max_retries?: number;
}
```

---

## 6. Math-Lite Model

The propagation model uses a simplified mathematical framework for decision-making.

### 6.1 Coupling Function

Coupling (C) measures intent-target alignment:

```
C(intent, target) = w_1 * relevance(intent, target)
                  + w_2 * capability_match(agent, intent)
                  + w_3 * scope_overlap(intent.scope, target.scope)
```

Where:
- `relevance`: Semantic similarity between intent action and target capabilities (0.0-1.0)
- `capability_match`: Agent capability coverage for intent requirements (0.0-1.0)
- `scope_overlap`: Intersection of intent scope with target scope (0.0-1.0)
- `w_1, w_2, w_3`: Tunable weights (default: 0.4, 0.3, 0.3)

### 6.2 Loss Function

Loss (L) measures propagation degradation:

```
L(intent, path) = L_base + L_distance + L_transformation

Where:
  L_base = 1 - intent.confidence
  L_distance = min(1.0, d / d_0)
  L_transformation = sum(t.loss_factor for t in transformations)
```

Where:
- `d`: Propagation distance (hops, latency, or semantic distance)
- `d_0`: Reference distance for normalization (configurable)
- `transformations`: Protocol/format transformations in path

### 6.3 Effective Coupling

Net coupling after loss:

```
C_effective = C * (1 - L)
```

### 6.4 Mode Selection Score

```
score(mode) = C_effective * mode.weight - risk_penalty(mode, intent)

selected_mode = argmax(score(mode) for mode in [M1, M2, M3, M4])
               subject to: all mode.conditions satisfied
```

### 6.5 Distance Thresholds

| Parameter | Default | Description |
|-----------|---------|-------------|
| `d_local` | 1 | Maximum distance for LOCAL_COHERENCE |
| `d_0` | 10 | Reference distance for loss normalization |
| `C_threshold_local` | 0.8 | Minimum coupling for M1 |
| `C_threshold_remote` | 0.5 | Minimum coupling for M2 |
| `L_threshold_local` | 0.2 | Maximum loss for M1 |
| `L_threshold_remote` | 0.4 | Maximum loss for M2 |

---

## 7. Propagation Algorithm

### 7.1 High-Level Flow

```
1. RECEIVE Intent Packet
2. VALIDATE schema and required fields
3. COMPUTE coupling C(intent, target)
4. COMPUTE loss L(intent, path)
5. EVALUATE policy constraints
6. SELECT mode based on (C, L, constraints)
7. IF mode == SAFE_HOLD:
     a. HALT propagation
     b. CAPTURE evidence
     c. ROUTE to human approval
     d. AWAIT decision
8. ELSE:
     a. EXECUTE intent in selected mode
     b. EMIT telemetry
     c. VALIDATE expected_observables
     d. IF validation fails: EXECUTE fallback_plan
9. RETURN PropagationResult with rationale
```

### 7.2 Pseudocode

```typescript
async function propagate(packet: IntentPacket): Promise<PropagationResult> {
  // Step 1-2: Validate
  const validation = validateIntentPacket(packet);
  if (!validation.valid) {
    return PropagationResult.rejected(validation.errors);
  }

  // Step 3-4: Compute metrics
  const target = resolveTarget(packet.target_selector);
  const C = computeCoupling(packet, target);
  const L = computeLoss(packet, determinePath(target));
  const C_effective = C * (1 - L);

  // Step 5: Policy evaluation
  const policyResult = evaluatePolicies(packet, C_effective);

  // Step 6: Mode selection
  const mode = selectMode(C, L, policyResult, packet.constraints);

  // Step 7: SAFE_HOLD handling
  if (mode === PropagationMode.SAFE_HOLD) {
    const evidence = captureEvidence(packet, C, L, policyResult);
    const escalation = await routeToHumanApproval(packet, evidence);
    return PropagationResult.held(escalation.id, evidence);
  }

  // Step 8: Execute
  const execution = await executeInMode(packet, mode, target);

  // Emit telemetry
  emitPropagationTelemetry({
    intent_id: packet.intent_id,
    mode,
    coupling: C,
    loss: L,
    outcome: execution.outcome
  });

  // Validate observables
  const observableValidation = await validateObservables(
    packet.expected_observables,
    execution.state
  );

  if (!observableValidation.satisfied) {
    await executeFallback(packet.fallback_plan, execution);
  }

  // Step 9: Return result with rationale
  return PropagationResult.completed({
    mode,
    rationale: buildRationale(C, L, mode, policyResult),
    telemetry: execution.telemetry,
    observables: observableValidation
  });
}
```

---

## 8. Telemetry

### 8.1 Required Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `propagation_coupling` | Gauge | `intent_type`, `mode`, `target_scope` | Coupling score at propagation time |
| `propagation_loss` | Gauge | `intent_type`, `mode`, `path_length` | Loss score at propagation time |
| `propagation_duration_ms` | Histogram | `mode`, `outcome` | End-to-end propagation time |
| `propagation_mode_selected` | Counter | `mode`, `intent_type` | Mode selection frequency |
| `propagation_safe_hold_triggered` | Counter | `reason`, `intent_type` | SAFE_HOLD activations |
| `propagation_fallback_executed` | Counter | `strategy`, `intent_type` | Fallback plan executions |
| `propagation_coherence_variance` | Gauge | `scope` | System coherence after propagation |
| `propagation_impact_score` | Gauge | `intent_type`, `target_scope` | Measured downstream impact |

### 8.2 Telemetry Events

All propagation operations emit structured events:

```typescript
interface PropagationTelemetryEvent {
  event_type: 'PROPAGATION_TELEMETRY';
  timestamp: string; // ISO 8601
  intent_id: string;

  // Metrics snapshot
  metrics: {
    coupling: number;
    loss: number;
    effective_coupling: number;
    coherence_before: number;
    coherence_after: number;
    impact_score: number;
  };

  // Decision context
  mode_selected: PropagationMode;
  mode_rationale: string;
  policy_flags: string[];

  // Outcome
  outcome: 'SUCCESS' | 'FALLBACK' | 'HELD' | 'REJECTED';
  duration_ms: number;
}
```

### 8.3 Observability Integration

Propagation telemetry integrates with the existing 0xSCADA observability stack:

- **Metrics**: Export to Prometheus via `/metrics` endpoint
- **Traces**: Correlation IDs link propagation spans
- **Logs**: Structured JSON logs with intent context
- **Events**: Anchor critical events to blockchain

---

## 9. Safety Assumptions

### 9.1 Core Safety Principles

1. **Fail-Closed**: When in doubt, SAFE_HOLD
2. **Human Authority**: Critical decisions require human approval
3. **Audit Trail**: All propagation decisions are recorded
4. **Bounded Impact**: Constraints limit blast radius
5. **Graceful Degradation**: Fallback plans always exist

### 9.2 Safety Invariants

The propagation model maintains these invariants:

```
INVARIANT 1: SAFE_HOLD is triggered when:
  - Coupling < C_threshold_remote
  - OR Loss > L_threshold_remote
  - OR authority_required > agent.authority
  - OR policy_risk_flag is set

INVARIANT 2: Critical assets require:
  - mode != EXPLORATION
  - Explicit human approval for modifications
  - Dual-confirmation for irreversible actions

INVARIANT 3: Propagation never:
  - Bypasses SAFE_HOLD once triggered
  - Executes without telemetry emission
  - Modifies state without rollback capability
```

### 9.3 Assumptions

| Assumption | Rationale |
|------------|-----------|
| Agents are correctly authenticated | Handled by agent framework |
| Network partitions are detectable | Health checks and timeouts |
| Clocks are synchronized | NTP required for coordination |
| Persistence layer is available | PostgreSQL for state |
| Human operators are available | Escalation SLA in operations |

---

## 10. Non-Goals

The propagation model explicitly does **not** address:

1. **Sub-millisecond timing**: Real-time control handled by kernel
2. **Protocol translation**: Handled by protocol drivers
3. **Physical safety interlocks**: Handled by PLCs/SIS
4. **Network security**: Handled by infrastructure layer
5. **Agent lifecycle management**: Handled by agent framework
6. **Consensus mechanisms**: Handled by blockchain layer

---

## 11. Conformance

### 11.1 Conformance Levels

| Level | Requirements | Test Coverage |
|-------|--------------|---------------|
| **BASIC** | M1, M2, M3 modes functional | Mode selection, basic telemetry |
| **STANDARD** | All modes + Intent Packet validation | Full schema validation, fallback |
| **FULL** | All features + policy integration | Policy gates, human escalation |

### 11.2 Conformance Test Criteria

Implementations MUST pass:

| Criterion | Test | Pass Condition |
|-----------|------|----------------|
| **C1** | Mode selection determinism | Same inputs produce same mode |
| **C2** | SAFE_HOLD triggering | Unsafe conditions always trigger M3 |
| **C3** | Telemetry emission | All propagations emit required metrics |
| **C4** | Rationale generation | Mode selection includes measurable inputs |
| **C5** | Fallback execution | Failed validations trigger fallback |
| **C6** | Human escalation | SAFE_HOLD routes to approval workflow |

### 11.3 Traceability Matrix

| Requirement | Criterion | Test File | Tests |
|-------------|-----------|-----------|-------|
| Mode M1 conditions (LOCAL_COHERENCE) | C1 | `propagation-mode-selector.test.ts`, `propagation-conformance.test.ts` | 51 + 7 |
| Mode M2 conditions (REMOTE_COHERENCE) | C1 | `propagation-mode-selector.test.ts`, `propagation-conformance.test.ts` | 51 + 7 |
| Mode M3 conditions (SAFE_HOLD) | C2 | `propagation-guardrails.test.ts`, `propagation-conformance.test.ts` | 51 + 8 |
| Mode M4 conditions (EXPLORATION) | C1 | `propagation-mode-selector.test.ts`, `propagation-conformance.test.ts` | 51 + 7 |
| Intent Packet schema | C5 | `intent-packet-schema.test.ts`, `propagation-conformance.test.ts` | 62 + 6 |
| Telemetry emission | C3 | `propagation-telemetry.test.ts`, `propagation-conformance.test.ts` | 41 + 7 |
| Rationale generation | C4 | `propagation-conformance.test.ts` | 7 |
| Human escalation | C6 | `propagation-guardrails.test.ts`, `propagation-conformance.test.ts` | 51 + 8 |
| **Conformance suite** | **All (C1-C6)** | `propagation-conformance.test.ts` | **43** |

**Total Test Coverage**: 248 tests across 5 test files

---

## 12. Implementation Roadmap

| Issue | Title | Status |
|-------|-------|--------|
| [#162](https://github.com/The-ESCO-Group/0xSCADA/issues/162) | Propagation Model Specification (this doc) | Complete |
| [#163](https://github.com/The-ESCO-Group/0xSCADA/issues/163) | Intent Packet Schema & Validation | Complete |
| [#164](https://github.com/The-ESCO-Group/0xSCADA/issues/164) | Propagation Mode Selection Engine | Complete |
| [#165](https://github.com/The-ESCO-Group/0xSCADA/issues/165) | SAFE_HOLD Guardrails & Human Escalation | Complete |
| [#166](https://github.com/The-ESCO-Group/0xSCADA/issues/166) | Propagation Telemetry | Complete |
| [#167](https://github.com/The-ESCO-Group/0xSCADA/issues/167) | Conformance Test Harness | Complete |

---

## 13. References

- [0xSCADA Agent Framework](../server/agents/)
- [Anchoring System](./ANCHORING.md)
- [Digital Twin Architecture](./DIGITAL_TWIN_ARCHITECTURE.md)
- [ROADMAP](./ROADMAP.md) - Phase 11: AI & Digital Twins

---

## Appendix A: Example Intent Packets

### A.1 Local Telemetry Summary (M1)

```json
{
  "intent_id": "7f8e9d0c-1234-5678-9abc-def012345678",
  "target_selector": {
    "siteIds": ["site-001"],
    "assetTypes": ["MOTOR", "PUMP"]
  },
  "mode": "LOCAL_COHERENCE",
  "constraints": [
    { "type": "MAX_DURATION", "value": 30000, "enforcement": "STRICT" }
  ],
  "confidence": 0.95,
  "authority_required": "OPERATOR",
  "ttl": 60000,
  "expected_observables": [
    { "type": "SUMMARY_GENERATED", "target": "shift-summary" }
  ],
  "fallback_plan": {
    "strategy": "ABORT"
  },
  "telemetry_hooks": []
}
```

### A.2 Cross-Site Deployment (M2)

```json
{
  "intent_id": "a1b2c3d4-5678-90ab-cdef-123456789012",
  "target_selector": {
    "siteIds": ["site-001", "site-002", "site-003"],
    "tags": ["production"]
  },
  "mode": "REMOTE_COHERENCE",
  "constraints": [
    { "type": "REQUIRE_QUORUM", "value": 2, "enforcement": "STRICT" },
    { "type": "EXCLUDE_CRITICAL", "value": true, "enforcement": "STRICT" }
  ],
  "confidence": 0.85,
  "authority_required": "ENGINEER",
  "ttl": 300000,
  "expected_observables": [
    { "type": "DEPLOYMENT_COMPLETE", "target": "all-sites" },
    { "type": "HEALTH_CHECK_PASS", "target": "all-sites" }
  ],
  "fallback_plan": {
    "strategy": "ROLLBACK",
    "max_retries": 1
  },
  "telemetry_hooks": [
    { "event": "PHASE_COMPLETE", "metrics": ["deployment_progress"] }
  ]
}
```

### A.3 SAFE_HOLD Trigger (M3)

```json
{
  "intent_id": "deadbeef-cafe-1234-5678-abcdef012345",
  "target_selector": {
    "assetIds": ["reactor-001"],
    "criticality": "CRITICAL"
  },
  "mode": "LOCAL_COHERENCE",
  "constraints": [],
  "confidence": 0.45,
  "authority_required": "SUPERVISOR",
  "ttl": 120000,
  "expected_observables": [
    { "type": "SETPOINT_CHANGED", "target": "reactor-001" }
  ],
  "fallback_plan": {
    "strategy": "ESCALATE",
    "escalation_target": "on-call-engineer"
  },
  "telemetry_hooks": []
}
```

*Note: This intent will be routed to SAFE_HOLD due to low confidence (0.45) and critical target.*

---

## Appendix B: Glossary

| Abbreviation | Full Term |
|--------------|-----------|
| C | Coupling coefficient |
| L | Loss coefficient |
| M1-M4 | Propagation modes 1-4 |
| TTL | Time to live |
| SIS | Safety Instrumented System |
| PLC | Programmable Logic Controller |
| SAFE_HOLD | Safety hold mode (M3) |

---

*This specification is a living document. Updates are made as the propagation model evolves.*

**Document Owner**: ghostmagicOS (gmOS) Team
**Review Cycle**: Quarterly
