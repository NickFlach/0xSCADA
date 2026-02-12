/**
 * 0xSCADA Operational Envelope Engine
 * 
 * ADR-0009: Measured Emergence Guardrails for Autonomous Agents
 * 
 * Enforces operational envelopes on agent actions:
 * - Hard/soft constraint checking
 * - Propagation mode transitions (M1-M4)
 * - Progressive trust tier management (T0-T4)
 * - Escalation to M3: SAFE_HOLD on constraint violations
 * - Observable traces for every constraint evaluation
 */

import { log, logError } from "../logger";
import type {
  OperationalEnvelope,
  EnvelopeCheckTrace,
  TrustTier,
  PropagationMode,
  TierDemotionTrigger,
} from "@shared/types/operational-envelope";
import {
  EnvelopeCheckResult,
  TRUST_TIER_ORDER,
  TIER_PROMOTION_CRITERIA,
  TIER_ENVELOPE_LIMITS,
  MODE_TRANSITIONS,
  TierDemotionTrigger as DemotionTriggers,
  PropagationMode as Modes,
  TrustTier as Tiers,
} from "@shared/types/operational-envelope";

// =============================================================================
// AGENT OPERATIONAL STATE
// =============================================================================

interface AgentOperationalState {
  /** The agent's operational envelope */
  envelope: OperationalEnvelope;

  /** Clean operation start time (reset on any anomaly) */
  cleanOperationSince: Date;

  /** Anomaly count in current evaluation period */
  anomalyCount: number;

  /** Consecutive failure count */
  consecutiveFailures: number;

  /** Last action timestamp */
  lastActionAt: Date | null;

  /** Actions in current minute window */
  actionsInWindow: number;

  /** Window start time */
  windowStart: Date;

  /** Audit-passed flag */
  auditPassed: boolean;

  /** Incident response test passed flag */
  incidentResponseTestPassed: boolean;

  /** Council review passed flag */
  councilReviewPassed: boolean;

  /** M4 exploration session details */
  explorationSession: {
    active: boolean;
    startedAt: Date | null;
    maxDurationMs: number; // 4 hours default
  };
}

// =============================================================================
// ENVELOPE ENGINE
// =============================================================================

export class EnvelopeEngine {
  private agentStates: Map<string, AgentOperationalState> = new Map();
  private traces: EnvelopeCheckTrace[] = [];
  private readonly maxTraceLog = 10000;

  // ==========================================================================
  // ENVELOPE REGISTRATION
  // ==========================================================================

  /**
   * Register an agent with an operational envelope
   */
  registerAgent(envelope: OperationalEnvelope): void {
    const state: AgentOperationalState = {
      envelope,
      cleanOperationSince: new Date(),
      anomalyCount: 0,
      consecutiveFailures: 0,
      lastActionAt: null,
      actionsInWindow: 0,
      windowStart: new Date(),
      auditPassed: false,
      incidentResponseTestPassed: false,
      councilReviewPassed: false,
      explorationSession: {
        active: false,
        startedAt: null,
        maxDurationMs: 4 * 60 * 60 * 1000, // 4 hours
      },
    };

    this.agentStates.set(envelope.agentId, state);
    log(`📐 Envelope registered: ${envelope.agentId} (${envelope.trustTier}, ${envelope.currentMode})`, "guardrails");
  }

  /**
   * Get an agent's current envelope
   */
  getEnvelope(agentId: string): OperationalEnvelope | undefined {
    return this.agentStates.get(agentId)?.envelope;
  }

  // ==========================================================================
  // CONSTRAINT CHECKING
  // ==========================================================================

  /**
   * Check if an agent action is within its operational envelope.
   * Returns a trace object for audit/observability.
   */
  checkAction(
    agentId: string,
    action: string,
    options: {
      setpointDeltaPercent?: number;
      targetAsset?: string;
      confidence?: number;
      anomalyScore?: number;
      justification?: string;
    } = {}
  ): { result: EnvelopeCheckTrace["envelopeCheck"]["result"]; trace: EnvelopeCheckTrace; requiresApproval: boolean } {
    const state = this.agentStates.get(agentId);
    if (!state) {
      const trace = this.buildTrace(agentId, "UNKNOWN", "UNKNOWN", action, {
        deltaRequested: options.setpointDeltaPercent ?? 0,
        deltaAllowed: 0,
        confidence: options.confidence ?? 0,
        threshold: 0,
        result: "HARD_LIMIT_VIOLATED" as const,
      });
      return { result: "HARD_LIMIT_VIOLATED", trace, requiresApproval: false };
    }

    const env = state.envelope;
    const confidence = options.confidence ?? 1.0;
    const delta = options.setpointDeltaPercent ?? 0;
    let requiresApproval = false;

    // 1. MODE CHECK: M3 SAFE_HOLD blocks all autonomous actions
    if (env.currentMode === Modes.M3_SAFE_HOLD) {
      const trace = this.buildTrace(agentId, env.currentMode, env.trustTier, action, {
        deltaRequested: delta,
        deltaAllowed: 0,
        confidence,
        threshold: env.uncertaintyThreshold,
        result: "MODE_RESTRICTED",
      });
      this.recordTrace(trace);
      return { result: "MODE_RESTRICTED", trace, requiresApproval: true };
    }

    // 2. MODE CHECK: M4 EXPLORATION only in sandbox
    if (env.currentMode === Modes.M4_EXPLORATION) {
      if (!state.explorationSession.active) {
        const trace = this.buildTrace(agentId, env.currentMode, env.trustTier, action, {
          deltaRequested: delta,
          deltaAllowed: 0,
          confidence,
          threshold: env.uncertaintyThreshold,
          result: "MODE_RESTRICTED",
        });
        this.recordTrace(trace);
        return { result: "MODE_RESTRICTED", trace, requiresApproval: true };
      }

      // Check exploration session timeout
      if (state.explorationSession.startedAt) {
        const elapsed = Date.now() - state.explorationSession.startedAt.getTime();
        if (elapsed > state.explorationSession.maxDurationMs) {
          this.transitionMode(agentId, Modes.M3_SAFE_HOLD, "Exploration session timeout");
          const trace = this.buildTrace(agentId, Modes.M3_SAFE_HOLD, env.trustTier, action, {
            deltaRequested: delta,
            deltaAllowed: 0,
            confidence,
            threshold: env.uncertaintyThreshold,
            result: "MODE_RESTRICTED",
          });
          this.recordTrace(trace);
          return { result: "MODE_RESTRICTED", trace, requiresApproval: true };
        }
      }
    }

    // 3. FORBIDDEN ASSET CHECK
    if (options.targetAsset && env.forbiddenAssets.includes(options.targetAsset)) {
      const trace = this.buildTrace(agentId, env.currentMode, env.trustTier, action, {
        deltaRequested: delta,
        deltaAllowed: 0,
        confidence,
        threshold: env.uncertaintyThreshold,
        result: "FORBIDDEN_ASSET",
      });
      this.recordTrace(trace);
      return { result: "FORBIDDEN_ASSET", trace, requiresApproval: false };
    }

    // 4. ESCALATION TRIGGERS → M3: SAFE_HOLD
    if (confidence < env.uncertaintyThreshold) {
      this.transitionMode(agentId, Modes.M3_SAFE_HOLD, `Confidence ${confidence} < threshold ${env.uncertaintyThreshold}`);
      const trace = this.buildTrace(agentId, Modes.M3_SAFE_HOLD, env.trustTier, action, {
        deltaRequested: delta,
        deltaAllowed: env.maxSetpointDelta,
        confidence,
        threshold: env.uncertaintyThreshold,
        result: "ESCALATION_TRIGGERED",
      });
      this.recordTrace(trace);
      return { result: "ESCALATION_TRIGGERED", trace, requiresApproval: true };
    }

    if (options.anomalyScore !== undefined && options.anomalyScore > env.anomalyScoreLimit) {
      this.transitionMode(agentId, Modes.M3_SAFE_HOLD, `Anomaly score ${options.anomalyScore} > limit ${env.anomalyScoreLimit}`);
      const trace = this.buildTrace(agentId, Modes.M3_SAFE_HOLD, env.trustTier, action, {
        deltaRequested: delta,
        deltaAllowed: env.maxSetpointDelta,
        confidence,
        threshold: env.uncertaintyThreshold,
        result: "ESCALATION_TRIGGERED",
      });
      this.recordTrace(trace);
      return { result: "ESCALATION_TRIGGERED", trace, requiresApproval: true };
    }

    // 5. HARD LIMIT CHECK
    if (delta > env.maxSetpointDelta) {
      const trace = this.buildTrace(agentId, env.currentMode, env.trustTier, action, {
        deltaRequested: delta,
        deltaAllowed: env.maxSetpointDelta,
        confidence,
        threshold: env.uncertaintyThreshold,
        result: "HARD_LIMIT_VIOLATED",
      });
      this.recordTrace(trace);
      state.consecutiveFailures++;

      if (state.consecutiveFailures >= env.consecutiveFailureLimit) {
        this.transitionMode(agentId, Modes.M3_SAFE_HOLD, `${state.consecutiveFailures} consecutive failures`);
      }

      return { result: "HARD_LIMIT_VIOLATED", trace, requiresApproval: false };
    }

    // 6. SOFT LIMIT CHECK
    if (delta > env.recommendedSetpointDelta) {
      if (!options.justification) {
        const trace = this.buildTrace(agentId, env.currentMode, env.trustTier, action, {
          deltaRequested: delta,
          deltaAllowed: env.maxSetpointDelta,
          confidence,
          threshold: env.uncertaintyThreshold,
          result: "SOFT_LIMIT_EXCEEDED",
          justification: "No justification provided",
        });
        this.recordTrace(trace);
        return { result: "SOFT_LIMIT_EXCEEDED", trace, requiresApproval: true };
      }

      // Soft limit exceeded WITH justification: log and allow
      requiresApproval = true;
    }

    // 7. RATE LIMIT CHECK
    const now = new Date();
    if (now.getTime() - state.windowStart.getTime() > 60_000) {
      state.actionsInWindow = 0;
      state.windowStart = now;
    }
    state.actionsInWindow++;

    if (state.actionsInWindow > env.maxActionsPerMinute) {
      const trace = this.buildTrace(agentId, env.currentMode, env.trustTier, action, {
        deltaRequested: delta,
        deltaAllowed: env.maxSetpointDelta,
        confidence,
        threshold: env.uncertaintyThreshold,
        result: "HARD_LIMIT_VIOLATED",
      });
      this.recordTrace(trace);
      return { result: "HARD_LIMIT_VIOLATED", trace, requiresApproval: false };
    }

    // 8. TIER-BASED APPROVAL CHECK
    const tierLimits = TIER_ENVELOPE_LIMITS[env.trustTier as TrustTier];
    if (tierLimits) {
      if (!tierLimits.canTakeControlActions && delta > 0) {
        const trace = this.buildTrace(agentId, env.currentMode, env.trustTier, action, {
          deltaRequested: delta,
          deltaAllowed: 0,
          confidence,
          threshold: env.uncertaintyThreshold,
          result: "HARD_LIMIT_VIOLATED",
        });
        this.recordTrace(trace);
        return { result: "HARD_LIMIT_VIOLATED", trace, requiresApproval: false };
      }

      if (delta > tierLimits.humanApprovalThresholdPercent) {
        requiresApproval = true;
      }
    }

    // 9. PERMITTED
    state.consecutiveFailures = 0; // Reset on success
    state.lastActionAt = now;

    const trace = this.buildTrace(agentId, env.currentMode, env.trustTier, action, {
      deltaRequested: delta,
      deltaAllowed: env.maxSetpointDelta,
      confidence,
      threshold: env.uncertaintyThreshold,
      result: "PERMITTED",
      justification: options.justification,
    });
    this.recordTrace(trace);

    return { result: "PERMITTED", trace, requiresApproval };
  }

  // ==========================================================================
  // MODE TRANSITIONS
  // ==========================================================================

  /**
   * Transition an agent's propagation mode
   */
  transitionMode(agentId: string, targetMode: PropagationMode, reason: string): boolean {
    const state = this.agentStates.get(agentId);
    if (!state) return false;

    const currentMode = state.envelope.currentMode as PropagationMode;
    if (currentMode === targetMode) return true;

    // Validate transition is allowed
    const transition = MODE_TRANSITIONS.find(
      (t) => t.from === currentMode && t.to === targetMode
    );

    if (!transition) {
      logError(
        `Mode transition denied: ${currentMode} → ${targetMode} for ${agentId} (no valid transition)`,
        null,
        "guardrails"
      );
      return false;
    }

    state.envelope.currentMode = targetMode;
    state.envelope.updatedAt = new Date().toISOString();

    // Handle exploration session state
    if (targetMode === Modes.M4_EXPLORATION) {
      state.explorationSession.active = true;
      state.explorationSession.startedAt = new Date();
    } else if (currentMode === Modes.M4_EXPLORATION) {
      state.explorationSession.active = false;
      state.explorationSession.startedAt = null;
    }

    log(
      `🔄 Mode transition: ${agentId} ${currentMode} → ${targetMode} (${reason})`,
      "guardrails"
    );

    return true;
  }

  // ==========================================================================
  // TRUST TIER MANAGEMENT
  // ==========================================================================

  /**
   * Attempt to promote an agent to the next trust tier
   */
  promoteTier(agentId: string): { promoted: boolean; newTier?: TrustTier; reason?: string } {
    const state = this.agentStates.get(agentId);
    if (!state) return { promoted: false, reason: "Agent not found" };

    const currentTier = state.envelope.trustTier as TrustTier;
    const currentIndex = TRUST_TIER_ORDER.indexOf(currentTier);

    if (currentIndex >= TRUST_TIER_ORDER.length - 1) {
      return { promoted: false, reason: "Already at maximum trust tier" };
    }

    const nextTier = TRUST_TIER_ORDER[currentIndex + 1];
    const criteria = TIER_PROMOTION_CRITERIA[nextTier];
    if (!criteria) {
      return { promoted: false, reason: "No promotion criteria defined" };
    }

    // Check clean operation hours
    const cleanHours = (Date.now() - state.cleanOperationSince.getTime()) / (1000 * 60 * 60);
    if (cleanHours < criteria.minCleanOperationHours) {
      return {
        promoted: false,
        reason: `Need ${criteria.minCleanOperationHours}h clean operation, have ${Math.floor(cleanHours)}h`,
      };
    }

    // Check anomaly count
    if (state.anomalyCount > criteria.maxAnomalies) {
      return {
        promoted: false,
        reason: `${state.anomalyCount} anomalies in period, max ${criteria.maxAnomalies}`,
      };
    }

    // Check audit
    if (criteria.requiresAuditPass && !state.auditPassed) {
      return { promoted: false, reason: "Audit pass required" };
    }

    // Check incident response test
    if (criteria.requiresIncidentResponseTest && !state.incidentResponseTestPassed) {
      return { promoted: false, reason: "Incident response test required" };
    }

    // Check council review
    if (criteria.requiresCouncilReview && !state.councilReviewPassed) {
      return { promoted: false, reason: "Council review required" };
    }

    // Promote
    state.envelope.trustTier = nextTier;
    state.envelope.updatedAt = new Date().toISOString();

    // Update envelope limits based on new tier
    const tierLimits = TIER_ENVELOPE_LIMITS[nextTier];
    if (tierLimits) {
      state.envelope.maxSetpointDelta = tierLimits.maxSetpointDeltaPercent;
      state.envelope.recommendedSetpointDelta = tierLimits.humanApprovalThresholdPercent;
    }

    log(`⬆️ Trust tier promoted: ${agentId} ${currentTier} → ${nextTier}`, "guardrails");

    return { promoted: true, newTier: nextTier };
  }

  /**
   * Demote an agent's trust tier (immediate, to T0)
   */
  demoteTier(agentId: string, trigger: TierDemotionTrigger): { demoted: boolean; newTier?: TrustTier } {
    const state = this.agentStates.get(agentId);
    if (!state) return { demoted: false };

    const oldTier = state.envelope.trustTier;

    // Demotion is always to T0_PROBATIONARY
    state.envelope.trustTier = Tiers.T0_PROBATIONARY;
    state.envelope.maxSetpointDelta = 0;
    state.envelope.recommendedSetpointDelta = 0;
    state.envelope.updatedAt = new Date().toISOString();

    // Reset clean operation tracking
    state.cleanOperationSince = new Date();
    state.anomalyCount = 0;
    state.auditPassed = false;
    state.incidentResponseTestPassed = false;
    state.councilReviewPassed = false;

    // Force M3: SAFE_HOLD
    this.transitionMode(agentId, Modes.M3_SAFE_HOLD, `Tier demotion: ${trigger}`);

    log(
      `⬇️ Trust tier demoted: ${agentId} ${oldTier} → T0_PROBATIONARY (trigger: ${trigger})`,
      "guardrails"
    );

    return { demoted: true, newTier: Tiers.T0_PROBATIONARY };
  }

  /**
   * Record an anomaly for an agent (may trigger demotion)
   */
  recordAnomaly(agentId: string, description: string, isSafetyRelated: boolean): void {
    const state = this.agentStates.get(agentId);
    if (!state) return;

    state.anomalyCount++;
    state.cleanOperationSince = new Date(); // Reset clean operation clock

    if (isSafetyRelated) {
      this.demoteTier(agentId, DemotionTriggers.SAFETY_ANOMALY);
    }

    log(`⚠️ Anomaly recorded for ${agentId}: ${description} (safety: ${isSafetyRelated})`, "guardrails");
  }

  // ==========================================================================
  // EXTERNAL STATE UPDATES
  // ==========================================================================

  /**
   * Record that an agent passed an audit
   */
  recordAuditPass(agentId: string): void {
    const state = this.agentStates.get(agentId);
    if (state) state.auditPassed = true;
  }

  /**
   * Record that an agent passed an incident response test
   */
  recordIncidentResponseTestPass(agentId: string): void {
    const state = this.agentStates.get(agentId);
    if (state) state.incidentResponseTestPassed = true;
  }

  /**
   * Record that an agent passed a council review
   */
  recordCouncilReviewPass(agentId: string): void {
    const state = this.agentStates.get(agentId);
    if (state) state.councilReviewPassed = true;
  }

  // ==========================================================================
  // QUERY & OBSERVABILITY
  // ==========================================================================

  /**
   * Get recent traces for an agent
   */
  getTraces(agentId?: string, limit: number = 100): EnvelopeCheckTrace[] {
    let result = this.traces;
    if (agentId) {
      result = result.filter((t) => t.agent === agentId);
    }
    return result.slice(-limit);
  }

  /**
   * Get agent operational state summary
   */
  getAgentState(agentId: string): {
    trustTier: string;
    mode: string;
    cleanHours: number;
    anomalyCount: number;
    consecutiveFailures: number;
  } | null {
    const state = this.agentStates.get(agentId);
    if (!state) return null;

    return {
      trustTier: state.envelope.trustTier,
      mode: state.envelope.currentMode,
      cleanHours: Math.floor((Date.now() - state.cleanOperationSince.getTime()) / (1000 * 60 * 60)),
      anomalyCount: state.anomalyCount,
      consecutiveFailures: state.consecutiveFailures,
    };
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  private buildTrace(
    agent: string,
    mode: string,
    trustTier: string,
    action: string,
    check: EnvelopeCheckTrace["envelopeCheck"]
  ): EnvelopeCheckTrace {
    return {
      agent,
      mode,
      trustTier,
      action,
      envelopeCheck: check,
      timestamp: new Date().toISOString(),
    };
  }

  private recordTrace(trace: EnvelopeCheckTrace): void {
    this.traces.push(trace);
    if (this.traces.length > this.maxTraceLog) {
      this.traces = this.traces.slice(-Math.floor(this.maxTraceLog / 2));
    }
  }
}

// =============================================================================
// SINGLETON
// =============================================================================

let engineInstance: EnvelopeEngine | null = null;

export function getEnvelopeEngine(): EnvelopeEngine {
  if (!engineInstance) {
    engineInstance = new EnvelopeEngine();
  }
  return engineInstance;
}

export function initEnvelopeEngine(): EnvelopeEngine {
  engineInstance = new EnvelopeEngine();
  return engineInstance;
}
