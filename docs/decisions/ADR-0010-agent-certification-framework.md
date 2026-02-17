# ADR-0010: Agent Certification Framework

## Status

Proposed

## Date

2026-02-12

## Context

The [Agentic Engineering Charter](../CHARTER.md) identifies certification frameworks for compliant implementations as a long-term objective. As 0xSCADA agents begin operating in regulated industrial environments, we need a formal process to certify that agents meet safety, security, and behavioral requirements before deployment.

Current industrial standards (IEC 61508, IEC 62443, ISA/IEC 62443) define requirements for functional safety and cybersecurity in industrial automation, but none address autonomous agent behavior specifically. The gap between traditional PLC safety certification and agentic system certification is significant:

1. **Non-determinism**: Agents may exhibit emergent behavior that wasn't explicitly programmed
2. **Adaptive behavior**: Agents learn and change behavior over time, unlike static PLC programs
3. **Multi-agent coordination**: Agent interactions create system-level behaviors not present in individual agents
4. **Decision opacity**: Agent decision-making may not be fully transparent to certifiers
5. **Continuous deployment**: Agents may be updated more frequently than traditional control systems

Without a certification framework, industrial operators cannot:
- Obtain insurance coverage for agentic systems
- Satisfy regulatory audits
- Demonstrate due diligence in safety-critical deployments
- Compare agent implementations across vendors

## Decision

We define a **four-level Agent Certification Framework** aligned with existing industrial safety standards and the charter's core principles.

### 1. Certification Levels

| Level | Name | Scope | Analogous To |
|-------|------|-------|-------------|
| **AC-1** | Observer | Read-only monitoring, alerting, reporting | SIL 1 / DAL D |
| **AC-2** | Advisor | Recommendations to operators, no direct control | SIL 1-2 / DAL C |
| **AC-3** | Operator | Bounded control actions within envelope (ADR-0009) | SIL 2-3 / DAL B |
| **AC-4** | Autonomous | Full autonomous operation within hard limits | SIL 3 / DAL A |

### 2. Certification Requirements per Level

#### AC-1: Observer

- [ ] Agent identity registered on-chain (ADR-0008)
- [ ] Read-only capability tokens verified
- [ ] Logging and audit trail operational
- [ ] No write access to any control system
- [ ] Basic functional test suite passes (>95% coverage of observation paths)

#### AC-2: Advisor

- All AC-1 requirements, plus:
- [ ] Recommendation accuracy validated against historical data (>90% correct)
- [ ] False positive rate for alerts below configurable threshold
- [ ] Recommendation latency within SLA (<5s for non-critical, <500ms for critical)
- [ ] Human-in-the-loop confirmation flow verified
- [ ] Operator override mechanism tested and documented

#### AC-3: Operator

- All AC-2 requirements, plus:
- [ ] Operational envelope formally specified and verified (ADR-0009)
- [ ] Trust tier T2+ achieved in staging environment
- [ ] Safety function test suite passes (100% of safety-critical paths)
- [ ] Failure mode analysis documented (FMEA)
- [ ] Emergency stop response time verified (<100ms)
- [ ] Rollback procedure tested for all control actions
- [ ] 30-day shadow-mode operation with zero safety deviations

#### AC-4: Autonomous

- All AC-3 requirements, plus:
- [ ] Trust tier T3+ achieved in production environment
- [ ] Independent security audit passed (ADR-0008 compliance)
- [ ] Multi-agent interaction testing complete
- [ ] 90-day supervised operation with zero safety deviations
- [ ] Incident response plan documented and drilled
- [ ] Insurance/liability review completed
- [ ] Technical advisory council sign-off

### 3. Certification Process

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  SUBMIT  │───►│  REVIEW  │───►│   TEST   │───►│  AUDIT   │───►│ CERTIFY  │
│          │    │          │    │          │    │          │    │          │
│ Agent    │    │ Docs &   │    │ Test     │    │ Indep.   │    │ On-chain │
│ manifest │    │ design   │    │ suite    │    │ review   │    │ registry │
│ + code   │    │ review   │    │ execution│    │ + sign   │    │ entry    │
└──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘
```

### 4. On-Chain Certification Registry

Certifications are recorded on-chain for transparency and immutability:

```solidity
struct AgentCertification {
    address agent;
    uint8 level;              // AC-1 through AC-4
    bytes32 testSuiteHash;    // Hash of test results
    bytes32 auditReportHash;  // Hash of audit report
    address[] certifiers;     // Who signed off
    uint256 issuedAt;
    uint256 expiresAt;        // Certifications expire
    bool revoked;
}
```

### 5. Recertification Triggers

Certifications are **not permanent**. Recertification is required when:

- Agent code is updated (any version change)
- Operational envelope is modified
- A safety incident occurs involving the agent
- 12 months elapse since last certification
- The agent is deployed to a new site or asset class
- Underlying infrastructure changes (OS, network, dependencies)

## Consequences

### Positive

- **Regulatory readiness**: Framework maps to existing safety standards (IEC 61508, 62443)
- **Operator confidence**: Clear levels communicate agent capability and risk
- **Insurance enablement**: Certifications provide basis for liability coverage
- **Vendor comparison**: Standard framework allows cross-vendor evaluation
- **Progressive deployment**: Levels match trust tiers from ADR-0009

### Negative

- **Certification overhead**: Significant effort to certify agents, especially AC-3/AC-4
- **Speed vs. safety trade-off**: Certification requirements slow agent deployment
- **Evolving standards**: Framework may need frequent updates as industry standards mature
- **Assessor availability**: Shortage of qualified industrial AI/agent certifiers

### Neutral

- No existing standard directly competes; this is greenfield work
- Can be adopted incrementally (start with AC-1/AC-2, expand later)
- Framework is technology-agnostic (applies to any agent implementation)

## Alternatives Considered

### Alternative 1: Defer to Existing Safety Standards Only

Use IEC 61508 / IEC 62443 without agent-specific extensions.

Rejected because: Existing standards don't address non-determinism, adaptive behavior, or multi-agent coordination. They would either over-constrain agents (treating them as static PLCs) or leave critical gaps.

### Alternative 2: Self-Certification

Let agent developers self-certify compliance.

Rejected because: Insufficient for safety-critical systems; no independent verification undermines trust and regulatory acceptance.

### Alternative 3: Wait for Industry Standards

Wait for IEC/IEEE/ISA to publish agent-specific standards.

Rejected because: Industry standards lag by years; 0xSCADA needs a framework now to guide development. Our framework can inform future standards.

## References

- [Agentic Engineering Charter](../CHARTER.md)
- [ADR-0008: Zero-Trust Agent Deployment](ADR-0008-zero-trust-agent-deployment.md)
- [ADR-0009: Measured Emergence Guardrails](ADR-0009-measured-emergence-guardrails.md)
- [IEC 61508: Functional Safety of E/E/PE Safety-Related Systems](https://www.iec.ch/functional-safety)
- [IEC 62443: Industrial Communication Networks Security](https://www.iec.ch/cyber-security)
- [DO-178C: Software Considerations in Airborne Systems](https://www.rtca.org/)
