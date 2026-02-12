/**
 * 0xSCADA Agent Certification Framework
 * 
 * ADR-0010: Agent Certification Framework
 * 
 * Four-level certification system for industrial agentic systems:
 * - AC-1: Observer (read-only monitoring)
 * - AC-2: Advisor (recommendations, no direct control)
 * - AC-3: Operator (bounded control within envelope)
 * - AC-4: Autonomous (full autonomous within hard limits)
 * 
 * Certifications are recorded on-chain for transparency and immutability.
 * Recertification is required on code update, envelope change, safety
 * incident, 12-month expiry, new deployment site, or infra change.
 */

import { z } from "zod";

// =============================================================================
// CERTIFICATION LEVELS
// =============================================================================

export const CertificationLevel = {
  AC1_OBSERVER: "AC1_OBSERVER",
  AC2_ADVISOR: "AC2_ADVISOR",
  AC3_OPERATOR: "AC3_OPERATOR",
  AC4_AUTONOMOUS: "AC4_AUTONOMOUS",
} as const;

export type CertificationLevel = (typeof CertificationLevel)[keyof typeof CertificationLevel];

export const CERTIFICATION_LEVEL_ORDER: CertificationLevel[] = [
  CertificationLevel.AC1_OBSERVER,
  CertificationLevel.AC2_ADVISOR,
  CertificationLevel.AC3_OPERATOR,
  CertificationLevel.AC4_AUTONOMOUS,
];

export const CERTIFICATION_LEVEL_META: Record<CertificationLevel, {
  name: string;
  description: string;
  analogousSIL: string;
  analogousDAL: string;
}> = {
  [CertificationLevel.AC1_OBSERVER]: {
    name: "Observer",
    description: "Read-only monitoring, alerting, reporting",
    analogousSIL: "SIL 1",
    analogousDAL: "DAL D",
  },
  [CertificationLevel.AC2_ADVISOR]: {
    name: "Advisor",
    description: "Recommendations to operators, no direct control",
    analogousSIL: "SIL 1-2",
    analogousDAL: "DAL C",
  },
  [CertificationLevel.AC3_OPERATOR]: {
    name: "Operator",
    description: "Bounded control actions within operational envelope",
    analogousSIL: "SIL 2-3",
    analogousDAL: "DAL B",
  },
  [CertificationLevel.AC4_AUTONOMOUS]: {
    name: "Autonomous",
    description: "Full autonomous operation within hard limits",
    analogousSIL: "SIL 3",
    analogousDAL: "DAL A",
  },
};

// =============================================================================
// CERTIFICATION REQUIREMENTS
// =============================================================================

export const CertificationCheckStatus = {
  PASSED: "PASSED",
  FAILED: "FAILED",
  PENDING: "PENDING",
  NOT_APPLICABLE: "NOT_APPLICABLE",
} as const;

export type CertificationCheckStatus = (typeof CertificationCheckStatus)[keyof typeof CertificationCheckStatus];

export const certificationCheckSchema = z.object({
  /** Check identifier */
  id: z.string(),

  /** Human-readable description */
  description: z.string(),

  /** Which certification level this check applies to */
  requiredForLevel: z.enum(["AC1_OBSERVER", "AC2_ADVISOR", "AC3_OPERATOR", "AC4_AUTONOMOUS"]),

  /** Check status */
  status: z.enum(["PASSED", "FAILED", "PENDING", "NOT_APPLICABLE"]),

  /** Evidence hash (content-addressed test results, audit report, etc.) */
  evidenceHash: z.string().optional(),

  /** Who verified this check */
  verifiedBy: z.string().optional(),

  /** When the check was last evaluated */
  evaluatedAt: z.string().datetime().optional(),

  /** Notes */
  notes: z.string().optional(),
});

export type CertificationCheck = z.infer<typeof certificationCheckSchema>;

// =============================================================================
// CERTIFICATION REQUIREMENTS BY LEVEL
// =============================================================================

export interface LevelRequirement {
  id: string;
  description: string;
  category: "identity" | "capability" | "testing" | "operational" | "security" | "governance";
}

export const AC1_REQUIREMENTS: LevelRequirement[] = [
  { id: "ac1-identity", description: "Agent identity registered on-chain", category: "identity" },
  { id: "ac1-readonly", description: "Read-only capability tokens verified", category: "capability" },
  { id: "ac1-logging", description: "Logging and audit trail operational", category: "operational" },
  { id: "ac1-no-write", description: "No write access to any control system", category: "capability" },
  { id: "ac1-test-coverage", description: "Functional test suite passes (>95% observation path coverage)", category: "testing" },
];

export const AC2_REQUIREMENTS: LevelRequirement[] = [
  ...AC1_REQUIREMENTS,
  { id: "ac2-accuracy", description: "Recommendation accuracy validated (>90% correct vs historical)", category: "testing" },
  { id: "ac2-false-positive", description: "False positive rate below configurable threshold", category: "testing" },
  { id: "ac2-latency", description: "Recommendation latency within SLA (<5s non-critical, <500ms critical)", category: "operational" },
  { id: "ac2-hitl", description: "Human-in-the-loop confirmation flow verified", category: "governance" },
  { id: "ac2-override", description: "Operator override mechanism tested and documented", category: "governance" },
];

export const AC3_REQUIREMENTS: LevelRequirement[] = [
  ...AC2_REQUIREMENTS,
  { id: "ac3-envelope", description: "Operational envelope formally specified and verified", category: "operational" },
  { id: "ac3-trust-tier", description: "Trust tier T2+ achieved in staging environment", category: "operational" },
  { id: "ac3-safety-tests", description: "Safety function test suite passes (100% safety-critical paths)", category: "testing" },
  { id: "ac3-fmea", description: "Failure mode analysis documented (FMEA)", category: "testing" },
  { id: "ac3-estop", description: "Emergency stop response time verified (<100ms)", category: "testing" },
  { id: "ac3-rollback", description: "Rollback procedure tested for all control actions", category: "operational" },
  { id: "ac3-shadow", description: "30-day shadow-mode operation with zero safety deviations", category: "operational" },
];

export const AC4_REQUIREMENTS: LevelRequirement[] = [
  ...AC3_REQUIREMENTS,
  { id: "ac4-trust-tier", description: "Trust tier T3+ achieved in production environment", category: "operational" },
  { id: "ac4-security-audit", description: "Independent security audit passed (ADR-0008 compliance)", category: "security" },
  { id: "ac4-multi-agent", description: "Multi-agent interaction testing complete", category: "testing" },
  { id: "ac4-supervised-90d", description: "90-day supervised operation with zero safety deviations", category: "operational" },
  { id: "ac4-incident-plan", description: "Incident response plan documented and drilled", category: "governance" },
  { id: "ac4-insurance", description: "Insurance/liability review completed", category: "governance" },
  { id: "ac4-council", description: "Technical advisory council sign-off", category: "governance" },
];

export const REQUIREMENTS_BY_LEVEL: Record<CertificationLevel, LevelRequirement[]> = {
  [CertificationLevel.AC1_OBSERVER]: AC1_REQUIREMENTS,
  [CertificationLevel.AC2_ADVISOR]: AC2_REQUIREMENTS,
  [CertificationLevel.AC3_OPERATOR]: AC3_REQUIREMENTS,
  [CertificationLevel.AC4_AUTONOMOUS]: AC4_REQUIREMENTS,
};

// =============================================================================
// CERTIFICATION RECORD (On-Chain Compatible)
// =============================================================================

export const certificationRecordSchema = z.object({
  /** Unique certification ID */
  id: z.string().uuid(),

  /** Agent being certified */
  agentId: z.string(),

  /** Agent code version at time of certification */
  agentVersion: z.string(),

  /** Certification level */
  level: z.enum(["AC1_OBSERVER", "AC2_ADVISOR", "AC3_OPERATOR", "AC4_AUTONOMOUS"]),

  /** Hash of the complete test suite results */
  testSuiteHash: z.string(),

  /** Hash of the audit report */
  auditReportHash: z.string().optional(),

  /** Certifiers who signed off */
  certifiers: z.array(z.object({
    id: z.string(),
    name: z.string(),
    role: z.string(),
    signature: z.string(),
    signedAt: z.string().datetime(),
  })),

  /** Individual check results */
  checks: z.array(certificationCheckSchema),

  /** Overall status */
  status: z.enum(["IN_PROGRESS", "CERTIFIED", "FAILED", "EXPIRED", "REVOKED"]),

  /** Issued at */
  issuedAt: z.string().datetime().optional(),

  /** Expires at */
  expiresAt: z.string().datetime().optional(),

  /** Revoked flag */
  revoked: z.boolean().default(false),

  /** Revocation reason */
  revokedReason: z.string().optional(),

  /** On-chain anchor (if recorded) */
  onChainAnchor: z.object({
    txHash: z.string(),
    blockNumber: z.number().int(),
    contractAddress: z.string(),
    anchoredAt: z.string().datetime(),
  }).optional(),

  /** Metadata */
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type CertificationRecord = z.infer<typeof certificationRecordSchema>;

// =============================================================================
// RECERTIFICATION TRIGGERS
// =============================================================================

export const RecertificationTrigger = {
  CODE_UPDATE: "CODE_UPDATE",
  ENVELOPE_MODIFIED: "ENVELOPE_MODIFIED",
  SAFETY_INCIDENT: "SAFETY_INCIDENT",
  EXPIRY_12_MONTHS: "EXPIRY_12_MONTHS",
  NEW_DEPLOYMENT_SITE: "NEW_DEPLOYMENT_SITE",
  INFRASTRUCTURE_CHANGE: "INFRASTRUCTURE_CHANGE",
} as const;

export type RecertificationTrigger = (typeof RecertificationTrigger)[keyof typeof RecertificationTrigger];

// =============================================================================
// CERTIFICATION PROCESS STAGES
// =============================================================================

export const CertificationStage = {
  SUBMIT: "SUBMIT",
  REVIEW: "REVIEW",
  TEST: "TEST",
  AUDIT: "AUDIT",
  CERTIFY: "CERTIFY",
} as const;

export type CertificationStage = (typeof CertificationStage)[keyof typeof CertificationStage];
