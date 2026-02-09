/**
 * 0xSCADA Intent Packet Types
 *
 * GhostOS Propagation Model - Intent Packet Schema
 * See docs/propagation-model.md for specification
 *
 * Issue: #163 - Intent Packet Schema & Validation
 * Epic: #161 - GhostOS Propagation Model
 */

import { z } from "zod";

// =============================================================================
// PROPAGATION MODES (docs/propagation-model.md Section 4)
// =============================================================================

export const PropagationMode = {
  LOCAL_COHERENCE: "LOCAL_COHERENCE",   // M1: High-confidence local actions
  REMOTE_COHERENCE: "REMOTE_COHERENCE", // M2: Distributed coordination
  SAFE_HOLD: "SAFE_HOLD",               // M3: Safety halt, human review
  EXPLORATION: "EXPLORATION",           // M4: Learning mode (non-critical)
} as const;

export type PropagationMode = (typeof PropagationMode)[keyof typeof PropagationMode];

export const propagationModeSchema = z.nativeEnum(PropagationMode);

// =============================================================================
// AUTHORITY LEVELS
// =============================================================================

export const AuthorityLevel = {
  VIEWER: "VIEWER",         // Read-only access
  OPERATOR: "OPERATOR",     // Routine operations
  ENGINEER: "ENGINEER",     // Configuration changes
  SUPERVISOR: "SUPERVISOR", // Critical operations
  ADMIN: "ADMIN",           // Full authority
} as const;

export type AuthorityLevel = (typeof AuthorityLevel)[keyof typeof AuthorityLevel];

export const authorityLevelSchema = z.nativeEnum(AuthorityLevel);

// Authority level ordering for comparison
export const AUTHORITY_ORDER: Record<AuthorityLevel, number> = {
  VIEWER: 0,
  OPERATOR: 1,
  ENGINEER: 2,
  SUPERVISOR: 3,
  ADMIN: 4,
};

// =============================================================================
// CRITICALITY LEVELS
// =============================================================================

export const CriticalityLevel = {
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
  CRITICAL: "CRITICAL",
} as const;

export type CriticalityLevel = (typeof CriticalityLevel)[keyof typeof CriticalityLevel];

export const criticalityLevelSchema = z.nativeEnum(CriticalityLevel);

// =============================================================================
// ASSET TYPES (aligned with existing schema)
// =============================================================================

export const AssetType = {
  MOTOR: "MOTOR",
  PUMP: "PUMP",
  VALVE: "VALVE",
  SENSOR: "SENSOR",
  PLC: "PLC",
  HMI: "HMI",
  RTU: "RTU",
  TANK: "TANK",
  REACTOR: "REACTOR",
  COMPRESSOR: "COMPRESSOR",
  HEAT_EXCHANGER: "HEAT_EXCHANGER",
  OTHER: "OTHER",
} as const;

export type AssetType = (typeof AssetType)[keyof typeof AssetType];

export const assetTypeSchema = z.nativeEnum(AssetType);

// =============================================================================
// TARGET SELECTOR (docs/propagation-model.md Section 5.2)
// =============================================================================

export const targetSelectorSchema = z.object({
  // Scope selection (at least one should be specified)
  allSites: z.boolean().optional(),
  siteIds: z.array(z.string()).optional(),
  allAssets: z.boolean().optional(),
  assetIds: z.array(z.string()).optional(),
  assetTypes: z.array(assetTypeSchema).optional(),
  agentIds: z.array(z.string().uuid()).optional(),

  // Filtering
  tags: z.array(z.string()).optional(),
  criticality: criticalityLevelSchema.optional(),
}).refine(
  (data) => {
    // At least one scope selector must be specified
    return (
      data.allSites ||
      (data.siteIds && data.siteIds.length > 0) ||
      data.allAssets ||
      (data.assetIds && data.assetIds.length > 0) ||
      (data.assetTypes && data.assetTypes.length > 0) ||
      (data.agentIds && data.agentIds.length > 0)
    );
  },
  {
    message: "At least one scope selector must be specified (allSites, siteIds, allAssets, assetIds, assetTypes, or agentIds)",
  }
);

export type TargetSelector = z.infer<typeof targetSelectorSchema>;

// =============================================================================
// CONSTRAINTS (docs/propagation-model.md Section 5.3)
// =============================================================================

export const ConstraintType = {
  MAX_IMPACT: "MAX_IMPACT",           // Maximum allowed impact score
  MAX_DURATION: "MAX_DURATION",       // Maximum execution time (ms)
  REQUIRE_QUORUM: "REQUIRE_QUORUM",   // Minimum agent agreement
  EXCLUDE_CRITICAL: "EXCLUDE_CRITICAL", // Skip critical assets
  TIME_WINDOW: "TIME_WINDOW",         // Execution time window
  CUSTOM: "CUSTOM",                   // Custom constraint
} as const;

export type ConstraintType = (typeof ConstraintType)[keyof typeof ConstraintType];

export const ConstraintEnforcement = {
  STRICT: "STRICT",     // Fail if constraint violated
  ADVISORY: "ADVISORY", // Warn but continue
} as const;

export type ConstraintEnforcement = (typeof ConstraintEnforcement)[keyof typeof ConstraintEnforcement];

export const constraintSchema = z.object({
  type: z.nativeEnum(ConstraintType),
  value: z.unknown(),
  enforcement: z.nativeEnum(ConstraintEnforcement),
  description: z.string().optional(),
});

export type Constraint = z.infer<typeof constraintSchema>;

// =============================================================================
// OBSERVABLES (docs/propagation-model.md Section 5.1)
// =============================================================================

export const ObservableType = {
  STATE_CHANGED: "STATE_CHANGED",
  EVENT_EMITTED: "EVENT_EMITTED",
  METRIC_THRESHOLD: "METRIC_THRESHOLD",
  SUMMARY_GENERATED: "SUMMARY_GENERATED",
  DEPLOYMENT_COMPLETE: "DEPLOYMENT_COMPLETE",
  HEALTH_CHECK_PASS: "HEALTH_CHECK_PASS",
  SETPOINT_CHANGED: "SETPOINT_CHANGED",
  CUSTOM: "CUSTOM",
} as const;

export type ObservableType = (typeof ObservableType)[keyof typeof ObservableType];

export const observableSchema = z.object({
  type: z.nativeEnum(ObservableType),
  target: z.string(),
  expectedValue: z.unknown().optional(),
  timeout: z.number().positive().optional(), // ms
});

export type Observable = z.infer<typeof observableSchema>;

// =============================================================================
// FALLBACK PLAN (docs/propagation-model.md Section 5.4)
// =============================================================================

export const FallbackStrategy = {
  ROLLBACK: "ROLLBACK",       // Undo changes
  COMPENSATE: "COMPENSATE",   // Apply compensating actions
  ESCALATE: "ESCALATE",       // Route to human
  ABORT: "ABORT",             // Stop with no action
} as const;

export type FallbackStrategy = (typeof FallbackStrategy)[keyof typeof FallbackStrategy];

export const fallbackActionSchema = z.object({
  type: z.string(),
  target: z.string(),
  params: z.record(z.unknown()).optional(),
});

export type FallbackAction = z.infer<typeof fallbackActionSchema>;

export const fallbackPlanSchema = z.object({
  strategy: z.nativeEnum(FallbackStrategy),
  compensation_actions: z.array(fallbackActionSchema).optional(),
  escalation_target: z.string().optional(),
  max_retries: z.number().int().min(0).max(10).optional(),
});

export type FallbackPlan = z.infer<typeof fallbackPlanSchema>;

// =============================================================================
// TELEMETRY HOOKS (docs/propagation-model.md Section 5.1)
// =============================================================================

export const TelemetryEvent = {
  PROPAGATION_START: "PROPAGATION_START",
  PROPAGATION_END: "PROPAGATION_END",
  MODE_SELECTED: "MODE_SELECTED",
  PHASE_COMPLETE: "PHASE_COMPLETE",
  CONSTRAINT_EVALUATED: "CONSTRAINT_EVALUATED",
  FALLBACK_TRIGGERED: "FALLBACK_TRIGGERED",
  CUSTOM: "CUSTOM",
} as const;

export type TelemetryEvent = (typeof TelemetryEvent)[keyof typeof TelemetryEvent];

export const telemetryHookSchema = z.object({
  event: z.nativeEnum(TelemetryEvent),
  metrics: z.array(z.string()).optional(),
  labels: z.record(z.string()).optional(),
});

export type TelemetryHook = z.infer<typeof telemetryHookSchema>;

// =============================================================================
// INTENT PACKET (docs/propagation-model.md Section 5)
// =============================================================================

export const intentPacketSchema = z.object({
  // Unique identifier for tracing
  intent_id: z.string().uuid(),

  // Target specification
  target_selector: targetSelectorSchema,

  // Requested propagation mode
  mode: propagationModeSchema,

  // Execution constraints
  constraints: z.array(constraintSchema).default([]),

  // Originator's confidence in intent validity (0.0 - 1.0)
  confidence: z.number().min(0).max(1),

  // Minimum authority level required to execute
  authority_required: authorityLevelSchema,

  // Time-to-live before automatic expiration (ms)
  ttl: z.number().int().positive().max(86400000), // Max 24 hours

  // Expected outcomes for validation
  expected_observables: z.array(observableSchema).default([]),

  // Actions if propagation fails
  fallback_plan: fallbackPlanSchema,

  // Custom telemetry emission points
  telemetry_hooks: z.array(telemetryHookSchema).default([]),

  // Optional metadata
  metadata: z.record(z.unknown()).optional(),

  // Originator information
  originator: z.object({
    agent_id: z.string().uuid().optional(),
    user_id: z.string().optional(),
    source: z.string(),
  }).optional(),

  // Timestamps
  created_at: z.string().datetime().optional(),
});

export type IntentPacket = z.infer<typeof intentPacketSchema>;

// =============================================================================
// INTENT PACKET CREATION HELPER
// =============================================================================

export const createIntentPacketSchema = intentPacketSchema.omit({
  intent_id: true,
  created_at: true,
}).extend({
  intent_id: z.string().uuid().optional(),
  created_at: z.string().datetime().optional(),
});

export type CreateIntentPacket = z.infer<typeof createIntentPacketSchema>;

// =============================================================================
// PROPAGATION RESULT (docs/propagation-model.md Section 7)
// =============================================================================

export const PropagationOutcome = {
  SUCCESS: "SUCCESS",
  FALLBACK: "FALLBACK",
  HELD: "HELD",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
} as const;

export type PropagationOutcome = (typeof PropagationOutcome)[keyof typeof PropagationOutcome];

export const propagationRationaleSchema = z.object({
  coupling: z.number().min(0).max(1),
  loss: z.number().min(0).max(1),
  effective_coupling: z.number().min(0).max(1),
  mode_selected: propagationModeSchema,
  mode_reason: z.string(),
  policy_flags: z.array(z.string()).default([]),
  constraints_evaluated: z.array(z.object({
    constraint_type: z.string(),
    satisfied: z.boolean(),
    value: z.unknown().optional(),
  })).default([]),
});

export type PropagationRationale = z.infer<typeof propagationRationaleSchema>;

export const propagationResultSchema = z.object({
  intent_id: z.string().uuid(),
  outcome: z.nativeEnum(PropagationOutcome),
  mode: propagationModeSchema,

  // Decision rationale
  rationale: propagationRationaleSchema,

  // Telemetry snapshot
  telemetry: z.object({
    duration_ms: z.number(),
    coupling: z.number(),
    loss: z.number(),
    coherence_before: z.number().optional(),
    coherence_after: z.number().optional(),
    impact_score: z.number().optional(),
  }),

  // Observable validation results
  observables: z.object({
    satisfied: z.boolean(),
    results: z.array(z.object({
      observable: observableSchema,
      satisfied: z.boolean(),
      actual_value: z.unknown().optional(),
      error: z.string().optional(),
    })),
  }).optional(),

  // For HELD outcomes
  escalation_id: z.string().uuid().optional(),
  evidence: z.unknown().optional(),

  // For REJECTED outcomes
  rejection_reason: z.string().optional(),
  validation_errors: z.array(z.object({
    path: z.array(z.string()),
    message: z.string(),
  })).optional(),

  // Timestamps
  started_at: z.string().datetime(),
  completed_at: z.string().datetime(),
});

export type PropagationResult = z.infer<typeof propagationResultSchema>;

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

export interface IntentPacketValidationError {
  field: string;
  message: string;
  code: string;
}

/**
 * Validate an Intent Packet and return actionable errors
 */
export function validateIntentPacket(data: unknown): {
  valid: boolean;
  data?: IntentPacket;
  errors?: IntentPacketValidationError[];
} {
  const result = intentPacketSchema.safeParse(data);

  if (result.success) {
    return { valid: true, data: result.data };
  }

  const errors: IntentPacketValidationError[] = result.error.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));

  return { valid: false, errors };
}

/**
 * Create a new Intent Packet with auto-generated ID and timestamp
 */
export function createIntentPacket(data: CreateIntentPacket): IntentPacket {
  return {
    ...data,
    intent_id: data.intent_id ?? crypto.randomUUID(),
    created_at: data.created_at ?? new Date().toISOString(),
    constraints: data.constraints ?? [],
    expected_observables: data.expected_observables ?? [],
    telemetry_hooks: data.telemetry_hooks ?? [],
  };
}

// =============================================================================
// PROPAGATION THRESHOLDS (docs/propagation-model.md Section 6.5)
// =============================================================================

export interface PropagationThresholds {
  d_local: number;              // Max distance for LOCAL_COHERENCE (default: 1)
  d_0: number;                  // Reference distance for loss normalization (default: 10)
  C_threshold_local: number;    // Min coupling for M1 (default: 0.8)
  C_threshold_remote: number;   // Min coupling for M2 (default: 0.5)
  L_threshold_local: number;    // Max loss for M1 (default: 0.2)
  L_threshold_remote: number;   // Max loss for M2 (default: 0.4)
}

export const DEFAULT_PROPAGATION_THRESHOLDS: PropagationThresholds = {
  d_local: 1,
  d_0: 10,
  C_threshold_local: 0.8,
  C_threshold_remote: 0.5,
  L_threshold_local: 0.2,
  L_threshold_remote: 0.4,
};

export const propagationThresholdsSchema = z.object({
  d_local: z.number().positive().default(1),
  d_0: z.number().positive().default(10),
  C_threshold_local: z.number().min(0).max(1).default(0.8),
  C_threshold_remote: z.number().min(0).max(1).default(0.5),
  L_threshold_local: z.number().min(0).max(1).default(0.2),
  L_threshold_remote: z.number().min(0).max(1).default(0.4),
});
