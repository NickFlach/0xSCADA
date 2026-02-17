# ADR-0011: OT/IT Convergence Standards for Agentic Systems

## Status

Proposed

## Date

2026-02-12

## Context

The [Agentic Engineering Charter](../CHARTER.md) calls for defining best practices for OT/IT convergence and establishing design patterns for distributed industrial intelligence.

0xSCADA already bridges the OT/IT divide — off-chain real-time control (OT) with on-chain governance and audit (IT). However, as agentic systems operate across both domains, we need formal standards for how agents traverse the OT/IT boundary.

The fundamental tension:

| Dimension | OT Priority | IT Priority |
|-----------|------------|------------|
| **Availability** | 99.999% uptime | Planned maintenance windows |
| **Latency** | <10ms deterministic | Best-effort, seconds acceptable |
| **Change velocity** | Slow, validated, tested | Continuous deployment |
| **Security model** | Air-gapped, physically secured | Defense-in-depth, patched frequently |
| **Data model** | Real-time tags, registers | Relational, document, event-stream |
| **Lifecycle** | 15-30 year asset life | 3-5 year refresh cycles |

Agents that don't respect these differences will either compromise OT safety or be too constrained to provide IT-layer value.

## Decision

We define a **Convergence Layer Architecture** that provides formal boundaries, translation services, and protocol standards for agents operating across OT and IT domains.

### 1. Domain Boundary Model

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          IT DOMAIN                                          │
│                                                                             │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                     │
│   │  Dashboard   │  │  Analytics   │  │  Governance  │                     │
│   │  (React)     │  │  (Batch)     │  │  (Chain)     │                     │
│   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                     │
│          └─────────────────┼─────────────────┘                             │
│                            │                                               │
├────────────────────────────┼───────────────────────────────────────────────┤
│                    CONVERGENCE LAYER                                        │
│                            │                                               │
│   ┌────────────────────────┼────────────────────────────────────────────┐  │
│   │  ┌─────────┐  ┌───────┴───────┐  ┌─────────┐  ┌─────────┐        │  │
│   │  │Protocol │  │ Data          │  │Security │  │Time     │        │  │
│   │  │Gateway  │  │ Translator    │  │Boundary │  │Sync     │        │  │
│   │  │         │  │               │  │         │  │         │        │  │
│   │  │OPC-UA   │  │Tag→Event      │  │mTLS     │  │PTP/NTP  │        │  │
│   │  │MQTT     │  │Register→JSON  │  │Firewall │  │TAI      │        │  │
│   │  │Modbus   │  │Alarm→Alert    │  │IDS/IPS  │  │         │        │  │
│   │  └─────────┘  └───────────────┘  └─────────┘  └─────────┘        │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
│                            │                                               │
├────────────────────────────┼───────────────────────────────────────────────┤
│                          OT DOMAIN                                          │
│                            │                                               │
│   ┌──────────────┐  ┌─────┴────────┐  ┌──────────────┐                     │
│   │  PLCs/RTUs   │  │  Field I/O   │  │  Safety      │                     │
│   │  (Realtime)  │  │  (Sensors)   │  │  (SIS)       │                     │
│   └──────────────┘  └──────────────┘  └──────────────┘                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2. Agent Domain Restrictions

Agents are classified by their domain authorization:

| Agent Type | OT Access | Convergence Layer | IT Access | Example |
|-----------|----------|------------------|----------|---------|
| **IT-Only** | None | Read via gateway | Full | Dashboard, analytics |
| **Convergence** | Read via gateway | Full | Full | Ops Agent, Compliance Agent |
| **OT-Supervised** | Read + bounded write | Full | Full | ChangeControl Agent (AC-3) |
| **OT-Native** | Direct (embedded) | Publish only | None | Safety PLC logic |

**Critical rule**: No IT-domain agent may directly address OT-domain devices. All cross-domain communication flows through the Convergence Layer.

### 3. Protocol Standards

| Protocol | Domain | Use Case | Agent Interaction |
|----------|--------|----------|------------------|
| **OPC-UA** | OT ↔ Convergence | Primary industrial protocol | Agents subscribe via gateway |
| **MQTT** | Convergence ↔ IT | Event streaming, telemetry | Agents publish/subscribe topics |
| **gRPC** | IT ↔ IT | Agent-to-agent communication | Direct with mTLS (ADR-0008) |
| **JSON-RPC** | Convergence | Blockchain interaction | Batch anchoring, governance |
| **Modbus TCP** | OT (legacy) | Legacy device access | Gateway translation only |

### 4. Data Translation Standards

The Convergence Layer translates between OT and IT data models:

```typescript
interface ConvergenceTranslation {
  // OT → IT: Tag data becomes typed events
  translateTag(tag: OpcUaTag): IndustrialEvent;

  // IT → OT: Commands become bounded setpoint changes
  translateCommand(cmd: AgentCommand): SetpointChange;

  // Validation: Every translation is constraint-checked
  validateBoundary(translation: Translation): BoundaryCheck;
}

// Every cross-domain translation is logged
interface TranslationAuditEntry {
  source_domain: 'OT' | 'IT';
  target_domain: 'OT' | 'IT';
  agent: string;
  translation_type: string;
  input_hash: string;
  output_hash: string;
  boundary_check: 'PASS' | 'FAIL' | 'ESCALATE';
  timestamp: string;
}
```

### 5. Time Synchronization

OT and IT systems have different time requirements. The Convergence Layer enforces:

- **OT domain**: PTP (IEEE 1588) or hardware timestamping, <1ms accuracy
- **IT domain**: NTP, <100ms accuracy acceptable
- **Convergence Layer**: Maps between time domains, records both timestamps
- **Blockchain**: Block timestamps used for ordering, not precision timing
- **Agent actions**: Logged with both OT-precision and IT-precision timestamps

### 6. Failure Isolation

If the IT domain fails, OT continues operating independently:

- OT control loops run locally on PLCs (never dependent on IT)
- Convergence Layer buffers events during IT outage
- Agents in M3: SAFE_HOLD if they lose Convergence Layer connectivity
- No IT failure can propagate to OT safety functions

## Consequences

### Positive

- **Safety preservation**: OT domain isolation maintained regardless of IT state
- **Clear boundaries**: Agents know exactly what they can access and how
- **Auditability**: Every cross-domain interaction is logged and hashable
- **Vendor agnostic**: Protocol standards support multi-vendor environments
- **Charter alignment**: Implements "Interoperability Over Lock-In" and "Safety First"

### Negative

- **Convergence Layer complexity**: New infrastructure component to build and maintain
- **Latency overhead**: Cross-domain translation adds processing time
- **Protocol diversity**: Supporting multiple protocols increases testing surface
- **Operational burden**: Teams need both OT and IT skills

### Neutral

- Aligns with Purdue Model / IEC 62443 zone concepts
- Compatible with existing 0xSCADA OPC-UA driver (ADR-0005)
- Can be implemented incrementally (start with OPC-UA gateway, expand protocols)

## Alternatives Considered

### Alternative 1: Flat Network with ACLs

Single network for OT and IT with access control lists.

Rejected because: Violates defense-in-depth; a compromised IT agent could reach OT devices. Unacceptable for safety-critical infrastructure.

### Alternative 2: Complete Air Gap

Fully air-gapped OT with manual data transfer.

Rejected because: Prevents the real-time monitoring and agentic optimization that 0xSCADA enables. Air gaps also don't prevent all attacks (Stuxnet proved this).

### Alternative 3: Cloud-First Architecture

Route all data through cloud services.

Rejected because: Adds unacceptable latency for OT operations, creates single point of failure, and raises data sovereignty concerns for industrial operators.

## References

- [Agentic Engineering Charter](../CHARTER.md)
- [ADR-0001: Hybrid On-Chain/Off-Chain Architecture](ADR-0001-hybrid-on-off-chain-architecture.md)
- [ADR-0005: OPC-UA Protocol Driver](ADR-0005-opcua-protocol-driver.md)
- [ADR-0008: Zero-Trust Agent Deployment](ADR-0008-zero-trust-agent-deployment.md)
- [IEC 62443: Industrial Network Security Zones & Conduits](https://www.iec.ch/cyber-security)
- [Purdue Enterprise Reference Architecture](https://en.wikipedia.org/wiki/Purdue_Enterprise_Reference_Architecture)
- [IEEE 1588: Precision Time Protocol](https://standards.ieee.org/ieee/1588/6825/)
