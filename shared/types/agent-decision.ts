/**
 * 0xSCADA Agent Decision Record Schema
 * 
 * VERITY Architecture - Agentic-QE Fork: LFS as Agent Memory Substrate
 * 
 * "Agents that cite, don't hallucinate."
 * 
 * Every decision must be replayable:
 *   Inputs → Constraints → Reasoning → Outputs
 * 
 * If replay is impossible, the decision is invalid.
 */

import { z } from "zod";
import { contentHashSchema, type ContentHash } from "../artifact";

// =============================================================================
// SUPPORTING TYPES
// =============================================================================

/**
 * Action types that an agent can propose
 */
export const ActionType = {
  COMMAND: "command",
  SETPOINT_CHANGE: "setpoint_change",
  MODE_CHANGE: "mode_change",
  CONFIGURATION: "configuration",
  MAINTENANCE: "maintenance",
  DEPLOYMENT: "deployment",
  ALERT: "alert",
  NO_OP: "no_op",
} as const;

export type ActionType = (typeof ActionType)[keyof typeof ActionType];

/**
 * Action schema - what the agent decided to do
 */
export const actionSchema = z.object({
  /** Type of action */
  type: z.enum([
    "command",
    "setpoint_change",
    "mode_change",
    "configuration",
    "maintenance",
    "deployment",
    "alert",
    "no_op",
  ]),
  
  /** Target of the action (asset ID, controller ID, etc.) */
  target: z.string().optional(),
  
  /** Action parameters */
  parameters: z.record(z.unknown()).optional(),
  
  /** Priority level */
  priority: z.enum(["low", "normal", "high", "critical"]).default("normal"),
  
  /** Whether this action requires human approval */
  requiresApproval: z.boolean().default(true),
  
  /** Deadline for action (ISO8601) */
  deadline: z.string().datetime().optional(),
});

export type Action = z.infer<typeof actionSchema>;

/**
 * Check result from automated verification
 */
export const CheckResultStatus = {
  PASS: "pass",
  FAIL: "fail",
  WARN: "warn",
  SKIP: "skip",
  ERROR: "error",
} as const;

export type CheckResultStatus = (typeof CheckResultStatus)[keyof typeof CheckResultStatus];

export const checkResultSchema = z.object({
  /** Name of the check */
  name: z.string(),
  
  /** Check category */
  category: z.enum([
    "safety",
    "compliance",
    "consistency",
    "boundary",
    "dependency",
    "policy",
  ]),
  
  /** Check status */
  status: z.enum(["pass", "fail", "warn", "skip", "error"]),
  
  /** Human-readable message */
  message: z.string().optional(),
  
  /** Check execution timestamp */
  checkedAt: z.string().datetime(),
  
  /** Duration in milliseconds */
  durationMs: z.number().int().nonnegative().optional(),
  
  /** Additional details */
  details: z.record(z.unknown()).optional(),
});

export type CheckResult = z.infer<typeof checkResultSchema>;

// =============================================================================
// AGENT DECISION INPUTS
// =============================================================================

/**
 * Decision Inputs - What the agent observed and considered
 * 
 * All inputs are artifact references (ContentHash) for:
 * - Provenance tracking
 * - Replay capability
 * - Audit trail
 */
export const decisionInputsSchema = z.object({
  /**
   * Artifacts the agent observed (LFS refs)
   * Examples: sensor readings, telemetry, events, traces
   */
  artifacts: z.array(contentHashSchema).default([]),
  
  /**
   * World model snapshot / context at decision time
   * This captures the agent's understanding of system state
   */
  context: contentHashSchema,
  
  /**
   * Active safety constraints and operational boundaries
   * These are the rules the agent must operate within
   */
  constraints: contentHashSchema,
  
  /**
   * Optional: Previous decisions that influenced this one
   */
  priorDecisions: z.array(contentHashSchema).optional(),
  
  /**
   * Optional: User queries or instructions that triggered the decision
   */
  userPrompt: contentHashSchema.optional(),
});

export type DecisionInputs = z.infer<typeof decisionInputsSchema>;

// =============================================================================
// AGENT DECISION REASONING
// =============================================================================

/**
 * Decision Reasoning - The full chain of thought
 * 
 * "If you act, you must be able to replay: Inputs → Constraints → Reasoning → Outputs"
 */
export const decisionReasoningSchema = z.object({
  /**
   * Full chain-of-thought stored in LFS
   * This is the complete reasoning trace, not a summary
   */
  chainOfThought: contentHashSchema,
  
  /**
   * Model identifier (version, checkpoint, or name)
   * Examples: "gpt-4-turbo-2024-04-09", "claude-3-opus", "local-llama-70b"
   */
  model: z.string(),
  
  /**
   * Temperature parameter used (for reproducibility)
   */
  temperature: z.number().min(0).max(2),
  
  /**
   * Tokens consumed (input + output)
   */
  tokens: z.number().int().nonnegative(),
  
  /**
   * Token breakdown (optional)
   */
  tokenBreakdown: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  }).optional(),
  
  /**
   * Seed for deterministic sampling (if used)
   */
  seed: z.number().int().optional(),
  
  /**
   * Duration of reasoning in milliseconds
   */
  durationMs: z.number().int().nonnegative().optional(),
  
  /**
   * System prompt hash (for reproducibility)
   */
  systemPromptHash: contentHashSchema.optional(),
  
  /**
   * Tool calls made during reasoning
   */
  toolCalls: z.array(z.object({
    tool: z.string(),
    input: z.record(z.unknown()),
    output: contentHashSchema,
    durationMs: z.number().int().nonnegative().optional(),
  })).optional(),
});

export type DecisionReasoning = z.infer<typeof decisionReasoningSchema>;

// =============================================================================
// AGENT DECISION OUTPUT
// =============================================================================

/**
 * Decision Output - What the agent decided
 */
export const decisionOutputSchema = z.object({
  /**
   * Human-readable decision summary
   */
  decision: z.string(),
  
  /**
   * Optional action to take (may be absent for observational decisions)
   */
  action: actionSchema.optional(),
  
  /**
   * Confidence score (0.0 to 1.0)
   * - 0.0-0.3: Low confidence, likely needs human review
   * - 0.3-0.7: Medium confidence
   * - 0.7-1.0: High confidence
   */
  confidence: z.number().min(0).max(1),
  
  /**
   * Alternatives considered (for transparency)
   */
  alternatives: z.array(z.object({
    decision: z.string(),
    action: actionSchema.optional(),
    confidence: z.number().min(0).max(1),
    rejectionReason: z.string(),
  })).optional(),
  
  /**
   * Key factors that influenced the decision
   */
  keyFactors: z.array(z.string()).optional(),
  
  /**
   * Uncertainties or caveats
   */
  uncertainties: z.array(z.string()).optional(),
});

export type DecisionOutput = z.infer<typeof decisionOutputSchema>;

// =============================================================================
// AGENT DECISION VERIFICATION
// =============================================================================

/**
 * Decision Verification - How the decision was checked
 */
export const decisionVerificationSchema = z.object({
  /**
   * Human approval status
   */
  humanApproved: z.boolean().optional(),
  
  /**
   * Human approver information (if approved)
   */
  humanApprover: z.object({
    userId: z.string(),
    approvedAt: z.string().datetime(),
    comment: z.string().optional(),
    signature: z.string().optional(),
  }).optional(),
  
  /**
   * Automated checks performed
   */
  automatedChecks: z.array(checkResultSchema).default([]),
  
  /**
   * Overall safety score (0.0 to 1.0)
   * Computed from automated checks and risk assessment
   */
  safetyScore: z.number().min(0).max(1),
  
  /**
   * Risk assessment
   */
  riskAssessment: z.object({
    level: z.enum(["low", "medium", "high", "critical"]),
    factors: z.array(z.string()),
  }).optional(),
  
  /**
   * Policy compliance
   */
  policyCompliance: z.object({
    compliant: z.boolean(),
    violations: z.array(z.string()),
    warnings: z.array(z.string()),
  }).optional(),
  
  /**
   * Verification timestamp
   */
  verifiedAt: z.string().datetime().optional(),
});

export type DecisionVerification = z.infer<typeof decisionVerificationSchema>;

// =============================================================================
// AGENT DECISION RECORD (Main Schema)
// =============================================================================

/**
 * AgentDecision - Complete decision record
 * 
 * This is the core schema for the Agentic-QE fork's decision memory.
 * Every decision is:
 * - Content-addressed (immutable after creation)
 * - Replayable (all inputs captured)
 * - Auditable (full reasoning trace)
 * - Verifiable (automated + human checks)
 */
export const agentDecisionSchema = z.object({
  /**
   * Content-addressed ID (SHA-256 of decision content)
   */
  id: contentHashSchema,
  
  /**
   * Version of the decision schema
   */
  schemaVersion: z.literal("1.0.0"),
  
  /**
   * When the decision was made (ISO8601)
   */
  timestamp: z.string().datetime(),
  
  /**
   * Agent that made this decision
   */
  agent: z.object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    version: z.string(),
  }),
  
  /**
   * Site context (if applicable)
   */
  siteId: z.string().optional(),
  
  /**
   * Asset context (if applicable)
   */
  assetIds: z.array(z.string()).optional(),
  
  /**
   * Decision inputs - what the agent observed
   */
  inputs: decisionInputsSchema,
  
  /**
   * Decision reasoning - how the agent thought
   */
  reasoning: decisionReasoningSchema,
  
  /**
   * Decision output - what the agent decided
   */
  output: decisionOutputSchema,
  
  /**
   * Decision verification - how it was checked
   */
  verification: decisionVerificationSchema,
  
  /**
   * Cryptographic signature of the decision
   */
  signature: z.object({
    algorithm: z.enum(["hmac-sha256", "ed25519", "secp256k1"]),
    keyId: z.string(),
    value: z.string(),
    signedAt: z.string().datetime(),
  }).optional(),
  
  /**
   * Execution status (for decisions with actions)
   */
  execution: z.object({
    status: z.enum(["pending", "approved", "rejected", "executing", "completed", "failed", "cancelled"]),
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
    result: z.record(z.unknown()).optional(),
    error: z.string().optional(),
  }).optional(),
  
  /**
   * Cross-references to related artifacts
   */
  relatedArtifacts: z.object({
    /** Previous decision in chain */
    previousDecision: contentHashSchema.optional(),
    /** Twin checkpoint at decision time */
    twinCheckpoint: contentHashSchema.optional(),
    /** Blockchain anchor (if anchored) */
    anchor: z.object({
      txHash: z.string(),
      blockNumber: z.number().int(),
      anchoredAt: z.string().datetime(),
    }).optional(),
  }).optional(),
});

export type AgentDecision = z.infer<typeof agentDecisionSchema>;

// =============================================================================
// INPUT SCHEMAS (For creating new decisions)
// =============================================================================

/**
 * Input for creating a new agent decision
 */
export const createAgentDecisionInputSchema = z.object({
  agent: z.object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    version: z.string(),
  }),
  siteId: z.string().optional(),
  assetIds: z.array(z.string()).optional(),
  inputs: decisionInputsSchema,
  reasoning: decisionReasoningSchema,
  output: decisionOutputSchema,
  verification: decisionVerificationSchema.optional(),
});

export type CreateAgentDecisionInput = z.infer<typeof createAgentDecisionInputSchema>;

// =============================================================================
// QUERY SCHEMAS
// =============================================================================

/**
 * Query parameters for searching decisions
 */
export const agentDecisionQuerySchema = z.object({
  /** Filter by agent ID */
  agentId: z.string().optional(),
  
  /** Filter by agent type */
  agentType: z.string().optional(),
  
  /** Filter by site ID */
  siteId: z.string().optional(),
  
  /** Filter by asset IDs */
  assetIds: z.array(z.string()).optional(),
  
  /** Filter by action type */
  actionType: z.enum([
    "command",
    "setpoint_change",
    "mode_change",
    "configuration",
    "maintenance",
    "deployment",
    "alert",
    "no_op",
  ]).optional(),
  
  /** Filter by execution status */
  executionStatus: z.enum([
    "pending",
    "approved",
    "rejected",
    "executing",
    "completed",
    "failed",
    "cancelled",
  ]).optional(),
  
  /** Filter by minimum confidence */
  minConfidence: z.number().min(0).max(1).optional(),
  
  /** Filter by minimum safety score */
  minSafetyScore: z.number().min(0).max(1).optional(),
  
  /** Filter by human approval status */
  humanApproved: z.boolean().optional(),
  
  /** Filter by artifact dependency */
  dependsOnArtifact: contentHashSchema.optional(),
  
  /** Time range start */
  fromTimestamp: z.string().datetime().optional(),
  
  /** Time range end */
  toTimestamp: z.string().datetime().optional(),
  
  /** Pagination offset */
  offset: z.number().int().nonnegative().default(0),
  
  /** Pagination limit */
  limit: z.number().int().positive().max(1000).default(100),
});

export type AgentDecisionQuery = z.infer<typeof agentDecisionQuerySchema>;

// =============================================================================
// REPLAY SCHEMAS
// =============================================================================

/**
 * Result of replaying a decision
 */
export const decisionReplayResultSchema = z.object({
  /** Original decision ID */
  originalId: contentHashSchema,
  
  /** Replayed decision (new ID due to timestamp change) */
  replayedDecision: agentDecisionSchema,
  
  /** Whether the replay produced the same output */
  outputMatches: z.boolean(),
  
  /** Detailed comparison */
  comparison: z.object({
    decisionMatches: z.boolean(),
    actionMatches: z.boolean(),
    confidenceDelta: z.number(),
    keyDifferences: z.array(z.string()),
  }),
  
  /** Replay metadata */
  replay: z.object({
    replayedAt: z.string().datetime(),
    replayDurationMs: z.number().int().nonnegative(),
    replayReason: z.string().optional(),
  }),
});

export type DecisionReplayResult = z.infer<typeof decisionReplayResultSchema>;

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

/**
 * Validate an agent decision
 */
export function validateAgentDecision(data: unknown): {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
  decision?: AgentDecision;
} {
  const result = agentDecisionSchema.safeParse(data);
  
  if (result.success) {
    return {
      valid: true,
      errors: [],
      decision: result.data,
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
 * Validate decision inputs
 */
export function validateDecisionInputs(data: unknown): {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
  inputs?: DecisionInputs;
} {
  const result = decisionInputsSchema.safeParse(data);
  
  if (result.success) {
    return {
      valid: true,
      errors: [],
      inputs: result.data,
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

export function isAgentDecision(value: unknown): value is AgentDecision {
  return agentDecisionSchema.safeParse(value).success;
}

export function isAction(value: unknown): value is Action {
  return actionSchema.safeParse(value).success;
}

export function isCheckResult(value: unknown): value is CheckResult {
  return checkResultSchema.safeParse(value).success;
}
