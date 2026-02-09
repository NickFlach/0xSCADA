/**
 * Propagation Model Conformance Test Harness
 *
 * GhostOS Propagation Model - Spec Conformance Validation
 * See docs/propagation-model.md Section 11 for conformance criteria
 *
 * Issue: #167 - Propagation Model Conformance Test Harness
 * Epic: #161 - GhostOS Propagation Model
 *
 * Conformance Levels:
 * - BASIC: M1, M2, M3 modes functional
 * - STANDARD: All modes + Intent Packet validation
 * - FULL: All features + policy integration
 *
 * Conformance Criteria:
 * - C1: Mode selection determinism (same inputs produce same mode)
 * - C2: SAFE_HOLD triggering (unsafe conditions always trigger M3)
 * - C3: Telemetry emission (all propagations emit required metrics)
 * - C4: Rationale generation (mode selection includes measurable inputs)
 * - C5: Fallback execution (failed validations trigger fallback)
 * - C6: Human escalation (SAFE_HOLD routes to approval workflow)
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";

import {
  PropagationMode,
  IntentPacket,
  FallbackStrategy,
  AuthorityLevel,
  CriticalityLevel,
  TelemetryEvent,
  validateIntentPacket,
} from "../../shared/types/intent-packet";

import {
  ModeSelectionResult,
  ModeSelectionContext,
  PolicyFlag,
  RiskLevel,
  DEFAULT_PROPAGATION_THRESHOLDS,
  DEFAULT_COUPLING_WEIGHTS,
  DEFAULT_PROPAGATION_ENVIRONMENT,
} from "../../shared/types/propagation";

import {
  calculateCoupling,
  calculateLoss,
  calculateEffectiveCoupling,
  PropagationModeSelector,
} from "../services/propagation-mode-selector";

import { PropagationGuardrails } from "../services/propagation-guardrails";

import {
  PropagationTelemetry,
  getPropagationTelemetry,
  resetPropagationTelemetry,
} from "../services/propagation-telemetry";

// =============================================================================
// CONFORMANCE REPORT TYPES
// =============================================================================

interface ConformanceCriterion {
  id: string;
  name: string;
  description: string;
  level: "BASIC" | "STANDARD" | "FULL";
  tests: ConformanceTestResult[];
  passed: boolean;
}

interface ConformanceTestResult {
  name: string;
  passed: boolean;
  details?: string;
  duration_ms: number;
}

interface ConformanceReport {
  version: string;
  timestamp: string;
  level_achieved: "NONE" | "BASIC" | "STANDARD" | "FULL";
  criteria: ConformanceCriterion[];
  total_tests: number;
  passed_tests: number;
  failed_tests: number;
  summary: string;
}

// =============================================================================
// CONFORMANCE REPORT BUILDER
// =============================================================================

class ConformanceReportBuilder {
  private criteria: Map<string, ConformanceCriterion> = new Map();
  private startTime: number = Date.now();

  registerCriterion(
    id: string,
    name: string,
    description: string,
    level: "BASIC" | "STANDARD" | "FULL"
  ): void {
    this.criteria.set(id, {
      id,
      name,
      description,
      level,
      tests: [],
      passed: false,
    });
  }

  recordTest(
    criterionId: string,
    testName: string,
    passed: boolean,
    durationMs: number,
    details?: string
  ): void {
    const criterion = this.criteria.get(criterionId);
    if (criterion) {
      criterion.tests.push({
        name: testName,
        passed,
        details,
        duration_ms: durationMs,
      });
    }
  }

  finalize(): ConformanceReport {
    // Calculate pass/fail for each criterion
    for (const criterion of this.criteria.values()) {
      criterion.passed =
        criterion.tests.length > 0 &&
        criterion.tests.every((t) => t.passed);
    }

    // Determine conformance level
    const basicCriteria = ["C1", "C2"];
    const standardCriteria = ["C1", "C2", "C3", "C4"];
    const fullCriteria = ["C1", "C2", "C3", "C4", "C5", "C6"];

    const passedIds = Array.from(this.criteria.values())
      .filter((c) => c.passed)
      .map((c) => c.id);

    let levelAchieved: "NONE" | "BASIC" | "STANDARD" | "FULL" = "NONE";
    if (fullCriteria.every((id) => passedIds.includes(id))) {
      levelAchieved = "FULL";
    } else if (standardCriteria.every((id) => passedIds.includes(id))) {
      levelAchieved = "STANDARD";
    } else if (basicCriteria.every((id) => passedIds.includes(id))) {
      levelAchieved = "BASIC";
    }

    const allTests = Array.from(this.criteria.values()).flatMap((c) => c.tests);
    const passedTests = allTests.filter((t) => t.passed).length;
    const failedTests = allTests.filter((t) => !t.passed).length;

    return {
      version: "1.0.0",
      timestamp: new Date().toISOString(),
      level_achieved: levelAchieved,
      criteria: Array.from(this.criteria.values()),
      total_tests: allTests.length,
      passed_tests: passedTests,
      failed_tests: failedTests,
      summary: `Conformance Level: ${levelAchieved} (${passedTests}/${allTests.length} tests passed)`,
    };
  }
}

// =============================================================================
// TEST FIXTURES
// =============================================================================

/**
 * Create a valid Intent Packet for conformance testing.
 * This matches the intentPacketSchema from shared/types/intent-packet.ts
 */
function createBasePacket(overrides: Partial<IntentPacket> = {}): IntentPacket {
  return {
    intent_id: "550e8400-e29b-41d4-a716-446655440000",
    target_selector: {
      siteIds: ["site-001"],
    },
    mode: PropagationMode.LOCAL_COHERENCE, // Required field
    constraints: [], // Array of constraints
    confidence: 0.9,
    authority_required: AuthorityLevel.OPERATOR, // Required field
    ttl: 3600000, // Required field (1 hour in ms)
    expected_observables: [],
    fallback_plan: {
      strategy: FallbackStrategy.ROLLBACK,
      escalation_target: "supervisor",
    },
    telemetry_hooks: [],
    ...overrides,
  };
}

function createModeContext(
  overrides: Partial<ModeSelectionContext> = {}
): ModeSelectionContext {
  return {
    packet: createBasePacket(),
    coupling: 0.9,
    loss: 0.1,
    distance: 1,
    targetsCritical: false,
    hasAuthority: true,
    explorationAllowed: true,
    policyFlags: [],
    ...overrides,
  };
}

// =============================================================================
// CONFORMANCE TESTS
// =============================================================================

const reportBuilder = new ConformanceReportBuilder();

// Register all criteria
reportBuilder.registerCriterion(
  "C1",
  "Mode Selection Determinism",
  "Same inputs produce same mode selection",
  "BASIC"
);
reportBuilder.registerCriterion(
  "C2",
  "SAFE_HOLD Triggering",
  "Unsafe conditions always trigger M3 (SAFE_HOLD)",
  "BASIC"
);
reportBuilder.registerCriterion(
  "C3",
  "Telemetry Emission",
  "All propagations emit required metrics",
  "STANDARD"
);
reportBuilder.registerCriterion(
  "C4",
  "Rationale Generation",
  "Mode selection includes measurable coupling/loss inputs",
  "STANDARD"
);
reportBuilder.registerCriterion(
  "C5",
  "Fallback Execution",
  "Failed validations trigger fallback plans",
  "FULL"
);
reportBuilder.registerCriterion(
  "C6",
  "Human Escalation",
  "SAFE_HOLD routes to human approval workflow",
  "FULL"
);

describe("Propagation Model Conformance Test Harness", () => {
  let selector: PropagationModeSelector;
  let guardrails: PropagationGuardrails;
  let telemetry: PropagationTelemetry;

  beforeEach(() => {
    selector = new PropagationModeSelector();
    guardrails = new PropagationGuardrails();
    telemetry = new PropagationTelemetry();
  });

  // ===========================================================================
  // C1: Mode Selection Determinism
  // ===========================================================================

  describe("C1: Mode Selection Determinism", () => {
    it("C1.1: M1 (LOCAL_COHERENCE) - High coupling, low loss produces M1", () => {
      const start = Date.now();
      const context = createModeContext({
        coupling: 0.9,
        loss: 0.1,
        distance: 1,
      });

      const result1 = selector.selectMode(context);
      const result2 = selector.selectMode(context);
      const result3 = selector.selectMode(context);

      const passed =
        result1.mode === PropagationMode.LOCAL_COHERENCE &&
        result1.mode === result2.mode &&
        result2.mode === result3.mode;

      reportBuilder.recordTest(
        "C1",
        "M1 determinism",
        passed,
        Date.now() - start,
        `All iterations returned ${result1.mode}`
      );

      expect(result1.mode).toBe(PropagationMode.LOCAL_COHERENCE);
      expect(result1.mode).toBe(result2.mode);
      expect(result2.mode).toBe(result3.mode);
    });

    it("C1.2: M2 (REMOTE_COHERENCE) - Medium coupling, medium loss produces M2", () => {
      const start = Date.now();
      const context = createModeContext({
        coupling: 0.7,
        loss: 0.3,
        distance: 5,
      });

      const result1 = selector.selectMode(context);
      const result2 = selector.selectMode(context);
      const result3 = selector.selectMode(context);

      const passed =
        result1.mode === PropagationMode.REMOTE_COHERENCE &&
        result1.mode === result2.mode &&
        result2.mode === result3.mode;

      reportBuilder.recordTest(
        "C1",
        "M2 determinism",
        passed,
        Date.now() - start,
        `All iterations returned ${result1.mode}`
      );

      expect(result1.mode).toBe(PropagationMode.REMOTE_COHERENCE);
      expect(result1.mode).toBe(result2.mode);
      expect(result2.mode).toBe(result3.mode);
    });

    it("C1.3: M3 (SAFE_HOLD) - Low coupling produces M3", () => {
      const start = Date.now();
      const context = createModeContext({
        coupling: 0.3,
        loss: 0.2,
      });

      const result1 = selector.selectMode(context);
      const result2 = selector.selectMode(context);
      const result3 = selector.selectMode(context);

      const passed =
        result1.mode === PropagationMode.SAFE_HOLD &&
        result1.mode === result2.mode &&
        result2.mode === result3.mode;

      reportBuilder.recordTest(
        "C1",
        "M3 determinism (low coupling)",
        passed,
        Date.now() - start,
        `All iterations returned ${result1.mode}`
      );

      expect(result1.mode).toBe(PropagationMode.SAFE_HOLD);
      expect(result1.mode).toBe(result2.mode);
      expect(result2.mode).toBe(result3.mode);
    });

    it("C1.4: M4 (EXPLORATION) - Non-critical with exploration allowed", () => {
      const start = Date.now();
      // EXPLORATION requires packet.mode === PropagationMode.EXPLORATION
      const explorationPacket = createBasePacket({
        mode: PropagationMode.EXPLORATION,
      });

      const context = createModeContext({
        packet: explorationPacket,
        coupling: 0.4,
        loss: 0.3,
        targetsCritical: false,
        explorationAllowed: true,
      });

      const result1 = selector.selectMode(context);
      const result2 = selector.selectMode(context);
      const result3 = selector.selectMode(context);

      const passed =
        result1.mode === PropagationMode.EXPLORATION &&
        result1.mode === result2.mode &&
        result2.mode === result3.mode;

      reportBuilder.recordTest(
        "C1",
        "M4 determinism",
        passed,
        Date.now() - start,
        `All iterations returned ${result1.mode}`
      );

      expect(result1.mode).toBe(PropagationMode.EXPLORATION);
      expect(result1.mode).toBe(result2.mode);
      expect(result2.mode).toBe(result3.mode);
    });

    it("C1.5: Identical contexts produce identical effective coupling", () => {
      const start = Date.now();
      const context = createModeContext({
        coupling: 0.8,
        loss: 0.15,
      });

      const result1 = selector.selectMode(context);
      const result2 = selector.selectMode(context);

      const passed = result1.effectiveCoupling === result2.effectiveCoupling;

      reportBuilder.recordTest(
        "C1",
        "Effective coupling determinism",
        passed,
        Date.now() - start,
        `C_eff = ${result1.effectiveCoupling}`
      );

      expect(result1.effectiveCoupling).toBe(result2.effectiveCoupling);
    });

    it("C1.6: Coupling calculation is deterministic", () => {
      const start = Date.now();
      const inputs = {
        relevance: 0.8,
        capabilityMatch: 0.9,
        scopeOverlap: 0.7,
      };

      const c1 = calculateCoupling(inputs);
      const c2 = calculateCoupling(inputs);
      const c3 = calculateCoupling(inputs);

      const passed = c1 === c2 && c2 === c3;

      reportBuilder.recordTest(
        "C1",
        "Coupling calculation determinism",
        passed,
        Date.now() - start,
        `C = ${c1}`
      );

      expect(c1).toBe(c2);
      expect(c2).toBe(c3);
    });

    it("C1.7: Loss calculation is deterministic", () => {
      const start = Date.now();
      const inputs = {
        baseLoss: 0.1,
        distance: 3,
        transformationLoss: 0.05,
      };

      const l1 = calculateLoss(inputs);
      const l2 = calculateLoss(inputs);
      const l3 = calculateLoss(inputs);

      const passed = l1 === l2 && l2 === l3;

      reportBuilder.recordTest(
        "C1",
        "Loss calculation determinism",
        passed,
        Date.now() - start,
        `L = ${l1}`
      );

      expect(l1).toBe(l2);
      expect(l2).toBe(l3);
    });
  });

  // ===========================================================================
  // C2: SAFE_HOLD Triggering
  // ===========================================================================

  describe("C2: SAFE_HOLD Triggering", () => {
    it("C2.1: SAFE_HOLD when coupling < C_threshold_remote (0.5)", () => {
      const start = Date.now();
      const context = createModeContext({
        coupling: 0.4,
        loss: 0.1,
        targetsCritical: true, // Critical to prevent EXPLORATION
      });

      const result = selector.selectMode(context);

      const passed = result.mode === PropagationMode.SAFE_HOLD;

      reportBuilder.recordTest(
        "C2",
        "Low coupling triggers SAFE_HOLD",
        passed,
        Date.now() - start,
        `C = 0.4, Mode = ${result.mode}`
      );

      expect(result.mode).toBe(PropagationMode.SAFE_HOLD);
    });

    it("C2.2: SAFE_HOLD when loss > L_threshold_remote (0.4)", () => {
      const start = Date.now();
      const context = createModeContext({
        coupling: 0.9,
        loss: 0.5,
      });

      const result = selector.selectMode(context);

      const passed = result.mode === PropagationMode.SAFE_HOLD;

      reportBuilder.recordTest(
        "C2",
        "High loss triggers SAFE_HOLD",
        passed,
        Date.now() - start,
        `L = 0.5, Mode = ${result.mode}`
      );

      expect(result.mode).toBe(PropagationMode.SAFE_HOLD);
    });

    it("C2.3: SAFE_HOLD when authority exceeded", () => {
      const start = Date.now();
      const context = createModeContext({
        coupling: 0.9,
        loss: 0.1,
        hasAuthority: false,
      });

      const result = selector.selectMode(context);

      const passed =
        result.mode === PropagationMode.SAFE_HOLD &&
        result.forcedByPolicy === true;

      reportBuilder.recordTest(
        "C2",
        "Authority exceeded triggers SAFE_HOLD",
        passed,
        Date.now() - start,
        `hasAuthority = false, Mode = ${result.mode}`
      );

      expect(result.mode).toBe(PropagationMode.SAFE_HOLD);
      expect(result.forcedByPolicy).toBe(true);
    });

    it("C2.4: SAFE_HOLD when policy risk flag is set", () => {
      const start = Date.now();
      // MANUAL_SAFE_HOLD is a forcing flag (see checkForcedSafeHold)
      const context = createModeContext({
        coupling: 0.9,
        loss: 0.1,
        policyFlags: [PolicyFlag.MANUAL_SAFE_HOLD],
      });

      const result = selector.selectMode(context);

      const passed =
        result.mode === PropagationMode.SAFE_HOLD &&
        result.activeFlags.includes(PolicyFlag.MANUAL_SAFE_HOLD);

      reportBuilder.recordTest(
        "C2",
        "Policy flag triggers SAFE_HOLD",
        passed,
        Date.now() - start,
        `Flags = [MANUAL_SAFE_HOLD], Mode = ${result.mode}`
      );

      expect(result.mode).toBe(PropagationMode.SAFE_HOLD);
      expect(result.activeFlags).toContain(PolicyFlag.MANUAL_SAFE_HOLD);
    });

    it("C2.5: SAFE_HOLD when targeting critical with exploration mode", () => {
      const start = Date.now();
      // Exploration on critical targets forces SAFE_HOLD
      const explorationPacket = createBasePacket({
        mode: PropagationMode.EXPLORATION,
        confidence: 0.4
      });
      const context = createModeContext({
        packet: explorationPacket,
        coupling: 0.9,
        loss: 0.1,
        targetsCritical: true,
        explorationAllowed: true,
      });

      const result = selector.selectMode(context);

      const passed =
        result.mode === PropagationMode.SAFE_HOLD &&
        result.forcedByPolicy === true;

      reportBuilder.recordTest(
        "C2",
        "Exploration on critical triggers SAFE_HOLD",
        passed,
        Date.now() - start,
        `Exploration + Critical = true, Mode = ${result.mode}`
      );

      expect(result.mode).toBe(PropagationMode.SAFE_HOLD);
      expect(result.forcedByPolicy).toBe(true);
    });

    it("C2.6: SAFE_HOLD cannot be bypassed by high coupling", () => {
      const start = Date.now();
      // Even with perfect coupling, policy flags force SAFE_HOLD
      const context = createModeContext({
        coupling: 1.0,
        loss: 0.0,
        policyFlags: [PolicyFlag.MANUAL_SAFE_HOLD],
      });

      const result = selector.selectMode(context);

      const passed =
        result.mode === PropagationMode.SAFE_HOLD && result.forcedByPolicy;

      reportBuilder.recordTest(
        "C2",
        "SAFE_HOLD cannot be bypassed",
        passed,
        Date.now() - start,
        `C = 1.0, L = 0.0, but MANUAL_SAFE_HOLD flag present`
      );

      expect(result.mode).toBe(PropagationMode.SAFE_HOLD);
      expect(result.forcedByPolicy).toBe(true);
    });

    it("C2.7: Multiple SAFE_HOLD conditions compound", () => {
      const start = Date.now();
      const context = createModeContext({
        coupling: 0.3,
        loss: 0.6,
        hasAuthority: false,
        policyFlags: [PolicyFlag.CRITICAL_TARGET, PolicyFlag.LOW_CONFIDENCE],
      });

      const result = selector.selectMode(context);

      const passed =
        result.mode === PropagationMode.SAFE_HOLD &&
        result.activeFlags.length >= 2;

      reportBuilder.recordTest(
        "C2",
        "Multiple conditions compound in SAFE_HOLD",
        passed,
        Date.now() - start,
        `Active flags: ${result.activeFlags.join(", ")}`
      );

      expect(result.mode).toBe(PropagationMode.SAFE_HOLD);
      expect(result.activeFlags.length).toBeGreaterThanOrEqual(2);
    });

    it("C2.8: Guardrails enforce SAFE_HOLD invariant", () => {
      const start = Date.now();
      const packet = createBasePacket({ confidence: 0.3 });
      const context = createModeContext({
        packet,
        coupling: 0.3,
        loss: 0.1,
        hasAuthority: false,
      });

      // evaluate() takes only context; packet is in context.packet
      const result = guardrails.evaluate(context);

      const passed = !result.passed && result.evidence !== undefined;

      reportBuilder.recordTest(
        "C2",
        "Guardrails enforce SAFE_HOLD",
        passed,
        Date.now() - start,
        `Passed = ${result.passed}, Evidence captured = ${!!result.evidence}`
      );

      expect(result.passed).toBe(false);
      expect(result.evidence).toBeDefined();
    });
  });

  // ===========================================================================
  // C3: Telemetry Emission
  // ===========================================================================

  describe("C3: Telemetry Emission", () => {
    it("C3.1: Propagation emits coupling metric", () => {
      const start = Date.now();
      const packet = createBasePacket();
      const modeResult: ModeSelectionResult = {
        mode: PropagationMode.LOCAL_COHERENCE,
        effectiveCoupling: 0.81,
        reason: "High coupling, low loss",
        rationale: {
          coupling: 0.9,
          loss: 0.1,
          effectiveCoupling: 0.81,
          distance: 1,
          thresholds: DEFAULT_PROPAGATION_THRESHOLDS,
          modeScores: {
            [PropagationMode.LOCAL_COHERENCE]: 0.9,
            [PropagationMode.REMOTE_COHERENCE]: 0.6,
            [PropagationMode.SAFE_HOLD]: 0.0,
            [PropagationMode.EXPLORATION]: 0.5,
          },
          conditionsChecked: [],
        },
        forcedByPolicy: false,
        activeFlags: [],
      };

      telemetry.recordPropagation(packet, modeResult, "success", 10);

      const metrics = telemetry.getMetrics();
      const passed = metrics.coupling.length > 0;

      reportBuilder.recordTest(
        "C3",
        "Coupling metric emitted",
        passed,
        Date.now() - start,
        `Coupling samples: ${metrics.coupling.length}`
      );

      expect(metrics.coupling.length).toBeGreaterThan(0);
    });

    it("C3.2: Propagation emits loss metric", () => {
      const start = Date.now();
      const packet = createBasePacket();
      const modeResult: ModeSelectionResult = {
        mode: PropagationMode.LOCAL_COHERENCE,
        effectiveCoupling: 0.81,
        reason: "High coupling, low loss",
        rationale: {
          coupling: 0.9,
          loss: 0.1,
          effectiveCoupling: 0.81,
          distance: 1,
          thresholds: DEFAULT_PROPAGATION_THRESHOLDS,
          modeScores: {
            [PropagationMode.LOCAL_COHERENCE]: 0.9,
            [PropagationMode.REMOTE_COHERENCE]: 0.6,
            [PropagationMode.SAFE_HOLD]: 0.0,
            [PropagationMode.EXPLORATION]: 0.5,
          },
          conditionsChecked: [],
        },
        forcedByPolicy: false,
        activeFlags: [],
      };

      telemetry.recordPropagation(packet, modeResult, "success", 10);

      const metrics = telemetry.getMetrics();
      const passed = metrics.loss.length > 0;

      reportBuilder.recordTest(
        "C3",
        "Loss metric emitted",
        passed,
        Date.now() - start,
        `Loss samples: ${metrics.loss.length}`
      );

      expect(metrics.loss.length).toBeGreaterThan(0);
    });

    it("C3.3: Propagation emits duration histogram", () => {
      const start = Date.now();
      const packet = createBasePacket();
      const modeResult: ModeSelectionResult = {
        mode: PropagationMode.LOCAL_COHERENCE,
        effectiveCoupling: 0.81,
        reason: "High coupling, low loss",
        rationale: {
          coupling: 0.9,
          loss: 0.1,
          effectiveCoupling: 0.81,
          distance: 1,
          thresholds: DEFAULT_PROPAGATION_THRESHOLDS,
          modeScores: {
            [PropagationMode.LOCAL_COHERENCE]: 0.9,
            [PropagationMode.REMOTE_COHERENCE]: 0.6,
            [PropagationMode.SAFE_HOLD]: 0.0,
            [PropagationMode.EXPLORATION]: 0.5,
          },
          conditionsChecked: [],
        },
        forcedByPolicy: false,
        activeFlags: [],
      };

      telemetry.recordPropagation(packet, modeResult, "success", 25);

      const metrics = telemetry.getMetrics();
      const passed = metrics.durationCount > 0 && metrics.durationSum > 0;

      reportBuilder.recordTest(
        "C3",
        "Duration histogram populated",
        passed,
        Date.now() - start,
        `Duration count: ${metrics.durationCount}, sum: ${metrics.durationSum}`
      );

      expect(metrics.durationCount).toBeGreaterThan(0);
      expect(metrics.durationSum).toBe(25);
    });

    it("C3.4: Mode selection counter incremented", () => {
      const start = Date.now();
      const packet = createBasePacket();
      const modeResult: ModeSelectionResult = {
        mode: PropagationMode.REMOTE_COHERENCE,
        effectiveCoupling: 0.6,
        reason: "Medium coupling",
        rationale: {
          coupling: 0.7,
          loss: 0.2,
          effectiveCoupling: 0.56,
          distance: 3,
          thresholds: DEFAULT_PROPAGATION_THRESHOLDS,
          modeScores: {
            [PropagationMode.LOCAL_COHERENCE]: 0.0,
            [PropagationMode.REMOTE_COHERENCE]: 0.7,
            [PropagationMode.SAFE_HOLD]: 0.0,
            [PropagationMode.EXPLORATION]: 0.5,
          },
          conditionsChecked: [],
        },
        forcedByPolicy: false,
        activeFlags: [],
      };

      telemetry.recordPropagation(packet, modeResult, "success", 10);

      const metrics = telemetry.getMetrics();
      const passed =
        metrics.modeSelected[PropagationMode.REMOTE_COHERENCE] > 0;

      reportBuilder.recordTest(
        "C3",
        "Mode selection counter incremented",
        passed,
        Date.now() - start,
        `M2 count: ${metrics.modeSelected[PropagationMode.REMOTE_COHERENCE]}`
      );

      expect(
        metrics.modeSelected[PropagationMode.REMOTE_COHERENCE]
      ).toBeGreaterThan(0);
    });

    it("C3.5: SAFE_HOLD trigger counter incremented", () => {
      const start = Date.now();
      const packet = createBasePacket();
      const modeResult: ModeSelectionResult = {
        mode: PropagationMode.SAFE_HOLD,
        effectiveCoupling: 0.3,
        reason: "Low coupling",
        rationale: {
          coupling: 0.4,
          loss: 0.25,
          effectiveCoupling: 0.3,
          distance: 1,
          thresholds: DEFAULT_PROPAGATION_THRESHOLDS,
          modeScores: {
            [PropagationMode.LOCAL_COHERENCE]: 0.0,
            [PropagationMode.REMOTE_COHERENCE]: 0.0,
            [PropagationMode.SAFE_HOLD]: 1.0,
            [PropagationMode.EXPLORATION]: 0.0,
          },
          conditionsChecked: [],
        },
        forcedByPolicy: false,
        activeFlags: [PolicyFlag.LOW_CONFIDENCE],
      };

      telemetry.recordPropagation(packet, modeResult, "held", 10);

      const metrics = telemetry.getMetrics();
      const passed = Object.values(metrics.safeHoldTriggered).some(
        (v) => v > 0
      );

      reportBuilder.recordTest(
        "C3",
        "SAFE_HOLD trigger counter incremented",
        passed,
        Date.now() - start,
        `SAFE_HOLD reasons: ${JSON.stringify(metrics.safeHoldTriggered)}`
      );

      expect(Object.values(metrics.safeHoldTriggered).some((v) => v > 0)).toBe(
        true
      );
    });

    it("C3.6: Prometheus export contains required metrics", () => {
      const start = Date.now();
      const packet = createBasePacket();
      const modeResult: ModeSelectionResult = {
        mode: PropagationMode.LOCAL_COHERENCE,
        effectiveCoupling: 0.81,
        reason: "High coupling, low loss",
        rationale: {
          coupling: 0.9,
          loss: 0.1,
          effectiveCoupling: 0.81,
          distance: 1,
          thresholds: DEFAULT_PROPAGATION_THRESHOLDS,
          modeScores: {
            [PropagationMode.LOCAL_COHERENCE]: 0.9,
            [PropagationMode.REMOTE_COHERENCE]: 0.6,
            [PropagationMode.SAFE_HOLD]: 0.0,
            [PropagationMode.EXPLORATION]: 0.5,
          },
          conditionsChecked: [],
        },
        forcedByPolicy: false,
        activeFlags: [],
      };

      telemetry.recordPropagation(packet, modeResult, "success", 10);

      const prometheus = telemetry.exportPrometheus();

      const requiredMetrics = [
        "propagation_coupling",
        "propagation_loss",
        "propagation_duration_ms",
        "propagation_mode_selected_total",
        "propagation_safe_hold_triggered_total",
        "propagation_fallback_executed_total",
      ];

      const passed = requiredMetrics.every((m) => prometheus.includes(m));

      reportBuilder.recordTest(
        "C3",
        "Prometheus export contains required metrics",
        passed,
        Date.now() - start,
        `Missing: ${requiredMetrics.filter((m) => !prometheus.includes(m)).join(", ") || "none"}`
      );

      for (const metric of requiredMetrics) {
        expect(prometheus).toContain(metric);
      }
    });

    it("C3.7: Telemetry event has correct structure", () => {
      const start = Date.now();
      const packet = createBasePacket();
      const modeResult: ModeSelectionResult = {
        mode: PropagationMode.LOCAL_COHERENCE,
        effectiveCoupling: 0.81,
        reason: "High coupling, low loss",
        rationale: {
          coupling: 0.9,
          loss: 0.1,
          effectiveCoupling: 0.81,
          distance: 1,
          thresholds: DEFAULT_PROPAGATION_THRESHOLDS,
          modeScores: {
            [PropagationMode.LOCAL_COHERENCE]: 0.9,
            [PropagationMode.REMOTE_COHERENCE]: 0.6,
            [PropagationMode.SAFE_HOLD]: 0.0,
            [PropagationMode.EXPLORATION]: 0.5,
          },
          conditionsChecked: [],
        },
        forcedByPolicy: false,
        activeFlags: [],
      };

      const event = telemetry.recordPropagation(
        packet,
        modeResult,
        "success",
        15
      );

      const passed =
        event.event_type === "PROPAGATION_TELEMETRY" &&
        event.intent_id === packet.intent_id &&
        typeof event.metrics.coupling === "number" &&
        typeof event.metrics.loss === "number" &&
        typeof event.duration_ms === "number";

      reportBuilder.recordTest(
        "C3",
        "Telemetry event structure correct",
        passed,
        Date.now() - start,
        `Event type: ${event.event_type}`
      );

      expect(event.event_type).toBe("PROPAGATION_TELEMETRY");
      expect(event.intent_id).toBe(packet.intent_id);
      expect(typeof event.metrics.coupling).toBe("number");
      expect(typeof event.metrics.loss).toBe("number");
    });
  });

  // ===========================================================================
  // C4: Rationale Generation
  // ===========================================================================

  describe("C4: Rationale Generation", () => {
    it("C4.1: Rationale includes coupling value", () => {
      const start = Date.now();
      const context = createModeContext({
        coupling: 0.85,
        loss: 0.1,
      });

      const result = selector.selectMode(context);

      const passed =
        result.rationale !== undefined &&
        typeof result.rationale.coupling === "number";

      reportBuilder.recordTest(
        "C4",
        "Rationale includes coupling",
        passed,
        Date.now() - start,
        `Coupling in rationale: ${result.rationale.coupling}`
      );

      expect(result.rationale.coupling).toBe(0.85);
    });

    it("C4.2: Rationale includes loss value", () => {
      const start = Date.now();
      const context = createModeContext({
        coupling: 0.85,
        loss: 0.15,
      });

      const result = selector.selectMode(context);

      const passed =
        result.rationale !== undefined &&
        typeof result.rationale.loss === "number";

      reportBuilder.recordTest(
        "C4",
        "Rationale includes loss",
        passed,
        Date.now() - start,
        `Loss in rationale: ${result.rationale.loss}`
      );

      expect(result.rationale.loss).toBe(0.15);
    });

    it("C4.3: Rationale includes effective coupling", () => {
      const start = Date.now();
      const context = createModeContext({
        coupling: 0.8,
        loss: 0.2,
      });

      const result = selector.selectMode(context);

      const passed =
        result.rationale !== undefined &&
        typeof result.rationale.effectiveCoupling === "number";

      // C_eff = C * (1 - L) = 0.8 * 0.8 = 0.64
      const expectedEffective = 0.8 * (1 - 0.2);

      reportBuilder.recordTest(
        "C4",
        "Rationale includes effective coupling",
        passed,
        Date.now() - start,
        `C_eff = ${result.rationale.effectiveCoupling}, expected ~${expectedEffective}`
      );

      expect(result.rationale.effectiveCoupling).toBeCloseTo(expectedEffective);
    });

    it("C4.4: Rationale includes thresholds used", () => {
      const start = Date.now();
      const context = createModeContext();

      const result = selector.selectMode(context);

      const passed =
        result.rationale.thresholds !== undefined &&
        typeof result.rationale.thresholds.C_threshold_local === "number" &&
        typeof result.rationale.thresholds.L_threshold_local === "number";

      reportBuilder.recordTest(
        "C4",
        "Rationale includes thresholds",
        passed,
        Date.now() - start,
        `C_local = ${result.rationale.thresholds.C_threshold_local}, L_local = ${result.rationale.thresholds.L_threshold_local}`
      );

      expect(result.rationale.thresholds.C_threshold_local).toBe(0.8);
      expect(result.rationale.thresholds.L_threshold_local).toBe(0.2);
    });

    it("C4.5: Rationale includes mode scores", () => {
      const start = Date.now();
      const context = createModeContext();

      const result = selector.selectMode(context);

      const passed =
        result.rationale.modeScores !== undefined &&
        PropagationMode.LOCAL_COHERENCE in result.rationale.modeScores &&
        PropagationMode.REMOTE_COHERENCE in result.rationale.modeScores &&
        PropagationMode.SAFE_HOLD in result.rationale.modeScores &&
        PropagationMode.EXPLORATION in result.rationale.modeScores;

      reportBuilder.recordTest(
        "C4",
        "Rationale includes mode scores",
        passed,
        Date.now() - start,
        `Scores: ${JSON.stringify(result.rationale.modeScores)}`
      );

      expect(result.rationale.modeScores).toHaveProperty(
        PropagationMode.LOCAL_COHERENCE
      );
      expect(result.rationale.modeScores).toHaveProperty(
        PropagationMode.REMOTE_COHERENCE
      );
      expect(result.rationale.modeScores).toHaveProperty(
        PropagationMode.SAFE_HOLD
      );
      expect(result.rationale.modeScores).toHaveProperty(
        PropagationMode.EXPLORATION
      );
    });

    it("C4.6: Human-readable reason provided", () => {
      const start = Date.now();
      const context = createModeContext({
        coupling: 0.9,
        loss: 0.1,
      });

      const result = selector.selectMode(context);

      const passed =
        typeof result.reason === "string" && result.reason.length > 0;

      reportBuilder.recordTest(
        "C4",
        "Human-readable reason provided",
        passed,
        Date.now() - start,
        `Reason: "${result.reason}"`
      );

      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    });

    it("C4.7: Active policy flags listed", () => {
      const start = Date.now();
      const context = createModeContext({
        coupling: 0.9,
        loss: 0.1,
        policyFlags: [PolicyFlag.CRITICAL_TARGET],
      });

      const result = selector.selectMode(context);

      const passed = Array.isArray(result.activeFlags);

      reportBuilder.recordTest(
        "C4",
        "Active policy flags listed",
        passed,
        Date.now() - start,
        `Active flags: ${result.activeFlags.join(", ") || "none"}`
      );

      expect(Array.isArray(result.activeFlags)).toBe(true);
    });
  });

  // ===========================================================================
  // C5: Fallback Execution
  // ===========================================================================

  describe("C5: Fallback Execution", () => {
    it("C5.1: Intent Packet requires fallback_plan", () => {
      const start = Date.now();
      const packet = createBasePacket();

      const validation = validateIntentPacket(packet);

      const passed =
        validation.valid && packet.fallback_plan !== undefined;

      reportBuilder.recordTest(
        "C5",
        "Intent Packet requires fallback_plan",
        passed,
        Date.now() - start,
        `Fallback strategy: ${packet.fallback_plan?.strategy}`
      );

      expect(validation.valid).toBe(true);
      expect(packet.fallback_plan).toBeDefined();
    });

    it("C5.2: ROLLBACK fallback strategy accepted", () => {
      const start = Date.now();
      const packet = createBasePacket({
        fallback_plan: {
          strategy: FallbackStrategy.ROLLBACK,
          escalation_target: "supervisor",
        },
      });

      const validation = validateIntentPacket(packet);

      const passed =
        validation.valid &&
        packet.fallback_plan.strategy === FallbackStrategy.ROLLBACK;

      reportBuilder.recordTest(
        "C5",
        "ROLLBACK strategy accepted",
        passed,
        Date.now() - start,
        `Strategy: ${packet.fallback_plan.strategy}`
      );

      expect(validation.valid).toBe(true);
      expect(packet.fallback_plan.strategy).toBe(FallbackStrategy.ROLLBACK);
    });

    it("C5.3: COMPENSATE fallback strategy accepted", () => {
      const start = Date.now();
      const packet = createBasePacket({
        fallback_plan: {
          strategy: FallbackStrategy.COMPENSATE,
          escalation_target: "supervisor",
        },
      });

      const validation = validateIntentPacket(packet);

      const passed =
        validation.valid &&
        packet.fallback_plan.strategy === FallbackStrategy.COMPENSATE;

      reportBuilder.recordTest(
        "C5",
        "COMPENSATE strategy accepted",
        passed,
        Date.now() - start,
        `Strategy: ${packet.fallback_plan.strategy}`
      );

      expect(validation.valid).toBe(true);
      expect(packet.fallback_plan.strategy).toBe(FallbackStrategy.COMPENSATE);
    });

    it("C5.4: ESCALATE fallback strategy accepted", () => {
      const start = Date.now();
      const packet = createBasePacket({
        fallback_plan: {
          strategy: FallbackStrategy.ESCALATE,
          escalation_target: "on-call-engineer",
        },
      });

      const validation = validateIntentPacket(packet);

      const passed =
        validation.valid &&
        packet.fallback_plan.strategy === FallbackStrategy.ESCALATE;

      reportBuilder.recordTest(
        "C5",
        "ESCALATE strategy accepted",
        passed,
        Date.now() - start,
        `Strategy: ${packet.fallback_plan.strategy}`
      );

      expect(validation.valid).toBe(true);
      expect(packet.fallback_plan.strategy).toBe(FallbackStrategy.ESCALATE);
    });

    it("C5.5: ABORT fallback strategy accepted", () => {
      const start = Date.now();
      const packet = createBasePacket({
        fallback_plan: {
          strategy: FallbackStrategy.ABORT,
          escalation_target: "supervisor",
        },
      });

      const validation = validateIntentPacket(packet);

      const passed =
        validation.valid &&
        packet.fallback_plan.strategy === FallbackStrategy.ABORT;

      reportBuilder.recordTest(
        "C5",
        "ABORT strategy accepted",
        passed,
        Date.now() - start,
        `Strategy: ${packet.fallback_plan.strategy}`
      );

      expect(validation.valid).toBe(true);
      expect(packet.fallback_plan.strategy).toBe(FallbackStrategy.ABORT);
    });

    it("C5.6: Fallback execution tracked in telemetry", () => {
      const start = Date.now();

      telemetry.recordFallback(FallbackStrategy.ROLLBACK, true, 100);

      const metrics = telemetry.getMetrics();
      const passed = metrics.fallbackExecuted[FallbackStrategy.ROLLBACK] > 0;

      reportBuilder.recordTest(
        "C5",
        "Fallback execution tracked",
        passed,
        Date.now() - start,
        `ROLLBACK count: ${metrics.fallbackExecuted[FallbackStrategy.ROLLBACK]}`
      );

      expect(
        metrics.fallbackExecuted[FallbackStrategy.ROLLBACK]
      ).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // C6: Human Escalation
  // ===========================================================================

  describe("C6: Human Escalation", () => {
    it("C6.1: SAFE_HOLD captures evidence payload", () => {
      const start = Date.now();
      const packet = createBasePacket({ confidence: 0.3 });
      const context = createModeContext({
        packet,
        coupling: 0.3,
        loss: 0.2,
        hasAuthority: false,
      });

      const result = guardrails.evaluate(context);

      const passed =
        result.evidence !== undefined &&
        result.evidence.evidenceId !== undefined &&
        result.evidence.intentId === packet.intent_id;

      reportBuilder.recordTest(
        "C6",
        "Evidence payload captured",
        passed,
        Date.now() - start,
        `Evidence ID: ${result.evidence?.evidenceId}`
      );

      expect(result.evidence).toBeDefined();
      expect(result.evidence?.evidenceId).toBeDefined();
      expect(result.evidence?.intentId).toBe(packet.intent_id);
    });

    it("C6.2: Evidence includes coupling/loss context", () => {
      const start = Date.now();
      const packet = createBasePacket({ confidence: 0.3 });
      const context = createModeContext({
        packet,
        coupling: 0.35,
        loss: 0.25,
        hasAuthority: false,
      });

      const result = guardrails.evaluate(context);

      const passed =
        result.evidence?.context.coupling === 0.35 &&
        result.evidence?.context.loss === 0.25;

      reportBuilder.recordTest(
        "C6",
        "Evidence includes metrics context",
        passed,
        Date.now() - start,
        `C = ${result.evidence?.context.coupling}, L = ${result.evidence?.context.loss}`
      );

      expect(result.evidence?.context.coupling).toBe(0.35);
      expect(result.evidence?.context.loss).toBe(0.25);
    });

    it("C6.3: Evidence includes active policy flags", () => {
      const start = Date.now();
      const packet = createBasePacket({ confidence: 0.3 });
      const context = createModeContext({
        packet,
        coupling: 0.9,
        loss: 0.1,
        hasAuthority: false,
        policyFlags: [PolicyFlag.AUTHORITY_EXCEEDED],
      });

      const result = guardrails.evaluate(context);

      const passed =
        Array.isArray(result.evidence?.activeFlags) &&
        result.evidence.activeFlags.length > 0;

      reportBuilder.recordTest(
        "C6",
        "Evidence includes policy flags",
        passed,
        Date.now() - start,
        `Active flags: ${result.evidence?.activeFlags.join(", ")}`
      );

      expect(result.evidence?.activeFlags).toBeDefined();
      expect(result.evidence?.activeFlags.length).toBeGreaterThan(0);
    });

    it("C6.4: Evidence includes risk level assessment", () => {
      const start = Date.now();
      const packet = createBasePacket({ confidence: 0.3 });
      const context = createModeContext({
        packet,
        coupling: 0.3,
        loss: 0.2,
        hasAuthority: false,
      });

      const result = guardrails.evaluate(context);

      const passed =
        result.evidence?.riskLevel !== undefined &&
        Object.values(RiskLevel).includes(result.evidence.riskLevel);

      reportBuilder.recordTest(
        "C6",
        "Risk level assessed",
        passed,
        Date.now() - start,
        `Risk level: ${result.evidence?.riskLevel}`
      );

      expect(result.evidence?.riskLevel).toBeDefined();
      expect(Object.values(RiskLevel)).toContain(result.evidence?.riskLevel);
    });

    it("C6.5: Escalation request created for SAFE_HOLD", () => {
      const start = Date.now();
      const packet = createBasePacket({ confidence: 0.3 });
      const context = createModeContext({
        packet,
        coupling: 0.3,
        loss: 0.2,
        hasAuthority: false,
      });

      const result = guardrails.evaluate(context);

      const passed =
        result.escalation !== undefined &&
        result.escalation.escalationId !== undefined;

      reportBuilder.recordTest(
        "C6",
        "Escalation request created",
        passed,
        Date.now() - start,
        `Escalation ID: ${result.escalation?.escalationId}`
      );

      expect(result.escalation).toBeDefined();
      expect(result.escalation?.escalationId).toBeDefined();
    });

    it("C6.6: Escalation includes suggested actions", () => {
      const start = Date.now();
      const packet = createBasePacket({ confidence: 0.3 });
      const context = createModeContext({
        packet,
        coupling: 0.3,
        loss: 0.2,
        hasAuthority: false,
      });

      const result = guardrails.evaluate(context);

      const passed =
        result.escalation?.suggestedActions !== undefined &&
        result.escalation.suggestedActions.length > 0;

      reportBuilder.recordTest(
        "C6",
        "Escalation includes suggested actions",
        passed,
        Date.now() - start,
        `Actions: ${result.escalation?.suggestedActions.map((a) => a.label).join(", ")}`
      );

      expect(result.escalation?.suggestedActions).toBeDefined();
      expect(result.escalation?.suggestedActions.length).toBeGreaterThan(0);
    });

    it("C6.7: Escalation response can approve intent", () => {
      const start = Date.now();
      const packet = createBasePacket({ confidence: 0.3 });
      const context = createModeContext({
        packet,
        coupling: 0.3,
        loss: 0.2,
        hasAuthority: false,
      });

      const evalResult = guardrails.evaluate(context);

      const response = {
        escalationId: evalResult.escalation!.escalationId,
        responderId: "supervisor-001",
        responderAuthority: "SUPERVISOR",
        action: "approve",
        approved: true,
        respondedAt: new Date().toISOString(),
      };

      // processEscalationResponse takes only the response
      const processResult = guardrails.processEscalationResponse(response);

      const passed =
        processResult.accepted === true &&
        processResult.updatedEscalation?.status === "APPROVED";

      reportBuilder.recordTest(
        "C6",
        "Escalation response approval works",
        passed,
        Date.now() - start,
        `Status: ${processResult.updatedEscalation?.status}`
      );

      expect(processResult.accepted).toBe(true);
      expect(processResult.updatedEscalation?.status).toBe("APPROVED");
    });

    it("C6.8: Escalation response can reject intent", () => {
      const start = Date.now();
      const packet = createBasePacket({ confidence: 0.3 });
      const context = createModeContext({
        packet,
        coupling: 0.3,
        loss: 0.2,
        hasAuthority: false,
      });

      const evalResult = guardrails.evaluate(context);

      const response = {
        escalationId: evalResult.escalation!.escalationId,
        responderId: "supervisor-001",
        responderAuthority: "SUPERVISOR",
        action: "reject",
        approved: false,
        comment: "Too risky",
        respondedAt: new Date().toISOString(),
      };

      // processEscalationResponse takes only the response
      const processResult = guardrails.processEscalationResponse(response);

      const passed =
        processResult.accepted === true && // Response was accepted
        processResult.updatedEscalation?.status === "REJECTED"; // But intent rejected

      reportBuilder.recordTest(
        "C6",
        "Escalation response rejection works",
        passed,
        Date.now() - start,
        `Status: ${processResult.updatedEscalation?.status}`
      );

      expect(processResult.accepted).toBe(true);
      expect(processResult.updatedEscalation?.status).toBe("REJECTED");
    });
  });

  // ===========================================================================
  // Conformance Report Generation
  // ===========================================================================

  afterAll(() => {
    const report = reportBuilder.finalize();

    // Output conformance report as JSON artifact
    console.log("\n" + "=".repeat(80));
    console.log("PROPAGATION MODEL CONFORMANCE REPORT");
    console.log("=".repeat(80));
    console.log(`Version: ${report.version}`);
    console.log(`Timestamp: ${report.timestamp}`);
    console.log(`Level Achieved: ${report.level_achieved}`);
    console.log(
      `Tests: ${report.passed_tests}/${report.total_tests} passed`
    );
    console.log("-".repeat(80));

    for (const criterion of report.criteria) {
      const status = criterion.passed ? "[PASS]" : "[FAIL]";
      console.log(`\n${criterion.id}: ${criterion.name} ${status}`);
      console.log(`  Level: ${criterion.level}`);
      console.log(`  ${criterion.description}`);
      console.log(
        `  Tests: ${criterion.tests.filter((t) => t.passed).length}/${criterion.tests.length}`
      );

      for (const test of criterion.tests) {
        const testStatus = test.passed ? "[OK]" : "[FAIL]";
        console.log(`    ${testStatus} ${test.name} (${test.duration_ms}ms)`);
        if (test.details) {
          console.log(`         ${test.details}`);
        }
      }
    }

    console.log("\n" + "=".repeat(80));
    console.log(report.summary);
    console.log("=".repeat(80) + "\n");

    // Assert overall conformance
    expect(report.level_achieved).not.toBe("NONE");
  });
});
