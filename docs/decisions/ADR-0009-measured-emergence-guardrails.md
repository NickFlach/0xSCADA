# ADR-0009: Measured Emergence Guardrails for Autonomous Agents

## Status

Proposed

## Date

2026-02-12

## Context

The [Agentic Engineering Charter](../CHARTER.md) defines "Measured Emergence" as a core principle: adaptive systems must operate within defined constraints to ensure predictability and trust.

0xSCADA agents currently operate under the [ghostmagicOS (gmOS) Propagation Model](../propagation-model.md) with four modes (M1-M4). However, the boundaries between modes — particularly the conditions under which an agent may autonomously escalate or de-escalate — are not formally specified.

As agents gain more capability (self-diagnosis, optimization, learning), we need formal guardrails that:

1. **Bound autonomous behavior** to prevent unintended consequences in physical systems
2. **Define escalation thresholds** for when agents must yield to human operators
3. **Constrain exploration** to sandboxed, non-critical contexts
4. **Ensure predictability** so operators can reason about agent behavior
5. **Enable progressive trust** as agents demonstrate reliability over time

The stakes are high: an unconstrained agent adjusting a PID loop on a chemical reactor could cause a safety incident. An agent exploring novel configurations on a live power grid could cause outages.

## Decision

We implement a **Constraint Envelope System** that formally bounds agent autonomy at every level.

### 1. Operational Envelopes

Each agent operates within a declared **operational envelope** — a set of hard constraints that cannot be overridden by the agent itself:

```typescript
interface OperationalEnvelope {
  // Hard limits — agent CANNOT exceed these
  maxSetpointDelta: number;       // Max % change per action
  maxActionsPerMinute: number;    // Rate limiting
  forbiddenAssets: string[];      // Assets agent must never touch
  requiredApprovals: number;      // Min human approvals for action

  // Soft limits — agent CAN exceed with justification logged
  recommendedSetpointDelta: number;
  recommendedActionInterval: Duration;

  // Escalation triggers — force M3: SAFE_HOLD
  uncertaintyThreshold: number;   // 0.0-1.0 confidence score
  anomalyScoreLimit: number;      // Statistical deviation threshold
  consecutiveFailureLimit: number;// Failures before halt
}
```

### 2. Mode Transition Rules

Formal state machine for propagation mode transitions:

```
         ┌──────────────────────────────────────────┐
         │                                          │
         ▼                                          │
    ┌─────────┐   confidence > 0.9   ┌──────────┐  │
    │   M1    │◄─────────────────────│   M2     │  │
    │ LOCAL   │   confidence > 0.8   │ REMOTE   │  │
    │COHERENCE│──────────────────────►│COHERENCE │  │
    └────┬────┘                      └────┬─────┘  │
         │                                │        │
         │ confidence < 0.6               │ confidence < 0.5
         │ OR anomaly detected            │ OR cross-site conflict
         │                                │        │
         ▼                                ▼        │
    ┌─────────┐                      ┌──────────┐  │
    │   M3    │                      │   M4     │──┘
    │  SAFE   │   human approval     │EXPLORATION│
    │  HOLD   │◄─────────────────────│(sandbox)  │
    └─────────┘                      └──────────┘
```

**Transition constraints:**
- M1 → M2: Only when coordinating across sites; requires capability token
- M1/M2 → M3: **Mandatory** when confidence drops below threshold
- M4 → anything: Requires explicit human approval; M4 runs in isolated sandbox only
- M3 → M1: Requires human operator acknowledgment + root cause logged

### 3. Progressive Trust Tiers

Agents earn expanded envelopes through demonstrated reliability:

| Trust Tier | Unlock Criteria | Envelope Expansion |
|-----------|----------------|-------------------|
| **T0: Probationary** | Initial deployment | Read-only, no control actions |
| **T1: Monitored** | 72h clean operation, 0 anomalies | Setpoint adjustments ≤1%, human notification |
| **T2: Supervised** | 30d clean operation, audit passed | Setpoint adjustments ≤5%, human approval for >2% |
| **T3: Trusted** | 90d clean operation, incident response test passed | Setpoint adjustments ≤10%, autonomous for ≤5% |
| **T4: Autonomous** | 180d + council review | Full envelope within hard limits |

**Tier demotion** is immediate upon:
- Any safety-related anomaly
- Exceeding soft limits without justification
- Failed attestation or capability renewal
- Operator override

### 4. Sandbox Isolation for M4: EXPLORATION

Exploration mode operates exclusively in:
- Digital twin environments (not live systems)
- Isolated network segments with no path to field devices
- Time-bounded sessions (max 4h) with automatic termination
- All exploration results logged but NOT applied without human review

### 5. Audit & Observability Requirements

Every constraint evaluation must produce an observable trace:

```json
{
  "agent": "ops-agent-001",
  "mode": "M1",
  "trust_tier": "T2",
  "action": "adjust_setpoint",
  "envelope_check": {
    "delta_requested": 3.2,
    "delta_allowed": 5.0,
    "confidence": 0.87,
    "threshold": 0.6,
    "result": "PERMITTED"
  },
  "timestamp": "2026-02-12T19:21:00Z"
}
```

## Consequences

### Positive

- **Predictable autonomy**: Operators can reason about worst-case agent behavior
- **Progressive trust**: Agents earn capability over time, reducing deployment risk
- **Safety guarantee**: Hard limits cannot be overridden by agent logic
- **Auditability**: Every constraint evaluation is logged and anchored
- **Charter alignment**: Directly implements "Measured Emergence" and "Human-in-the-Loop"

### Negative

- **Slower autonomous adoption**: Trust tiers mean months before full autonomy
- **Configuration complexity**: Envelopes must be tuned per deployment context
- **Potential over-constraint**: Conservative limits may prevent beneficial actions
- **Tier management overhead**: Demotion/promotion logic adds system complexity

### Neutral

- Similar to automotive ASIL levels and aviation DAL classifications
- Can be implemented incrementally (start with T0/T1, expand later)
- Envelope parameters are site-configurable, not hardcoded

## Alternatives Considered

### Alternative 1: Binary On/Off Autonomy

Either agents are fully autonomous or fully manual.

Rejected because: Too coarse; prevents the gradual trust-building that industrial operators need. All-or-nothing autonomy is a non-starter for critical infrastructure.

### Alternative 2: Unbounded Learning with Rollback

Let agents explore freely but roll back any negative outcomes.

Rejected because: Physical systems cannot always be rolled back (chemical reactions, mechanical wear, safety incidents). Prevention is required, not just recovery.

### Alternative 3: Static Constraints Only

Fixed rules with no progressive trust.

Rejected because: Prevents agents from becoming more useful over time; operators would abandon the system if agents never graduate beyond basic monitoring.

## References

- [Agentic Engineering Charter](../CHARTER.md)
- [ghostmagicOS (gmOS) Propagation Model](../propagation-model.md)
- [ADR-0007: Agent-Based Governance](ADR-0007-agent-based-governance.md)
- [ADR-0008: Zero-Trust Agent Deployment](ADR-0008-zero-trust-agent-deployment.md)
- [IEC 61508: Functional Safety](https://www.iec.ch/functional-safety)
- [ISO 26262: Automotive Safety Integrity Levels](https://www.iso.org/standard/68383.html)
