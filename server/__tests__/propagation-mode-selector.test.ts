/**
 * Propagation Mode Selector Test Suite
 *
 * GhostOS Propagation Model - Mode Selection Tests
 * See docs/propagation-model.md for specification
 *
 * Issue: #164 - Propagation Mode Selection Engine
 * Epic: #161 - GhostOS Propagation Model
 *
 * Coverage targets:
 * - Mode selection determinism (same inputs -> same mode)
 * - Decision boundary testing
 * - Policy flag handling
 * - Fallback behavior
 * - Environment configuration
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  PropagationModeSelector,
  calculateCoupling,
  calculateLoss,
  calculateEffectiveCoupling,
  selectPropagationMode,
  buildModeContext,
  getPropagationModeSelector,
  resetPropagationModeSelector,
} from "../services/propagation-mode-selector";
import {
  PropagationMode,
  AuthorityLevel,
  FallbackStrategy,
  DEFAULT_PROPAGATION_THRESHOLDS,
} from "../../shared/types/intent-packet";
import {
  ModeSelectionContext,
  PolicyFlag,
  CouplingInputs,
  LossInputs,
  DEFAULT_COUPLING_WEIGHTS,
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

const createTestContext = (overrides: Partial<ModeSelectionContext> = {}): ModeSelectionContext => ({
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

// =============================================================================
// COUPLING CALCULATION TESTS
// =============================================================================

describe("Coupling Calculation", () => {
  it("should calculate coupling with default weights", () => {
    const inputs: CouplingInputs = {
      relevance: 0.8,
      capabilityMatch: 0.9,
      scopeOverlap: 0.7,
    };

    const coupling = calculateCoupling(inputs);

    // Expected: 0.4 * 0.8 + 0.3 * 0.9 + 0.3 * 0.7 = 0.32 + 0.27 + 0.21 = 0.8
    expect(coupling).toBeCloseTo(0.8, 2);
  });

  it("should calculate coupling with custom weights", () => {
    const inputs: CouplingInputs = {
      relevance: 1.0,
      capabilityMatch: 0.0,
      scopeOverlap: 0.0,
    };

    const weights = {
      relevance: 1.0,
      capabilityMatch: 0.0,
      scopeOverlap: 0.0,
    };

    const coupling = calculateCoupling(inputs, weights);
    expect(coupling).toBe(1.0);
  });

  it("should normalize weights", () => {
    const inputs: CouplingInputs = {
      relevance: 1.0,
      capabilityMatch: 1.0,
      scopeOverlap: 1.0,
    };

    const weights = {
      relevance: 2.0,
      capabilityMatch: 2.0,
      scopeOverlap: 2.0,
    };

    const coupling = calculateCoupling(inputs, weights);
    expect(coupling).toBe(1.0);
  });

  it("should clamp coupling to [0, 1]", () => {
    const lowInputs: CouplingInputs = {
      relevance: 0,
      capabilityMatch: 0,
      scopeOverlap: 0,
    };

    const highInputs: CouplingInputs = {
      relevance: 1,
      capabilityMatch: 1,
      scopeOverlap: 1,
    };

    expect(calculateCoupling(lowInputs)).toBe(0);
    expect(calculateCoupling(highInputs)).toBe(1);
  });
});

// =============================================================================
// LOSS CALCULATION TESTS
// =============================================================================

describe("Loss Calculation", () => {
  it("should calculate loss with default d0", () => {
    const inputs: LossInputs = {
      baseLoss: 0.1,
      distance: 5,
      transformationLoss: 0.1,
    };

    const loss = calculateLoss(inputs);

    // Expected: 0.1 + min(1, 5/10) + 0.1 = 0.1 + 0.5 + 0.1 = 0.7
    expect(loss).toBeCloseTo(0.7, 2);
  });

  it("should cap distance loss at 1.0", () => {
    const inputs: LossInputs = {
      baseLoss: 0,
      distance: 100,
      transformationLoss: 0,
    };

    const loss = calculateLoss(inputs, 10);

    // Distance loss = min(1, 100/10) = 1.0
    expect(loss).toBe(1.0);
  });

  it("should calculate loss with custom d0", () => {
    const inputs: LossInputs = {
      baseLoss: 0,
      distance: 5,
      transformationLoss: 0,
    };

    const loss = calculateLoss(inputs, 5);

    // Distance loss = min(1, 5/5) = 1.0
    expect(loss).toBe(1.0);
  });

  it("should clamp total loss to [0, 1]", () => {
    const highInputs: LossInputs = {
      baseLoss: 0.5,
      distance: 10,
      transformationLoss: 0.5,
    };

    const loss = calculateLoss(highInputs, 10);
    expect(loss).toBeLessThanOrEqual(1);
  });
});

// =============================================================================
// EFFECTIVE COUPLING TESTS
// =============================================================================

describe("Effective Coupling", () => {
  it("should calculate effective coupling correctly", () => {
    expect(calculateEffectiveCoupling(1.0, 0.0)).toBe(1.0);
    expect(calculateEffectiveCoupling(1.0, 0.5)).toBe(0.5);
    expect(calculateEffectiveCoupling(0.8, 0.2)).toBeCloseTo(0.64, 2);
    expect(calculateEffectiveCoupling(0.5, 1.0)).toBe(0);
  });
});

// =============================================================================
// MODE SELECTION - LOCAL_COHERENCE TESTS
// =============================================================================

describe("Mode Selection - LOCAL_COHERENCE", () => {
  let selector: PropagationModeSelector;

  beforeEach(() => {
    selector = new PropagationModeSelector();
  });

  it("should select LOCAL_COHERENCE with high coupling and low loss", () => {
    const context = createTestContext({
      coupling: 0.9,
      loss: 0.1,
      distance: 0,
    });

    const result = selector.selectMode(context);

    expect(result.mode).toBe(PropagationMode.LOCAL_COHERENCE);
    expect(result.forcedByPolicy).toBe(false);
  });

  it("should select LOCAL_COHERENCE at exact thresholds", () => {
    const context = createTestContext({
      coupling: 0.8, // Exactly at C_threshold_local
      loss: 0.2, // Exactly at L_threshold_local
      distance: 1, // Exactly at d_local
    });

    const result = selector.selectMode(context);

    expect(result.mode).toBe(PropagationMode.LOCAL_COHERENCE);
  });

  it("should NOT select LOCAL_COHERENCE with low coupling", () => {
    const context = createTestContext({
      coupling: 0.7, // Below C_threshold_local (0.8)
      loss: 0.1,
      distance: 0,
    });

    const result = selector.selectMode(context);

    expect(result.mode).not.toBe(PropagationMode.LOCAL_COHERENCE);
  });

  it("should NOT select LOCAL_COHERENCE with high loss", () => {
    const context = createTestContext({
      coupling: 0.9,
      loss: 0.3, // Above L_threshold_local (0.2)
      distance: 0,
    });

    const result = selector.selectMode(context);

    expect(result.mode).not.toBe(PropagationMode.LOCAL_COHERENCE);
  });

  it("should NOT select LOCAL_COHERENCE with high distance", () => {
    const context = createTestContext({
      coupling: 0.9,
      loss: 0.1,
      distance: 5, // Above d_local (1)
    });

    const result = selector.selectMode(context);

    expect(result.mode).not.toBe(PropagationMode.LOCAL_COHERENCE);
  });
});

// =============================================================================
// MODE SELECTION - REMOTE_COHERENCE TESTS
// =============================================================================

describe("Mode Selection - REMOTE_COHERENCE", () => {
  let selector: PropagationModeSelector;

  beforeEach(() => {
    selector = new PropagationModeSelector();
  });

  it("should select REMOTE_COHERENCE with moderate coupling and distance", () => {
    const context = createTestContext({
      coupling: 0.6,
      loss: 0.3,
      distance: 5,
    });

    const result = selector.selectMode(context);

    expect(result.mode).toBe(PropagationMode.REMOTE_COHERENCE);
  });

  it("should select REMOTE_COHERENCE at threshold boundaries", () => {
    const context = createTestContext({
      coupling: 0.5, // Exactly at C_threshold_remote
      loss: 0.4, // Exactly at L_threshold_remote
      distance: 2,
    });

    const result = selector.selectMode(context);

    expect(result.mode).toBe(PropagationMode.REMOTE_COHERENCE);
  });

  it("should prefer LOCAL_COHERENCE over REMOTE_COHERENCE when both conditions met", () => {
    const context = createTestContext({
      coupling: 0.9,
      loss: 0.1,
      distance: 0, // Within d_local
    });

    const result = selector.selectMode(context);

    expect(result.mode).toBe(PropagationMode.LOCAL_COHERENCE);
  });
});

// =============================================================================
// MODE SELECTION - SAFE_HOLD TESTS
// =============================================================================

describe("Mode Selection - SAFE_HOLD", () => {
  let selector: PropagationModeSelector;

  beforeEach(() => {
    selector = new PropagationModeSelector();
  });

  it("should select SAFE_HOLD with low coupling", () => {
    const context = createTestContext({
      coupling: 0.3, // Below C_threshold_remote (0.5)
      loss: 0.2,
      distance: 0,
    });

    const result = selector.selectMode(context);

    expect(result.mode).toBe(PropagationMode.SAFE_HOLD);
    expect(result.reason).toContain("coupling");
  });

  it("should select SAFE_HOLD with high loss", () => {
    const context = createTestContext({
      coupling: 0.9,
      loss: 0.6, // Above L_threshold_remote (0.4)
      distance: 0,
    });

    const result = selector.selectMode(context);

    expect(result.mode).toBe(PropagationMode.SAFE_HOLD);
    expect(result.reason).toContain("loss");
  });

  it("should select SAFE_HOLD when authority is insufficient", () => {
    const context = createTestContext({
      coupling: 0.9,
      loss: 0.1,
      hasAuthority: false,
    });

    const result = selector.selectMode(context);

    expect(result.mode).toBe(PropagationMode.SAFE_HOLD);
    expect(result.forcedByPolicy).toBe(true);
    expect(result.reason).toContain("authority");
  });

  it("should select SAFE_HOLD when explicitly requested", () => {
    const context = createTestContext({
      packet: createTestPacket({ mode: PropagationMode.SAFE_HOLD }),
      coupling: 0.9,
      loss: 0.1,
    });

    const result = selector.selectMode(context);

    expect(result.mode).toBe(PropagationMode.SAFE_HOLD);
    expect(result.forcedByPolicy).toBe(true);
  });

  it("should include policy flags in SAFE_HOLD result", () => {
    const context = createTestContext({
      coupling: 0.3,
      loss: 0.1,
      policyFlags: [PolicyFlag.QUORUM_REQUIRED],
    });

    const result = selector.selectMode(context);

    expect(result.mode).toBe(PropagationMode.SAFE_HOLD);
    expect(result.activeFlags).toContain(PolicyFlag.QUORUM_REQUIRED);
  });
});

// =============================================================================
// MODE SELECTION - EXPLORATION TESTS
// =============================================================================

describe("Mode Selection - EXPLORATION", () => {
  let selector: PropagationModeSelector;

  beforeEach(() => {
    selector = new PropagationModeSelector();
  });

  it("should select EXPLORATION when requested and conditions met", () => {
    const context = createTestContext({
      packet: createTestPacket({ mode: PropagationMode.EXPLORATION }),
      coupling: 0.6,
      loss: 0.2,
      targetsCritical: false,
      explorationAllowed: true,
    });

    const result = selector.selectMode(context);

    expect(result.mode).toBe(PropagationMode.EXPLORATION);
  });

  it("should NOT select EXPLORATION with critical targets", () => {
    const context = createTestContext({
      packet: createTestPacket({ mode: PropagationMode.EXPLORATION }),
      coupling: 0.6,
      loss: 0.2,
      targetsCritical: true,
    });

    const result = selector.selectMode(context);

    expect(result.mode).toBe(PropagationMode.SAFE_HOLD);
    expect(result.activeFlags).toContain(PolicyFlag.CRITICAL_TARGET);
  });

  it("should NOT select EXPLORATION when disabled", () => {
    const context = createTestContext({
      packet: createTestPacket({ mode: PropagationMode.EXPLORATION }),
      coupling: 0.6,
      loss: 0.2,
      explorationAllowed: false,
    });

    const result = selector.selectMode(context);

    expect(result.mode).toBe(PropagationMode.SAFE_HOLD);
    expect(result.activeFlags).toContain(PolicyFlag.EXPLORATION_DISABLED);
  });
});

// =============================================================================
// DECISION DETERMINISM TESTS
// =============================================================================

describe("Decision Determinism", () => {
  let selector: PropagationModeSelector;

  beforeEach(() => {
    selector = new PropagationModeSelector();
  });

  it("should produce same result for same inputs", () => {
    const context = createTestContext({
      coupling: 0.75,
      loss: 0.25,
      distance: 2,
    });

    const result1 = selector.selectMode(context);
    const result2 = selector.selectMode(context);
    const result3 = selector.selectMode(context);

    expect(result1.mode).toBe(result2.mode);
    expect(result2.mode).toBe(result3.mode);
    expect(result1.effectiveCoupling).toBe(result2.effectiveCoupling);
  });

  it("should produce consistent rationale", () => {
    const context = createTestContext({
      coupling: 0.6,
      loss: 0.3,
      distance: 3,
    });

    const result1 = selector.selectMode(context);
    const result2 = selector.selectMode(context);

    expect(result1.rationale.coupling).toBe(result2.rationale.coupling);
    expect(result1.rationale.loss).toBe(result2.rationale.loss);
    expect(result1.rationale.modeScores).toEqual(result2.rationale.modeScores);
  });
});

// =============================================================================
// RATIONALE TESTS
// =============================================================================

describe("Mode Selection Rationale", () => {
  let selector: PropagationModeSelector;

  beforeEach(() => {
    selector = new PropagationModeSelector();
  });

  it("should include all scoring inputs in rationale", () => {
    const context = createTestContext({
      coupling: 0.8,
      loss: 0.15,
      distance: 1,
    });

    const result = selector.selectMode(context);

    expect(result.rationale.coupling).toBe(0.8);
    expect(result.rationale.loss).toBe(0.15);
    expect(result.rationale.distance).toBe(1);
    expect(result.rationale.effectiveCoupling).toBeCloseTo(0.68, 2);
  });

  it("should include thresholds used", () => {
    const context = createTestContext();
    const result = selector.selectMode(context);

    expect(result.rationale.thresholds).toEqual(DEFAULT_PROPAGATION_THRESHOLDS);
  });

  it("should include mode scores", () => {
    const context = createTestContext();
    const result = selector.selectMode(context);

    expect(result.rationale.modeScores).toHaveProperty(PropagationMode.LOCAL_COHERENCE);
    expect(result.rationale.modeScores).toHaveProperty(PropagationMode.REMOTE_COHERENCE);
    expect(result.rationale.modeScores).toHaveProperty(PropagationMode.SAFE_HOLD);
    expect(result.rationale.modeScores).toHaveProperty(PropagationMode.EXPLORATION);
  });

  it("should include conditions checked", () => {
    const context = createTestContext();
    const result = selector.selectMode(context);

    expect(result.rationale.conditionsChecked.length).toBeGreaterThan(0);
    expect(result.rationale.conditionsChecked[0]).toHaveProperty("mode");
    expect(result.rationale.conditionsChecked[0]).toHaveProperty("condition");
    expect(result.rationale.conditionsChecked[0]).toHaveProperty("passed");
  });
});

// =============================================================================
// POLICY FLAG TESTS
// =============================================================================

describe("Policy Flag Handling", () => {
  let selector: PropagationModeSelector;

  beforeEach(() => {
    selector = new PropagationModeSelector();
  });

  it("should detect LOW_CONFIDENCE flag", () => {
    const context = createTestContext({
      packet: createTestPacket({ confidence: 0.3 }),
      coupling: 0.9,
      loss: 0.1,
    });

    const result = selector.selectMode(context);

    expect(result.activeFlags).toContain(PolicyFlag.LOW_CONFIDENCE);
  });

  it("should detect HIGH_LOSS flag", () => {
    const context = createTestContext({
      coupling: 0.9,
      loss: 0.5,
    });

    const result = selector.selectMode(context);

    expect(result.activeFlags).toContain(PolicyFlag.HIGH_LOSS);
  });

  it("should detect CRITICAL_TARGET flag", () => {
    const context = createTestContext({
      targetsCritical: true,
    });

    const result = selector.selectMode(context);

    expect(result.activeFlags).toContain(PolicyFlag.CRITICAL_TARGET);
  });

  it("should detect AUTHORITY_EXCEEDED flag", () => {
    const context = createTestContext({
      hasAuthority: false,
    });

    const result = selector.selectMode(context);

    expect(result.activeFlags).toContain(PolicyFlag.AUTHORITY_EXCEEDED);
  });

  it("should preserve custom policy flags", () => {
    const context = createTestContext({
      policyFlags: [PolicyFlag.QUORUM_REQUIRED, PolicyFlag.MANUAL_SAFE_HOLD],
    });

    const result = selector.selectMode(context);

    expect(result.activeFlags).toContain(PolicyFlag.QUORUM_REQUIRED);
    expect(result.activeFlags).toContain(PolicyFlag.MANUAL_SAFE_HOLD);
  });

  it("should deduplicate policy flags", () => {
    const context = createTestContext({
      targetsCritical: true,
      policyFlags: [PolicyFlag.CRITICAL_TARGET],
    });

    const result = selector.selectMode(context);

    const criticalCount = result.activeFlags.filter(
      (f) => f === PolicyFlag.CRITICAL_TARGET
    ).length;
    expect(criticalCount).toBe(1);
  });
});

// =============================================================================
// ENVIRONMENT CONFIGURATION TESTS
// =============================================================================

describe("Environment Configuration", () => {
  it("should use custom thresholds", () => {
    const selector = new PropagationModeSelector({
      thresholds: {
        ...DEFAULT_PROPAGATION_THRESHOLDS,
        C_threshold_local: 0.95,
      },
    });

    const context = createTestContext({
      coupling: 0.9,
      loss: 0.1,
      distance: 0,
    });

    const result = selector.selectMode(context);

    // With higher threshold, should not qualify for LOCAL_COHERENCE
    expect(result.mode).not.toBe(PropagationMode.LOCAL_COHERENCE);
  });

  it("should allow runtime threshold updates", () => {
    const selector = new PropagationModeSelector();

    const context = createTestContext({
      coupling: 0.75,
      loss: 0.1,
      distance: 0,
    });

    // Initially should not be LOCAL_COHERENCE (0.75 < 0.8)
    const result1 = selector.selectMode(context);
    expect(result1.mode).not.toBe(PropagationMode.LOCAL_COHERENCE);

    // Update threshold
    selector.updateThresholds({ C_threshold_local: 0.7 });

    // Now should qualify
    const result2 = selector.selectMode(context);
    expect(result2.mode).toBe(PropagationMode.LOCAL_COHERENCE);
  });

  it("should support site-specific thresholds", () => {
    const selector = new PropagationModeSelector({
      siteOverrides: {
        "site-critical": { C_threshold_local: 0.95 },
      },
    });

    const defaultThresholds = selector.getThresholdsForSite("site-normal");
    const siteThresholds = selector.getThresholdsForSite("site-critical");

    expect(defaultThresholds.C_threshold_local).toBe(0.8);
    expect(siteThresholds.C_threshold_local).toBe(0.95);
  });

  it("should return environment configuration", () => {
    const selector = new PropagationModeSelector({
      allowExploration: false,
      maxDistance: 50,
    });

    const env = selector.getEnvironment();

    expect(env.allowExploration).toBe(false);
    expect(env.maxDistance).toBe(50);
  });
});

// =============================================================================
// CONVENIENCE FUNCTION TESTS
// =============================================================================

describe("Convenience Functions", () => {
  afterEach(() => {
    resetPropagationModeSelector();
  });

  it("selectPropagationMode should work with defaults", () => {
    const context = createTestContext({
      coupling: 0.9,
      loss: 0.1,
    });

    const result = selectPropagationMode(context);

    expect(result.mode).toBe(PropagationMode.LOCAL_COHERENCE);
  });

  it("buildModeContext should create valid context", () => {
    const packet = createTestPacket();
    const context = buildModeContext(packet, {
      coupling: 0.8,
      loss: 0.2,
      distance: 1,
      targetsCritical: true,
      agentAuthority: AuthorityLevel.OPERATOR,
    });

    expect(context.packet).toBe(packet);
    expect(context.coupling).toBe(0.8);
    expect(context.targetsCritical).toBe(true);
    expect(context.hasAuthority).toBe(true); // OPERATOR >= OPERATOR
  });

  it("buildModeContext should detect authority mismatch", () => {
    const packet = createTestPacket({
      authority_required: AuthorityLevel.SUPERVISOR,
    });

    const context = buildModeContext(packet, {
      coupling: 0.8,
      loss: 0.2,
      distance: 1,
      agentAuthority: AuthorityLevel.OPERATOR,
    });

    expect(context.hasAuthority).toBe(false);
  });
});

// =============================================================================
// SINGLETON TESTS
// =============================================================================

describe("Singleton Instance", () => {
  afterEach(() => {
    resetPropagationModeSelector();
  });

  it("should return same instance", () => {
    const selector1 = getPropagationModeSelector();
    const selector2 = getPropagationModeSelector();

    expect(selector1).toBe(selector2);
  });

  it("should create new instance after reset", () => {
    const selector1 = getPropagationModeSelector();
    resetPropagationModeSelector();
    const selector2 = getPropagationModeSelector();

    expect(selector1).not.toBe(selector2);
  });
});

// =============================================================================
// BOUNDARY CONDITION TESTS
// =============================================================================

describe("Boundary Conditions", () => {
  let selector: PropagationModeSelector;

  beforeEach(() => {
    selector = new PropagationModeSelector();
  });

  it("should handle coupling at exactly 0", () => {
    const context = createTestContext({
      coupling: 0,
      loss: 0.1,
    });

    const result = selector.selectMode(context);

    expect(result.mode).toBe(PropagationMode.SAFE_HOLD);
    expect(result.effectiveCoupling).toBe(0);
  });

  it("should handle coupling at exactly 1", () => {
    const context = createTestContext({
      coupling: 1,
      loss: 0,
      distance: 0,
    });

    const result = selector.selectMode(context);

    expect(result.mode).toBe(PropagationMode.LOCAL_COHERENCE);
    expect(result.effectiveCoupling).toBe(1);
  });

  it("should handle loss at exactly 0", () => {
    const context = createTestContext({
      coupling: 0.9,
      loss: 0,
    });

    const result = selector.selectMode(context);

    expect(result.effectiveCoupling).toBe(0.9);
  });

  it("should handle loss at exactly 1", () => {
    const context = createTestContext({
      coupling: 0.9,
      loss: 1,
    });

    const result = selector.selectMode(context);

    expect(result.effectiveCoupling).toBe(0);
    expect(result.mode).toBe(PropagationMode.SAFE_HOLD);
  });

  it("should handle zero distance", () => {
    const context = createTestContext({
      coupling: 0.9,
      loss: 0.1,
      distance: 0,
    });

    const result = selector.selectMode(context);

    expect(result.mode).toBe(PropagationMode.LOCAL_COHERENCE);
  });
});
