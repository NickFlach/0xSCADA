# Digital Twin Checkpoint System Design

> **VERITY Architecture - Phase β.2**  
> **Status**: Design Complete (Blocked by β.1)  
> **Version**: 1.0.0  
> **Last Updated**: 2026-02-02

---

## Overview

The Digital Twin Checkpoint system brings git-like version control to industrial reality. Just as developers use branches and commits to manage code changes, 0xSCADA uses checkpoints and branches to manage industrial configuration changes.

```
main (production)
├── feature/new-pump-config
│   └── checkpoint-a7f3e2 (proposed state)
├── experiment/higher-pressure
│   └── checkpoint-b2c4d1 (what-if scenario)
├── vendor/siemens-upgrade
│   └── checkpoint-c9e8f3 (vendor testing)
└── training/operator-sim
    └── checkpoint-d4a1b2 (training environment)
```

---

## Core Concepts

### 1. Checkpoints (≈ Git Commits)

A **TwinCheckpoint** is an immutable, content-addressed snapshot of complete industrial reality:

| Component | Description |
|-----------|-------------|
| `plcStates` | All PLC/DCS tag values, modes, programs |
| `topology` | Plant connectivity graph (equipment, piping) |
| `safetyEnvelopes` | Operational constraints (SIL-rated) |
| `calibrations` | Instrument calibration records |
| `alarmThresholds` | Alarm configuration |

**Key Properties:**
- **Content-addressed**: ID is SHA-256 hash of content
- **Immutable**: Never modified after creation
- **Linked**: Points to parent checkpoint(s) forming a DAG
- **Signed**: Optional cryptographic attestation
- **Anchored**: Optional blockchain proof

### 2. Branches (≈ Git Branches)

A **BranchReference** is a named, mutable pointer to a checkpoint:

```
Branch "main" → checkpoint abc123
Branch "feature/pump-upgrade" → checkpoint def456
```

**Branch Naming Convention:**

| Pattern | Purpose | Example |
|---------|---------|---------|
| `main` | Production state | Always protected |
| `feature/*` | New configurations | `feature/new-pump-config` |
| `experiment/*` | What-if scenarios | `experiment/higher-pressure` |
| `hotfix/*` | Emergency fixes | `hotfix/valve-calibration` |
| `vendor/*` | Vendor testing | `vendor/rockwell-aoi-v2` |
| `training/*` | Operator training | `training/batch-process-sim` |
| `release/*` | Staged deployments | `release/v2.5.0` |

### 3. Diffs (≈ Git Diff)

**CheckpointDiff** compares two checkpoints:

```typescript
const diff = await twin.diff("abc123", "def456");
// Returns:
// - All changed tag values
// - Topology modifications
// - Safety constraint changes
// - Risk assessment
```

### 4. Merges (≈ Git Merge)

**MergeResult** combines changes from one branch into another:

- **Fast-forward**: Target is ancestor of source (no conflict possible)
- **Three-way**: Common ancestor used to detect conflicts
- **Conflict resolution**: Manual or automatic based on rules

---

## Storage Pattern (LFS)

### Directory Structure

```
.0xscada/
├── lfs/
│   └── objects/                    # Content-addressed blob storage
│       ├── ab/
│       │   └── c123...def456       # Checkpoint state blob
│       ├── de/
│       │   └── f789...abc012       # Another checkpoint
│       └── ...
├── refs/
│   ├── heads/                      # Branch references
│   │   ├── main                    # → checkpoint ID
│   │   ├── feature/
│   │   │   └── new-pump-config     # → checkpoint ID
│   │   └── experiment/
│   │       └── higher-pressure     # → checkpoint ID
│   └── tags/                       # Named checkpoint tags
│       └── v1.0.0-baseline         # → checkpoint ID
├── checkpoints/
│   └── index.json                  # Checkpoint metadata index
└── config.json                     # Repository configuration
```

### Blob Storage Format

Each checkpoint is stored as a compressed blob:

```
┌─────────────────────────────────────────────┐
│ CHECKPOINT BLOB                             │
├─────────────────────────────────────────────┤
│ Header (64 bytes)                           │
│ ├─ Magic: "0xTWIN" (6 bytes)                │
│ ├─ Version: 1 (2 bytes)                     │
│ ├─ Compression: zstd (1 byte)               │
│ ├─ Encrypted: false (1 byte)                │
│ ├─ Original size (8 bytes)                  │
│ ├─ Compressed size (8 bytes)                │
│ ├─ State hash (32 bytes)                    │
│ └─ Reserved (6 bytes)                       │
├─────────────────────────────────────────────┤
│ Metadata (JSON, variable)                   │
│ ├─ id, parentId, branchName                 │
│ ├─ timestamp, siteId                        │
│ ├─ metadata (author, reason, reviewers)     │
│ └─ signature (optional)                     │
├─────────────────────────────────────────────┤
│ State (compressed, variable)                │
│ ├─ plcStates[]                              │
│ ├─ topology                                 │
│ ├─ safetyEnvelopes[]                        │
│ ├─ calibrations                             │
│ └─ alarmThresholds                          │
└─────────────────────────────────────────────┘
```

### Content Addressing

```typescript
// Checkpoint ID is derived from content hash
const checkpointId = sha256(
  canonicalize({
    schemaVersion: "1.0.0",
    parentId,
    branchName,
    timestamp,
    siteId,
    state: sha256(canonicalize(state)),
    metadata,
  })
);
```

### Delta Storage (Optimization)

For efficiency, consecutive checkpoints can store deltas:

```
checkpoint-abc123 (full state, 50MB)
   ↓
checkpoint-def456 (delta from abc123, 500KB)
   ↓
checkpoint-ghi789 (delta from def456, 200KB)
```

Delta reconstruction:
```typescript
async function reconstructState(checkpointId: string): Promise<CheckpointState> {
  const checkpoint = await loadCheckpoint(checkpointId);
  
  if (checkpoint.storage.isDelta) {
    const baseState = await reconstructState(checkpoint.storage.deltaBase);
    return applyDelta(baseState, checkpoint.storage.delta);
  }
  
  return decompress(checkpoint.storage.stateBlob);
}
```

---

## Branching & Merging Semantics

### Creating a Branch

```typescript
// Branch from current main HEAD
const branch = await twin.createBranch({
  name: "feature/new-pump-config",
  siteId: "site-001",
  startPoint: mainHead.id,
  description: "Testing new pump configuration",
  protection: {
    requireReview: true,
    minApprovals: 1,
  },
});
```

### Creating Checkpoints

```typescript
// Capture current state as checkpoint
const checkpoint = await twin.createCheckpoint({
  parentId: branch.headId,
  branchName: "feature/new-pump-config",
  siteId: "site-001",
  state: await captureCurrentState(siteId),
  metadata: {
    author: { id: "user-001", name: "Nick", type: "user" },
    reason: "Updated pump setpoints for energy optimization",
    linkedIssue: "SCADA-1234",
  },
});
```

### Merging Branches

```typescript
// Merge feature branch into main
const result = await twin.merge({
  sourceBranch: "feature/new-pump-config",
  targetBranch: "main",
  siteId: "site-001",
  message: "Merge new pump configuration after validation",
  strategy: "three-way",
});

if (!result.success) {
  // Handle conflicts
  for (const conflict of result.conflicts) {
    console.log(`Conflict at ${conflict.path}`);
    console.log(`  Ours: ${conflict.oursValue}`);
    console.log(`  Theirs: ${conflict.theirsValue}`);
  }
}
```

### Merge Strategies

| Strategy | When Used | Behavior |
|----------|-----------|----------|
| **Fast-forward** | Target is ancestor of source | Move pointer, no merge commit |
| **Three-way** | Divergent histories | Create merge commit with two parents |
| **Squash** | Clean history | Combine all commits into one |

### Conflict Resolution Rules

Automatic resolution for non-conflicting changes:

| Category | Auto-resolve? | Strategy |
|----------|---------------|----------|
| Different tags modified | ✅ | Take both changes |
| Same tag, same value | ✅ | Keep one |
| Same tag, different values | ❌ | Manual required |
| Safety constraint modified | ❌ | Always manual |
| Topology structure changed | ❌ | Always manual |

---

## Workflows

### 1. Safety Review Workflow

**Purpose**: Validate configuration changes before production deployment.

```
┌──────────────────────────────────────────────────────────────────┐
│                    SAFETY REVIEW WORKFLOW                        │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Create Feature Branch                                        │
│     └─► feature/new-setpoints                                    │
│                                                                  │
│  2. Make Changes                                                 │
│     └─► Create checkpoint with proposed changes                  │
│                                                                  │
│  3. Generate Diff                                                │
│     └─► twin.diff(main.head, feature.head)                       │
│         ├─ Identify all changes                                  │
│         ├─ Flag safety-impacting modifications                   │
│         └─ Calculate risk score                                  │
│                                                                  │
│  4. Automated Checks                                             │
│     └─► Run validation suite                                     │
│         ├─ Safety envelope verification                          │
│         ├─ Interlock logic validation                            │
│         ├─ Alarm rationalization check                           │
│         └─ Simulation test against twin                          │
│                                                                  │
│  5. Human Review                                                 │
│     └─► Required reviewers:                                      │
│         ├─ Process Engineer (technical review)                   │
│         ├─ Safety Engineer (SIL verification)                    │
│         └─ Operations Lead (operational impact)                  │
│                                                                  │
│  6. Approval & Merge                                             │
│     └─► On approval:                                             │
│         ├─ Merge to main                                         │
│         ├─ Anchor to blockchain                                  │
│         └─ Generate deployment package                           │
│                                                                  │
│  7. Deployment                                                   │
│     └─► Staged rollout to controllers                            │
│         ├─ Pre-deployment snapshot                               │
│         ├─ Download to controller                                │
│         └─ Post-deployment verification                          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**Required Approvals by Change Type**:

| Change Type | Min Approvals | Required Roles |
|-------------|---------------|----------------|
| Tag value change | 1 | Engineer |
| Setpoint modification | 2 | Engineer + Ops |
| Safety constraint | 3 | Engineer + Safety + Ops |
| Interlock logic | 3 | Engineer + Safety + Ops |
| Alarm threshold | 2 | Engineer + Ops |
| Topology change | 2 | Engineer + Maintenance |

### 2. Vendor Onboarding Workflow

**Purpose**: Safely integrate vendor-provided configurations or updates.

```
┌──────────────────────────────────────────────────────────────────┐
│                  VENDOR ONBOARDING WORKFLOW                      │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Create Vendor Branch                                         │
│     └─► vendor/siemens-tia-v18                                   │
│         Branch from main to create isolated environment          │
│                                                                  │
│  2. Import Vendor Package                                        │
│     └─► Load vendor-provided configuration                       │
│         ├─ Parse vendor format (L5X, TIA, etc.)                  │
│         ├─ Convert to 0xSCADA schema                             │
│         ├─ Create checkpoint with imported state                 │
│         └─ Hash original vendor files for provenance             │
│                                                                  │
│  3. Apply Site Constraints                                       │
│     └─► Overlay site-specific requirements                       │
│         ├─ Apply safety envelopes from main                      │
│         ├─ Apply calibration data from main                      │
│         └─ Create constrained checkpoint                         │
│                                                                  │
│  4. Validation Testing                                           │
│     └─► Run comprehensive test suite                             │
│         ├─ Functional tests against simulation                   │
│         ├─ Safety interlock verification                         │
│         ├─ Performance benchmarks                                │
│         └─ Compatibility checks                                  │
│                                                                  │
│  5. Security Audit                                               │
│     └─► Scan for anomalies                                       │
│         ├─ Unexpected network configurations                     │
│         ├─ Unauthorized access paths                             │
│         ├─ Hidden backdoors or debug ports                       │
│         └─ Malware signatures                                    │
│                                                                  │
│  6. Review & Approval                                            │
│     └─► Multi-party review                                       │
│         ├─ Internal engineering review                           │
│         ├─ Vendor sign-off (optional)                            │
│         └─ Security team approval                                │
│                                                                  │
│  7. Staged Deployment                                            │
│     └─► Gradual rollout                                          │
│         ├─ Deploy to test controller                             │
│         ├─ 24-hour observation period                            │
│         ├─ Deploy to production                                  │
│         └─ Merge to main on success                              │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 3. Training Workflow

**Purpose**: Create isolated training environments for operator education.

```
┌──────────────────────────────────────────────────────────────────┐
│                     TRAINING WORKFLOW                            │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Create Training Branch                                       │
│     └─► training/batch-operator-certification-2026               │
│                                                                  │
│  2. Configure Training Scenarios                                 │
│     └─► Modify checkpoint for training                           │
│         ├─ Set initial conditions                                │
│         ├─ Configure fault injection points                      │
│         ├─ Prepare alarm scenarios                               │
│         └─ Create scenario checkpoints                           │
│                                                                  │
│         Scenario Examples:                                       │
│         ├─ Pump failure during transfer                          │
│         ├─ High level alarm cascade                              │
│         ├─ Runaway reaction response                             │
│         └─ Emergency shutdown procedure                          │
│                                                                  │
│  3. Agent Learning                                               │
│     └─► Train AI agents against scenarios                        │
│         ├─ Replay historical incidents                           │
│         ├─ Generate synthetic scenarios                          │
│         ├─ Test response patterns                                │
│         └─ Validate decision quality                             │
│                                                                  │
│  4. Operator Sessions                                            │
│     └─► Run training sessions                                    │
│         ├─ Load scenario checkpoint                              │
│         ├─ Connect to simulation twin                            │
│         ├─ Execute scenario                                      │
│         ├─ Capture operator actions                              │
│         └─ Generate performance report                           │
│                                                                  │
│  5. Assessment & Certification                                   │
│     └─► Evaluate performance                                     │
│         ├─ Compare to expected responses                         │
│         ├─ Score decision quality                                │
│         ├─ Identify training gaps                                │
│         └─ Issue certification on pass                           │
│                                                                  │
│  Note: Training branches never merge to main                     │
│  They are isolated simulations only                              │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 4. Disaster Recovery Workflow

**Purpose**: Rapidly restore to a known-good state after incidents.

```
┌──────────────────────────────────────────────────────────────────┐
│                  DISASTER RECOVERY WORKFLOW                      │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  PREPARATION (Before Incident)                                   │
│  ─────────────────────────────                                   │
│                                                                  │
│  1. Automated Baseline Checkpoints                               │
│     └─► Schedule: Every shift change (8 hours)                   │
│         ├─ Capture complete state                                │
│         ├─ Verify integrity (hash check)                         │
│         ├─ Anchor to blockchain                                  │
│         └─ Replicate to off-site storage                         │
│                                                                  │
│  2. Tag Known-Good States                                        │
│     └─► Create named references                                  │
│         ├─ tag: "last-known-good"                                │
│         ├─ tag: "pre-maintenance-2026-02-01"                     │
│         └─ tag: "certified-baseline-v1.0"                        │
│                                                                  │
│  3. Test Recovery Procedures                                     │
│     └─► Quarterly DR drills                                      │
│         ├─ Restore to test environment                           │
│         ├─ Verify all systems operational                        │
│         └─ Document recovery time                                │
│                                                                  │
│  ═══════════════════════════════════════════════════════════════ │
│                                                                  │
│  RECOVERY (During Incident)                                      │
│  ──────────────────────────                                      │
│                                                                  │
│  4. Identify Recovery Point                                      │
│     └─► Determine restore target                                 │
│         ├─ "Restore to last-known-good"                          │
│         ├─ "Restore to 2 hours before incident"                  │
│         └─ "Restore to specific checkpoint abc123"               │
│                                                                  │
│  5. Verify Checkpoint Integrity                                  │
│     └─► Before restore                                           │
│         ├─ Verify content hash                                   │
│         ├─ Verify blockchain anchor                              │
│         ├─ Verify signature (if present)                         │
│         └─ Confirm checkpoint is complete                        │
│                                                                  │
│  6. Create Recovery Branch                                       │
│     └─► hotfix/incident-recovery-2026-02-02                      │
│         Do NOT restore directly to main                          │
│                                                                  │
│  7. Execute Restoration                                          │
│     └─► Staged restore                                           │
│         ├─ Load checkpoint state                                 │
│         ├─ Generate controller downloads                         │
│         ├─ Deploy to controllers (staged)                        │
│         │   ├─ Critical safety systems first                     │
│         │   ├─ Process control second                            │
│         │   └─ Auxiliary systems last                            │
│         └─ Verify each stage before proceeding                   │
│                                                                  │
│  8. Validate Recovery                                            │
│     └─► Confirm operational state                                │
│         ├─ All tags reading correctly                            │
│         ├─ Control loops stable                                  │
│         ├─ Safety systems armed                                  │
│         └─ No unexpected alarms                                  │
│                                                                  │
│  9. Merge to Main                                                │
│     └─► On successful validation                                 │
│         ├─ Merge hotfix to main                                  │
│         ├─ Tag as recovery point                                 │
│         └─ Begin incident analysis                               │
│                                                                  │
│  ═══════════════════════════════════════════════════════════════ │
│                                                                  │
│  POST-INCIDENT                                                   │
│  ─────────────                                                   │
│                                                                  │
│  10. Root Cause Analysis                                         │
│      └─► Use time-travel debugging                               │
│          ├─ Diff pre-incident vs incident checkpoints            │
│          ├─ Replay agent decisions                               │
│          ├─ Analyze event sequence                               │
│          └─ Document findings                                    │
│                                                                  │
│  11. Implement Preventive Measures                               │
│      └─► Create improvement branch                               │
│          ├─ Add new safety constraints                           │
│          ├─ Update alarm thresholds                              │
│          ├─ Modify interlock logic                               │
│          └─ Follow safety review workflow                        │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 5. A/B Testing Workflow

**Purpose**: Compare alternative configurations in parallel.

```
┌──────────────────────────────────────────────────────────────────┐
│                     A/B TESTING WORKFLOW                         │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Create Experiment Branches                                   │
│     ├─► experiment/energy-opt-aggressive                         │
│     └─► experiment/energy-opt-conservative                       │
│                                                                  │
│  2. Configure Variants                                           │
│     ├─► Aggressive: Higher pump speeds, tighter tolerances       │
│     └─► Conservative: Lower speeds, wider margins                │
│                                                                  │
│  3. Simulate Both Scenarios                                      │
│     └─► Run physics simulation for each                          │
│         ├─ Energy consumption projection                         │
│         ├─ Equipment wear estimation                             │
│         ├─ Process quality prediction                            │
│         └─ Risk assessment                                       │
│                                                                  │
│  4. Compare Results                                              │
│     └─► Generate comparison report                               │
│         ├─ Energy savings: +15% vs +8%                           │
│         ├─ Wear increase: +25% vs +5%                            │
│         ├─ Quality impact: Negligible vs None                    │
│         └─ Risk score: Medium vs Low                             │
│                                                                  │
│  5. Select Winner                                                │
│     └─► Based on business criteria                               │
│         ├─ Merge winning branch to main                          │
│         └─ Archive losing branch for reference                   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## API Reference

### Core Operations

```typescript
interface TwinCheckpointService {
  // Checkpoint operations
  createCheckpoint(input: CreateCheckpointInput): Promise<TwinCheckpoint>;
  getCheckpoint(id: ContentHash): Promise<TwinCheckpoint | null>;
  getCheckpointState(id: ContentHash): Promise<CheckpointState>;
  listCheckpoints(query: CheckpointQuery): Promise<TwinCheckpoint[]>;
  
  // Branch operations
  createBranch(input: CreateBranchInput): Promise<BranchReference>;
  getBranch(name: string, siteId: string): Promise<BranchReference | null>;
  listBranches(siteId: string): Promise<BranchReference[]>;
  deleteBranch(name: string, siteId: string): Promise<void>;
  
  // Diff & Merge
  diff(baseId: ContentHash, targetId: ContentHash): Promise<CheckpointDiff>;
  merge(input: MergeBranchInput): Promise<MergeResult>;
  
  // Time travel
  findAncestor(id1: ContentHash, id2: ContentHash): Promise<ContentHash | null>;
  getHistory(id: ContentHash, limit?: number): Promise<TwinCheckpoint[]>;
  
  // State capture
  captureCurrentState(siteId: string): Promise<CheckpointState>;
  
  // Blockchain anchoring
  anchorCheckpoint(id: ContentHash): Promise<{ txHash: string; blockNumber: number }>;
  verifyAnchor(id: ContentHash): Promise<{ valid: boolean; anchoredAt?: string }>;
}
```

### Event Hooks

```typescript
// Register event handlers
twin.on('checkpoint:created', (checkpoint: TwinCheckpoint) => {
  console.log(`New checkpoint: ${checkpoint.id}`);
});

twin.on('branch:merged', (result: MergeResult) => {
  console.log(`Merged ${result.sourceBranch} → ${result.targetBranch}`);
});

twin.on('conflict:detected', (conflicts: MergeConflict[]) => {
  // Trigger manual resolution UI
});
```

---

## Security Considerations

### Access Control

| Operation | Required Role | Audit |
|-----------|---------------|-------|
| View checkpoints | Reader | No |
| Create checkpoint | Engineer | Yes |
| Create branch | Engineer | Yes |
| Merge to feature | Engineer | Yes |
| Merge to main | Engineer + Approver | Yes |
| Delete branch | Admin | Yes |
| Modify protection | Admin | Yes |

### Cryptographic Guarantees

1. **Integrity**: Content-addressed storage ensures tampering is detectable
2. **Provenance**: Signatures prove who created/approved checkpoints
3. **Immutability**: Blockchain anchoring provides permanent proof
4. **Non-repudiation**: Signed approvals cannot be denied

### Audit Trail

All operations are logged with:
- Timestamp
- User/agent identity
- Operation type
- Affected resources
- Cryptographic proof

---

## Implementation Dependencies

### Phase β.1 (Required First)
- Time-Travel Reconstruction API
- Reality Snapshot Serialization

### Phase α (Already Complete)
- LFS Integration (α.1.1)
- Artifact Schema (α.1.2)
- Content-addressed storage

### Related Components
- Digital Twin Platform (existing)
- AAS Registry
- Blockchain Anchoring Service

---

## Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| Checkpoint creation | <5s | Including compression |
| State reconstruction | <2s | From compressed blob |
| Diff generation | <1s | For typical changes |
| Merge (no conflict) | <3s | Fast-forward or clean |
| Merge (with conflicts) | <10s | Conflict detection |
| History traversal | <100ms | Per checkpoint |

---

## Future Enhancements

### v1.1
- [ ] Partial checkpoints (capture subset of state)
- [ ] Checkpoint search by content
- [ ] Branch comparison UI

### v1.2
- [ ] Checkpoint comments/discussions
- [ ] CI/CD integration hooks
- [ ] Automated rollback triggers

### v2.0
- [ ] Distributed checkpoints (multi-site)
- [ ] Checkpoint streaming (real-time collaboration)
- [ ] ML-assisted conflict resolution

---

*"Version control for code changed software development. Version control for industrial reality will change operations."*
