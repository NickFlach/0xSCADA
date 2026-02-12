/**
 * 0xSCADA Operational Envelope & Trust Tier System
 * 
 * ADR-0009: Measured Emergence Guardrails for Autonomous Agents
 * 
 * Defines the constraint envelope system that formally bounds agent autonomy:
 * - Hard limits that agents CANNOT exceed
 * - Soft limits that agents CAN exceed with justification
 * - Escalation triggers that force M3: SAFE_HOLD
 * - Progressive trust tiers (T0-T4) with promotion/demotion
 * - Mode transition rules for the GhostOS Propagation Model
 */

import { z } from "zod";

// =============================================================================
// PROPAGATION MODES (GhostOS M1-M4)
// =============================================================================

export const PropagationMode = {
  M1_LOCAL_COHERENCE: "M1_LOCAL_COHERENCE",
  M2_REMOTE_COHERENCE: "M2_REMOTE_COHERENCE",
  M3_SAFE_HOLD: "M3_SAFE_HOLD",
  M4_EXPLORATION: "M4_EXPLORATION",
} as const;

export type PropagationMode = (typeof PropagationMode)[keyof typeof PropagationMode];

// =============================================================================
// TRUST TIERS (T0-T4)
// =============================================================================

export const TrustTier = {
  T0_PROBATIONARY: "T0_PROBATIONARY",
  T1_MONITORED: "T1_MONITORED",
  T2_SUPERVISED: "T2_SUPERVISED",
  T3_TRUSTED: "T3_TRUSTED",
  T4_AUTONOMOUS: "T4_AUTONOMOUS",
} as const;

export type TrustTier = (typeof TrustTier)[keyof typeof TrustTier];

export const TRUST_TIER_ORDER: TrustTier[] = [
  TrustTier.T0_PROBATIONARY,
  TrustTier.T1_MONITORED,
  TrustTier.T2_SUPERVISED,
  TrustTier.T3_TRUSTED,
  TrustTier.T4_AUTONOMOUS,
];

// =============================================================================
// TRUST TIER PROMOTION CRITERIA
// =============================================================================

export interface TierPromotionCriteria {
  /** Minimum clean operation duration in hours */
  minCleanOperationHours: number;
  /** Maximum anomalies allowed in the period */
  maxAnomalies: number;
  /** Whether an audit pass is required */
  requiresAuditPass: boolean;
  /** Whether a council review is required */
  requiresCouncilReview: boolean;
  /** Whether an incident response test is required */
  requiresIncidentResponseTest: boolean;
}

export const TIER_PROMOTION_CRITERIA: Record<TrustTier, TierPromotionCriteria | null> = {
  [TrustTier.T0_PROBATIONARY]: null, // Initial tier — no promotion from nowhere
  [TrustTier.T1_MONITORED]: {
    minCleanOperationHours: 72,
    maxAnomalies: 0,
    requiresAuditPass: false,
    requiresCouncilReview: false,
    requiresIncidentResponseTest: false,
  },
  [TrustTier.T2_SUPERVISED]: {
    minCleanOperationHours: 720, // 30 days
    maxAnomalies: 0,
    requiresAuditPass: true,
    requiresCouncilReview: false,
    requiresIncidentResponseTest: false,
  },
  [TrustTier.T3_TRUSTED]: {
    minCleanOperationHours: 2160, // 90 days
    maxAnomalies: 0,
    requiresAuditPass: true,
    requiresCouncilReview: false,
    requiresIncidentResponseTest: true,
  },
  [TrustTier.T4_AUTONOMOUS]: {
    minCleanOperationHours: 4320, // 180 days
    maxAnomalies: 0,
    requiresAuditPass: true,
    requiresCouncilReview: true,
    requiresIncidentResponseTest: true,
  },
};

// =============================================================================
// TIER ENVELOPE LIMITS
// =============================================================================

export interface TierEnvelopeLimits {
  /** Maximum setpoint change per action (percentage) */
  maxSetpointDeltaPercent: number;
  /** Whether human notification is required for any change */
  requiresHumanNotification: boolean;
  /** Threshold above which human approval is required (percentage) */
  humanApprovalThresholdPercent: number;
  /** Whether the agent can take autonomous control actions */
  canTakeControlActions: boolean;
  /** Description for display */
  description: string;
}

export const TIER_ENVELOPE_LIMITS: Record<TrustTier, TierEnvelopeLimits> = {
  [TrustTier.T0_PROBATIONARY]: {
    maxSetpointDeltaPercent: 0,
    requiresHumanNotification: false,
    humanApprovalThresholdPercent: 0,
    canTakeControlActions: false,
    description: "Read-only, no control actions",
  },
  [TrustTier.T1_MONITORED]: {
    maxSetpointDeltaPercent: 1,
    requiresHumanNotification: true,
    humanApprovalThresholdPercent: 0, // All changes need approval
    canTakeControlActions: true,
    description: "Setpoint adjustments ≤1%, human notification required",
  },
  [TrustTier.T2_SUPERVISED]: {
    maxSetpointDeltaPercent: 5,
    requiresHumanNotification: true,
    humanApprovalThresholdPercent: 2,
    canTakeControlActions: true,
    description: "Setpoint adjustments ≤5%, human approval for >2%",
  },
  [TrustTier.T3_TRUSTED]: {
    maxSetpointDeltaPercent: 10,
    requiresHumanNotification: false,
    humanApprovalThresholdPercent: 5,
    canTakeControlActions: true,
    description: "Setpoint adjustments ≤10%, autonomous for ≤5%",
  },
  [TrustTier.T4_AUTONOMOUS]: {
    maxSetpointDeltaPercent: 25,
    requiresHumanNotification: false,
    humanApprovalThresholdPercent: 10,
    canTakeControlActions: true,
    description: "Full envelope within hard limits",
  },
};

// =============================================================================
// OPERATIONAL ENVELOPE SCHEMA
// =============================================================================

export const operationalEnvelopeSchema = z.object({
  /** Envelope identifier */
  id: z.string(),

  /** Agent this envelope is bound to */
  agentId: z.string(),

  // --- Hard limits (agent CANNOT exceed) ---

  /** Max percentage change per action */
  maxSetpointDelta: z.number().min(0).max(100),

  /** Max actions per minute */
  maxActionsPerMinute: z.number().int().positive(),

  /** Assets the agent must never touch */
  forbiddenAssets: z.array(z.string()).default([]),

  /** Minimum human approvals required for any action */
  requiredApprovals: z.number().int().nonnegative().default(0),

  // --- Soft limits (agent CAN exceed with justification) ---

  /** Recommended max percentage change */
  recommendedSetpointDelta: z.number().min(0).max(100),

  /** Recommended minimum interval between actions (ms) */
  recommendedActionIntervalMs: z.number().int().nonnegative().default(5000),

  // --- Escalation triggers (force M3: SAFE_HOLD) ---

  /** Confidence threshold below which agent must escalate (0.0-1.0) */
  uncertaintyThreshold: z.number().min(0).max(1).default(0.6),

  /** Anomaly score limit before escalation */
  anomalyScoreLimit: z.number().min(0).default(3.0),

  /** Consecutive failures before halt */
  consecutiveFailureLimit: z.number().int().positive().default(3),

  // --- Metadata ---

  /** Current trust tier */
  trustTier: z.enum([
    "T0_PROBATIONARY",
    "T1_MONITORED",
    "T2_SUPERVISED",
    "T3_TRUSTED",
    "T4_AUTONOMOUS",
  ]),

  /** Current propagation mode */
  currentMode: z.enum([
    "M1_LOCAL_COHERENCE",
    "M2_REMOTE_COHERENCE",
    "M3_SAFE_HOLD",
    "M4_EXPLORATION",
  ]),

  /** Created at */
  createdAt: z.string().datetime(),

  /** Last updated */
  updatedAt: z.string().datetime(),
});

export type OperationalEnvelope = z.infer<typeof operationalEnvelopeSchema>;

// =============================================================================
// ENVELOPE CHECK RESULT
// =============================================================================

export const EnvelopeCheckResult = {
  PERMITTED: "PERMITTED",
  SOFT_LIMIT_EXCEEDED: "SOFT_LIMIT_EXCEEDED",
  HARD_LIMIT_VIOLATED: "HARD_LIMIT_VIOLATED",
  ESCALATION_TRIGGERED: "ESCALATION_TRIGGERED",
  FORBIDDEN_ASSET: "FORBIDDEN_ASSET",
  MODE_RESTRICTED: "MODE_RESTRICTED",
} as const;

export type EnvelopeCheckResult = (typeof EnvelopeCheckResult)[keyof typeof EnvelopeCheckResult];

export const envelopeCheckTraceSchema = z.object({
  /** Agent performing the action */
  agent: z.string(),

  /** Current propagation mode */
  mode: z.string(),

  /** Current trust tier */
  trustTier: z.string(),

  /** Action being checked */
  action: z.string(),

  /** Envelope check details */
  envelopeCheck: z.object({
    deltaRequested: z.number(),
    deltaAllowed: z.number(),
    confidence: z.number(),
    threshold: z.number(),
    result: z.enum([
      "PERMITTED",
      "SOFT_LIMIT_EXCEEDED",
      "HARD_LIMIT_VIOLATED",
      "ESCALATION_TRIGGERED",
      "FORBIDDEN_ASSET",
      "MODE_RESTRICTED",
    ]),
    justification: z.string().optional(),
  }),

  /** Timestamp */
  timestamp: z.string().datetime(),
});

export type EnvelopeCheckTrace = z.infer<typeof envelopeCheckTraceSchema>;

// =============================================================================
// MODE TRANSITION RULES
// =============================================================================

export interface ModeTransition {
  from: PropagationMode;
  to: PropagationMode;
  condition: string;
  requiresHumanApproval: boolean;
}

export const MODE_TRANSITIONS: ModeTransition[] = [
  // M1 → M2: Coordinating across sites
  {
    from: PropagationMode.M1_LOCAL_COHERENCE,
    to: PropagationMode.M2_REMOTE_COHERENCE,
    condition: "confidence > 0.8 AND cross-site coordination required",
    requiresHumanApproval: false,
  },
  // M2 → M1: Back to local after coordination
  {
    from: PropagationMode.M2_REMOTE_COHERENCE,
    to: PropagationMode.M1_LOCAL_COHERENCE,
    condition: "confidence > 0.9 AND coordination complete",
    requiresHumanApproval: false,
  },
  // M1/M2 → M3: Confidence drop or anomaly
  {
    from: PropagationMode.M1_LOCAL_COHERENCE,
    to: PropagationMode.M3_SAFE_HOLD,
    condition: "confidence < uncertaintyThreshold OR anomaly detected",
    requiresHumanApproval: false, // Automatic safety escalation
  },
  {
    from: PropagationMode.M2_REMOTE_COHERENCE,
    to: PropagationMode.M3_SAFE_HOLD,
    condition: "confidence < uncertaintyThreshold OR cross-site conflict",
    requiresHumanApproval: false, // Automatic safety escalation
  },
  // M3 → M1: Recovery after human acknowledgment
  {
    from: PropagationMode.M3_SAFE_HOLD,
    to: PropagationMode.M1_LOCAL_COHERENCE,
    condition: "human operator acknowledgment AND root cause logged",
    requiresHumanApproval: true,
  },
  // M4 → M3: Exploration must go through safe hold
  {
    from: PropagationMode.M4_EXPLORATION,
    to: PropagationMode.M3_SAFE_HOLD,
    condition: "exploration session ended OR timeout",
    requiresHumanApproval: false,
  },
  // M3 → M4: Only from safe hold with explicit approval
  {
    from: PropagationMode.M3_SAFE_HOLD,
    to: PropagationMode.M4_EXPLORATION,
    condition: "explicit human approval AND sandbox environment verified",
    requiresHumanApproval: true,
  },
];

// =============================================================================
// TIER DEMOTION TRIGGERS
// =============================================================================

export const TierDemotionTrigger = {
  SAFETY_ANOMALY: "SAFETY_ANOMALY",
  SOFT_LIMIT_EXCEEDED_WITHOUT_JUSTIFICATION: "SOFT_LIMIT_EXCEEDED_WITHOUT_JUSTIFICATION",
  FAILED_ATTESTATION: "FAILED_ATTESTATION",
  CAPABILITY_RENEWAL_FAILURE: "CAPABILITY_RENEWAL_FAILURE",
  OPERATOR_OVERRIDE: "OPERATOR_OVERRIDE",
  CONSECUTIVE_FAILURES: "CONSECUTIVE_FAILURES",
} as const;

export type TierDemotionTrigger = (typeof TierDemotionTrigger)[keyof typeof TierDemotionTrigger];
