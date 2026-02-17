# Vendor Learning Tract: Audit & Traceability

Compliance guide for 0xSCADA — CFR 21 Part 11 compliance, audit trails, electronic signatures, recipe management, and traceability.

---

## 1. Regulatory Overview

### 1.1 21 CFR Part 11 — Electronic Records & Signatures

FDA regulation governing electronic records in pharmaceutical, biotech, and food manufacturing. Key requirements:

| Requirement | 0xSCADA Implementation |
|---|---|
| **Audit trails** | Immutable, timestamped event log with blockchain anchoring |
| **Electronic signatures** | Cryptographic signing with user identity binding |
| **Access controls** | RBAC with site-level isolation |
| **System validation** | IQ/OQ/PQ documentation support |
| **Data integrity** | ALCOA+ principles enforced |
| **Record retention** | Configurable retention with tamper-evident storage |

### 1.2 ALCOA+ Principles

0xSCADA enforces ALCOA+ for all electronic records:

| Principle | Implementation |
|---|---|
| **Attributable** | Every action linked to authenticated user/system |
| **Legible** | Structured data with human-readable audit views |
| **Contemporaneous** | Timestamps at point of capture (NTP-synced) |
| **Original** | First-capture data preserved; changes create new versions |
| **Accurate** | Validated inputs, checksums, blockchain verification |
| **Complete** | No selective deletion; full lifecycle captured |
| **Consistent** | Standardized formats across all sites |
| **Enduring** | Long-term storage with format migration support |
| **Available** | Accessible for inspection within regulatory timeframes |

### 1.3 Other Applicable Standards

- **IEC 62443** — Industrial cybersecurity
- **ISA-88** — Batch control and recipe management
- **ISA-95** — Enterprise-control system integration
- **EU Annex 11** — Computerised systems (EU GMP)
- **GAMP 5** — Good Automated Manufacturing Practice

---

## 2. Audit Trails

### 2.1 Audit Trail Architecture

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Application │───▶│  Audit Log   │───▶│  Blockchain  │
│   Events     │    │  (Immutable) │    │   Anchors    │
└──────────────┘    └──────────────┘    └──────────────┘
                           │
                    ┌──────┴──────┐
                    │  SIEM/Long  │
                    │  Term Store │
                    └─────────────┘
```

### 2.2 Audited Events

**Process Data:**
- Tag value changes (who, when, old value, new value, reason)
- Alarm state transitions (triggered → acknowledged → cleared)
- Setpoint modifications
- Manual overrides

**System Events:**
- User login/logout
- Permission changes
- Configuration modifications
- System start/stop/restart
- Backup and restore operations

**Recipe/Batch Events:**
- Recipe creation, modification, approval
- Batch start, phase transitions, completion
- Parameter deviations
- Material additions

### 2.3 Audit Record Structure

```json
{
  "id": "audit-20260214-001234",
  "timestamp": "2026-02-14T22:15:00.000Z",
  "source": "0xscada-server",
  "category": "process",
  "action": "tag.write",
  "actor": {
    "userId": "user-123",
    "username": "j.smith",
    "role": "operator",
    "station": "HMI-NORTH-01",
    "ip": "10.0.1.50"
  },
  "resource": {
    "type": "tag",
    "id": "REACTOR1_TEMP_SP",
    "site": "site-001"
  },
  "changes": {
    "before": { "value": 72.0, "unit": "°C" },
    "after": { "value": 75.0, "unit": "°C" }
  },
  "reason": "Batch recipe step 3 requires 75°C",
  "signature": {
    "method": "ecdsa-p256",
    "signedBy": "user-123",
    "hash": "sha256:abc123...",
    "timestamp": "2026-02-14T22:15:00.000Z"
  },
  "integrity": {
    "previousHash": "sha256:def456...",
    "currentHash": "sha256:789ghi...",
    "anchorBatch": "anchor-batch-42"
  }
}
```

### 2.4 Audit Trail Integrity

**Hash chain:** Each audit record includes the SHA-256 hash of the previous record, forming a tamper-evident chain.

**Blockchain anchoring:** Periodic batch anchoring of audit log hashes:

```bash
# Automatic (configured interval)
# Or manual:
0xscada anchor create --data $(0xscada events list --json | sha256sum)
0xscada anchor verify <anchor-id>
```

**Verification:**
```bash
# Verify audit trail integrity
0xscada audit verify --from 2026-01-01 --to 2026-02-14
# Output: ✓ 15,234 records verified, chain intact, 42 anchors confirmed
```

### 2.5 Retention & Archival

```json
{
  "audit": {
    "retention": {
      "online": "2y",
      "archive": "10y",
      "format": "jsonl.gz",
      "archiveDestination": "s3://compliance-archive/0xscada/"
    },
    "deletion": {
      "policy": "prohibited",
      "override": "requires dual-admin approval + documented justification"
    }
  }
}
```

---

## 3. Electronic Signatures

### 3.1 Signature Requirements (21 CFR Part 11.50–11.100)

- Unique to one individual
- Not reusable or reassignable
- Includes printed name, date/time, and meaning (e.g., "approved", "reviewed")
- Two-component: something you know + something you have/are

### 3.2 Signing a Record

**API:**
```http
POST /api/records/<id>/sign
Content-Type: application/json
Authorization: Bearer <token>

{
  "meaning": "approved",
  "reason": "Batch parameters within specification",
  "mfaToken": "<totp-code>"
}
```

**CLI:**
```bash
0xscada sign <record-id> --meaning "approved" --reason "Within spec" --mfa <code>
```

### 3.3 Signature Record

```json
{
  "signatureId": "sig-001",
  "recordId": "batch-2026-001",
  "signedBy": {
    "userId": "user-456",
    "name": "Dr. Jane Smith",
    "title": "Quality Manager",
    "department": "QA"
  },
  "meaning": "approved",
  "reason": "Batch parameters within specification",
  "method": {
    "primary": "password",
    "secondary": "totp",
    "verified": true
  },
  "timestamp": "2026-02-14T22:20:00.000Z",
  "cryptographic": {
    "algorithm": "ECDSA-P256",
    "publicKey": "0x04abc...",
    "signature": "0xdef...",
    "recordHash": "sha256:123..."
  }
}
```

### 3.4 Signature Policies

```json
{
  "signatures": {
    "requiredFor": [
      "recipe.approve",
      "batch.release",
      "deviation.close",
      "calibration.approve",
      "tag.criticalWrite"
    ],
    "requireMFA": true,
    "requireReason": true,
    "sessionTimeout": 300,
    "consecutiveSigningLimit": 5,
    "dualSignature": {
      "enabled": true,
      "for": ["batch.release", "deviation.close"],
      "roles": ["operator", "qa_manager"]
    }
  }
}
```

---

## 4. Recipe Management (ISA-88)

### 4.1 Recipe Hierarchy

```
General Recipe (site-independent)
└── Site Recipe (site-specific parameters)
    └── Master Recipe (equipment-specific)
        └── Control Recipe (single batch instance)
```

### 4.2 Recipe Data Model

```json
{
  "id": "recipe-001",
  "name": "Product A - Standard Batch",
  "version": "3.2",
  "status": "approved",
  "category": "master-recipe",
  "phases": [
    {
      "id": "phase-1",
      "name": "Charge",
      "sequence": 1,
      "parameters": [
        { "name": "MATERIAL_A_AMOUNT", "value": 500, "unit": "kg", "tolerance": 2 },
        { "name": "MATERIAL_B_AMOUNT", "value": 200, "unit": "kg", "tolerance": 1 }
      ],
      "duration": { "nominal": 30, "max": 45, "unit": "min" }
    },
    {
      "id": "phase-2",
      "name": "React",
      "sequence": 2,
      "parameters": [
        { "name": "TEMPERATURE", "value": 75, "unit": "°C", "tolerance": 2 },
        { "name": "AGITATOR_SPEED", "value": 150, "unit": "rpm", "tolerance": 5 },
        { "name": "HOLD_TIME", "value": 120, "unit": "min", "tolerance": 5 }
      ]
    }
  ],
  "approvals": [
    { "role": "process_engineer", "signatureId": "sig-010", "date": "2026-02-10" },
    { "role": "qa_manager", "signatureId": "sig-011", "date": "2026-02-11" }
  ],
  "changelog": [
    { "version": "3.2", "date": "2026-02-10", "author": "j.smith", "changes": "Adjusted hold time from 100 to 120 min" },
    { "version": "3.1", "date": "2026-01-05", "author": "j.smith", "changes": "Updated material B amount" }
  ]
}
```

### 4.3 Recipe Version Control

- All recipe modifications create new versions
- Previous versions are never deleted or modified
- Version comparison: `0xscada blueprints diff <id> --v1 3.1 --v2 3.2`
- Approval workflow required before production use
- Blockchain anchoring of approved recipe hashes

### 4.4 Batch Execution Record

```json
{
  "batchId": "batch-2026-0214-001",
  "recipeId": "recipe-001",
  "recipeVersion": "3.2",
  "site": "site-001",
  "equipment": "reactor-1",
  "status": "completed",
  "startTime": "2026-02-14T08:00:00Z",
  "endTime": "2026-02-14T14:30:00Z",
  "phases": [
    {
      "phaseId": "phase-1",
      "status": "completed",
      "actualParameters": [
        { "name": "MATERIAL_A_AMOUNT", "actual": 501.2, "target": 500, "deviation": false }
      ],
      "startTime": "2026-02-14T08:00:00Z",
      "endTime": "2026-02-14T08:28:00Z"
    }
  ],
  "deviations": [],
  "signatures": {
    "started": "sig-020",
    "released": "sig-021"
  },
  "anchorTxHash": "0xabc123..."
}
```

---

## 5. Compliance Validation

### 5.1 System Validation (IQ/OQ/PQ)

| Phase | Description | 0xSCADA Support |
|---|---|---|
| **IQ** (Installation Qualification) | Verify correct installation | `0xscada status`, automated health checks |
| **OQ** (Operational Qualification) | Verify operation per spec | Test suite: `0xscada test --compliance` |
| **PQ** (Performance Qualification) | Verify real-world performance | Monitoring dashboards, load test results |

### 5.2 Compliance Report Generation

```bash
# Generate compliance report
0xscada audit report --from 2026-01-01 --to 2026-02-14 --format pdf
# Includes: audit trail summary, signature log, deviation list, anchor verifications
```

### 5.3 Inspection Readiness Checklist

- [ ] Audit trails enabled and verified (`0xscada audit verify`)
- [ ] Electronic signatures configured with MFA
- [ ] User access matrix documented and current
- [ ] Recipe version control active
- [ ] Blockchain anchors verified for period
- [ ] Backup and recovery tested within last quarter
- [ ] System validation documents (IQ/OQ/PQ) current
- [ ] Change control procedures documented
- [ ] Training records for all system users
- [ ] Data integrity self-assessment completed

---

## 6. Data Integrity Self-Assessment

### 6.1 Regular Checks

| Check | Frequency | Command |
|---|---|---|
| Audit trail chain integrity | Daily | `0xscada audit verify --last 24h` |
| Blockchain anchor verification | Weekly | `0xscada anchor verify --all --last 7d` |
| User access review | Monthly | `0xscada auth list-keys --with-usage` |
| Signature log review | Monthly | `0xscada audit report --category signature` |
| Full compliance assessment | Quarterly | `0xscada audit report --full` |

### 6.2 Common Findings & Remediation

| Finding | Risk | Remediation |
|---|---|---|
| Shared user accounts | High | Create individual accounts; enforce unique logins |
| Missing audit entries | Critical | Investigate system gaps; restore from backup |
| Expired certificates | Medium | Enable auto-renewal; set expiry alerts |
| Unsigned critical changes | High | Enable mandatory signatures for critical operations |
| Unbacked audit logs | High | Configure redundant log destinations |
