/**
 * 0xSCADA Propagation Types
 *
 * GhostOS Propagation Model - Mode Selection and Metrics
 * See docs/propagation-model.md for specification
 *
 * Issue: #164 - Propagation Mode Selection Engine
 * Epic: #161 - GhostOS Propagation Model
 */

import { z } from "zod";
import {
  PropagationMode,
  PropagationThresholds,
  DEFAULT_PROPAGATION_THRESHOLDS,
  IntentPacket,
  TargetSelector,
  CriticalityLevel,
} from "./intent-packet";

// =============================================================================
// COUPLING METRICS (docs/propagation-model.md Section 6.1)
// =============================================================================

export interface CouplingInputs {
  /** Semantic similarity between intent action and target capabilities (0.0-1.0) */
  relevance: number;
  /** Agent capability coverage for intent requirements (0.0-1.0) */
  capabilityMatch: number;
  /** Intersection of intent scope with target scope (0.0-1.0) */
  scopeOverlap: number;
}

export interface CouplingWeights {
  relevance: number;
  capabilityMatch: number;
  scopeOverlap: number;
}

export const DEFAULT_COUPLING_WEIGHTS: CouplingWeights = {
  relevance: 0.4,
  capabilityMatch: 0.3,
  scopeOverlap: 0.3,
};

export const couplingInputsSchema = z.object({
  relevance: z.number().min(0).max(1),
  capabilityMatch: z.number().min(0).max(1),
  scopeOverlap: z.number().min(0).max(1),
});

// =============================================================================
// LOSS METRICS (docs/propagation-model.md Section 6.2)
// =============================================================================

export interface LossInputs {
  /** Base loss from originator confidence: 1 - confidence */
  baseLoss: number;
  /** Propagation distance (hops, latency, or semantic distance) */
  distance: number;
  /** Loss factors from protocol/format transformations */
  transformationLoss: number;
}

export const lossInputsSchema = z.object({
  baseLoss: z.number().min(0).max(1),
  distance: z.number().min(0),
  transformationLoss: z.number().min(0).max(1),
});

// =============================================================================
// POLICY FLAGS
// =============================================================================

export const PolicyFlag = {
  CRITICAL_TARGET: "CRITICAL_TARGET",
  AUTHORITY_EXCEEDED: "AUTHORITY_EXCEEDED",
  LOW_CONFIDENCE: "LOW_CONFIDENCE",
  HIGH_LOSS: "HIGH_LOSS",
  EXPLORATION_DISABLED: "EXPLORATION_DISABLED",
  QUORUM_REQUIRED: "QUORUM_REQUIRED",
  MANUAL_SAFE_HOLD: "MANUAL_SAFE_HOLD",
  TTL_EXCEEDED: "TTL_EXCEEDED",
} as const;

export type PolicyFlag = (typeof PolicyFlag)[keyof typeof PolicyFlag];

// =============================================================================
// MODE SELECTION CONTEXT
// =============================================================================

export interface ModeSelectionContext {
  /** The intent packet being evaluated */
  packet: IntentPacket;

  /** Computed coupling score (0.0-1.0) */
  coupling: number;

  /** Computed loss score (0.0-1.0) */
  loss: number;

  /** Propagation distance */
  distance: number;

  /** Whether the target includes critical assets */
  targetsCritical: boolean;

  /** Whether the agent has sufficient authority */
  hasAuthority: boolean;

  /** Whether exploration mode is allowed in this environment */
  explorationAllowed: boolean;

  /** Custom policy flags that may force SAFE_HOLD */
  policyFlags: PolicyFlag[];
}

export const modeSelectionContextSchema = z.object({
  packet: z.any(), // IntentPacket validated separately
  coupling: z.number().min(0).max(1),
  loss: z.number().min(0).max(1),
  distance: z.number().min(0),
  targetsCritical: z.boolean(),
  hasAuthority: z.boolean(),
  explorationAllowed: z.boolean().default(true),
  policyFlags: z.array(z.nativeEnum(PolicyFlag)).default([]),
});

// =============================================================================
// MODE SELECTION RESULT
// =============================================================================

export interface ModeSelectionResult {
  /** Selected propagation mode */
  mode: PropagationMode;

  /** Effective coupling after loss: C * (1 - L) */
  effectiveCoupling: number;

  /** Human-readable reason for mode selection */
  reason: string;

  /** Detailed rationale with all scoring inputs */
  rationale: ModeRationale;

  /** Whether SAFE_HOLD was forced by policy */
  forcedByPolicy: boolean;

  /** Policy flags that influenced the decision */
  activeFlags: PolicyFlag[];
}

export interface ModeRationale {
  /** Raw coupling score */
  coupling: number;

  /** Raw loss score */
  loss: number;

  /** Effective coupling: C * (1 - L) */
  effectiveCoupling: number;

  /** Propagation distance */
  distance: number;

  /** Thresholds used for decision */
  thresholds: PropagationThresholds;

  /** Score breakdown for each mode */
  modeScores: Record<PropagationMode, number>;

  /** Conditions checked for each mode */
  conditionsChecked: ModeConditionResult[];
}

export interface ModeConditionResult {
  mode: PropagationMode;
  condition: string;
  passed: boolean;
  value?: number;
  threshold?: number;
}

// =============================================================================
// ENVIRONMENT CONFIGURATION
// =============================================================================

export interface PropagationEnvironment {
  /** Propagation thresholds (can be overridden per environment) */
  thresholds: PropagationThresholds;

  /** Coupling weights for scoring */
  couplingWeights: CouplingWeights;

  /** Whether exploration mode is allowed */
  allowExploration: boolean;

  /** Maximum allowed propagation distance */
  maxDistance: number;

  /** Site-specific configurations */
  siteOverrides?: Record<string, Partial<PropagationThresholds>>;
}

export const DEFAULT_PROPAGATION_ENVIRONMENT: PropagationEnvironment = {
  thresholds: DEFAULT_PROPAGATION_THRESHOLDS,
  couplingWeights: DEFAULT_COUPLING_WEIGHTS,
  allowExploration: true,
  maxDistance: 100,
};

// =============================================================================
// TARGET ANALYSIS
// =============================================================================

export interface TargetAnalysis {
  /** Total number of targets */
  targetCount: number;

  /** Number of critical targets */
  criticalCount: number;

  /** Whether any target is critical */
  hasCritical: boolean;

  /** Estimated propagation distance */
  estimatedDistance: number;

  /** Scope overlap with agent capabilities */
  scopeOverlap: number;

  /** Site IDs involved */
  siteIds: string[];

  /** Is this a cross-site operation */
  isCrossSite: boolean;
}

// =============================================================================
// SCORING FUNCTIONS TYPES
// =============================================================================

export type CouplingCalculator = (inputs: CouplingInputs, weights?: CouplingWeights) => number;

export type LossCalculator = (inputs: LossInputs, d0: number) => number;

export type ModeScorer = (
  mode: PropagationMode,
  context: ModeSelectionContext,
  thresholds: PropagationThresholds
) => number;

// =============================================================================
// SAFE_HOLD GUARDRAILS (docs/propagation-model.md Section 9)
// Issue: #165 - SAFE_HOLD Guardrails & Human Escalation
// =============================================================================

/**
 * Risk level for guardrail decisions
 */
export const RiskLevel = {
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
  CRITICAL: "CRITICAL",
} as const;

export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

/**
 * Escalation status for human approval workflow
 */
export const EscalationStatus = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
} as const;

export type EscalationStatus = (typeof EscalationStatus)[keyof typeof EscalationStatus];

/**
 * Evidence payload captured when SAFE_HOLD is triggered
 */
export interface SafeHoldEvidence {
  /** Unique evidence ID */
  evidenceId: string;

  /** Intent that triggered SAFE_HOLD */
  intentId: string;

  /** Timestamp when SAFE_HOLD was triggered */
  triggeredAt: string;

  /** Primary reason for SAFE_HOLD */
  primaryReason: string;

  /** All contributing factors */
  factors: SafeHoldFactor[];

  /** Mode selection context at time of decision */
  context: {
    coupling: number;
    loss: number;
    effectiveCoupling: number;
    distance: number;
    targetsCritical: boolean;
    hasAuthority: boolean;
  };

  /** Policy flags that were active */
  activeFlags: PolicyFlag[];

  /** Risk assessment */
  riskLevel: RiskLevel;

  /** Snapshot of the intent packet */
  intentSnapshot: unknown;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Individual factor contributing to SAFE_HOLD decision
 */
export interface SafeHoldFactor {
  /** Factor type/category */
  type: PolicyFlag | string;

  /** Human-readable description */
  description: string;

  /** Severity of this factor */
  severity: RiskLevel;

  /** Measured value (if applicable) */
  value?: number;

  /** Threshold that was violated (if applicable) */
  threshold?: number;
}

/**
 * Request for human escalation
 */
export interface EscalationRequest {
  /** Unique escalation ID */
  escalationId: string;

  /** Evidence from SAFE_HOLD trigger */
  evidence: SafeHoldEvidence;

  /** Target for escalation (user ID, role, or group) */
  escalationTarget: string;

  /** Priority level */
  priority: RiskLevel;

  /** When the escalation was created */
  createdAt: string;

  /** When the escalation expires */
  expiresAt: string;

  /** Current status */
  status: EscalationStatus;

  /** Suggested actions for the approver */
  suggestedActions: EscalationAction[];

  /** Context to help approver make decision */
  approverContext: string;
}

/**
 * Possible actions an approver can take
 */
export interface EscalationAction {
  /** Action identifier */
  actionId: string;

  /** Display label */
  label: string;

  /** Description of what this action does */
  description: string;

  /** Whether this action approves the intent */
  approves: boolean;

  /** Required confirmation level */
  requiresConfirmation: boolean;
}

/**
 * Response from human approval
 */
export interface EscalationResponse {
  /** Escalation ID being responded to */
  escalationId: string;

  /** User who responded */
  responderId: string;

  /** Responder's role/authority */
  responderAuthority: string;

  /** Action taken */
  action: string;

  /** Whether the intent was approved */
  approved: boolean;

  /** Optional comment from approver */
  comment?: string;

  /** Timestamp of response */
  respondedAt: string;

  /** Digital signature of response */
  signature?: string;
}

/**
 * Result of guardrail evaluation
 */
export interface GuardrailResult {
  /** Whether the intent passed all guardrails */
  passed: boolean;

  /** If blocked, the evidence payload */
  evidence?: SafeHoldEvidence;

  /** If blocked, the escalation request */
  escalation?: EscalationRequest;

  /** All guardrails that were checked */
  checksPerformed: GuardrailCheck[];

  /** Processing time in milliseconds */
  processingTimeMs: number;
}

/**
 * Individual guardrail check result
 */
export interface GuardrailCheck {
  /** Guardrail name/identifier */
  guardrail: string;

  /** Whether this guardrail passed */
  passed: boolean;

  /** Reason for pass/fail */
  reason: string;

  /** Whether this guardrail is blocking (vs advisory) */
  blocking: boolean;

  /** Risk level if failed */
  riskIfFailed?: RiskLevel;
}

/**
 * Configuration for guardrail behavior
 */
export interface GuardrailConfig {
  /** Enable/disable individual guardrails */
  enabledGuardrails: string[];

  /** Default escalation target */
  defaultEscalationTarget: string;

  /** Escalation timeout in milliseconds */
  escalationTimeoutMs: number;

  /** Whether to require dual approval for critical decisions */
  requireDualApproval: boolean;

  /** Minimum authority level for approvals */
  minApprovalAuthority: string;

  /** Whether to allow auto-approval for low-risk decisions */
  allowAutoApproval: boolean;

  /** Auto-approval threshold (max risk level) */
  autoApprovalMaxRisk: RiskLevel;
}

export const DEFAULT_GUARDRAIL_CONFIG: GuardrailConfig = {
  enabledGuardrails: [
    "authority",
    "coupling",
    "loss",
    "critical_target",
    "confidence",
    "policy_flags",
  ],
  defaultEscalationTarget: "on-call-supervisor",
  escalationTimeoutMs: 3600000, // 1 hour
  requireDualApproval: false,
  minApprovalAuthority: "SUPERVISOR",
  allowAutoApproval: false,
  autoApprovalMaxRisk: RiskLevel.LOW,
};

/**
 * Zod schemas for validation
 */
export const safeHoldFactorSchema = z.object({
  type: z.string(),
  description: z.string(),
  severity: z.nativeEnum(RiskLevel),
  value: z.number().optional(),
  threshold: z.number().optional(),
});

export const safeHoldEvidenceSchema = z.object({
  evidenceId: z.string().uuid(),
  intentId: z.string().uuid(),
  triggeredAt: z.string().datetime(),
  primaryReason: z.string(),
  factors: z.array(safeHoldFactorSchema),
  context: z.object({
    coupling: z.number(),
    loss: z.number(),
    effectiveCoupling: z.number(),
    distance: z.number(),
    targetsCritical: z.boolean(),
    hasAuthority: z.boolean(),
  }),
  activeFlags: z.array(z.nativeEnum(PolicyFlag)),
  riskLevel: z.nativeEnum(RiskLevel),
  intentSnapshot: z.unknown(),
  metadata: z.record(z.unknown()).optional(),
});

export const escalationRequestSchema = z.object({
  escalationId: z.string().uuid(),
  evidence: safeHoldEvidenceSchema,
  escalationTarget: z.string(),
  priority: z.nativeEnum(RiskLevel),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  status: z.nativeEnum(EscalationStatus),
  suggestedActions: z.array(z.object({
    actionId: z.string(),
    label: z.string(),
    description: z.string(),
    approves: z.boolean(),
    requiresConfirmation: z.boolean(),
  })),
  approverContext: z.string(),
});

export const escalationResponseSchema = z.object({
  escalationId: z.string().uuid(),
  responderId: z.string(),
  responderAuthority: z.string(),
  action: z.string(),
  approved: z.boolean(),
  comment: z.string().optional(),
  respondedAt: z.string().datetime(),
  signature: z.string().optional(),
});

// =============================================================================
// EXPORTS FOR CONVENIENCE
// =============================================================================

export {
  PropagationMode,
  PropagationThresholds,
  DEFAULT_PROPAGATION_THRESHOLDS,
} from "./intent-packet";
