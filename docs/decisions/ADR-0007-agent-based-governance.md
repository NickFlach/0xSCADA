# ADR-0007: Agent-Based Governance Model

## Status

Accepted

## Date

2024-02-01

## Context

0xSCADA operates critical infrastructure where governance decisions have real-world consequences:
- Changing control parameters affects physical processes
- Access control changes determine who can operate systems
- Protocol upgrades require coordinated deployment
- Incident response needs clear authority chains

Traditional SCADA governance is centralized (single operator/vendor), but 0xSCADA's blockchain integration enables distributed governance. We need a model that:

1. **Distributes authority** across stakeholders
2. **Maintains accountability** for all decisions
3. **Enables rapid response** for emergencies
4. **Provides transparency** for auditors
5. **Scales** across multiple facilities

## Decision

We implement an **Agent-Based Governance Model** with:

1. **Agent Roles**:
   ```
   OPERATOR    - Day-to-day system operation
   ENGINEER    - Configuration and tuning
   AUDITOR     - Read-only access, compliance verification
   GUARDIAN    - Emergency shutdown authority
   GOVERNOR    - Protocol upgrades, role management
   ```

2. **Multi-Signature Requirements**:
   | Action | Threshold |
   |--------|-----------|
   | Read data | 1 of any |
   | Adjust setpoint | 1 OPERATOR or ENGINEER |
   | Change config | 2 of {ENGINEER, GOVERNOR} |
   | Emergency stop | 1 GUARDIAN |
   | Add/remove agent | 2 of 3 GOVERNORs |
   | Protocol upgrade | 3 of 5 GOVERNORs + 24h timelock |

3. **On-Chain Governance Contracts**:
   ```solidity
   contract AgentRegistry {
     mapping(address => Role) public agents;
     mapping(bytes32 => Proposal) public proposals;
     
     function propose(Action action) external;
     function approve(bytes32 proposalId) external;
     function execute(bytes32 proposalId) external;
   }
   ```

4. **Off-Chain Integration**:
   - Agent credentials verified against on-chain registry
   - Actions logged with agent signature
   - Merkle commitments include agent attestations

5. **Emergency Override**:
   - GUARDIAN role can trigger immediate safety actions
   - Overrides logged but not blocked by governance
   - Post-incident review required within 48 hours

## Consequences

### Positive

- **Distributed trust**: No single point of failure/corruption
- **Audit trail**: All decisions cryptographically signed
- **Flexible authority**: Roles match organizational structure
- **Transparent**: Anyone can verify governance actions
- **Emergency handling**: Safety not blocked by consensus

### Negative

- **Coordination overhead**: Multi-sig slows routine changes
- **Key management**: Agents must secure private keys
- **Complexity**: More moving parts than central admin
- **Recovery risk**: Lost keys can lock out legitimate agents

### Neutral

- Follows DAO governance patterns adapted for industrial use
- Compatible with traditional RBAC mental models
- Can integrate with enterprise identity systems (future)

## Alternatives Considered

### Alternative 1: Traditional RBAC

Standard role-based access control without blockchain.

Rejected because: Loses transparency, audit trail depends on trusted admin, no cryptographic accountability.

### Alternative 2: Pure DAO Voting

All decisions made by token-weighted voting.

Rejected because: Too slow for operational decisions, token economics don't map to industrial authority.

### Alternative 3: Centralized Admin with Logging

Single admin with immutable audit log.

Rejected because: Single point of failure, doesn't distribute trust across stakeholders.

### Alternative 4: Federated Consensus

All facility operators must agree on all changes.

Rejected because: Doesn't scale, single veto blocks necessary changes, no emergency override path.

## References

- [0xSCADA Governance Contracts](../../contracts/governance/)
- [Agent Registry Implementation](../../src/core/agents/)
- [Multi-Signature Wallet Patterns](https://gnosis-safe.io/)
- [ADR-0003: Clique PoA Consensus](ADR-0003-clique-poa-consensus.md)
