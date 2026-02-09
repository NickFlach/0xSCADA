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
// EXPORTS FOR CONVENIENCE
// =============================================================================

export {
  PropagationMode,
  PropagationThresholds,
  DEFAULT_PROPAGATION_THRESHOLDS,
} from "./intent-packet";
