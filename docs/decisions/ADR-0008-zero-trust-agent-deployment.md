# ADR-0008: Zero-Trust Agent Deployment Model

## Status

Proposed

## Date

2026-02-12

## Context

The [Agentic Engineering Charter](../CHARTER.md) establishes "Security as Foundation" as a core principle: every agentic deployment must assume adversarial conditions and implement layered defenses.

0xSCADA's current agent framework ([ADR-0007](ADR-0007-agent-based-governance.md)) defines roles and multi-signature governance but does not prescribe a deployment security model. As the system grows to support autonomous agents operating across facility boundaries, we face new threat vectors:

1. **Agent impersonation**: A compromised agent identity could execute unauthorized actions
2. **Lateral movement**: An agent with access to one subsystem could pivot to others
3. **Supply chain attacks**: Malicious agent code injected through update channels
4. **Replay attacks**: Captured agent messages replayed to trigger duplicate actions
5. **Network position attacks**: Man-in-the-middle between agents and the governance layer

Industrial control systems are high-value targets. The convergence of OT and IT networks expands the attack surface. Traditional perimeter-based security is insufficient for a distributed agent architecture.

## Decision

We adopt a **Zero-Trust Agent Deployment Model** where no agent is inherently trusted, regardless of network position or prior authentication.

### 1. Agent Identity

Every agent must possess a **cryptographic identity** bound to the 0x5CADA chain:

- Agent keypair generated via secp256k1 (compatible with Ethereum signing)
- Public key registered in the on-chain `AgentRegistry` contract
- Identity attestation includes: role, capabilities, deployment scope, and expiry
- Agents must re-attest identity at configurable intervals (default: 24h)

### 2. Mutual Authentication

All agent-to-agent and agent-to-service communication requires mutual TLS with certificate pinning:

```
Agent A ──── mTLS ────► Agent B
  │                        │
  └── Verify on-chain ◄────┘
      registry status
```

### 3. Least-Privilege Capability Model

Agents receive **capability tokens** that grant specific, time-bounded permissions:

| Capability | Scope | TTL | Renewal |
|-----------|-------|-----|---------|
| `read:telemetry` | Per-site | 1h | Auto |
| `write:setpoint` | Per-asset | 15min | Requires re-auth |
| `execute:emergency_stop` | Global | Session | Guardian only |
| `propose:config_change` | Per-site | 30min | Manual |
| `anchor:batch` | Global | 1h | Auto |

### 4. Agent Attestation Chain

Every agent action must include an attestation chain:

```
{
  "agent": "0x1234...abcd",
  "action": "adjust_setpoint",
  "target": "asset:pump-001",
  "capability": "write:setpoint",
  "nonce": 847291,
  "timestamp": "2026-02-12T19:21:00Z",
  "signature": "0xdeadbeef...",
  "parent_attestation": "0xprevious..."
}
```

### 5. Network Segmentation

Agents operate within defined network zones with explicit cross-zone policies:

```
┌─────────────────────┐    ┌─────────────────────┐
│   FIELD ZONE (OT)   │    │   GOVERNANCE ZONE   │
│                      │    │                      │
│  PLCs, RTUs, I/O    ├────┤  Agent Registry      │
│  Real-time control  │    │  Multi-sig contracts │
│                      │    │  Audit anchoring     │
└──────────┬───────────┘    └──────────┬───────────┘
           │                           │
     ┌─────┴─────────────────────┬─────┘
     │      AGENT ZONE (DMZ)    │
     │                           │
     │  Ops Agent               │
     │  ChangeControl Agent     │
     │  Compliance Agent        │
     └───────────────────────────┘
```

## Consequences

### Positive

- **Defense in depth**: Compromise of one agent does not grant access to others
- **Auditability**: Every action cryptographically attributable to a specific agent
- **Blast radius containment**: Capability scoping limits damage from compromised agents
- **Regulatory alignment**: Meets IEC 62443 and NIST CSF requirements for OT security
- **Charter compliance**: Directly implements "Security as Foundation" principle

### Negative

- **Operational overhead**: Capability renewal adds latency to agent workflows
- **Key management complexity**: Each agent needs secure key storage (HSM recommended)
- **Bootstrap problem**: Initial agent deployment requires trusted provisioning process
- **Performance impact**: mTLS and attestation verification add per-request overhead

### Neutral

- Aligns with NIST SP 800-207 Zero Trust Architecture
- Compatible with existing Agent Registry contract from ADR-0007
- Capability model can be implemented incrementally

## Alternatives Considered

### Alternative 1: Perimeter-Based Security

Trust agents within the network perimeter, authenticate only at the boundary.

Rejected because: OT/IT convergence dissolves traditional perimeters; insider threats and lateral movement are primary risk vectors in industrial environments.

### Alternative 2: Role-Based Trust (Current State)

Trust agents based on their registered role in ADR-0007.

Rejected because: Roles are too coarse-grained; a compromised ENGINEER agent would have broad access. Need capability-level granularity.

### Alternative 3: Hardware-Only Attestation

Require TPM/HSM attestation for all agent actions.

Rejected because: Not all deployment targets have hardware security modules; would prevent software-only development and testing. HSM should be recommended but not required.

## References

- [Agentic Engineering Charter](../CHARTER.md)
- [ADR-0007: Agent-Based Governance Model](ADR-0007-agent-based-governance.md)
- [NIST SP 800-207: Zero Trust Architecture](https://csrc.nist.gov/publications/detail/sp/800-207/final)
- [IEC 62443: Industrial Communication Networks Security](https://www.iec.ch/cyber-security)
- [0xSCADA Propagation Model](../propagation-model.md)
