# 🕐 Time-Travel Debugger UI - Wireframes

> **VERITY Component**: β.1.3 - Time-travel debugger UI  
> **Related Architecture**: [REALITY_ARTIFACT_ARCHITECTURE.md](../REALITY_ARTIFACT_ARCHITECTURE.md)

---

## 🎯 Overview

The Time-Travel Debugger enables operators and agents to navigate through git history, 
reconstruct plant states at any commit, and replay decisions with frozen inputs.

**Primary Use Cases:**
- "Show me plant state as agent saw it before failure"
- "Re-run agent decision using exact inputs"
- "Compare two realities across commits"
- "Bisect when a sensor anomaly first appeared"

---

## 📐 Component Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        TimeTravelDebugger (Container)                   │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    CommitTimeline                                │   │
│  │  ←──●───●───●───●───●───◉───●───●───●───●───●───●───●───●───→   │   │
│  │     │       │       ▲                   │                        │   │
│  │  [A commit] [B]  [HEAD]              [Compare]                   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────────────────┐  ┌─────────────────────────────────┐  │
│  │     RealitySnapshot         │  │        ArtifactInspector        │  │
│  │  ┌───────────────────────┐  │  │  ┌───────────────────────────┐  │  │
│  │  │   Twin State View     │  │  │  │  Artifact Tree            │  │  │
│  │  │   ┌─────┬─────┐       │  │  │  │  ├─ traces/               │  │  │
│  │  │   │TK101│TK102│       │  │  │  │  │  └─ ftrace-001.bin     │  │  │
│  │  │   └─────┴─────┘       │  │  │  │  ├─ proofs/               │  │  │
│  │  │   PLC States | Alarms │  │  │  │  └─ decisions/            │  │  │
│  │  └───────────────────────┘  │  │  └───────────────────────────┘  │  │
│  │  [Restore] [Compare] [Fork] │  │  [View Raw] [Verify] [Cite]    │  │
│  └─────────────────────────────┘  └─────────────────────────────────┘  │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                        DiffViewer                                │   │
│  │  ┌─────────────────────┬──────────────────────────────────────┐ │   │
│  │  │  Snapshot A (old)   │  Snapshot B (new)                    │ │   │
│  │  ├─────────────────────┼──────────────────────────────────────┤ │   │
│  │  │  TK-101: 75.2%      │  TK-101: 82.1% ▲ (+6.9%)            │ │   │
│  │  │  TK-102: 23.1% ⚠    │  TK-102: 45.0% ✓                    │ │   │
│  │  │  Alarms: 2 active   │  Alarms: 0 active                   │ │   │
│  │  └─────────────────────┴──────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                      DecisionReplay                              │   │
│  │  ┌──────────────┬──────────────────┬─────────────────────────┐  │   │
│  │  │   INPUTS     │   REASONING      │   OUTPUT                │  │   │
│  │  │  ────────    │   ──────────     │   ────────              │  │   │
│  │  │  • ftrace... │   Agent Model:   │   Decision: CLOSE_VALVE │  │   │
│  │  │  • twin-snap │   claude-3.5     │   Confidence: 94%       │  │   │
│  │  │  • safety... │   ──────────     │   ──────────            │  │   │
│  │  │              │   "Given the     │   [✓] Safety Check      │  │   │
│  │  │              │    pressure..."  │   [✓] Human Approved    │  │   │
│  │  └──────────────┴──────────────────┴─────────────────────────┘  │   │
│  │  [◀ Prev Decision]  [▶ Next Decision]  [↻ Replay with New Code] │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 🧱 Component Specifications

### 1. CommitTimeline

**Purpose:** Navigate through git history with artifact-aware markers

```
┌────────────────────────────────────────────────────────────────────────────┐
│  ◀  ○──●──●──●──◉──●──●──●──●──●──●──●──●──○  ▶    [Jump to: ________]    │
│      │  │     ▲                    │                                       │
│      │  │  [HEAD]               [Selected]                                 │
│      │  └─ contains: 3 artifacts                                           │
│      └─ tag: v2.5.0                                                        │
│                                                                            │
│  Selected: a7f3e2b  │  "Fix valve calibration"  │  2h ago  │  Nick Flach   │
│  Artifacts: 2 traces, 1 proof, 1 decision                                  │
│                                                                            │
│  [◉ View Snapshot]  [⊕ Compare With...]  [↻ Replay Decisions]             │
└────────────────────────────────────────────────────────────────────────────┘
```

**Props:**
```typescript
interface CommitTimelineProps {
  commits: CommitInfo[];
  selectedCommit?: string;
  compareCommit?: string;
  onSelect: (commitHash: string) => void;
  onCompareSelect: (commitHash: string) => void;
  onViewSnapshot: (commitHash: string) => void;
  onReplayDecisions: (commitHash: string) => void;
}
```

**Visual States:**
- `○` - Normal commit
- `●` - Commit with artifacts
- `◉` - Selected commit
- `◎` - Compare target commit
- Color coding: Red = has failures, Yellow = has warnings, Green = all pass

---

### 2. RealitySnapshot

**Purpose:** Display complete plant state at a specific commit

```
┌─────────────────────────────────────────────────────────────────┐
│  REALITY SNAPSHOT                              a7f3e2b @ 2h ago │
│  ───────────────────────────────────────────────────────────────│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  🏭 TWIN STATE                                    [Expand]  ││
│  │  ────────────────────────────────────────────────────────── ││
│  │   ┌──────────┬──────────┬──────────┬──────────┐             ││
│  │   │  TK-101  │  TK-102  │  TK-103  │  TK-104  │             ││
│  │   │  ▓▓▓░░░  │  ▓░░░░░  │  ▓▓▓▓▓▓  │  ▓▓░░░░  │             ││
│  │   │  75.2%   │  23.1%⚠  │  98.4%🔴 │  45.0%   │             ││
│  │   └──────────┴──────────┴──────────┴──────────┘             ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  ⚡ PLC STATES                                              ││
│  │  ────────────────────────────────────────────────────────── ││
│  │  PLC-001: RUN    │  PLC-002: RUN    │  PLC-003: FAULT      ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  🚨 ALARMS (2 active)                                       ││
│  │  ────────────────────────────────────────────────────────── ││
│  │  • TK-102 LOW     │  Level below 25%          │  14:32:01  ││
│  │  • TK-103 HI-HI   │  Level exceeded 95%       │  14:35:22  ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                 │
│  [⟲ Restore to This State]  [⊕ Compare]  [⑂ Fork Branch]       │
└─────────────────────────────────────────────────────────────────┘
```

**Props:**
```typescript
interface RealitySnapshotProps {
  commit: CommitHash;
  snapshot: RealitySnapshotData;
  onRestore?: () => void;
  onCompare?: () => void;
  onFork?: () => void;
  isComparing?: boolean;
}
```

---

### 3. ArtifactInspector

**Purpose:** Browse and examine individual artifacts at a commit

```
┌─────────────────────────────────────────────────────────────────┐
│  ARTIFACT INSPECTOR                                    a7f3e2b  │
│  ───────────────────────────────────────────────────────────────│
│  ┌───────────────────┬─────────────────────────────────────────┐│
│  │  📁 ARTIFACT TREE │  📄 ARTIFACT DETAILS                    ││
│  │  ─────────────────│  ───────────────────────────────────────││
│  │  📂 traces/       │  ftrace-pump-001.bin                    ││
│  │   └─ 📄 ftrace... │  ─────────────────────                  ││
│  │  📂 proofs/       │  Type: Linux Trace (ftrace)             ││
│  │   └─ 📄 zk-attest │  Size: 2.4 MB                           ││
│  │  📂 decisions/    │  Hash: sha256:a7f3e2...                 ││
│  │   └─ 📄 valve-dec │  Captured: 2024-01-15 14:32:01          ││
│  │  📂 twins/        │  Origin: pump-controller-01             ││
│  │   └─ 📄 snapshot  │  ─────────────────────                  ││
│  │                   │  Dependencies:                          ││
│  │  ─────────────────│   • twin-snapshot-b2c4d1                ││
│  │  4 artifacts      │   • safety-envelope-v2                  ││
│  │  Total: 8.2 MB    │  ─────────────────────                  ││
│  │                   │  Signature: ✓ Valid (Nick Flach)        ││
│  └───────────────────┴─────────────────────────────────────────┘│
│                                                                 │
│  [👁 View Raw]  [✓ Verify Integrity]  [📋 Copy Citation]       │
└─────────────────────────────────────────────────────────────────┘
```

**Props:**
```typescript
interface ArtifactInspectorProps {
  commit: CommitHash;
  artifacts: RealityArtifact[];
  selectedArtifact?: ContentHash;
  onSelect: (artifactId: ContentHash) => void;
  onViewRaw: (artifactId: ContentHash) => void;
  onVerify: (artifactId: ContentHash) => Promise<VerifyResult>;
  onCopyCitation: (artifactId: ContentHash) => void;
}
```

---

### 4. DiffViewer

**Purpose:** Compare two reality snapshots side-by-side

```
┌─────────────────────────────────────────────────────────────────────────┐
│  REALITY DIFF                                                           │
│  ─────────────────────────────────────────────────────────────────────  │
│   a7f3e2b (2h ago)  ←→  b2c4d1f (30m ago)                              │
│  ─────────────────────────────────────────────────────────────────────  │
│  ┌─────────────────────────────┬───────────────────────────────────────┐│
│  │  📉 BEFORE                  │  📈 AFTER                             ││
│  ├─────────────────────────────┼───────────────────────────────────────┤│
│  │  TANKS                      │  TANKS                                ││
│  │  ─────                      │  ─────                                ││
│  │  TK-101: 75.2%              │  TK-101: 82.1%  ▲ +6.9%              ││
│  │  TK-102: 23.1% ⚠ LOW        │  TK-102: 45.0%  ▲ +21.9% ✓          ││
│  │  TK-103: 98.4% 🔴 HI-HI     │  TK-103: 72.3%  ▼ -26.1% ✓          ││
│  │  TK-104: 45.0%              │  TK-104: 45.0%  ─ (unchanged)        ││
│  ├─────────────────────────────┼───────────────────────────────────────┤│
│  │  ALARMS: 2 active           │  ALARMS: 0 active  ▼ -2 ✓           ││
│  │  • TK-102 LOW               │                                      ││
│  │  • TK-103 HI-HI             │                                      ││
│  ├─────────────────────────────┼───────────────────────────────────────┤│
│  │  PLC STATUS                 │  PLC STATUS                          ││
│  │  ───────────                │  ───────────                         ││
│  │  PLC-003: FAULT 🔴          │  PLC-003: RUN ✓                      ││
│  └─────────────────────────────┴───────────────────────────────────────┘│
│                                                                         │
│  SUMMARY: 3 tanks changed, 2 alarms cleared, 1 PLC recovered           │
│                                                                         │
│  [📊 Full Diff Report]  [⤓ Export]  [🔀 Swap A/B]                      │
└─────────────────────────────────────────────────────────────────────────┘
```

**Props:**
```typescript
interface DiffViewerProps {
  snapshotA: { commit: CommitHash; snapshot: RealitySnapshotData };
  snapshotB: { commit: CommitHash; snapshot: RealitySnapshotData };
  diff: RealityDiff;
  onSwap?: () => void;
  onExport?: () => void;
}
```

---

### 5. DecisionReplay

**Purpose:** Visualize and replay agent decisions with frozen inputs

```
┌─────────────────────────────────────────────────────────────────────────┐
│  DECISION REPLAY                                       DEC-a7f3e2b-001  │
│  ─────────────────────────────────────────────────────────────────────  │
│  Agent: claude-3.5-sonnet  │  Timestamp: 2024-01-15 14:35:22           │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  📥 INPUTS (frozen)                                              │  │
│  │  ────────────────────────────────────────────────────────────────│  │
│  │   Artifacts:                                                     │  │
│  │   • ftrace-pump-001.bin (sha256:a7f3...)  [View]                │  │
│  │   • twin-snapshot-main (sha256:b2c4...)   [View]                │  │
│  │   • safety-envelope-v2 (sha256:c9e8...)   [View]                │  │
│  │   ────────────────────────────────────────────────────────────── │  │
│  │   Context: "Pump pressure rising, TK-103 at critical level"     │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  🧠 REASONING (chain-of-thought)                                 │  │
│  │  ────────────────────────────────────────────────────────────────│  │
│  │   "Given the ftrace data showing pump pressure at 142 PSI and   │  │
│  │    TK-103 level at 98.4% (above HI-HI threshold of 95%), I      │  │
│  │    need to reduce inflow to prevent overflow.                   │  │
│  │                                                                  │  │
│  │    Options considered:                                           │  │
│  │    1. Close inlet valve V-103 → Stops inflow immediately        │  │
│  │    2. Increase outlet pump → May stress downstream              │  │
│  │    3. Alert operator only → Risk of overflow                    │  │
│  │                                                                  │  │
│  │    Safety envelope allows valve closure. Proceeding with #1."   │  │
│  │   ────────────────────────────────────────────────────────────── │  │
│  │   Model: claude-3.5-sonnet  │  Tokens: 847  │  Temp: 0.3        │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  📤 OUTPUT                                                       │  │
│  │  ────────────────────────────────────────────────────────────────│  │
│  │   Decision: CLOSE_VALVE                                          │  │
│  │   Target: V-103 (Inlet valve for TK-103)                        │  │
│  │   Confidence: 94%                                                │  │
│  │   ────────────────────────────────────────────────────────────── │  │
│  │   Verification:                                                  │  │
│  │   ✓ Safety envelope check passed                                │  │
│  │   ✓ Human approval received (Nick Flach @ 14:35:45)             │  │
│  │   ✓ Action executed successfully                                │  │
│  │   Safety Score: 98/100                                          │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  [◀ Previous]  [▶ Next]  │  [↻ Replay with Current Code]  [📋 Cite]   │
└─────────────────────────────────────────────────────────────────────────┘
```

**Props:**
```typescript
interface DecisionReplayProps {
  decision: AgentDecision;
  onViewArtifact: (artifactId: ContentHash) => void;
  onReplay: () => Promise<ReplayResult>;
  onPrevious?: () => void;
  onNext?: () => void;
  onCite: () => void;
  replayResult?: ReplayResult;
}
```

---

## 🎨 Visual Design Guidelines

### Color Scheme (aligns with existing HMI patterns)

| Element | Normal | Warning | Critical | Success |
|---------|--------|---------|----------|---------|
| Background | `bg-card` | `bg-yellow-500/20` | `bg-red-500/20` | `bg-green-500/20` |
| Border | `border` | `border-yellow-500` | `border-red-500` | `border-green-500` |
| Text | `text-foreground` | `text-yellow-600` | `text-red-600` | `text-green-600` |
| Indicator | `bg-muted` | `bg-yellow-500` | `bg-red-500 animate-pulse` | `bg-green-500` |

### Typography

- **Headers:** `text-2xl font-bold` (page), `text-lg font-semibold` (section)
- **Monospace:** `font-mono text-sm` for hashes, IDs, technical values
- **Descriptions:** `text-sm text-muted-foreground`

### Interactive States

- **Hover:** `hover-elevate` (shadow lift effect)
- **Selected:** `ring-2 ring-primary`
- **Disabled:** `opacity-50 pointer-events-none`

---

## 📱 Responsive Behavior

| Breakpoint | Layout |
|------------|--------|
| `< sm` | Stack all panels vertically |
| `sm - lg` | Timeline on top, 2-column below |
| `> lg` | Full layout as wireframed |

---

## 🔌 API Integration

Components connect to the Time-Travel API:

```typescript
// client/src/lib/time-travel.ts
export const timeTravelApi = {
  reconstruct: (commit: CommitHash) => Promise<RealitySnapshot>,
  replayDecision: (decisionId: string, commit: CommitHash) => Promise<ReplayResult>,
  diffReality: (a: CommitHash, b: CommitHash) => Promise<RealityDiff>,
  bisectArtifact: (pattern: string, range: CommitRange) => Promise<CommitHash>,
  listCommits: (range?: CommitRange) => Promise<CommitInfo[]>,
  getArtifacts: (commit: CommitHash) => Promise<RealityArtifact[]>,
};
```

---

## 🚀 Implementation Priority

1. **CommitTimeline** - Foundation for navigation
2. **RealitySnapshot** - Core state visualization
3. **ArtifactInspector** - Essential for debugging
4. **DiffViewer** - Compare states
5. **DecisionReplay** - Agent debugging

---

*Last Updated: 2024-01-15*
