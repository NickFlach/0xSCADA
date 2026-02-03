# OperationalNFT Use Cases

> Industrial-grade NFTs representing certified operational states

## Overview

The `OperationalNFT` contract creates ERC-721 tokens that represent **certified operational realities**—not collectibles or art. Each NFT is a tamper-evident, on-chain record linking to off-chain evidence (via LFS artifact hashes).

**Key Principle**: "Transfer = Operational responsibility changes hands"

---

## Certification Types

### 1. MACHINE_STATE

**Purpose**: Certified snapshot of physical equipment state

**Artifact Contents**:
- Digital twin checkpoint hash
- PLC state dumps (registers, I/O states)
- Sensor readings at snapshot time
- Equipment health metrics
- Operating parameters

**Use Cases**:

| Scenario | Example |
|----------|---------|
| **Commissioning** | "Pump P-101 commissioned at 87 PSI, 1200 RPM, vibration 0.3mm/s" |
| **Handover** | Asset state certified before shift change or contractor handoff |
| **Pre-Maintenance** | Baseline state before planned maintenance window |
| **Post-Repair** | Verified restoration to known-good state |
| **Insurance** | Proof of operational condition for coverage |

**Validity**: Typically point-in-time (no expiry) or tied to next maintenance window

**Supersession**: New snapshot invalidates previous when equipment state changes significantly

---

### 2. SAFETY_CONDITION

**Purpose**: Validated safety system state per functional safety standards (IEC 61511, IEC 62061)

**Artifact Contents**:
- Safety Integrity Level (SIL) verification report
- Safety logic validation results
- Trip test records
- Proof test documentation
- Safety function block diagrams
- Failure mode analysis (FMEA/HAZOP refs)

**Use Cases**:

| Scenario | Example |
|----------|---------|
| **SIL Verification** | "ESD-001 trip logic verified SIL-2 per IEC 61511" |
| **Proof Testing** | "PSV-101 proof test passed, 12-month validity" |
| **Regulatory Audit** | On-chain evidence for OSHA/EPA compliance |
| **Incident Response** | Proof safety systems were certified before event |
| **Insurance Claims** | Evidence of safety protocol compliance |

**Validity**: Tied to proof test interval (typically 12-24 months)

**Supersession**: Mandatory renewal after proof test or any safety system modification

---

### 3. AGENT_CAPABILITY

**Purpose**: Certified AI/agent operational capability and boundaries

**Artifact Contents**:
- Agent model hash (weights, architecture)
- Evaluation suite results
- Decision boundary specifications
- Performance metrics (latency, accuracy)
- Failure mode catalog
- Human-in-the-loop requirements
- Training data provenance

**Use Cases**:

| Scenario | Example |
|----------|---------|
| **Deployment Approval** | "Agent-Alpha certified for pressure control ±5%, response <100ms" |
| **Capability Boundaries** | On-chain record of what agent CAN and CANNOT do |
| **Model Updates** | New certification required when model weights change |
| **Liability Allocation** | Clear record of certified capabilities at time of incident |
| **Regulatory Compliance** | Evidence for AI governance requirements |

**Validity**: Until model retrain or capability expansion

**Supersession**: Any model update requires new certification

---

### 4. COMPLIANCE_SNAPSHOT

**Purpose**: Regulatory compliance evidence bundle

**Artifact Contents**:
- Audit reports (ISO, IEC, NIST)
- Compliance checklist completion
- Remediation evidence
- Third-party attestations
- Policy documents in effect
- Control implementation evidence

**Use Cases**:

| Scenario | Example |
|----------|---------|
| **ISO Certification** | "Site-A ISO 27001:2022 compliant as of 2024-01-15" |
| **ISA-95 Compliance** | Manufacturing execution system alignment proof |
| **IEC 62443** | Industrial cybersecurity compliance evidence |
| **Environmental** | EPA/environmental regulation compliance snapshots |
| **Industry-Specific** | FDA 21 CFR Part 11, NERC CIP, etc. |

**Validity**: Tied to certification cycle (typically 1-3 years)

**Supersession**: Annual surveillance audits or recertification

---

### 5. CALIBRATION_RECORD

**Purpose**: Instrument calibration verification with traceability

**Artifact Contents**:
- Calibration certificate
- As-found/as-left readings
- Measurement uncertainty analysis
- Reference standard traceability (NIST, etc.)
- Environmental conditions during calibration
- Calibration procedure reference

**Use Cases**:

| Scenario | Example |
|----------|---------|
| **Instrument Calibration** | "PT-101 calibrated ±0.1% per NIST traceability" |
| **Measurement Assurance** | Proof that readings were from calibrated instrument |
| **Audit Trail** | Historical calibration chain for forensics |
| **Quality Control** | Evidence for ISO 9001 measurement requirements |
| **Legal Evidence** | Admissible proof of instrument accuracy |

**Validity**: Calibration interval (typically 6-24 months depending on criticality)

**Supersession**: Each calibration cycle produces new certification

---

## Workflow Patterns

### Certification Lifecycle

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   ISSUED    │────▶│   ACTIVE    │────▶│  EXPIRED    │
│             │     │             │     │             │
└─────────────┘     └─────────────┘     └─────────────┘
                           │
                           │ revoke()
                           ▼
                    ┌─────────────┐
                    │  SUPERSEDED │
                    │             │
                    └─────────────┘
                           │
                           │ points to
                           ▼
                    ┌─────────────┐
                    │ NEW VERSION │
                    │             │
                    └─────────────┘
```

### Renewal Pattern

```solidity
// Operator recalibrates instrument
bytes32 newArtifact = storeCalibrationData(...);

// Mint new cert, auto-revoke old
uint256 newCertId = nft.mintSuperseding(
    siteOwner,
    CertificationType.CALIBRATION_RECORD,
    newArtifact,
    block.timestamp + 365 days,
    siteId,
    "ipfs://...",
    oldCertId  // This gets superseded
);
```

### Verification Pattern

```solidity
// Before allowing critical operation
(bool isValid, string memory reason) = nft.verifyCertification(certId);
require(isValid, reason);

// Or verify by artifact
(bool valid, uint256 tokenId, string memory status) = 
    nft.verifyCertificationByArtifact(artifactHash);
```

---

## Integration Points

### With EventAnchor

```
Event occurs → Hash event data → Include cert reference
                                      │
                                      ▼
                              OperationalNFT tokenId
                              proves instrument was
                              calibrated at event time
```

### With SiteRegistry

```
Site registered → Certifications minted → Linked via siteId
                                              │
                                              ▼
                                    Query: "Show all active
                                    safety certs for Site-A"
```

### With RealityAnchor (Future)

```
Artifact created → Certified by NFT → Anchored to chain
        │                │                    │
        └────────────────┴────────────────────┘
                         │
                    Full provenance:
                    What → Certified by whom → When anchored
```

---

## Economic Model

### Transfer Semantics

When an OperationalNFT is transferred:

1. **Ownership Transfer**: Asset operational responsibility changes hands
2. **Liability Transfer**: Certification holder assumes responsibility
3. **Historical Record**: Previous ownership chain preserved on-chain

### Potential Extensions

| Feature | Description |
|---------|-------------|
| **Staking** | Certifiers stake tokens, slashed for false certifications |
| **Renewal Fees** | Automated fee collection for recertification |
| **Insurance Integration** | Premiums tied to certification status |
| **Marketplace** | Trade certified assets with provenance |

---

## Security Considerations

1. **Role Separation**: CERTIFIER_ROLE and REVOKER_ROLE are distinct
2. **Artifact Uniqueness**: Same artifact cannot be certified twice
3. **Immutable History**: Revocation doesn't delete, only marks superseded
4. **Time Validation**: Cannot mint with past expiry
5. **Access Control**: OpenZeppelin AccessControl for role management

---

## Gas Optimization Notes

- Certification data stored in single mapping (not separate fields)
- Site/type indexes add gas on mint, save on queries
- Consider batch minting for high-volume scenarios
- Enumerable extension adds overhead—remove if not needed

---

## Future Enhancements

1. **Batch Minting**: Mint multiple certs in single tx
2. **Delegation**: Allow certifier to delegate to specific sites
3. **Expiry Alerts**: Events emitted N days before expiry
4. **Cross-Chain**: Bridge certifications to L2 for lower gas
5. **ZK Proofs**: Prove certification validity without revealing details

---

*"NFT = Certified operational state, not art."*
