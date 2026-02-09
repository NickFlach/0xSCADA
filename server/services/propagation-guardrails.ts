/**
 * Propagation Guardrails Service
 *
 * GhostOS Propagation Model - SAFE_HOLD Guardrails & Human Escalation
 * See docs/propagation-model.md Section 9 for specification
 *
 * Issue: #165 - SAFE_HOLD Guardrails & Human Escalation
 * Epic: #161 - GhostOS Propagation Model
 *
 * Safety Invariants (from spec):
 * 1. SAFE_HOLD is triggered when coupling < threshold OR loss > threshold
 * 2. Critical assets require explicit human approval for modifications
 * 3. Propagation never bypasses SAFE_HOLD once triggered
 */

import {
  IntentPacket,
  PropagationMode,
  AuthorityLevel,
  AUTHORITY_ORDER,
  CriticalityLevel,
} from "../../shared/types/intent-packet";

import {
  ModeSelectionContext,
  ModeSelectionResult,
  PolicyFlag,
  RiskLevel,
  EscalationStatus,
  SafeHoldEvidence,
  SafeHoldFactor,
  EscalationRequest,
  EscalationResponse,
  EscalationAction,
  GuardrailResult,
  GuardrailCheck,
  GuardrailConfig,
  DEFAULT_GUARDRAIL_CONFIG,
  DEFAULT_PROPAGATION_THRESHOLDS,
} from "../../shared/types/propagation";

// =============================================================================
// GUARDRAIL DEFINITIONS
// =============================================================================

interface Guardrail {
  name: string;
  description: string;
  blocking: boolean;
  check: (context: ModeSelectionContext, config: GuardrailConfig) => GuardrailCheck;
}

const AUTHORITY_GUARDRAIL: Guardrail = {
  name: "authority",
  description: "Verifies agent has sufficient authority for the operation",
  blocking: true,
  check: (context) => ({
    guardrail: "authority",
    passed: context.hasAuthority,
    reason: context.hasAuthority
      ? "Agent has sufficient authority"
      : "Agent authority insufficient for requested operation",
    blocking: true,
    riskIfFailed: RiskLevel.HIGH,
  }),
};

const COUPLING_GUARDRAIL: Guardrail = {
  name: "coupling",
  description: "Verifies coupling score meets minimum threshold",
  blocking: true,
  check: (context) => {
    const threshold = DEFAULT_PROPAGATION_THRESHOLDS.C_threshold_remote;
    const passed = context.coupling >= threshold;
    return {
      guardrail: "coupling",
      passed,
      reason: passed
        ? `Coupling ${context.coupling.toFixed(2)} >= ${threshold}`
        : `Coupling ${context.coupling.toFixed(2)} below threshold ${threshold}`,
      blocking: true,
      riskIfFailed: RiskLevel.MEDIUM,
    };
  },
};

const LOSS_GUARDRAIL: Guardrail = {
  name: "loss",
  description: "Verifies loss score is within acceptable limits",
  blocking: true,
  check: (context) => {
    const threshold = DEFAULT_PROPAGATION_THRESHOLDS.L_threshold_remote;
    const passed = context.loss <= threshold;
    return {
      guardrail: "loss",
      passed,
      reason: passed
        ? `Loss ${context.loss.toFixed(2)} <= ${threshold}`
        : `Loss ${context.loss.toFixed(2)} exceeds threshold ${threshold}`,
      blocking: true,
      riskIfFailed: RiskLevel.MEDIUM,
    };
  },
};

const CRITICAL_TARGET_GUARDRAIL: Guardrail = {
  name: "critical_target",
  description: "Blocks non-approved operations on critical assets",
  blocking: true,
  check: (context) => {
    // Critical targets require explicit approval for non-read operations
    const isExploration = context.packet.mode === PropagationMode.EXPLORATION;
    const passed = !context.targetsCritical || !isExploration;
    return {
      guardrail: "critical_target",
      passed,
      reason: passed
        ? "Target criticality check passed"
        : "Cannot perform exploration on critical targets",
      blocking: true,
      riskIfFailed: RiskLevel.CRITICAL,
    };
  },
};

const CONFIDENCE_GUARDRAIL: Guardrail = {
  name: "confidence",
  description: "Warns on low confidence intents",
  blocking: false, // Advisory only
  check: (context) => {
    const threshold = 0.5;
    const passed = context.packet.confidence >= threshold;
    return {
      guardrail: "confidence",
      passed,
      reason: passed
        ? `Confidence ${context.packet.confidence.toFixed(2)} is acceptable`
        : `Low confidence ${context.packet.confidence.toFixed(2)} - consider review`,
      blocking: false,
      riskIfFailed: RiskLevel.LOW,
    };
  },
};

const POLICY_FLAGS_GUARDRAIL: Guardrail = {
  name: "policy_flags",
  description: "Checks for blocking policy flags",
  blocking: true,
  check: (context) => {
    const blockingFlags = [
      PolicyFlag.MANUAL_SAFE_HOLD,
      PolicyFlag.AUTHORITY_EXCEEDED,
    ];
    const hasBlockingFlag = context.policyFlags.some((f) =>
      blockingFlags.includes(f)
    );
    return {
      guardrail: "policy_flags",
      passed: !hasBlockingFlag,
      reason: hasBlockingFlag
        ? `Blocking policy flag detected: ${context.policyFlags.join(", ")}`
        : "No blocking policy flags",
      blocking: true,
      riskIfFailed: RiskLevel.HIGH,
    };
  },
};

const ALL_GUARDRAILS: Guardrail[] = [
  AUTHORITY_GUARDRAIL,
  COUPLING_GUARDRAIL,
  LOSS_GUARDRAIL,
  CRITICAL_TARGET_GUARDRAIL,
  CONFIDENCE_GUARDRAIL,
  POLICY_FLAGS_GUARDRAIL,
];

// =============================================================================
// GUARDRAILS SERVICE
// =============================================================================

export class PropagationGuardrails {
  private config: GuardrailConfig;
  private pendingEscalations: Map<string, EscalationRequest> = new Map();
  private escalationResponses: Map<string, EscalationResponse> = new Map();

  constructor(config: Partial<GuardrailConfig> = {}) {
    this.config = { ...DEFAULT_GUARDRAIL_CONFIG, ...config };
  }

  /**
   * Evaluate all guardrails for an intent
   * This is the primary entry point for SAFE_HOLD decision
   */
  evaluate(context: ModeSelectionContext): GuardrailResult {
    const startTime = Date.now();
    const checksPerformed: GuardrailCheck[] = [];

    // Run all enabled guardrails
    for (const guardrail of ALL_GUARDRAILS) {
      if (this.config.enabledGuardrails.includes(guardrail.name)) {
        const check = guardrail.check(context, this.config);
        checksPerformed.push(check);
      }
    }

    // Determine if any blocking guardrail failed
    const blockingFailures = checksPerformed.filter(
      (c) => c.blocking && !c.passed
    );

    const passed = blockingFailures.length === 0;
    const processingTimeMs = Date.now() - startTime;

    if (passed) {
      return {
        passed: true,
        checksPerformed,
        processingTimeMs,
      };
    }

    // Build evidence and escalation for blocked intent
    const evidence = this.captureEvidence(context, checksPerformed);
    const escalation = this.createEscalation(evidence, context);

    return {
      passed: false,
      evidence,
      escalation,
      checksPerformed,
      processingTimeMs,
    };
  }

  /**
   * Capture comprehensive evidence when SAFE_HOLD is triggered
   */
  captureEvidence(
    context: ModeSelectionContext,
    checks: GuardrailCheck[]
  ): SafeHoldEvidence {
    const failedChecks = checks.filter((c) => !c.passed);
    const factors: SafeHoldFactor[] = failedChecks.map((check) => ({
      type: check.guardrail,
      description: check.reason,
      severity: check.riskIfFailed || RiskLevel.MEDIUM,
    }));

    // Add context-based factors
    if (context.coupling < DEFAULT_PROPAGATION_THRESHOLDS.C_threshold_remote) {
      factors.push({
        type: PolicyFlag.LOW_CONFIDENCE,
        description: `Low coupling score: ${context.coupling.toFixed(3)}`,
        severity: RiskLevel.MEDIUM,
        value: context.coupling,
        threshold: DEFAULT_PROPAGATION_THRESHOLDS.C_threshold_remote,
      });
    }

    if (context.loss > DEFAULT_PROPAGATION_THRESHOLDS.L_threshold_remote) {
      factors.push({
        type: PolicyFlag.HIGH_LOSS,
        description: `High loss score: ${context.loss.toFixed(3)}`,
        severity: RiskLevel.MEDIUM,
        value: context.loss,
        threshold: DEFAULT_PROPAGATION_THRESHOLDS.L_threshold_remote,
      });
    }

    // Determine overall risk level
    const riskLevel = this.calculateRiskLevel(factors);

    // Find primary reason
    const primaryReason =
      failedChecks.length > 0
        ? failedChecks[0].reason
        : "SAFE_HOLD triggered due to policy constraints";

    const effectiveCoupling = context.coupling * (1 - context.loss);

    return {
      evidenceId: crypto.randomUUID(),
      intentId: context.packet.intent_id,
      triggeredAt: new Date().toISOString(),
      primaryReason,
      factors,
      context: {
        coupling: context.coupling,
        loss: context.loss,
        effectiveCoupling,
        distance: context.distance,
        targetsCritical: context.targetsCritical,
        hasAuthority: context.hasAuthority,
      },
      activeFlags: context.policyFlags,
      riskLevel,
      intentSnapshot: context.packet,
    };
  }

  /**
   * Create an escalation request for human approval
   */
  createEscalation(
    evidence: SafeHoldEvidence,
    context: ModeSelectionContext
  ): EscalationRequest {
    const escalationId = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.escalationTimeoutMs);

    // Determine escalation target
    const escalationTarget =
      context.packet.fallback_plan.escalation_target ||
      this.config.defaultEscalationTarget;

    // Build suggested actions
    const suggestedActions = this.buildSuggestedActions(evidence, context);

    // Build approver context
    const approverContext = this.buildApproverContext(evidence, context);

    const escalation: EscalationRequest = {
      escalationId,
      evidence,
      escalationTarget,
      priority: evidence.riskLevel,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: EscalationStatus.PENDING,
      suggestedActions,
      approverContext,
    };

    // Store pending escalation
    this.pendingEscalations.set(escalationId, escalation);

    return escalation;
  }

  /**
   * Process a response to an escalation request
   */
  processEscalationResponse(response: EscalationResponse): {
    accepted: boolean;
    reason: string;
    updatedEscalation?: EscalationRequest;
  } {
    const escalation = this.pendingEscalations.get(response.escalationId);

    if (!escalation) {
      return {
        accepted: false,
        reason: "Escalation not found or already processed",
      };
    }

    // Check if expired
    if (new Date(escalation.expiresAt) < new Date()) {
      escalation.status = EscalationStatus.EXPIRED;
      this.pendingEscalations.delete(response.escalationId);
      return {
        accepted: false,
        reason: "Escalation has expired",
        updatedEscalation: escalation,
      };
    }

    // Verify responder authority
    const authorityCheck = this.verifyResponderAuthority(response);
    if (!authorityCheck.valid) {
      return {
        accepted: false,
        reason: authorityCheck.reason,
      };
    }

    // Update escalation status
    escalation.status = response.approved
      ? EscalationStatus.APPROVED
      : EscalationStatus.REJECTED;

    // Store response
    this.escalationResponses.set(response.escalationId, response);

    // Remove from pending
    this.pendingEscalations.delete(response.escalationId);

    return {
      accepted: true,
      reason: response.approved
        ? "Escalation approved"
        : "Escalation rejected",
      updatedEscalation: escalation,
    };
  }

  /**
   * Check if an intent can proceed after escalation approval
   */
  canProceedAfterApproval(escalationId: string): {
    canProceed: boolean;
    reason: string;
  } {
    const response = this.escalationResponses.get(escalationId);

    if (!response) {
      return {
        canProceed: false,
        reason: "No approval response found for escalation",
      };
    }

    if (!response.approved) {
      return {
        canProceed: false,
        reason: `Escalation was rejected: ${response.comment || "No reason provided"}`,
      };
    }

    return {
      canProceed: true,
      reason: "Escalation approved - intent may proceed",
    };
  }

  /**
   * Get a pending escalation by ID
   */
  getPendingEscalation(escalationId: string): EscalationRequest | undefined {
    return this.pendingEscalations.get(escalationId);
  }

  /**
   * Get all pending escalations
   */
  getAllPendingEscalations(): EscalationRequest[] {
    return Array.from(this.pendingEscalations.values());
  }

  /**
   * Cancel a pending escalation
   */
  cancelEscalation(escalationId: string): boolean {
    const escalation = this.pendingEscalations.get(escalationId);
    if (!escalation) {
      return false;
    }

    escalation.status = EscalationStatus.CANCELLED;
    this.pendingEscalations.delete(escalationId);
    return true;
  }

  /**
   * Clear expired escalations
   */
  clearExpiredEscalations(): number {
    const now = new Date();
    let cleared = 0;

    for (const [id, escalation] of this.pendingEscalations) {
      if (new Date(escalation.expiresAt) < now) {
        escalation.status = EscalationStatus.EXPIRED;
        this.pendingEscalations.delete(id);
        cleared++;
      }
    }

    return cleared;
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  private calculateRiskLevel(factors: SafeHoldFactor[]): RiskLevel {
    if (factors.some((f) => f.severity === RiskLevel.CRITICAL)) {
      return RiskLevel.CRITICAL;
    }
    if (factors.some((f) => f.severity === RiskLevel.HIGH)) {
      return RiskLevel.HIGH;
    }
    if (factors.some((f) => f.severity === RiskLevel.MEDIUM)) {
      return RiskLevel.MEDIUM;
    }
    return RiskLevel.LOW;
  }

  private buildSuggestedActions(
    evidence: SafeHoldEvidence,
    context: ModeSelectionContext
  ): EscalationAction[] {
    const actions: EscalationAction[] = [];

    // Always include approve/reject
    actions.push({
      actionId: "approve",
      label: "Approve",
      description: "Approve the intent to proceed with the operation",
      approves: true,
      requiresConfirmation: evidence.riskLevel === RiskLevel.CRITICAL,
    });

    actions.push({
      actionId: "reject",
      label: "Reject",
      description: "Reject the intent and block the operation",
      approves: false,
      requiresConfirmation: false,
    });

    // Add modify option for non-critical
    if (evidence.riskLevel !== RiskLevel.CRITICAL) {
      actions.push({
        actionId: "modify",
        label: "Modify & Approve",
        description: "Modify constraints and approve with reduced scope",
        approves: true,
        requiresConfirmation: true,
      });
    }

    // Add escalate-higher option
    actions.push({
      actionId: "escalate",
      label: "Escalate Further",
      description: "Escalate to a higher authority for decision",
      approves: false,
      requiresConfirmation: false,
    });

    return actions;
  }

  private buildApproverContext(
    evidence: SafeHoldEvidence,
    context: ModeSelectionContext
  ): string {
    const lines: string[] = [
      `## SAFE_HOLD Escalation`,
      ``,
      `**Intent ID:** ${evidence.intentId}`,
      `**Risk Level:** ${evidence.riskLevel}`,
      `**Triggered:** ${evidence.triggeredAt}`,
      ``,
      `### Primary Reason`,
      evidence.primaryReason,
      ``,
      `### Metrics`,
      `- Coupling: ${evidence.context.coupling.toFixed(3)}`,
      `- Loss: ${evidence.context.loss.toFixed(3)}`,
      `- Effective Coupling: ${evidence.context.effectiveCoupling.toFixed(3)}`,
      `- Distance: ${evidence.context.distance}`,
      `- Targets Critical: ${evidence.context.targetsCritical}`,
      ``,
      `### Contributing Factors`,
    ];

    for (const factor of evidence.factors) {
      lines.push(`- **${factor.type}** (${factor.severity}): ${factor.description}`);
    }

    if (evidence.activeFlags.length > 0) {
      lines.push(``, `### Active Policy Flags`);
      for (const flag of evidence.activeFlags) {
        lines.push(`- ${flag}`);
      }
    }

    return lines.join("\n");
  }

  private verifyResponderAuthority(response: EscalationResponse): {
    valid: boolean;
    reason: string;
  } {
    // Check if responder authority meets minimum
    const responderLevel =
      AUTHORITY_ORDER[response.responderAuthority as AuthorityLevel];
    const requiredLevel =
      AUTHORITY_ORDER[this.config.minApprovalAuthority as AuthorityLevel];

    if (responderLevel === undefined) {
      return {
        valid: false,
        reason: `Unknown authority level: ${response.responderAuthority}`,
      };
    }

    if (responderLevel < requiredLevel) {
      return {
        valid: false,
        reason: `Responder authority ${response.responderAuthority} below required ${this.config.minApprovalAuthority}`,
      };
    }

    return { valid: true, reason: "Authority verified" };
  }
}

// =============================================================================
// CONVENIENCE FUNCTIONS
// =============================================================================

/**
 * Quick guardrail check with default configuration
 */
export function checkGuardrails(context: ModeSelectionContext): GuardrailResult {
  const guardrails = new PropagationGuardrails();
  return guardrails.evaluate(context);
}

/**
 * Check if a mode selection result requires escalation
 */
export function requiresEscalation(result: ModeSelectionResult): boolean {
  return (
    result.mode === PropagationMode.SAFE_HOLD &&
    (result.forcedByPolicy ||
      result.activeFlags.includes(PolicyFlag.AUTHORITY_EXCEEDED) ||
      result.activeFlags.includes(PolicyFlag.CRITICAL_TARGET))
  );
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

let guardrailsInstance: PropagationGuardrails | null = null;

export function getPropagationGuardrails(
  config?: Partial<GuardrailConfig>
): PropagationGuardrails {
  if (!guardrailsInstance) {
    guardrailsInstance = new PropagationGuardrails(config);
  }
  return guardrailsInstance;
}

export function resetPropagationGuardrails(): void {
  guardrailsInstance = null;
}
