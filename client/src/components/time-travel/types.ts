/**
 * Time-Travel Debugger Types
 *
 * β.1.3 - Time-travel debugger UI
 *
 * Type definitions for the VERITY time-travel debugging system.
 * See: docs/REALITY_ARTIFACT_ARCHITECTURE.md
 */

// =============================================================================
// PRIMITIVE TYPES
// =============================================================================

/** Git commit hash (40-char hex string) */
export type CommitHash = string;

/** Content-addressed hash (sha256) */
export type ContentHash = string;

/** ISO 8601 timestamp string */
export type ISO8601 = string;

/** Agent identifier */
export type AgentId = string;

/** Device identifier */
export type DeviceId = string;

/** PLC identifier */
export type PLCId = string;

// =============================================================================
// ARTIFACT TYPES
// =============================================================================

export type ArtifactType = 'trace' | 'proof' | 'twin' | 'decision' | 'embedding';

export type ArtifactOriginSystem = 'linux' | 'ethereum' | 'agentic-qe';

export interface ArtifactOrigin {
  system: ArtifactOriginSystem;
  agent?: AgentId;
  fork?: CommitHash;
  device?: DeviceId;
}

export interface ArtifactScope {
  domain?: string;
  tags?: string[];
}

export interface CryptoSignature {
  algorithm: string;
  signer: string;
  signature: string;
  timestamp: ISO8601;
  valid?: boolean;
}

export interface RealityArtifact {
  id: ContentHash;
  type: ArtifactType;
  name: string;
  timestamp: ISO8601;
  origin: ArtifactOrigin;
  scope?: ArtifactScope;
  dependencies: ContentHash[];
  signature?: CryptoSignature;
  summary?: string;
  size: number;
  contentPath: string;
}

// =============================================================================
// COMMIT TYPES
// =============================================================================

export type CommitStatus = 'normal' | 'warning' | 'error' | 'success';

export interface CommitInfo {
  hash: CommitHash;
  shortHash: string;
  message: string;
  author: string;
  timestamp: ISO8601;
  artifactCount: number;
  artifactTypes: ArtifactType[];
  status: CommitStatus;
  tags?: string[];
  branch?: string;
}

export interface CommitRange {
  from?: CommitHash;
  to?: CommitHash;
  limit?: number;
}

// =============================================================================
// SNAPSHOT TYPES
// =============================================================================

export type AlarmSeverity = 'info' | 'low' | 'high' | 'low-low' | 'high-high';
export type PLCState = 'RUN' | 'STOP' | 'FAULT' | 'PROGRAM' | 'UNKNOWN';

export interface TankState {
  id: string;
  name: string;
  level: number;
  temperature?: number;
  pressure?: number;
  alarmState: AlarmSeverity | 'normal';
}

export interface AlarmRecord {
  id: string;
  sourceId: string;
  severity: AlarmSeverity;
  message: string;
  timestamp: ISO8601;
  acknowledged: boolean;
}

export interface PLCStateRecord {
  id: PLCId;
  name: string;
  state: PLCState;
  lastUpdate: ISO8601;
}

export interface SafetyConstraint {
  id: string;
  name: string;
  active: boolean;
  violated: boolean;
}

export interface RealitySnapshotData {
  commit: CommitHash;
  timestamp: ISO8601;
  tanks: TankState[];
  plcStates: PLCStateRecord[];
  alarms: AlarmRecord[];
  safetyConstraints: SafetyConstraint[];
  artifacts: ContentHash[];
}

// =============================================================================
// DIFF TYPES
// =============================================================================

export type ChangeType = 'added' | 'removed' | 'changed' | 'unchanged';

export interface ValueChange<T> {
  type: ChangeType;
  before?: T;
  after?: T;
  delta?: number | string;
}

export interface TankDiff {
  id: string;
  name: string;
  level: ValueChange<number>;
  alarmState: ValueChange<string>;
}

export interface RealityDiff {
  commitA: CommitHash;
  commitB: CommitHash;
  tanks: TankDiff[];
  alarmsAdded: AlarmRecord[];
  alarmsRemoved: AlarmRecord[];
  plcChanges: Array<{
    id: PLCId;
    name: string;
    stateChange: ValueChange<PLCState>;
  }>;
  artifactsAdded: ContentHash[];
  artifactsRemoved: ContentHash[];
  summary: {
    tanksChanged: number;
    alarmsCleared: number;
    alarmsRaised: number;
    plcRecovered: number;
    plcFaulted: number;
  };
}

// =============================================================================
// DECISION TYPES
// =============================================================================

export interface DecisionInputs {
  artifacts: ContentHash[];
  context: ContentHash;
  constraints: ContentHash;
}

export interface DecisionReasoning {
  chainOfThought: string;
  model: string;
  temperature: number;
  tokens: number;
}

export interface DecisionOutput {
  decision: string;
  target?: string;
  action?: string;
  confidence: number;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  message?: string;
}

export interface DecisionVerification {
  humanApproved?: boolean;
  humanApprover?: string;
  humanApprovedAt?: ISO8601;
  automatedChecks: CheckResult[];
  safetyScore: number;
}

export interface AgentDecision {
  id: ContentHash;
  timestamp: ISO8601;
  agent: AgentId;
  commit: CommitHash;
  inputs: DecisionInputs;
  reasoning: DecisionReasoning;
  output: DecisionOutput;
  verification: DecisionVerification;
}

// =============================================================================
// REPLAY TYPES
// =============================================================================

export interface ReplayResult {
  originalDecision: AgentDecision;
  replayedDecision: AgentDecision;
  match: boolean;
  divergencePoint?: string;
  divergenceReason?: string;
}

export interface VerifyResult {
  valid: boolean;
  hash: ContentHash;
  expectedHash?: ContentHash;
  signature?: {
    valid: boolean;
    signer?: string;
    timestamp?: ISO8601;
  };
  errors?: string[];
}

// =============================================================================
// COMPONENT PROP TYPES
// =============================================================================

export interface CommitTimelineProps {
  commits: CommitInfo[];
  selectedCommit?: CommitHash;
  compareCommit?: CommitHash;
  onSelect: (commitHash: CommitHash) => void;
  onCompareSelect: (commitHash: CommitHash) => void;
  onViewSnapshot: (commitHash: CommitHash) => void;
  onReplayDecisions: (commitHash: CommitHash) => void;
  className?: string;
}

export interface RealitySnapshotProps {
  commit: CommitHash;
  snapshot: RealitySnapshotData;
  onRestore?: () => void;
  onCompare?: () => void;
  onFork?: () => void;
  isComparing?: boolean;
  className?: string;
}

export interface ArtifactInspectorProps {
  commit: CommitHash;
  artifacts: RealityArtifact[];
  selectedArtifact?: ContentHash;
  onSelect: (artifactId: ContentHash) => void;
  onViewRaw: (artifactId: ContentHash) => void;
  onVerify: (artifactId: ContentHash) => Promise<VerifyResult>;
  onCopyCitation: (artifactId: ContentHash) => void;
  className?: string;
}

export interface DiffViewerProps {
  snapshotA: { commit: CommitHash; snapshot: RealitySnapshotData };
  snapshotB: { commit: CommitHash; snapshot: RealitySnapshotData };
  diff: RealityDiff;
  onSwap?: () => void;
  onExport?: () => void;
  className?: string;
}

export interface DecisionReplayProps {
  decision: AgentDecision;
  artifacts: RealityArtifact[];
  onViewArtifact: (artifactId: ContentHash) => void;
  onReplay: () => Promise<ReplayResult>;
  onPrevious?: () => void;
  onNext?: () => void;
  onCite: () => void;
  replayResult?: ReplayResult;
  isReplaying?: boolean;
  className?: string;
}
