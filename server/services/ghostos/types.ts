/**
 * Public contracts for the ghostmagicOS (gmOS) coordination layer.
 *
 * ADR-0013 maps Signal -> Resonance -> Emergence onto the SCADA event
 * pipeline.  These types deliberately keep recommendations separate from
 * execution: coherence never grants authority.
 */

export interface Clock {
  now(): number;
}

export const systemClock: Clock = Object.freeze({
  now: () => Date.now(),
});

export type SignalType = "sensor" | "alarm" | "agent" | "operator";

export interface Signal {
  id: string;
  source: string;
  type: SignalType;
  value: number;
  timestamp: number;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface ResonancePattern {
  id: string;
  sourceIds: readonly [string, string];
  signalIds: readonly string[];
  strength: number;
  correlation: number;
  frequencyHz: number;
  phaseOffset: number;
  sampleCount: number;
  windowStart: number;
  windowEnd: number;
  detectedAt: number;
}

export interface AgentOscillator {
  agentId: string;
  /** Natural angular frequency, in radians per second. */
  naturalFrequency: number;
  /** Current phase, normalized into [0, 2pi). */
  phase: number;
  /** Relative influence of this agent in coordination telemetry. */
  amplitude: number;
  /** Per-agent multiplier applied to the global coupling strength. */
  couplingStrength: number;
  lastUpdate: number;
}

export interface SynchronizationState {
  /** Kuramoto order parameter: 0 means incoherent, 1 means phase aligned. */
  r: number;
  /** Circular mean phase in [0, 2pi). */
  psi: number;
}

export type EmergentActionKind =
  | "notify"
  | "workflow"
  | "configuration"
  | "control";

export interface EmergentAction {
  kind: EmergentActionKind;
  target: string;
  summary: string;
  payload?: Readonly<Record<string, unknown>>;
  /**
   * Required for control recommendations that alter a setpoint.  The
   * operational envelope compares its absolute value with the hard limit.
   */
  setpointDeltaPercent?: number;
}

export interface OperationalEnvelope {
  allowedActionKinds: readonly EmergentActionKind[];
  /** Exact targets or prefix globs ending in `*`. */
  allowedTargets: readonly string[];
  forbiddenTargets: readonly string[];
  minConfidence: number;
  minCoherence: number;
  maxSetpointDeltaPercent: number;
  maxDecisionAgeMs: number;
  maxExecutionsPerMinute: number;
  requiredApprovals: number;
  /** Notifications remain approval-gated unless this is explicitly enabled. */
  allowAutonomousNotifications: boolean;
}

export const DEFAULT_OPERATIONAL_ENVELOPE: Readonly<OperationalEnvelope> =
  Object.freeze({
    allowedActionKinds: Object.freeze(["notify"] as const),
    allowedTargets: Object.freeze([] as string[]),
    forbiddenTargets: Object.freeze(["*"] as string[]),
    minConfidence: 0.8,
    minCoherence: 0.7,
    maxSetpointDeltaPercent: 0,
    maxDecisionAgeMs: 5 * 60_000,
    maxExecutionsPerMinute: 0,
    requiredApprovals: 1,
    allowAutonomousNotifications: false,
  });

export type DecisionStatus =
  | "blocked"
  | "pending-approval"
  | "approved"
  | "executing"
  | "executed"
  | "rejected"
  | "failed"
  | "expired";

export interface EnvelopeCheck {
  permitted: boolean;
  reasons: readonly string[];
  evaluatedAt: number;
  coherence: number;
}

export interface HumanApproval {
  principalId: string;
  approvedAt: number;
  comment?: string;
  capabilityGrantId: string;
}

export interface EmergentDecision {
  id: string;
  patternId: string;
  agentId: string;
  action: EmergentAction;
  confidence: number;
  createdAt: number;
  status: DecisionStatus;
  requiredApprovals: number;
  approvals: readonly HumanApproval[];
  envelopeCheck: EnvelopeCheck;
  recommendationGrantId?: string;
  executionGrantId?: string;
  rejection?: {
    principalId: string;
    rejectedAt: number;
    reason: string;
  };
  executedAt?: number;
  result?: unknown;
  error?: string;
}

export interface AuthenticatedPrincipal {
  /** Server-derived identity; never accept this field from an HTTP body. */
  id: string;
  authenticated: true;
}

export interface CapabilityRequest {
  subjectId: string;
  capability: string;
  target: string;
  at: number;
}

export interface CapabilityAuthorization {
  authorized: boolean;
  reason?: string;
  grantId?: string;
}

export interface CapabilityAuthorizer {
  authorize(
    request: CapabilityRequest,
  ): CapabilityAuthorization | Promise<CapabilityAuthorization>;
}

export interface CapabilityGrant {
  id: string;
  subjectId: string;
  capabilities: readonly string[];
  scopes: readonly string[];
  issuedAt: number;
  expiresAt: number;
  revoked?: boolean;
}

export interface ActionExecutor {
  execute(decision: Readonly<EmergentDecision>): Promise<unknown>;
}

export interface GhostAuditEvent {
  sequence: number;
  timestamp: number;
  type:
    | "signal.accepted"
    | "signal.rejected"
    | "resonance.detected"
    | "agent.registered"
    | "coordination.stepped"
    | "decision.proposed"
    | "decision.blocked"
    | "decision.approved"
    | "decision.approval-denied"
    | "decision.expired"
    | "decision.rejected"
    | "decision.executing"
    | "decision.executed"
    | "decision.failed";
  agentId?: string;
  decisionId?: string;
  details: Readonly<Record<string, unknown>>;
}

export interface PipelineEventLike {
  timestamp: string;
  source_id: string;
  event_type: string;
  sequence_number: number;
  payload?: unknown;
  metadata?: Record<string, unknown>;
}

export interface PipelineEventSource {
  on(event: "event:processed", listener: (event: PipelineEventLike) => void): unknown;
  off(event: "event:processed", listener: (event: PipelineEventLike) => void): unknown;
}

export type PipelineSignalMapper = (event: PipelineEventLike) => Signal | null;
