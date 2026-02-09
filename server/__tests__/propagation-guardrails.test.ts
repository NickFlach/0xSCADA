/**
 * Propagation Guardrails Test Suite
 *
 * GhostOS Propagation Model - SAFE_HOLD Guardrails Tests
 * See docs/propagation-model.md Section 9 for specification
 *
 * Issue: #165 - SAFE_HOLD Guardrails & Human Escalation
 * Epic: #161 - GhostOS Propagation Model
 *
 * Coverage targets:
 * - SAFE_HOLD is triggered under unsafe conditions
 * - Evidence is captured correctly
 * - Escalation workflow functions properly
 * - Unsafe actions cannot bypass SAFE_HOLD
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  PropagationGuardrails,
  checkGuardrails,
  requiresEscalation,
  getPropagationGuardrails,
  resetPropagationGuardrails,
} from "../services/propagation-guardrails";
import {
  PropagationMode,
  AuthorityLevel,
  FallbackStrategy,
} from "../../shared/types/intent-packet";
import {
  ModeSelectionContext,
  ModeSelectionResult,
  PolicyFlag,
  RiskLevel,
  EscalationStatus,
  EscalationResponse,
  DEFAULT_GUARDRAIL_CONFIG,
} from "../../shared/types/propagation";

// =============================================================================
// TEST FIXTURES
// =============================================================================

const createTestPacket = (overrides: Partial<any> = {}) => ({
  intent_id: "test-intent-001",
  target_selector: { allSites: true },
  mode: PropagationMode.LOCAL_COHERENCE,
  constraints: [],
  confidence: 0.9,
  authority_required: AuthorityLevel.OPERATOR,
  ttl: 60000,
  expected_observables: [],
  fallback_plan: { strategy: FallbackStrategy.ABORT },
  telemetry_hooks: [],
  ...overrides,
});

const createTestContext = (
  overrides: Partial<ModeSelectionContext> = {}
): ModeSelectionContext => ({
  packet: createTestPacket(),
  coupling: 0.9,
  loss: 0.1,
  distance: 0,
  targetsCritical: false,
  hasAuthority: true,
  explorationAllowed: true,
  policyFlags: [],
  ...overrides,
});

const createModeResult = (
  overrides: Partial<ModeSelectionResult> = {}
): ModeSelectionResult => ({
  mode: PropagationMode.LOCAL_COHERENCE,
  effectiveCoupling: 0.81,
  reason: "Test reason",
  rationale: {
    coupling: 0.9,
    loss: 0.1,
    effectiveCoupling: 0.81,
    distance: 0,
    thresholds: {
      d_local: 1,
      d_0: 10,
      C_threshold_local: 0.8,
      C_threshold_remote: 0.5,
      L_threshold_local: 0.2,
      L_threshold_remote: 0.4,
    },
    modeScores: {
      [PropagationMode.LOCAL_COHERENCE]: 0.81,
      [PropagationMode.REMOTE_COHERENCE]: 0.65,
      [PropagationMode.SAFE_HOLD]: 0,
      [PropagationMode.EXPLORATION]: 0.4,
    },
    conditionsChecked: [],
  },
  forcedByPolicy: false,
  activeFlags: [],
  ...overrides,
});

// =============================================================================
// GUARDRAIL EVALUATION TESTS
// =============================================================================

describe("Guardrail Evaluation", () => {
  let guardrails: PropagationGuardrails;

  beforeEach(() => {
    guardrails = new PropagationGuardrails();
  });

  describe("Safe Contexts", () => {
    it("should pass all guardrails for safe context", () => {
      const context = createTestContext({
        coupling: 0.9,
        loss: 0.1,
        hasAuthority: true,
        targetsCritical: false,
      });

      const result = guardrails.evaluate(context);

      expect(result.passed).toBe(true);
      expect(result.evidence).toBeUndefined();
      expect(result.escalation).toBeUndefined();
    });

    it("should pass with moderate coupling above threshold", () => {
      const context = createTestContext({
        coupling: 0.5, // Exactly at C_threshold_remote
        loss: 0.3,
      });

      const result = guardrails.evaluate(context);

      expect(result.passed).toBe(true);
    });

    it("should pass with loss at threshold", () => {
      const context = createTestContext({
        coupling: 0.8,
        loss: 0.4, // Exactly at L_threshold_remote
      });

      const result = guardrails.evaluate(context);

      expect(result.passed).toBe(true);
    });
  });

  describe("Unsafe Contexts - SAFE_HOLD Triggers", () => {
    it("should trigger SAFE_HOLD for low coupling", () => {
      const context = createTestContext({
        coupling: 0.3, // Below C_threshold_remote (0.5)
        loss: 0.1,
      });

      const result = guardrails.evaluate(context);

      expect(result.passed).toBe(false);
      expect(result.evidence).toBeDefined();
      expect(result.escalation).toBeDefined();
    });

    it("should trigger SAFE_HOLD for high loss", () => {
      const context = createTestContext({
        coupling: 0.9,
        loss: 0.6, // Above L_threshold_remote (0.4)
      });

      const result = guardrails.evaluate(context);

      expect(result.passed).toBe(false);
      expect(result.evidence).toBeDefined();
    });

    it("should trigger SAFE_HOLD when authority is insufficient", () => {
      const context = createTestContext({
        coupling: 0.9,
        loss: 0.1,
        hasAuthority: false,
      });

      const result = guardrails.evaluate(context);

      expect(result.passed).toBe(false);
      expect(result.evidence).toBeDefined();
      expect(result.evidence!.primaryReason).toContain("authority");
    });

    it("should trigger SAFE_HOLD for exploration on critical targets", () => {
      const context = createTestContext({
        packet: createTestPacket({ mode: PropagationMode.EXPLORATION }),
        coupling: 0.9,
        loss: 0.1,
        targetsCritical: true,
      });

      const result = guardrails.evaluate(context);

      expect(result.passed).toBe(false);
    });

    it("should trigger SAFE_HOLD with MANUAL_SAFE_HOLD flag", () => {
      const context = createTestContext({
        coupling: 0.9,
        loss: 0.1,
        policyFlags: [PolicyFlag.MANUAL_SAFE_HOLD],
      });

      const result = guardrails.evaluate(context);

      expect(result.passed).toBe(false);
    });

    it("should trigger SAFE_HOLD with AUTHORITY_EXCEEDED flag", () => {
      const context = createTestContext({
        coupling: 0.9,
        loss: 0.1,
        policyFlags: [PolicyFlag.AUTHORITY_EXCEEDED],
      });

      const result = guardrails.evaluate(context);

      expect(result.passed).toBe(false);
    });
  });

  describe("Advisory Guardrails", () => {
    it("should pass but warn on low confidence", () => {
      const context = createTestContext({
        packet: createTestPacket({ confidence: 0.3 }),
        coupling: 0.9,
        loss: 0.1,
      });

      const result = guardrails.evaluate(context);

      // Should pass because confidence is advisory only
      expect(result.passed).toBe(true);

      // But should have a failed advisory check
      const confidenceCheck = result.checksPerformed.find(
        (c) => c.guardrail === "confidence"
      );
      expect(confidenceCheck).toBeDefined();
      expect(confidenceCheck!.passed).toBe(false);
      expect(confidenceCheck!.blocking).toBe(false);
    });
  });
});

// =============================================================================
// EVIDENCE CAPTURE TESTS
// =============================================================================

describe("Evidence Capture", () => {
  let guardrails: PropagationGuardrails;

  beforeEach(() => {
    guardrails = new PropagationGuardrails();
  });

  it("should capture intent ID in evidence", () => {
    const context = createTestContext({
      packet: createTestPacket({ intent_id: "unique-intent-123" }),
      coupling: 0.3,
    });

    const result = guardrails.evaluate(context);

    expect(result.evidence!.intentId).toBe("unique-intent-123");
  });

  it("should capture coupling and loss metrics", () => {
    const context = createTestContext({
      coupling: 0.35,
      loss: 0.25,
    });

    const result = guardrails.evaluate(context);

    expect(result.evidence!.context.coupling).toBe(0.35);
    expect(result.evidence!.context.loss).toBe(0.25);
  });

  it("should calculate effective coupling correctly", () => {
    const context = createTestContext({
      coupling: 0.4,
      loss: 0.2,
    });

    const result = guardrails.evaluate(context);

    // Effective = 0.4 * (1 - 0.2) = 0.32
    expect(result.evidence!.context.effectiveCoupling).toBeCloseTo(0.32, 2);
  });

  it("should capture all active policy flags", () => {
    const context = createTestContext({
      coupling: 0.3,
      policyFlags: [PolicyFlag.LOW_CONFIDENCE, PolicyFlag.QUORUM_REQUIRED],
    });

    const result = guardrails.evaluate(context);

    expect(result.evidence!.activeFlags).toContain(PolicyFlag.LOW_CONFIDENCE);
    expect(result.evidence!.activeFlags).toContain(PolicyFlag.QUORUM_REQUIRED);
  });

  it("should capture intent snapshot", () => {
    const packet = createTestPacket({ confidence: 0.5 });
    const context = createTestContext({
      packet,
      coupling: 0.3,
    });

    const result = guardrails.evaluate(context);

    expect(result.evidence!.intentSnapshot).toEqual(packet);
  });

  it("should include timestamp", () => {
    const context = createTestContext({ coupling: 0.3 });

    const result = guardrails.evaluate(context);

    expect(result.evidence!.triggeredAt).toBeDefined();
    expect(new Date(result.evidence!.triggeredAt).getTime()).toBeGreaterThan(0);
  });

  it("should generate unique evidence ID", () => {
    const context = createTestContext({ coupling: 0.3 });

    const result1 = guardrails.evaluate(context);
    const result2 = guardrails.evaluate(context);

    expect(result1.evidence!.evidenceId).not.toBe(result2.evidence!.evidenceId);
  });

  it("should determine correct risk level", () => {
    // High risk - authority failure
    const highRiskContext = createTestContext({
      hasAuthority: false,
    });

    const highRiskResult = guardrails.evaluate(highRiskContext);
    expect(highRiskResult.evidence!.riskLevel).toBe(RiskLevel.HIGH);

    // Critical risk - exploration on critical targets
    const criticalContext = createTestContext({
      packet: createTestPacket({ mode: PropagationMode.EXPLORATION }),
      targetsCritical: true,
    });

    const criticalResult = guardrails.evaluate(criticalContext);
    expect(criticalResult.evidence!.riskLevel).toBe(RiskLevel.CRITICAL);

    // Medium risk - low coupling
    const mediumContext = createTestContext({
      coupling: 0.3,
    });

    const mediumResult = guardrails.evaluate(mediumContext);
    expect([RiskLevel.MEDIUM, RiskLevel.HIGH]).toContain(
      mediumResult.evidence!.riskLevel
    );
  });
});

// =============================================================================
// ESCALATION WORKFLOW TESTS
// =============================================================================

describe("Escalation Workflow", () => {
  let guardrails: PropagationGuardrails;

  beforeEach(() => {
    guardrails = new PropagationGuardrails();
  });

  describe("Escalation Creation", () => {
    it("should create escalation with unique ID", () => {
      const context = createTestContext({ coupling: 0.3 });

      const result = guardrails.evaluate(context);

      expect(result.escalation!.escalationId).toBeDefined();
      expect(result.escalation!.escalationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}/i
      );
    });

    it("should set escalation status to PENDING", () => {
      const context = createTestContext({ coupling: 0.3 });

      const result = guardrails.evaluate(context);

      expect(result.escalation!.status).toBe(EscalationStatus.PENDING);
    });

    it("should use fallback escalation target if specified", () => {
      const context = createTestContext({
        packet: createTestPacket({
          fallback_plan: {
            strategy: FallbackStrategy.ESCALATE,
            escalation_target: "specific-engineer",
          },
        }),
        coupling: 0.3,
      });

      const result = guardrails.evaluate(context);

      expect(result.escalation!.escalationTarget).toBe("specific-engineer");
    });

    it("should use default escalation target if not specified", () => {
      const context = createTestContext({ coupling: 0.3 });

      const result = guardrails.evaluate(context);

      expect(result.escalation!.escalationTarget).toBe(
        DEFAULT_GUARDRAIL_CONFIG.defaultEscalationTarget
      );
    });

    it("should include suggested actions", () => {
      const context = createTestContext({ coupling: 0.3 });

      const result = guardrails.evaluate(context);

      expect(result.escalation!.suggestedActions.length).toBeGreaterThan(0);

      const approveAction = result.escalation!.suggestedActions.find(
        (a) => a.actionId === "approve"
      );
      expect(approveAction).toBeDefined();
      expect(approveAction!.approves).toBe(true);

      const rejectAction = result.escalation!.suggestedActions.find(
        (a) => a.actionId === "reject"
      );
      expect(rejectAction).toBeDefined();
      expect(rejectAction!.approves).toBe(false);
    });

    it("should set expiration time", () => {
      const context = createTestContext({ coupling: 0.3 });

      const result = guardrails.evaluate(context);

      const createdAt = new Date(result.escalation!.createdAt);
      const expiresAt = new Date(result.escalation!.expiresAt);

      expect(expiresAt.getTime()).toBeGreaterThan(createdAt.getTime());
    });

    it("should store escalation in pending", () => {
      const context = createTestContext({ coupling: 0.3 });

      const result = guardrails.evaluate(context);
      const escalationId = result.escalation!.escalationId;

      const pending = guardrails.getPendingEscalation(escalationId);
      expect(pending).toBeDefined();
      expect(pending!.escalationId).toBe(escalationId);
    });
  });

  describe("Escalation Response Processing", () => {
    it("should accept valid approval response", () => {
      const context = createTestContext({ coupling: 0.3 });
      const result = guardrails.evaluate(context);
      const escalationId = result.escalation!.escalationId;

      const response: EscalationResponse = {
        escalationId,
        responderId: "user-001",
        responderAuthority: AuthorityLevel.SUPERVISOR,
        action: "approve",
        approved: true,
        respondedAt: new Date().toISOString(),
      };

      const processResult = guardrails.processEscalationResponse(response);

      expect(processResult.accepted).toBe(true);
      expect(processResult.updatedEscalation!.status).toBe(
        EscalationStatus.APPROVED
      );
    });

    it("should accept valid rejection response", () => {
      const context = createTestContext({ coupling: 0.3 });
      const result = guardrails.evaluate(context);
      const escalationId = result.escalation!.escalationId;

      const response: EscalationResponse = {
        escalationId,
        responderId: "user-001",
        responderAuthority: AuthorityLevel.SUPERVISOR,
        action: "reject",
        approved: false,
        comment: "Too risky",
        respondedAt: new Date().toISOString(),
      };

      const processResult = guardrails.processEscalationResponse(response);

      expect(processResult.accepted).toBe(true);
      expect(processResult.updatedEscalation!.status).toBe(
        EscalationStatus.REJECTED
      );
    });

    it("should reject response for non-existent escalation", () => {
      const response: EscalationResponse = {
        escalationId: "non-existent-id",
        responderId: "user-001",
        responderAuthority: AuthorityLevel.SUPERVISOR,
        action: "approve",
        approved: true,
        respondedAt: new Date().toISOString(),
      };

      const processResult = guardrails.processEscalationResponse(response);

      expect(processResult.accepted).toBe(false);
      expect(processResult.reason).toContain("not found");
    });

    it("should reject response with insufficient authority", () => {
      const guardrailsWithHighAuth = new PropagationGuardrails({
        minApprovalAuthority: AuthorityLevel.ADMIN,
      });

      const context = createTestContext({ coupling: 0.3 });
      const result = guardrailsWithHighAuth.evaluate(context);
      const escalationId = result.escalation!.escalationId;

      const response: EscalationResponse = {
        escalationId,
        responderId: "user-001",
        responderAuthority: AuthorityLevel.OPERATOR, // Below ADMIN
        action: "approve",
        approved: true,
        respondedAt: new Date().toISOString(),
      };

      const processResult =
        guardrailsWithHighAuth.processEscalationResponse(response);

      expect(processResult.accepted).toBe(false);
      expect(processResult.reason).toContain("authority");
    });

    it("should remove escalation from pending after response", () => {
      const context = createTestContext({ coupling: 0.3 });
      const result = guardrails.evaluate(context);
      const escalationId = result.escalation!.escalationId;

      expect(guardrails.getPendingEscalation(escalationId)).toBeDefined();

      const response: EscalationResponse = {
        escalationId,
        responderId: "user-001",
        responderAuthority: AuthorityLevel.SUPERVISOR,
        action: "approve",
        approved: true,
        respondedAt: new Date().toISOString(),
      };

      guardrails.processEscalationResponse(response);

      expect(guardrails.getPendingEscalation(escalationId)).toBeUndefined();
    });
  });

  describe("Post-Approval Checks", () => {
    it("should allow proceeding after approval", () => {
      const context = createTestContext({ coupling: 0.3 });
      const result = guardrails.evaluate(context);
      const escalationId = result.escalation!.escalationId;

      const response: EscalationResponse = {
        escalationId,
        responderId: "user-001",
        responderAuthority: AuthorityLevel.SUPERVISOR,
        action: "approve",
        approved: true,
        respondedAt: new Date().toISOString(),
      };

      guardrails.processEscalationResponse(response);

      const canProceed = guardrails.canProceedAfterApproval(escalationId);

      expect(canProceed.canProceed).toBe(true);
    });

    it("should block proceeding after rejection", () => {
      const context = createTestContext({ coupling: 0.3 });
      const result = guardrails.evaluate(context);
      const escalationId = result.escalation!.escalationId;

      const response: EscalationResponse = {
        escalationId,
        responderId: "user-001",
        responderAuthority: AuthorityLevel.SUPERVISOR,
        action: "reject",
        approved: false,
        comment: "Not approved",
        respondedAt: new Date().toISOString(),
      };

      guardrails.processEscalationResponse(response);

      const canProceed = guardrails.canProceedAfterApproval(escalationId);

      expect(canProceed.canProceed).toBe(false);
      expect(canProceed.reason).toContain("rejected");
    });

    it("should block proceeding without response", () => {
      const canProceed = guardrails.canProceedAfterApproval("unknown-id");

      expect(canProceed.canProceed).toBe(false);
    });
  });

  describe("Escalation Management", () => {
    it("should cancel pending escalation", () => {
      const context = createTestContext({ coupling: 0.3 });
      const result = guardrails.evaluate(context);
      const escalationId = result.escalation!.escalationId;

      const cancelled = guardrails.cancelEscalation(escalationId);

      expect(cancelled).toBe(true);
      expect(guardrails.getPendingEscalation(escalationId)).toBeUndefined();
    });

    it("should return false when cancelling non-existent escalation", () => {
      const cancelled = guardrails.cancelEscalation("non-existent");

      expect(cancelled).toBe(false);
    });

    it("should list all pending escalations", () => {
      // Create multiple escalations
      const context1 = createTestContext({
        packet: createTestPacket({ intent_id: "intent-1" }),
        coupling: 0.3,
      });
      const context2 = createTestContext({
        packet: createTestPacket({ intent_id: "intent-2" }),
        coupling: 0.2,
      });

      guardrails.evaluate(context1);
      guardrails.evaluate(context2);

      const pending = guardrails.getAllPendingEscalations();

      expect(pending.length).toBe(2);
    });
  });
});

// =============================================================================
// SAFETY INVARIANT TESTS
// =============================================================================

describe("Safety Invariants", () => {
  let guardrails: PropagationGuardrails;

  beforeEach(() => {
    guardrails = new PropagationGuardrails();
  });

  it("INVARIANT 1: SAFE_HOLD triggered when coupling < threshold", () => {
    const context = createTestContext({
      coupling: 0.49, // Just below 0.5 threshold
      loss: 0.1,
    });

    const result = guardrails.evaluate(context);

    expect(result.passed).toBe(false);
  });

  it("INVARIANT 1: SAFE_HOLD triggered when loss > threshold", () => {
    const context = createTestContext({
      coupling: 0.9,
      loss: 0.41, // Just above 0.4 threshold
    });

    const result = guardrails.evaluate(context);

    expect(result.passed).toBe(false);
  });

  it("INVARIANT 2: Critical assets require explicit approval", () => {
    const context = createTestContext({
      packet: createTestPacket({ mode: PropagationMode.EXPLORATION }),
      coupling: 0.9,
      loss: 0.1,
      targetsCritical: true,
    });

    const result = guardrails.evaluate(context);

    expect(result.passed).toBe(false);
    expect(result.escalation).toBeDefined();
  });

  it("INVARIANT 3: Cannot bypass SAFE_HOLD by repeated evaluation", () => {
    const context = createTestContext({
      coupling: 0.3,
      loss: 0.1,
    });

    // Evaluate multiple times
    const results = [
      guardrails.evaluate(context),
      guardrails.evaluate(context),
      guardrails.evaluate(context),
    ];

    // All should fail
    results.forEach((result) => {
      expect(result.passed).toBe(false);
    });
  });

  it("INVARIANT 3: High coupling does not bypass authority check", () => {
    const context = createTestContext({
      coupling: 1.0, // Maximum coupling
      loss: 0.0, // Minimum loss
      hasAuthority: false, // But no authority
    });

    const result = guardrails.evaluate(context);

    expect(result.passed).toBe(false);
  });

  it("Cannot use exploration mode on critical targets regardless of metrics", () => {
    const context = createTestContext({
      packet: createTestPacket({ mode: PropagationMode.EXPLORATION }),
      coupling: 1.0,
      loss: 0.0,
      targetsCritical: true,
    });

    const result = guardrails.evaluate(context);

    expect(result.passed).toBe(false);
  });
});

// =============================================================================
// CONVENIENCE FUNCTION TESTS
// =============================================================================

describe("Convenience Functions", () => {
  afterEach(() => {
    resetPropagationGuardrails();
  });

  it("checkGuardrails should work with defaults", () => {
    const context = createTestContext({
      coupling: 0.9,
      loss: 0.1,
    });

    const result = checkGuardrails(context);

    expect(result.passed).toBe(true);
  });

  it("requiresEscalation should detect SAFE_HOLD with policy", () => {
    const result = createModeResult({
      mode: PropagationMode.SAFE_HOLD,
      forcedByPolicy: true,
    });

    expect(requiresEscalation(result)).toBe(true);
  });

  it("requiresEscalation should detect authority exceeded", () => {
    const result = createModeResult({
      mode: PropagationMode.SAFE_HOLD,
      activeFlags: [PolicyFlag.AUTHORITY_EXCEEDED],
    });

    expect(requiresEscalation(result)).toBe(true);
  });

  it("requiresEscalation should return false for normal modes", () => {
    const result = createModeResult({
      mode: PropagationMode.LOCAL_COHERENCE,
    });

    expect(requiresEscalation(result)).toBe(false);
  });
});

// =============================================================================
// SINGLETON TESTS
// =============================================================================

describe("Singleton Instance", () => {
  afterEach(() => {
    resetPropagationGuardrails();
  });

  it("should return same instance", () => {
    const instance1 = getPropagationGuardrails();
    const instance2 = getPropagationGuardrails();

    expect(instance1).toBe(instance2);
  });

  it("should create new instance after reset", () => {
    const instance1 = getPropagationGuardrails();
    resetPropagationGuardrails();
    const instance2 = getPropagationGuardrails();

    expect(instance1).not.toBe(instance2);
  });
});

// =============================================================================
// CHECKS PERFORMED TESTS
// =============================================================================

describe("Checks Performed", () => {
  let guardrails: PropagationGuardrails;

  beforeEach(() => {
    guardrails = new PropagationGuardrails();
  });

  it("should include all enabled guardrails in checks", () => {
    const context = createTestContext();

    const result = guardrails.evaluate(context);

    const guardrailNames = result.checksPerformed.map((c) => c.guardrail);

    expect(guardrailNames).toContain("authority");
    expect(guardrailNames).toContain("coupling");
    expect(guardrailNames).toContain("loss");
    expect(guardrailNames).toContain("critical_target");
    expect(guardrailNames).toContain("confidence");
    expect(guardrailNames).toContain("policy_flags");
  });

  it("should only run enabled guardrails", () => {
    const customGuardrails = new PropagationGuardrails({
      enabledGuardrails: ["authority", "coupling"],
    });

    const context = createTestContext();

    const result = customGuardrails.evaluate(context);

    expect(result.checksPerformed.length).toBe(2);
  });

  it("should record processing time", () => {
    const context = createTestContext();

    const result = guardrails.evaluate(context);

    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
  });
});
