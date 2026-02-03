/**
 * 0xSCADA Digital Twin Checkpoint Schema
 * 
 * VERITY Architecture - Phase β.2: Digital Twin Checkpoints
 * 
 * "GitHub PRs for industrial reality."
 * 
 * Digital Twin Checkpoints are versioned, branchable snapshots of industrial reality.
 * Like git for code, this system enables:
 * - Branching for what-if scenarios
 * - Merging validated changes into production
 * - Time-travel to any historical state
 * - Diff visualization between configurations
 * 
 * Core Principles:
 * - Every checkpoint is content-addressed (immutable)
 * - Checkpoints form a DAG (directed acyclic graph) via parentId
 * - Branches are named reference pointers to checkpoint IDs
 * - Merging creates new checkpoints, never modifies existing ones
 */

import { z } from "zod";
import { contentHashSchema, type ContentHash } from "../artifact";

// =============================================================================
// PLC STATE (Individual controller state)
// =============================================================================

/**
 * Data quality indicators (OPC UA quality codes simplified)
 */
export const DataQuality = {
  GOOD: "good",
  UNCERTAIN: "uncertain",
  BAD: "bad",
  STALE: "stale",
} as const;

export type DataQuality = (typeof DataQuality)[keyof typeof DataQuality];

/**
 * Tag value with metadata
 */
export const tagValueSchema = z.object({
  /** Tag path/name (e.g., "TT4750_01.PV") */
  path: z.string(),
  
  /** Current value (any JSON-serializable type) */
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  
  /** Data type */
  dataType: z.enum(["bool", "int16", "int32", "int64", "float32", "float64", "string", "datetime"]),
  
  /** Data quality */
  quality: z.enum(["good", "uncertain", "bad", "stale"]).default("good"),
  
  /** Source timestamp (when value was generated at source) */
  sourceTimestamp: z.string().datetime(),
  
  /** Engineering units (if applicable) */
  units: z.string().optional(),
});

export type TagValue = z.infer<typeof tagValueSchema>;

/**
 * Controller operating mode
 */
export const ControllerMode = {
  RUN: "run",
  PROGRAM: "program",
  REMOTE: "remote",
  TEST: "test",
  FAULT: "fault",
  OFFLINE: "offline",
} as const;

export type ControllerMode = (typeof ControllerMode)[keyof typeof ControllerMode];

/**
 * PLC/DCS State - Complete state of a single controller
 */
export const plcStateSchema = z.object({
  /** Controller identifier (from controllers table) */
  controllerId: z.string(),
  
  /** Controller name */
  controllerName: z.string(),
  
  /** Vendor (Siemens, Rockwell, ABB, etc.) */
  vendor: z.string(),
  
  /** Controller model */
  model: z.string(),
  
  /** Firmware version at snapshot time */
  firmwareVersion: z.string().optional(),
  
  /** Operating mode */
  mode: z.enum(["run", "program", "remote", "test", "fault", "offline"]),
  
  /** All tag values at snapshot time */
  tags: z.array(tagValueSchema),
  
  /** Program/project metadata */
  program: z.object({
    /** Project name */
    name: z.string(),
    /** Project version */
    version: z.string(),
    /** Content hash of program binary */
    hash: contentHashSchema.optional(),
    /** Last download timestamp */
    lastDownloaded: z.string().datetime().optional(),
  }).optional(),
  
  /** Memory/resource utilization */
  resources: z.object({
    cpuPercent: z.number().min(0).max(100).optional(),
    memoryPercent: z.number().min(0).max(100).optional(),
    ioUtilization: z.number().min(0).max(100).optional(),
  }).optional(),
  
  /** Active faults/errors */
  faults: z.array(z.object({
    code: z.string(),
    message: z.string(),
    severity: z.enum(["info", "warning", "error", "critical"]),
    timestamp: z.string().datetime(),
  })).default([]),
});

export type PLCState = z.infer<typeof plcStateSchema>;

// =============================================================================
// TOPOLOGY (Plant connectivity graph)
// =============================================================================

/**
 * Connection types between equipment
 */
export const ConnectionType = {
  PIPE: "pipe",
  WIRE: "wire",
  SIGNAL: "signal",
  DATA: "data",
  CONTROL: "control",
} as const;

export type ConnectionType = (typeof ConnectionType)[keyof typeof ConnectionType];

/**
 * Topology node (equipment/instrument)
 */
export const topologyNodeSchema = z.object({
  /** Unique node identifier */
  id: z.string(),
  
  /** Display name */
  name: z.string(),
  
  /** Node type (from ISA standards) */
  type: z.enum([
    "tank", "reactor", "pump", "valve", "heat_exchanger",
    "sensor", "transmitter", "controller", "motor",
    "pipe_section", "junction", "header",
  ]),
  
  /** Asset reference (if linked to assets table) */
  assetId: z.string().optional(),
  
  /** Control module instance reference */
  controlModuleInstanceId: z.string().optional(),
  
  /** P&ID drawing reference */
  pidReference: z.string().optional(),
  
  /** Position in 3D space (for visualization) */
  position: z.object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
  }).optional(),
  
  /** Custom properties */
  properties: z.record(z.unknown()).optional(),
});

export type TopologyNode = z.infer<typeof topologyNodeSchema>;

/**
 * Topology edge (connection between nodes)
 */
export const topologyEdgeSchema = z.object({
  /** Unique edge identifier */
  id: z.string(),
  
  /** Source node ID */
  sourceId: z.string(),
  
  /** Source port/connection point */
  sourcePort: z.string().optional(),
  
  /** Target node ID */
  targetId: z.string(),
  
  /** Target port/connection point */
  targetPort: z.string().optional(),
  
  /** Connection type */
  connectionType: z.enum(["pipe", "wire", "signal", "data", "control"]),
  
  /** Bidirectional flag */
  bidirectional: z.boolean().default(false),
  
  /** Custom properties (pipe diameter, wire gauge, etc.) */
  properties: z.record(z.unknown()).optional(),
});

export type TopologyEdge = z.infer<typeof topologyEdgeSchema>;

/**
 * Topology Graph - Complete plant connectivity
 */
export const topologyGraphSchema = z.object({
  /** Schema version */
  version: z.literal("1.0.0"),
  
  /** Site this topology belongs to */
  siteId: z.string(),
  
  /** All nodes in the topology */
  nodes: z.array(topologyNodeSchema),
  
  /** All edges (connections) */
  edges: z.array(topologyEdgeSchema),
  
  /** Named regions/areas for organization */
  regions: z.array(z.object({
    id: z.string(),
    name: z.string(),
    nodeIds: z.array(z.string()),
    parentRegionId: z.string().optional(),
  })).optional(),
  
  /** Content hash of source P&ID documents */
  sourceDocuments: z.array(z.object({
    name: z.string(),
    hash: contentHashSchema,
    type: z.enum(["pid", "cad", "bim", "usd"]),
  })).optional(),
});

export type TopologyGraph = z.infer<typeof topologyGraphSchema>;

// =============================================================================
// SAFETY ENVELOPES (Operational boundaries)
// =============================================================================

/**
 * Safety Integrity Level (IEC 61508)
 */
export const SafetyIntegrityLevel = {
  NONE: "none",
  SIL1: "sil1",
  SIL2: "sil2",
  SIL3: "sil3",
  SIL4: "sil4",
} as const;

export type SafetyIntegrityLevel = (typeof SafetyIntegrityLevel)[keyof typeof SafetyIntegrityLevel];

/**
 * Constraint type
 */
export const ConstraintType = {
  RANGE: "range",           // Value must be within min/max
  RATE: "rate",             // Rate of change limit
  INTERLOCK: "interlock",   // Boolean condition
  SEQUENCE: "sequence",     // Step sequence requirement
  PERMISSIVE: "permissive", // Condition for action
} as const;

export type ConstraintType = (typeof ConstraintType)[keyof typeof ConstraintType];

/**
 * Safety Constraint - Single operational boundary
 */
export const safetyConstraintSchema = z.object({
  /** Unique constraint identifier */
  id: z.string(),
  
  /** Human-readable name */
  name: z.string(),
  
  /** Detailed description */
  description: z.string(),
  
  /** Constraint type */
  type: z.enum(["range", "rate", "interlock", "sequence", "permissive"]),
  
  /** Safety integrity level */
  sil: z.enum(["none", "sil1", "sil2", "sil3", "sil4"]).default("none"),
  
  /** Target (tag path, asset ID, or expression) */
  target: z.string(),
  
  /** Constraint parameters based on type */
  parameters: z.union([
    // Range constraint
    z.object({
      type: z.literal("range"),
      min: z.number().optional(),
      max: z.number().optional(),
      units: z.string().optional(),
    }),
    // Rate constraint
    z.object({
      type: z.literal("rate"),
      maxRate: z.number(),
      period: z.enum(["second", "minute", "hour"]),
      units: z.string().optional(),
    }),
    // Interlock constraint
    z.object({
      type: z.literal("interlock"),
      condition: z.string(), // Boolean expression
      action: z.enum(["alarm", "shutdown", "setpoint_override"]),
    }),
    // Sequence constraint
    z.object({
      type: z.literal("sequence"),
      steps: z.array(z.string()),
      timeout: z.number().optional(), // seconds
    }),
    // Permissive constraint
    z.object({
      type: z.literal("permissive"),
      condition: z.string(),
      requiredFor: z.array(z.string()),
    }),
  ]),
  
  /** Whether this constraint is currently active */
  active: z.boolean().default(true),
  
  /** Override information (if bypassed) */
  override: z.object({
    bypassed: z.boolean(),
    bypassedBy: z.string(),
    bypassedAt: z.string().datetime(),
    reason: z.string(),
    expiresAt: z.string().datetime().optional(),
  }).optional(),
  
  /** Source documentation */
  sourceDocument: z.string().optional(),
  
  /** Last review date */
  lastReviewed: z.string().datetime().optional(),
  
  /** Reviewer */
  reviewedBy: z.string().optional(),
});

export type SafetyConstraint = z.infer<typeof safetyConstraintSchema>;

// =============================================================================
// CALIBRATIONS (Instrument calibration data)
// =============================================================================

/**
 * Calibration point (input/output pair)
 */
export const calibrationPointSchema = z.object({
  /** Applied input value */
  input: z.number(),
  
  /** Measured output value */
  output: z.number(),
  
  /** Error from ideal */
  error: z.number().optional(),
  
  /** Units */
  units: z.string().optional(),
});

export type CalibrationPoint = z.infer<typeof calibrationPointSchema>;

/**
 * Instrument Calibration Record
 */
export const calibrationRecordSchema = z.object({
  /** Unique calibration ID */
  id: z.string(),
  
  /** Instrument/asset being calibrated */
  assetId: z.string(),
  
  /** Tag path */
  tagPath: z.string(),
  
  /** Calibration type */
  calibrationType: z.enum(["zero", "span", "multipoint", "functional"]),
  
  /** Calibration standard used */
  standard: z.object({
    name: z.string(),
    serialNumber: z.string().optional(),
    certificateNumber: z.string().optional(),
    uncertainty: z.number().optional(),
    units: z.string().optional(),
  }),
  
  /** Calibration points */
  points: z.array(calibrationPointSchema),
  
  /** As-found values (before adjustment) */
  asFound: z.object({
    zeroError: z.number().optional(),
    spanError: z.number().optional(),
    linearityError: z.number().optional(),
    pass: z.boolean(),
  }),
  
  /** As-left values (after adjustment) */
  asLeft: z.object({
    zeroError: z.number().optional(),
    spanError: z.number().optional(),
    linearityError: z.number().optional(),
    pass: z.boolean(),
  }),
  
  /** Tolerance specification */
  tolerance: z.object({
    accuracy: z.number(),
    units: z.enum(["percent", "absolute"]),
  }),
  
  /** Calibration date */
  calibratedAt: z.string().datetime(),
  
  /** Next due date */
  nextDue: z.string().datetime(),
  
  /** Technician */
  calibratedBy: z.string(),
  
  /** Certificate/work order number */
  certificateNumber: z.string().optional(),
  
  /** Environmental conditions */
  conditions: z.object({
    temperature: z.number().optional(),
    humidity: z.number().optional(),
    pressure: z.number().optional(),
  }).optional(),
  
  /** Comments */
  notes: z.string().optional(),
});

export type CalibrationRecord = z.infer<typeof calibrationRecordSchema>;

/**
 * Calibration Set - All calibrations at a point in time
 */
export const calibrationSetSchema = z.object({
  /** Schema version */
  version: z.literal("1.0.0"),
  
  /** Site ID */
  siteId: z.string(),
  
  /** All calibration records */
  records: z.array(calibrationRecordSchema),
  
  /** Summary statistics */
  summary: z.object({
    totalInstruments: z.number().int(),
    inTolerance: z.number().int(),
    outOfTolerance: z.number().int(),
    overdue: z.number().int(),
  }).optional(),
});

export type CalibrationSet = z.infer<typeof calibrationSetSchema>;

// =============================================================================
// ALARM THRESHOLDS (Alarm configuration)
// =============================================================================

/**
 * Alarm priority (ISA 18.2)
 */
export const AlarmPriority = {
  DIAGNOSTIC: "diagnostic",
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
} as const;

export type AlarmPriority = (typeof AlarmPriority)[keyof typeof AlarmPriority];

/**
 * Alarm type
 */
export const AlarmType = {
  HIGH: "high",
  HIGH_HIGH: "high_high",
  LOW: "low",
  LOW_LOW: "low_low",
  RATE: "rate",
  DEVIATION: "deviation",
  DISCRETE: "discrete",
} as const;

export type AlarmType = (typeof AlarmType)[keyof typeof AlarmType];

/**
 * Single alarm threshold configuration
 */
export const alarmThresholdSchema = z.object({
  /** Unique alarm ID */
  id: z.string(),
  
  /** Tag path being monitored */
  tagPath: z.string(),
  
  /** Alarm name */
  name: z.string(),
  
  /** Alarm type */
  type: z.enum(["high", "high_high", "low", "low_low", "rate", "deviation", "discrete"]),
  
  /** Priority (ISA 18.2) */
  priority: z.enum(["diagnostic", "low", "medium", "high", "critical"]),
  
  /** Threshold value */
  threshold: z.number(),
  
  /** Engineering units */
  units: z.string().optional(),
  
  /** Deadband (hysteresis) */
  deadband: z.number().optional(),
  
  /** On-delay (seconds before alarm activates) */
  onDelay: z.number().int().default(0),
  
  /** Off-delay (seconds before alarm clears) */
  offDelay: z.number().int().default(0),
  
  /** Whether alarm is enabled */
  enabled: z.boolean().default(true),
  
  /** Shelving/suppression */
  shelved: z.object({
    isShelved: z.boolean(),
    shelvedBy: z.string(),
    shelvedAt: z.string().datetime(),
    reason: z.string(),
    expiresAt: z.string().datetime().optional(),
  }).optional(),
  
  /** Alarm message template */
  message: z.string().optional(),
  
  /** Consequence description */
  consequence: z.string().optional(),
  
  /** Response procedure */
  response: z.string().optional(),
});

export type AlarmThreshold = z.infer<typeof alarmThresholdSchema>;

/**
 * Alarm Configuration - All alarms for a site
 */
export const alarmConfigSchema = z.object({
  /** Schema version */
  version: z.literal("1.0.0"),
  
  /** Site ID */
  siteId: z.string(),
  
  /** All alarm thresholds */
  thresholds: z.array(alarmThresholdSchema),
  
  /** Global alarm settings */
  globalSettings: z.object({
    /** Maximum alarm rate (alarms per 10 minutes) */
    maxAlarmRate: z.number().int().optional(),
    /** Standing alarm limit */
    standingAlarmLimit: z.number().int().optional(),
    /** Auto-shelve duration (minutes) */
    autoShelveDuration: z.number().int().optional(),
  }).optional(),
  
  /** Summary by priority */
  summary: z.object({
    total: z.number().int(),
    byPriority: z.record(z.number().int()),
    enabled: z.number().int(),
    shelved: z.number().int(),
  }).optional(),
});

export type AlarmConfig = z.infer<typeof alarmConfigSchema>;

// =============================================================================
// CHECKPOINT STATE (Complete twin state)
// =============================================================================

/**
 * Complete state captured in a checkpoint
 */
export const checkpointStateSchema = z.object({
  /** All PLC/DCS states */
  plcStates: z.array(plcStateSchema),
  
  /** Plant topology graph */
  topology: topologyGraphSchema,
  
  /** Safety constraints/envelopes */
  safetyEnvelopes: z.array(safetyConstraintSchema),
  
  /** Calibration records */
  calibrations: calibrationSetSchema,
  
  /** Alarm threshold configuration */
  alarmThresholds: alarmConfigSchema,
});

export type CheckpointState = z.infer<typeof checkpointStateSchema>;

// =============================================================================
// CHECKPOINT METADATA
// =============================================================================

/**
 * Reviewer record
 */
export const reviewerSchema = z.object({
  /** User ID */
  userId: z.string(),
  
  /** User name */
  name: z.string(),
  
  /** Review status */
  status: z.enum(["pending", "approved", "changes_requested", "rejected"]),
  
  /** Review timestamp */
  reviewedAt: z.string().datetime().optional(),
  
  /** Review comments */
  comments: z.string().optional(),
  
  /** Signature (if approved) */
  signature: z.string().optional(),
});

export type Reviewer = z.infer<typeof reviewerSchema>;

/**
 * Checkpoint metadata
 */
export const checkpointMetadataSchema = z.object({
  /** Author (user or agent who created checkpoint) */
  author: z.object({
    id: z.string(),
    name: z.string(),
    type: z.enum(["user", "agent", "system"]),
  }),
  
  /** Reason for creating checkpoint */
  reason: z.string(),
  
  /** Linked issue/ticket number */
  linkedIssue: z.string().optional(),
  
  /** Linked work order */
  linkedWorkOrder: z.string().optional(),
  
  /** Reviewers for this checkpoint */
  reviewers: z.array(reviewerSchema).optional(),
  
  /** Tags for categorization */
  tags: z.array(z.string()).optional(),
  
  /** Change description (for non-main branches) */
  changeDescription: z.string().optional(),
  
  /** Risk assessment */
  riskAssessment: z.object({
    level: z.enum(["low", "medium", "high", "critical"]),
    factors: z.array(z.string()),
    mitigations: z.array(z.string()).optional(),
  }).optional(),
  
  /** Test results (if validated) */
  testResults: z.object({
    passed: z.boolean(),
    totalTests: z.number().int(),
    passedTests: z.number().int(),
    failedTests: z.number().int(),
    skippedTests: z.number().int(),
    resultHash: contentHashSchema.optional(),
  }).optional(),
});

export type CheckpointMetadata = z.infer<typeof checkpointMetadataSchema>;

// =============================================================================
// TWIN CHECKPOINT (Main Schema)
// =============================================================================

/**
 * TwinCheckpoint - Versioned, branchable digital twin snapshot
 * 
 * Like a git commit for industrial reality:
 * - Content-addressed (ID is hash of content)
 * - Immutable once created
 * - Forms DAG via parentId references
 * - Branches are named pointers to checkpoint IDs
 */
export const twinCheckpointSchema = z.object({
  /**
   * Content-addressed ID (SHA-256 of checkpoint content)
   * This is the "commit hash" of this checkpoint
   */
  id: contentHashSchema,
  
  /**
   * Schema version for forward compatibility
   */
  schemaVersion: z.literal("1.0.0"),
  
  /**
   * Parent checkpoint ID (for branching/lineage)
   * - null for initial checkpoint ("root commit")
   * - single ID for linear history
   * - Note: Merge commits handled via MergeRecord
   */
  parentId: contentHashSchema.nullable(),
  
  /**
   * Secondary parent for merge commits
   * When merging branch B into A, this contains B's head
   */
  secondaryParentId: contentHashSchema.optional(),
  
  /**
   * Branch name this checkpoint belongs to
   * Convention: "main" for production, "feature/*" for experiments
   */
  branchName: z.string(),
  
  /**
   * When this checkpoint was created (ISO8601)
   */
  timestamp: z.string().datetime(),
  
  /**
   * Site this twin represents
   */
  siteId: z.string(),
  
  /**
   * Complete state captured in this checkpoint
   */
  state: checkpointStateSchema,
  
  /**
   * Checkpoint metadata (author, reason, reviewers)
   */
  metadata: checkpointMetadataSchema,
  
  /**
   * LFS storage information
   */
  storage: z.object({
    /** Size of serialized state in bytes */
    sizeBytes: z.number().int(),
    
    /** Content hash of compressed state blob */
    stateHash: contentHashSchema,
    
    /** Compression algorithm used */
    compression: z.enum(["none", "gzip", "zstd", "lz4"]).default("zstd"),
    
    /** Encrypted flag */
    encrypted: z.boolean().default(false),
    
    /** Key ID if encrypted */
    encryptionKeyId: z.string().optional(),
  }),
  
  /**
   * Cryptographic signature (for attestation)
   */
  signature: z.object({
    algorithm: z.enum(["hmac-sha256", "ed25519", "secp256k1"]),
    keyId: z.string(),
    value: z.string(),
    signedAt: z.string().datetime(),
  }).optional(),
  
  /**
   * Blockchain anchoring (if anchored)
   */
  anchor: z.object({
    txHash: z.string(),
    blockNumber: z.number().int(),
    anchoredAt: z.string().datetime(),
    merkleRoot: contentHashSchema.optional(),
  }).optional(),
});

export type TwinCheckpoint = z.infer<typeof twinCheckpointSchema>;

// =============================================================================
// BRANCH REFERENCE (Named pointer to checkpoint)
// =============================================================================

/**
 * Branch protection rules
 */
export const branchProtectionSchema = z.object({
  /** Require review before merge */
  requireReview: z.boolean().default(false),
  
  /** Minimum number of approvals */
  minApprovals: z.number().int().min(0).default(1),
  
  /** Require all tests to pass */
  requireTests: z.boolean().default(false),
  
  /** Require blockchain anchoring */
  requireAnchor: z.boolean().default(false),
  
  /** Required reviewers (user IDs) */
  requiredReviewers: z.array(z.string()).optional(),
  
  /** Block force updates */
  blockForceUpdate: z.boolean().default(true),
  
  /** Block deletion */
  blockDeletion: z.boolean().default(true),
});

export type BranchProtection = z.infer<typeof branchProtectionSchema>;

/**
 * Branch Reference - Named pointer to a checkpoint
 */
export const branchReferenceSchema = z.object({
  /** Branch name (e.g., "main", "feature/new-pump-config") */
  name: z.string(),
  
  /** Site ID this branch belongs to */
  siteId: z.string(),
  
  /** Current HEAD checkpoint ID */
  headId: contentHashSchema,
  
  /** When branch was created */
  createdAt: z.string().datetime(),
  
  /** When HEAD was last updated */
  updatedAt: z.string().datetime(),
  
  /** Who created the branch */
  createdBy: z.object({
    id: z.string(),
    name: z.string(),
    type: z.enum(["user", "agent", "system"]),
  }),
  
  /** Branch description */
  description: z.string().optional(),
  
  /** Protection rules */
  protection: branchProtectionSchema.optional(),
  
  /** Whether this is the default branch */
  isDefault: z.boolean().default(false),
  
  /** Parent branch (where this was branched from) */
  parentBranch: z.string().optional(),
  
  /** Checkpoint where branch was created */
  branchPoint: contentHashSchema.optional(),
});

export type BranchReference = z.infer<typeof branchReferenceSchema>;

// =============================================================================
// DIFF & MERGE OPERATIONS
// =============================================================================

/**
 * Types of changes in a diff
 */
export const DiffChangeType = {
  ADDED: "added",
  REMOVED: "removed",
  MODIFIED: "modified",
  UNCHANGED: "unchanged",
} as const;

export type DiffChangeType = (typeof DiffChangeType)[keyof typeof DiffChangeType];

/**
 * Single change in a diff
 */
export const diffChangeSchema = z.object({
  /** Path to changed element (e.g., "plcStates[0].tags[5].value") */
  path: z.string(),
  
  /** Type of change */
  changeType: z.enum(["added", "removed", "modified", "unchanged"]),
  
  /** Previous value (for modified/removed) */
  oldValue: z.unknown().optional(),
  
  /** New value (for added/modified) */
  newValue: z.unknown().optional(),
  
  /** Human-readable description */
  description: z.string().optional(),
  
  /** Impact assessment */
  impact: z.enum(["none", "low", "medium", "high", "critical"]).optional(),
});

export type DiffChange = z.infer<typeof diffChangeSchema>;

/**
 * Complete diff between two checkpoints
 */
export const checkpointDiffSchema = z.object({
  /** Base checkpoint ID (older) */
  baseId: contentHashSchema,
  
  /** Target checkpoint ID (newer) */
  targetId: contentHashSchema,
  
  /** All changes */
  changes: z.array(diffChangeSchema),
  
  /** Summary by category */
  summary: z.object({
    plcStateChanges: z.number().int(),
    topologyChanges: z.number().int(),
    safetyEnvelopeChanges: z.number().int(),
    calibrationChanges: z.number().int(),
    alarmThresholdChanges: z.number().int(),
    totalChanges: z.number().int(),
  }),
  
  /** Safety impact assessment */
  safetyImpact: z.object({
    level: z.enum(["none", "low", "medium", "high", "critical"]),
    affectedConstraints: z.array(z.string()),
    requiresReview: z.boolean(),
  }),
  
  /** Generated at timestamp */
  generatedAt: z.string().datetime(),
});

export type CheckpointDiff = z.infer<typeof checkpointDiffSchema>;

/**
 * Merge conflict
 */
export const mergeConflictSchema = z.object({
  /** Path to conflicting element */
  path: z.string(),
  
  /** Value in base (common ancestor) */
  baseValue: z.unknown(),
  
  /** Value in "ours" (target branch) */
  oursValue: z.unknown(),
  
  /** Value in "theirs" (source branch) */
  theirsValue: z.unknown(),
  
  /** Auto-resolved (if possible) */
  autoResolved: z.boolean().default(false),
  
  /** Resolution strategy used */
  resolution: z.enum(["ours", "theirs", "manual", "unresolved"]).optional(),
  
  /** Manually resolved value */
  resolvedValue: z.unknown().optional(),
});

export type MergeConflict = z.infer<typeof mergeConflictSchema>;

/**
 * Merge result
 */
export const mergeResultSchema = z.object({
  /** Whether merge was successful */
  success: z.boolean(),
  
  /** Resulting checkpoint (if successful) */
  mergedCheckpoint: twinCheckpointSchema.optional(),
  
  /** Conflicts encountered */
  conflicts: z.array(mergeConflictSchema),
  
  /** Merge strategy used */
  strategy: z.enum(["fast-forward", "three-way", "recursive"]),
  
  /** Base (common ancestor) checkpoint ID */
  baseId: contentHashSchema,
  
  /** Source branch being merged */
  sourceBranch: z.string(),
  
  /** Target branch receiving merge */
  targetBranch: z.string(),
  
  /** Merge metadata */
  metadata: z.object({
    mergedBy: z.object({
      id: z.string(),
      name: z.string(),
      type: z.enum(["user", "agent", "system"]),
    }),
    mergedAt: z.string().datetime(),
    message: z.string(),
  }),
});

export type MergeResult = z.infer<typeof mergeResultSchema>;

// =============================================================================
// CHECKPOINT OPERATIONS
// =============================================================================

/**
 * Input for creating a new checkpoint
 */
export const createCheckpointInputSchema = z.object({
  /** Parent checkpoint ID (null for root) */
  parentId: contentHashSchema.nullable(),
  
  /** Branch name */
  branchName: z.string(),
  
  /** Site ID */
  siteId: z.string(),
  
  /** State to capture */
  state: checkpointStateSchema,
  
  /** Metadata */
  metadata: checkpointMetadataSchema,
  
  /** Whether to sign the checkpoint */
  sign: z.boolean().default(false),
  
  /** Compression algorithm */
  compression: z.enum(["none", "gzip", "zstd", "lz4"]).default("zstd"),
});

export type CreateCheckpointInput = z.infer<typeof createCheckpointInputSchema>;

/**
 * Input for creating a new branch
 */
export const createBranchInputSchema = z.object({
  /** Branch name */
  name: z.string(),
  
  /** Site ID */
  siteId: z.string(),
  
  /** Starting checkpoint ID */
  startPoint: contentHashSchema,
  
  /** Description */
  description: z.string().optional(),
  
  /** Protection rules */
  protection: branchProtectionSchema.optional(),
});

export type CreateBranchInput = z.infer<typeof createBranchInputSchema>;

/**
 * Input for merging branches
 */
export const mergeBranchInputSchema = z.object({
  /** Source branch (being merged) */
  sourceBranch: z.string(),
  
  /** Target branch (receiving merge) */
  targetBranch: z.string(),
  
  /** Site ID */
  siteId: z.string(),
  
  /** Merge message */
  message: z.string(),
  
  /** Strategy preference */
  strategy: z.enum(["fast-forward", "three-way", "squash"]).default("three-way"),
  
  /** Conflict resolutions (if pre-resolved) */
  resolutions: z.array(z.object({
    path: z.string(),
    resolution: z.enum(["ours", "theirs"]),
  })).optional(),
  
  /** Delete source branch after merge */
  deleteSource: z.boolean().default(false),
});

export type MergeBranchInput = z.infer<typeof mergeBranchInputSchema>;

// =============================================================================
// CHECKPOINT QUERY
// =============================================================================

/**
 * Query parameters for searching checkpoints
 */
export const checkpointQuerySchema = z.object({
  /** Filter by site ID */
  siteId: z.string().optional(),
  
  /** Filter by branch name */
  branchName: z.string().optional(),
  
  /** Filter by author ID */
  authorId: z.string().optional(),
  
  /** Filter by tag */
  tag: z.string().optional(),
  
  /** Filter by linked issue */
  linkedIssue: z.string().optional(),
  
  /** Time range start */
  fromTimestamp: z.string().datetime().optional(),
  
  /** Time range end */
  toTimestamp: z.string().datetime().optional(),
  
  /** Include ancestors of checkpoint */
  ancestorOf: contentHashSchema.optional(),
  
  /** Include descendants of checkpoint */
  descendantOf: contentHashSchema.optional(),
  
  /** Pagination offset */
  offset: z.number().int().nonnegative().default(0),
  
  /** Pagination limit */
  limit: z.number().int().positive().max(1000).default(100),
  
  /** Sort order */
  sortBy: z.enum(["timestamp", "branchName", "author"]).default("timestamp"),
  
  /** Sort direction */
  sortDirection: z.enum(["asc", "desc"]).default("desc"),
});

export type CheckpointQuery = z.infer<typeof checkpointQuerySchema>;

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

/**
 * Validate a twin checkpoint
 */
export function validateTwinCheckpoint(data: unknown): {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
  checkpoint?: TwinCheckpoint;
} {
  const result = twinCheckpointSchema.safeParse(data);
  
  if (result.success) {
    return {
      valid: true,
      errors: [],
      checkpoint: result.data,
    };
  }
  
  return {
    valid: false,
    errors: result.error.errors.map((e) => ({
      path: e.path.join("."),
      message: e.message,
    })),
  };
}

/**
 * Validate checkpoint state
 */
export function validateCheckpointState(data: unknown): {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
  state?: CheckpointState;
} {
  const result = checkpointStateSchema.safeParse(data);
  
  if (result.success) {
    return {
      valid: true,
      errors: [],
      state: result.data,
    };
  }
  
  return {
    valid: false,
    errors: result.error.errors.map((e) => ({
      path: e.path.join("."),
      message: e.message,
    })),
  };
}

// =============================================================================
// TYPE GUARDS
// =============================================================================

export function isTwinCheckpoint(value: unknown): value is TwinCheckpoint {
  return twinCheckpointSchema.safeParse(value).success;
}

export function isBranchReference(value: unknown): value is BranchReference {
  return branchReferenceSchema.safeParse(value).success;
}

export function isCheckpointDiff(value: unknown): value is CheckpointDiff {
  return checkpointDiffSchema.safeParse(value).success;
}

export function isMergeResult(value: unknown): value is MergeResult {
  return mergeResultSchema.safeParse(value).success;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default branch name (production) */
export const DEFAULT_BRANCH = "main";

/** Branch name patterns */
export const BRANCH_PATTERNS = {
  FEATURE: /^feature\/.+$/,
  EXPERIMENT: /^experiment\/.+$/,
  HOTFIX: /^hotfix\/.+$/,
  RELEASE: /^release\/.+$/,
  VENDOR: /^vendor\/.+$/,
  TRAINING: /^training\/.+$/,
} as const;

/** Recommended compression for different scenarios */
export const COMPRESSION_RECOMMENDATIONS = {
  /** Real-time checkpoints: fast compression */
  REALTIME: "lz4" as const,
  /** Archival: maximum compression */
  ARCHIVAL: "zstd" as const,
  /** Transfer: balanced */
  TRANSFER: "gzip" as const,
} as const;
