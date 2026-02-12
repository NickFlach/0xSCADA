/**
 * 0xSCADA Shared Types
 *
 * VERITY Architecture - Type Definitions
 */

// Agent Decision Types
export * from "./agent-decision";
export * from "./agent-decision-storage";

// Digital Twin Checkpoint Types
export * from "./twin-checkpoint";

// Time-Travel Reconstruction Types
export * from "./time-travel";

// GhostOS Propagation Model Types
export * from "./propagation";

// Operational Envelope & Trust Tier Types (ADR-0009)
// Note: PropagationMode is intentionally re-declared in operational-envelope.ts
// for self-contained usage. Import from this module via @shared/types/operational-envelope directly.
export {
  TrustTier,
  TRUST_TIER_ORDER,
  TierPromotionCriteria,
  TIER_PROMOTION_CRITERIA,
  TierEnvelopeLimits,
  TIER_ENVELOPE_LIMITS,
  OperationalEnvelope,
  operationalEnvelopeSchema,
  EnvelopeCheckResult,
  EnvelopeCheckTrace,
  envelopeCheckTraceSchema,
  ModeTransition,
  MODE_TRANSITIONS,
  TierDemotionTrigger,
} from "./operational-envelope";
