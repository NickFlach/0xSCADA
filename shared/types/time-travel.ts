/**
 * 0xSCADA Time-Travel Reconstruction API Types
 * 
 * VERITY Architecture - Phase β.1: Time-Travel SCADA
 * 
 * "Debug industrial reality, not software."
 * 
 * Git Commit = Logical System Change
 * LFS Objects = Frozen Physical/Crypto State
 * Agent = Navigator Across Time
 * 
 * CAPABILITIES:
 * • "Show me plant state as agent saw it before failure"
 * • "Re-run agent decision using exact inputs"
 * • "Compare two realities across commits"
 * • "Bisect when a sensor anomaly first appeared"
 */

import { z } from "zod";
import { contentHashSchema, type ContentHash, type RealityArtifact } from "../artifact";
import { type TwinCheckpoint, type CheckpointState } from "./twin-checkpoint";
import { type AgentDecision, type DecisionReplayResult } from "./agent-decision";

// =============================================================================
// COMMIT TYPES (Git integration)
// =============================================================================

/**
 * Git commit hash (40-character SHA-1)
 */
export const commitHashSchema = z.string().regex(
  /^[a-f0-9]{40}$/,
  "CommitHash must be a 40-character lowercase hex string (SHA-1)"
);

export type CommitHash = z.infer<typeof commitHashSchema>;

/**
 * Commit range for bisection and history queries
 */
export const commitRangeSchema = z.object({
  /** Start commit (older, "good" in bisect) */
  from: commitHashSchema,
  
  /** End commit (newer, "bad" in bisect) */
  to: commitHashSchema,
  
  /** Include these paths only (git pathspec) */
  paths: z.array(z.string()).optional(),
  
  /** Exclude merge commits */
  noMerges: z.boolean().optional(),
});

export type CommitRange = z.infer<typeof commitRangeSchema>;

/**
 * Git commit metadata
 */
export const commitInfoSchema = z.object({
  /** Commit hash */
  hash: commitHashSchema,
  
  /** Short hash (7 characters) */
  shortHash: z.string(),
  
  /** Commit message subject line */
  subject: z.string(),
  
  /** Full commit message */
  body: z.string().optional(),
  
  /** Author name */
  authorName: z.string(),
  
  /** Author email */
  authorEmail: z.string(),
  
  /** Author date (ISO8601) */
  authorDate: z.string().datetime(),
  
  /** Committer name */
  committerName: z.string(),
  
  /** Committer email */
  committerEmail: z.string(),
  
  /** Commit date (ISO8601) */
  commitDate: z.string().datetime(),
  
  /** Parent commit hashes */
  parents: z.array(commitHashSchema),
  
  /** Associated tags */
  tags: z.array(z.string()).optional(),
  
  /** Associated branches */
  branches: z.array(z.string()).optional(),
});

export type CommitInfo = z.infer<typeof commitInfoSchema>;

// =============================================================================
// REALITY SNAPSHOT (Frozen state at a point in time)
// =============================================================================

/**
 * System origin types for snapshot organization
 */
export const SnapshotOrigin = {
  LINUX: "linux",
  ETHEREUM: "ethereum",
  AGENTIC_QE: "agentic-qe",
} as const;

export type SnapshotOrigin = (typeof SnapshotOrigin)[keyof typeof SnapshotOrigin];

/**
 * Artifact reference within a snapshot
 */
export const snapshotArtifactRefSchema = z.object({
  /** Content hash (LFS pointer) */
  hash: contentHashSchema,
  
  /** Artifact type */
  type: z.string(),
  
  /** Path in repository (if tracked) */
  repoPath: z.string().optional(),
  
  /** Size in bytes */
  size: z.number().int().nonnegative(),
  
  /** Loaded artifact (if hydrated) */
  artifact: z.any().optional(), // RealityArtifact when hydrated
});

export type SnapshotArtifactRef = z.infer<typeof snapshotArtifactRefSchema>;

/**
 * Reality Snapshot - Complete frozen state at a commit
 * 
 * This is what gets reconstructed when you time-travel to a commit.
 * It captures the exact state of all three forks at that moment.
 */
export const realitySnapshotSchema = z.object({
  /** Schema version */
  schemaVersion: z.literal("1.0.0"),
  
  /** Git commit this snapshot represents */
  commit: commitInfoSchema,
  
  /** When this snapshot was reconstructed */
  reconstructedAt: z.string().datetime(),
  
  /** Reconstruction duration in milliseconds */
  reconstructionMs: z.number().int().nonnegative(),
  
  /**
   * Linux Fork State
   * Physical reality: traces, sensor data, firmware
   */
  linux: z.object({
    /** Kernel traces at this commit */
    traces: z.array(snapshotArtifactRefSchema),
    
    /** Sensor/Modbus snapshots */
    sensors: z.array(snapshotArtifactRefSchema),
    
    /** Firmware images */
    firmware: z.array(snapshotArtifactRefSchema),
    
    /** Device states */
    devices: z.array(snapshotArtifactRefSchema),
  }),
  
  /**
   * Ethereum Fork State
   * Cryptographic truth: proofs, oracle data, anchors
   */
  ethereum: z.object({
    /** ZK proof blobs */
    proofs: z.array(snapshotArtifactRefSchema),
    
    /** Oracle snapshots */
    oracles: z.array(snapshotArtifactRefSchema),
    
    /** Merkle state diffs */
    merkleTrees: z.array(snapshotArtifactRefSchema),
    
    /** Attestation bundles */
    attestations: z.array(snapshotArtifactRefSchema),
  }),
  
  /**
   * Agentic-QE Fork State
   * Reasoning layer: decisions, models, embeddings
   */
  agenticQe: z.object({
    /** Agent decisions at this commit */
    decisions: z.array(snapshotArtifactRefSchema),
    
    /** World model snapshots */
    models: z.array(snapshotArtifactRefSchema),
    
    /** Learned embeddings */
    embeddings: z.array(snapshotArtifactRefSchema),
    
    /** Evaluation replays */
    evaluations: z.array(snapshotArtifactRefSchema),
  }),
  
  /**
   * Digital Twin State (if available at commit)
   */
  twin: z.object({
    /** Twin checkpoint at this commit */
    checkpoint: z.any().optional(), // TwinCheckpoint when available
    
    /** Branch this twin belongs to */
    branch: z.string().optional(),
    
    /** Checkpoint content hash */
    checkpointHash: contentHashSchema.optional(),
  }).optional(),
  
  /**
   * Summary statistics
   */
  summary: z.object({
    /** Total artifacts in snapshot */
    totalArtifacts: z.number().int().nonnegative(),
    
    /** Total size in bytes */
    totalSizeBytes: z.number().int().nonnegative(),
    
    /** Artifacts by origin system */
    byOrigin: z.record(z.number().int().nonnegative()),
    
    /** Artifacts by type */
    byType: z.record(z.number().int().nonnegative()),
    
    /** Oldest artifact timestamp */
    oldestArtifact: z.string().datetime().optional(),
    
    /** Newest artifact timestamp */
    newestArtifact: z.string().datetime().optional(),
  }),
  
  /**
   * Warnings or issues during reconstruction
   */
  warnings: z.array(z.object({
    level: z.enum(["info", "warning", "error"]),
    message: z.string(),
    artifactHash: contentHashSchema.optional(),
    path: z.string().optional(),
  })).optional(),
});

export type RealitySnapshot = z.infer<typeof realitySnapshotSchema>;

// =============================================================================
// REPLAY RESULT (Agent decision replay)
// =============================================================================

/**
 * Extended replay result with time-travel context
 */
export const replayResultSchema = z.object({
  /** Original decision that was replayed */
  originalDecision: z.any(), // AgentDecision
  
  /** Decision ID being replayed */
  decisionId: contentHashSchema,
  
  /** Commit the replay was executed against */
  commit: commitInfoSchema,
  
  /** Reality snapshot used for replay */
  snapshotHash: contentHashSchema.optional(),
  
  /** Replay execution result */
  replay: z.object({
    /** Whether replay was successful */
    success: z.boolean(),
    
    /** Replayed decision (new instance) */
    replayedDecision: z.any().optional(), // AgentDecision
    
    /** Whether outputs match the original */
    outputMatches: z.boolean(),
    
    /** Confidence delta (replayed - original) */
    confidenceDelta: z.number(),
    
    /** Detailed comparison */
    comparison: z.object({
      /** Same decision text */
      decisionMatches: z.boolean(),
      
      /** Same action */
      actionMatches: z.boolean(),
      
      /** Same key factors identified */
      keyFactorsMatch: z.boolean(),
      
      /** List of differences */
      differences: z.array(z.string()),
    }),
  }),
  
  /** Replay metadata */
  metadata: z.object({
    /** When replay was executed */
    replayedAt: z.string().datetime(),
    
    /** Duration in milliseconds */
    durationMs: z.number().int().nonnegative(),
    
    /** Reason for replay */
    reason: z.string().optional(),
    
    /** Model used for replay (may differ from original) */
    replayModel: z.string().optional(),
  }),
  
  /** Input artifacts used in replay */
  inputArtifacts: z.array(snapshotArtifactRefSchema),
  
  /** Errors if replay failed */
  errors: z.array(z.string()).optional(),
});

export type ReplayResult = z.infer<typeof replayResultSchema>;

// =============================================================================
// REALITY DIFF (Compare two snapshots)
// =============================================================================

/**
 * Single artifact change in diff
 */
export const artifactDiffEntrySchema = z.object({
  /** Change type */
  changeType: z.enum(["added", "removed", "modified"]),
  
  /** Path in repository */
  path: z.string().optional(),
  
  /** Artifact hash in commit A (base) */
  hashA: contentHashSchema.optional(),
  
  /** Artifact hash in commit B (target) */
  hashB: contentHashSchema.optional(),
  
  /** Artifact type */
  artifactType: z.string(),
  
  /** Origin system */
  origin: z.enum(["linux", "ethereum", "agentic-qe"]),
  
  /** Size change in bytes */
  sizeChange: z.number().int().optional(),
  
  /** Human-readable description of change */
  description: z.string().optional(),
  
  /** Impact level */
  impact: z.enum(["none", "low", "medium", "high", "critical"]).optional(),
});

export type ArtifactDiffEntry = z.infer<typeof artifactDiffEntrySchema>;

/**
 * Reality Diff - Comparison between two commits/snapshots
 */
export const realityDiffSchema = z.object({
  /** Schema version */
  schemaVersion: z.literal("1.0.0"),
  
  /** Base commit (older) */
  commitA: commitInfoSchema,
  
  /** Target commit (newer) */
  commitB: commitInfoSchema,
  
  /** When diff was computed */
  computedAt: z.string().datetime(),
  
  /** Computation duration in milliseconds */
  computationMs: z.number().int().nonnegative(),
  
  /**
   * Changes by origin system
   */
  changes: z.object({
    linux: z.array(artifactDiffEntrySchema),
    ethereum: z.array(artifactDiffEntrySchema),
    agenticQe: z.array(artifactDiffEntrySchema),
  }),
  
  /**
   * Twin checkpoint diff (if both have twins)
   */
  twinDiff: z.object({
    /** Base checkpoint hash */
    checkpointA: contentHashSchema.optional(),
    
    /** Target checkpoint hash */
    checkpointB: contentHashSchema.optional(),
    
    /** PLC state changes */
    plcChanges: z.number().int().nonnegative(),
    
    /** Topology changes */
    topologyChanges: z.number().int().nonnegative(),
    
    /** Safety envelope changes */
    safetyChanges: z.number().int().nonnegative(),
    
    /** Calibration changes */
    calibrationChanges: z.number().int().nonnegative(),
    
    /** Alarm threshold changes */
    alarmChanges: z.number().int().nonnegative(),
    
    /** Detailed changes (if computed) */
    details: z.any().optional(), // CheckpointDiff
  }).optional(),
  
  /**
   * Summary statistics
   */
  summary: z.object({
    /** Total artifacts added */
    added: z.number().int().nonnegative(),
    
    /** Total artifacts removed */
    removed: z.number().int().nonnegative(),
    
    /** Total artifacts modified */
    modified: z.number().int().nonnegative(),
    
    /** Total changes */
    total: z.number().int().nonnegative(),
    
    /** Changes by origin */
    byOrigin: z.object({
      linux: z.number().int().nonnegative(),
      ethereum: z.number().int().nonnegative(),
      agenticQe: z.number().int().nonnegative(),
    }),
    
    /** Net size change in bytes */
    sizeChange: z.number().int(),
    
    /** Overall impact assessment */
    impact: z.enum(["none", "low", "medium", "high", "critical"]),
  }),
  
  /**
   * Safety impact assessment
   */
  safetyImpact: z.object({
    /** Impact level */
    level: z.enum(["none", "low", "medium", "high", "critical"]),
    
    /** Affected safety constraints */
    affectedConstraints: z.array(z.string()),
    
    /** Whether human review is required */
    requiresReview: z.boolean(),
    
    /** Safety-related changes */
    safetyChanges: z.array(artifactDiffEntrySchema),
  }),
  
  /** Warnings during diff computation */
  warnings: z.array(z.string()).optional(),
});

export type RealityDiff = z.infer<typeof realityDiffSchema>;

// =============================================================================
// BISECT (Find when an artifact changed)
// =============================================================================

/**
 * Bisect status for a commit
 */
export const BisectStatus = {
  GOOD: "good",
  BAD: "bad",
  SKIP: "skip",
  UNKNOWN: "unknown",
} as const;

export type BisectStatus = (typeof BisectStatus)[keyof typeof BisectStatus];

/**
 * Bisect step result
 */
export const bisectStepSchema = z.object({
  /** Commit being tested */
  commit: commitInfoSchema,
  
  /** Status determination */
  status: z.enum(["good", "bad", "skip", "unknown"]),
  
  /** Whether artifact pattern matched */
  patternMatched: z.boolean(),
  
  /** Matching artifacts (if any) */
  matchingArtifacts: z.array(snapshotArtifactRefSchema).optional(),
  
  /** Reason for status */
  reason: z.string().optional(),
  
  /** Step number in bisection */
  stepNumber: z.number().int().positive(),
  
  /** Remaining commits to test */
  remainingCommits: z.number().int().nonnegative(),
});

export type BisectStep = z.infer<typeof bisectStepSchema>;

/**
 * Bisect result
 */
export const bisectResultSchema = z.object({
  /** Schema version */
  schemaVersion: z.literal("1.0.0"),
  
  /** Pattern that was searched */
  pattern: z.string(),
  
  /** Original search range */
  range: commitRangeSchema,
  
  /** Found commit (first bad/matching commit) */
  foundCommit: commitInfoSchema.optional(),
  
  /** All steps in bisection */
  steps: z.array(bisectStepSchema),
  
  /** Whether bisection completed successfully */
  success: z.boolean(),
  
  /** Total commits examined */
  commitsExamined: z.number().int().nonnegative(),
  
  /** Total commits in range */
  totalCommits: z.number().int().nonnegative(),
  
  /** When bisection was executed */
  executedAt: z.string().datetime(),
  
  /** Total duration in milliseconds */
  durationMs: z.number().int().nonnegative(),
  
  /** Artifacts matching pattern at found commit */
  matchingArtifacts: z.array(snapshotArtifactRefSchema).optional(),
  
  /** Error message if failed */
  error: z.string().optional(),
});

export type BisectResult = z.infer<typeof bisectResultSchema>;

// =============================================================================
// TIME-TRAVEL SERVICE INTERFACE
// =============================================================================

/**
 * Time-Travel Service Interface
 * 
 * This is the main API for time-travel debugging in 0xSCADA.
 */
export interface TimeTravelService {
  /**
   * Reconstruct exact state at any commit
   * 
   * @param commit - Git commit hash to reconstruct
   * @returns Complete reality snapshot at that commit
   */
  reconstruct(commit: CommitHash): Promise<RealitySnapshot>;
  
  /**
   * Replay agent decision with frozen inputs
   * 
   * Re-runs a decision using the exact artifacts that were available
   * at the specified commit, allowing comparison with the original.
   * 
   * @param decisionId - Content hash of the decision to replay
   * @param commit - Git commit to use for context (defaults to decision's commit)
   * @returns Replay result with comparison
   */
  replayDecision(decisionId: ContentHash, commit?: CommitHash): Promise<ReplayResult>;
  
  /**
   * Compare two reality snapshots
   * 
   * Shows what changed between two commits across all three forks.
   * 
   * @param commitA - Base commit (older)
   * @param commitB - Target commit (newer)
   * @returns Detailed diff of changes
   */
  diffReality(commitA: CommitHash, commitB: CommitHash): Promise<RealityDiff>;
  
  /**
   * Find when artifact first appeared/changed
   * 
   * Binary search through commit history to find when an artifact
   * matching the pattern first appeared or changed.
   * 
   * @param artifactPattern - Glob or regex pattern to match
   * @param range - Commit range to search
   * @returns Commit where pattern first matched
   */
  bisectArtifact(artifactPattern: string, range: CommitRange): Promise<BisectResult>;
}

// =============================================================================
// INPUT SCHEMAS
// =============================================================================

/**
 * Options for reconstruct operation
 */
export const reconstructOptionsSchema = z.object({
  /** Only reconstruct specific origins */
  origins: z.array(z.enum(["linux", "ethereum", "agentic-qe"])).optional(),
  
  /** Hydrate artifact content (not just refs) */
  hydrateArtifacts: z.boolean().default(false),
  
  /** Include twin checkpoint */
  includeTwin: z.boolean().default(true),
  
  /** Maximum artifacts per category */
  maxArtifactsPerCategory: z.number().int().positive().optional(),
  
  /** Filter by artifact types */
  artifactTypes: z.array(z.string()).optional(),
  
  /** Filter by site ID */
  siteId: z.string().optional(),
});

export type ReconstructOptions = z.infer<typeof reconstructOptionsSchema>;

/**
 * Options for replay operation
 */
export const replayOptionsSchema = z.object({
  /** Model to use for replay (defaults to original model) */
  model: z.string().optional(),
  
  /** Temperature override */
  temperature: z.number().min(0).max(2).optional(),
  
  /** Use exact seed from original (if available) */
  useOriginalSeed: z.boolean().default(true),
  
  /** Reason for replay */
  reason: z.string().optional(),
  
  /** Include detailed comparison */
  detailedComparison: z.boolean().default(true),
});

export type ReplayOptions = z.infer<typeof replayOptionsSchema>;

/**
 * Options for diff operation
 */
export const diffOptionsSchema = z.object({
  /** Include twin diff */
  includeTwinDiff: z.boolean().default(true),
  
  /** Compute safety impact */
  computeSafetyImpact: z.boolean().default(true),
  
  /** Filter by origins */
  origins: z.array(z.enum(["linux", "ethereum", "agentic-qe"])).optional(),
  
  /** Filter by artifact types */
  artifactTypes: z.array(z.string()).optional(),
  
  /** Filter by paths */
  paths: z.array(z.string()).optional(),
});

export type DiffOptions = z.infer<typeof diffOptionsSchema>;

/**
 * Options for bisect operation
 */
export const bisectOptionsSchema = z.object({
  /** Treat pattern as regex (default: glob) */
  regex: z.boolean().default(false),
  
  /** Maximum steps before giving up */
  maxSteps: z.number().int().positive().default(100),
  
  /** Filter by origin */
  origin: z.enum(["linux", "ethereum", "agentic-qe"]).optional(),
  
  /** Filter by artifact type */
  artifactType: z.string().optional(),
  
  /** Custom test function name (for advanced bisection) */
  testFunction: z.string().optional(),
});

export type BisectOptions = z.infer<typeof bisectOptionsSchema>;

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

export function validateCommitHash(hash: string): boolean {
  return commitHashSchema.safeParse(hash).success;
}

export function validateCommitRange(range: unknown): {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
  range?: CommitRange;
} {
  const result = commitRangeSchema.safeParse(range);
  if (result.success) {
    return { valid: true, errors: [], range: result.data };
  }
  return {
    valid: false,
    errors: result.error.errors.map((e) => ({
      path: e.path.join("."),
      message: e.message,
    })),
  };
}

export function isRealitySnapshot(value: unknown): value is RealitySnapshot {
  return realitySnapshotSchema.safeParse(value).success;
}

export function isRealityDiff(value: unknown): value is RealityDiff {
  return realityDiffSchema.safeParse(value).success;
}

export function isBisectResult(value: unknown): value is BisectResult {
  return bisectResultSchema.safeParse(value).success;
}
