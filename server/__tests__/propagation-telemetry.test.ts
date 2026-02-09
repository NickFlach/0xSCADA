/**
 * Propagation Telemetry Tests
 *
 * GhostOS Propagation Model - Telemetry Emission and Metrics
 * See docs/propagation-model.md Section 8 for specification
 *
 * Issue: #166 - Propagation Telemetry
 * Epic: #161 - GhostOS Propagation Model
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  PropagationTelemetry,
  getPropagationTelemetry,
  resetPropagationTelemetry,
  PropagationOutcome,
  PropagationTelemetryEvent,
} from "../services/propagation-telemetry";

import {
  PropagationMode,
  IntentPacket,
  FallbackStrategy,
  AuthorityLevel,
  CriticalityLevel,
  TelemetryEvent,
} from "../../shared/types/intent-packet";

import {
  ModeSelectionResult,
  PolicyFlag,
  RiskLevel,
  SafeHoldEvidence,
  GuardrailResult,
} from "../../shared/types/propagation";

// =============================================================================
// TEST HELPERS
// =============================================================================

function createTestPacket(overrides: Partial<IntentPacket> = {}): IntentPacket {
  return {
    intent_id: "550e8400-e29b-41d4-a716-446655440000",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    origin: {
      agent_id: "550e8400-e29b-41d4-a716-446655440001",
      agent_type: "test-agent",
      authority_level: AuthorityLevel.OPERATOR,
      site_context: "site-001",
    },
    action: {
      type: "test_action",
      parameters: {},
      description: "Test action for telemetry",
    },
    target_selector: {
      siteIds: ["site-001"],
    },
    constraints: {
      temporal: {
        not_before: new Date().toISOString(),
        not_after: new Date(Date.now() + 3600000).toISOString(),
        ttl_ms: 3600000,
      },
      safety: {
        criticality_threshold: CriticalityLevel.STANDARD,
        allow_exploration: true,
      },
    },
    observables: {
      required_telemetry: [TelemetryEvent.PHASE_COMPLETE],
      checkpoint_interval_ms: 1000,
    },
    fallback_plan: {
      strategy: FallbackStrategy.ROLLBACK,
      escalation_target: "supervisor",
    },
    confidence: 0.9,
    ...overrides,
  };
}

function createTestModeResult(
  overrides: Partial<ModeSelectionResult> = {}
): ModeSelectionResult {
  return {
    mode: PropagationMode.LOCAL_COHERENCE,
    effectiveCoupling: 0.85,
    reason: "High coupling, low loss - suitable for local coherence",
    rationale: {
      coupling: 0.9,
      loss: 0.1,
      effectiveCoupling: 0.81,
      distance: 1,
      thresholds: {
        C_threshold_local: 0.8,
        C_threshold_remote: 0.5,
        L_threshold_local: 0.2,
        L_threshold_remote: 0.4,
      },
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
    ...overrides,
  };
}

function createTestEvidence(
  overrides: Partial<SafeHoldEvidence> = {}
): SafeHoldEvidence {
  return {
    evidenceId: "550e8400-e29b-41d4-a716-446655440002",
    intentId: "550e8400-e29b-41d4-a716-446655440000",
    triggeredAt: new Date().toISOString(),
    primaryReason: PolicyFlag.AUTHORITY_EXCEEDED,
    factors: [
      {
        type: PolicyFlag.AUTHORITY_EXCEEDED,
        description: "Agent lacks authority for critical target",
        severity: RiskLevel.HIGH,
      },
    ],
    context: {
      coupling: 0.5,
      loss: 0.3,
      effectiveCoupling: 0.35,
      distance: 3,
      targetsCritical: true,
      hasAuthority: false,
    },
    activeFlags: [PolicyFlag.AUTHORITY_EXCEEDED],
    riskLevel: RiskLevel.HIGH,
    intentSnapshot: {},
    ...overrides,
  };
}

function createTestGuardrailResult(
  overrides: Partial<GuardrailResult> = {}
): GuardrailResult {
  return {
    passed: true,
    checksPerformed: [
      {
        guardrail: "authority",
        passed: true,
        reason: "Agent has sufficient authority",
        blocking: true,
      },
      {
        guardrail: "coupling",
        passed: true,
        reason: "Coupling above threshold",
        blocking: true,
      },
    ],
    processingTimeMs: 5,
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe("PropagationTelemetry", () => {
  let telemetry: PropagationTelemetry;

  beforeEach(() => {
    telemetry = new PropagationTelemetry();
  });

  describe("constructor", () => {
    it("should initialize with default options", () => {
      const metrics = telemetry.getMetrics();

      expect(metrics.totalPropagations).toBe(0);
      expect(metrics.successRate).toBe(0);
      expect(metrics.safeHoldRate).toBe(0);
      expect(metrics.avgDuration).toBe(0);
    });

    it("should accept custom options", () => {
      const custom = new PropagationTelemetry({
        maxEvents: 500,
        maxMetricSamples: 50,
      });

      // Record more than maxMetricSamples to verify limit
      for (let i = 0; i < 60; i++) {
        custom.recordPropagation(
          createTestPacket(),
          createTestModeResult(),
          "success",
          10
        );
      }

      const metrics = custom.getMetrics();
      expect(metrics.coupling.length).toBeLessThanOrEqual(50);
    });
  });

  describe("recordPropagation", () => {
    it("should record a successful propagation", () => {
      const packet = createTestPacket();
      const result = createTestModeResult();

      const event = telemetry.recordPropagation(packet, result, "success", 15);

      expect(event.event_type).toBe("PROPAGATION_TELEMETRY");
      expect(event.intent_id).toBe(packet.intent_id);
      expect(event.mode_selected).toBe(PropagationMode.LOCAL_COHERENCE);
      expect(event.outcome).toBe("success");
      expect(event.duration_ms).toBe(15);
    });

    it("should record coupling and loss metrics", () => {
      const packet = createTestPacket();
      const result = createTestModeResult({
        rationale: {
          ...createTestModeResult().rationale,
          coupling: 0.85,
          loss: 0.15,
        },
      });

      telemetry.recordPropagation(packet, result, "success", 10);

      const metrics = telemetry.getMetrics();
      expect(metrics.coupling.length).toBe(1);
      expect(metrics.coupling[0].value).toBe(0.85);
      expect(metrics.loss.length).toBe(1);
      expect(metrics.loss[0].value).toBe(0.15);
    });

    it("should track coherence variance when provided", () => {
      const packet = createTestPacket();
      const result = createTestModeResult();

      telemetry.recordPropagation(packet, result, "success", 10, {
        coherenceBefore: 0.9,
        coherenceAfter: 0.85,
      });

      const metrics = telemetry.getMetrics();
      expect(metrics.coherenceVariance.length).toBe(1);
      expect(metrics.coherenceVariance[0].value).toBeCloseTo(0.05);
    });

    it("should track impact score when provided", () => {
      const packet = createTestPacket();
      const result = createTestModeResult();

      telemetry.recordPropagation(packet, result, "success", 10, {
        impactScore: 0.75,
      });

      const metrics = telemetry.getMetrics();
      expect(metrics.impactScore.length).toBe(1);
      expect(metrics.impactScore[0].value).toBe(0.75);
    });

    it("should increment mode selection counter", () => {
      const packet = createTestPacket();
      const localResult = createTestModeResult({
        mode: PropagationMode.LOCAL_COHERENCE,
      });
      const remoteResult = createTestModeResult({
        mode: PropagationMode.REMOTE_COHERENCE,
      });

      telemetry.recordPropagation(packet, localResult, "success", 10);
      telemetry.recordPropagation(packet, localResult, "success", 10);
      telemetry.recordPropagation(packet, remoteResult, "success", 10);

      const metrics = telemetry.getMetrics();
      expect(metrics.modeSelected[PropagationMode.LOCAL_COHERENCE]).toBe(2);
      expect(metrics.modeSelected[PropagationMode.REMOTE_COHERENCE]).toBe(1);
    });

    it("should track SAFE_HOLD triggers with reason", () => {
      const packet = createTestPacket();
      const result = createTestModeResult({
        mode: PropagationMode.SAFE_HOLD,
        activeFlags: [PolicyFlag.AUTHORITY_EXCEEDED],
      });

      telemetry.recordPropagation(packet, result, "held", 10);

      const metrics = telemetry.getMetrics();
      expect(metrics.modeSelected[PropagationMode.SAFE_HOLD]).toBe(1);
      expect(metrics.safeHoldTriggered[PolicyFlag.AUTHORITY_EXCEEDED]).toBe(1);
    });

    it("should record duration in histogram", () => {
      const packet = createTestPacket();
      const result = createTestModeResult();

      // Record various durations
      telemetry.recordPropagation(packet, result, "success", 2); // 5ms bucket
      telemetry.recordPropagation(packet, result, "success", 8); // 10ms bucket
      telemetry.recordPropagation(packet, result, "success", 30); // 50ms bucket
      telemetry.recordPropagation(packet, result, "success", 200); // 250ms bucket

      const metrics = telemetry.getMetrics();
      expect(metrics.durationCount).toBe(4);
      expect(metrics.durationSum).toBe(240);
    });

    it("should update derived metrics", () => {
      const packet = createTestPacket();
      const localResult = createTestModeResult({
        mode: PropagationMode.LOCAL_COHERENCE,
      });
      const safeHoldResult = createTestModeResult({
        mode: PropagationMode.SAFE_HOLD,
        activeFlags: [PolicyFlag.LOW_CONFIDENCE],
      });

      telemetry.recordPropagation(packet, localResult, "success", 10);
      telemetry.recordPropagation(packet, localResult, "success", 10);
      telemetry.recordPropagation(packet, safeHoldResult, "held", 10);

      const metrics = telemetry.getMetrics();
      expect(metrics.totalPropagations).toBe(3);
      expect(metrics.successRate).toBeCloseTo(2 / 3);
      expect(metrics.safeHoldRate).toBeCloseTo(1 / 3);
    });

    it("should limit stored events", () => {
      const custom = new PropagationTelemetry({ maxEvents: 5 });
      const packet = createTestPacket();
      const result = createTestModeResult();

      for (let i = 0; i < 10; i++) {
        custom.recordPropagation(packet, result, "success", 10);
      }

      const events = custom.getEvents();
      expect(events.length).toBe(5);
    });

    it("should capture target scope in labels", () => {
      const allSitesPacket = createTestPacket({
        target_selector: { allSites: true },
      });
      const assetsPacket = createTestPacket({
        target_selector: { assetIds: ["a1", "a2", "a3"] },
      });
      const result = createTestModeResult();

      telemetry.recordPropagation(allSitesPacket, result, "success", 10);
      telemetry.recordPropagation(assetsPacket, result, "success", 10);

      const metrics = telemetry.getMetrics();
      expect(metrics.coupling[0].labels.target_scope).toBe("all_sites");
      expect(metrics.coupling[1].labels.target_scope).toBe("assets:3");
    });
  });

  describe("recordSafeHold", () => {
    it("should record SAFE_HOLD trigger with evidence", () => {
      const evidence = createTestEvidence({
        primaryReason: PolicyFlag.CRITICAL_TARGET,
      });

      telemetry.recordSafeHold(evidence, 25);

      const metrics = telemetry.getMetrics();
      expect(metrics.safeHoldTriggered[PolicyFlag.CRITICAL_TARGET]).toBe(1);
      expect(metrics.durationCount).toBe(1);
    });

    it("should accumulate multiple SAFE_HOLD reasons", () => {
      const evidence1 = createTestEvidence({
        primaryReason: PolicyFlag.AUTHORITY_EXCEEDED,
      });
      const evidence2 = createTestEvidence({
        primaryReason: PolicyFlag.LOW_CONFIDENCE,
      });
      const evidence3 = createTestEvidence({
        primaryReason: PolicyFlag.AUTHORITY_EXCEEDED,
      });

      telemetry.recordSafeHold(evidence1, 10);
      telemetry.recordSafeHold(evidence2, 10);
      telemetry.recordSafeHold(evidence3, 10);

      const metrics = telemetry.getMetrics();
      expect(metrics.safeHoldTriggered[PolicyFlag.AUTHORITY_EXCEEDED]).toBe(2);
      expect(metrics.safeHoldTriggered[PolicyFlag.LOW_CONFIDENCE]).toBe(1);
    });
  });

  describe("recordFallback", () => {
    it("should record fallback execution by strategy", () => {
      telemetry.recordFallback(FallbackStrategy.ROLLBACK, true, 100);
      telemetry.recordFallback(FallbackStrategy.COMPENSATE, true, 50);
      telemetry.recordFallback(FallbackStrategy.ROLLBACK, false, 200);

      const metrics = telemetry.getMetrics();
      expect(metrics.fallbackExecuted[FallbackStrategy.ROLLBACK]).toBe(2);
      expect(metrics.fallbackExecuted[FallbackStrategy.COMPENSATE]).toBe(1);
    });

    it("should record fallback duration in histogram", () => {
      telemetry.recordFallback(FallbackStrategy.ESCALATE, true, 500);

      const metrics = telemetry.getMetrics();
      expect(metrics.durationCount).toBe(1);
      expect(metrics.durationSum).toBe(500);
    });
  });

  describe("recordGuardrailEvaluation", () => {
    it("should record guardrail evaluation duration", () => {
      const result = createTestGuardrailResult();

      telemetry.recordGuardrailEvaluation(result, 3);

      const metrics = telemetry.getMetrics();
      expect(metrics.durationCount).toBe(1);
      expect(metrics.durationSum).toBe(3);
    });
  });

  describe("getMetrics", () => {
    it("should return a snapshot of current metrics", () => {
      const packet = createTestPacket();
      const result = createTestModeResult();

      telemetry.recordPropagation(packet, result, "success", 10);

      const metrics = telemetry.getMetrics();
      expect(metrics.totalPropagations).toBe(1);
      expect(metrics.coupling.length).toBe(1);
    });

    it("should return a copy, not the original", () => {
      const metrics1 = telemetry.getMetrics();
      metrics1.totalPropagations = 999;

      const metrics2 = telemetry.getMetrics();
      expect(metrics2.totalPropagations).toBe(0);
    });
  });

  describe("getEvents", () => {
    it("should return all events", () => {
      const packet = createTestPacket();
      const result = createTestModeResult();

      telemetry.recordPropagation(packet, result, "success", 10);
      telemetry.recordPropagation(packet, result, "fallback", 20);

      const events = telemetry.getEvents();
      expect(events.length).toBe(2);
    });

    it("should return limited events when specified", () => {
      const packet = createTestPacket();
      const result = createTestModeResult();

      for (let i = 0; i < 10; i++) {
        telemetry.recordPropagation(packet, result, "success", 10);
      }

      const events = telemetry.getEvents(3);
      expect(events.length).toBe(3);
    });

    it("should return most recent events when limited", () => {
      const packet = createTestPacket();
      const result = createTestModeResult();

      for (let i = 0; i < 5; i++) {
        telemetry.recordPropagation(
          { ...packet, intent_id: `id-${i}` } as any,
          result,
          "success",
          10
        );
      }

      const events = telemetry.getEvents(2);
      expect(events[0].intent_id).toBe("id-3");
      expect(events[1].intent_id).toBe("id-4");
    });
  });

  describe("exportPrometheus", () => {
    it("should export metrics in Prometheus format", () => {
      const packet = createTestPacket();
      const result = createTestModeResult();

      telemetry.recordPropagation(packet, result, "success", 10);

      const output = telemetry.exportPrometheus();

      expect(output).toContain("# HELP propagation_coupling");
      expect(output).toContain("# TYPE propagation_coupling gauge");
      expect(output).toContain("propagation_coupling");

      expect(output).toContain("# HELP propagation_loss");
      expect(output).toContain("# TYPE propagation_loss gauge");

      expect(output).toContain("# HELP propagation_mode_selected_total");
      expect(output).toContain("# TYPE propagation_mode_selected_total counter");
      expect(output).toContain('propagation_mode_selected_total{mode="LOCAL_COHERENCE"}');

      expect(output).toContain("# HELP propagation_duration_ms");
      expect(output).toContain("# TYPE propagation_duration_ms histogram");
      expect(output).toContain("propagation_duration_ms_bucket");
      expect(output).toContain("propagation_duration_ms_sum");
      expect(output).toContain("propagation_duration_ms_count");
    });

    it("should include SAFE_HOLD metrics when triggered", () => {
      const evidence = createTestEvidence({
        primaryReason: PolicyFlag.CRITICAL_TARGET,
      });

      telemetry.recordSafeHold(evidence, 10);

      const output = telemetry.exportPrometheus();

      expect(output).toContain("# HELP propagation_safe_hold_triggered_total");
      expect(output).toContain(
        `propagation_safe_hold_triggered_total{reason="${PolicyFlag.CRITICAL_TARGET}"}`
      );
    });

    it("should include fallback metrics", () => {
      telemetry.recordFallback(FallbackStrategy.ROLLBACK, true, 100);

      const output = telemetry.exportPrometheus();

      expect(output).toContain("# HELP propagation_fallback_executed_total");
      expect(output).toContain(
        `propagation_fallback_executed_total{strategy="${FallbackStrategy.ROLLBACK}"}`
      );
    });

    it("should include derived metrics", () => {
      const packet = createTestPacket();
      const result = createTestModeResult();

      telemetry.recordPropagation(packet, result, "success", 10);

      const output = telemetry.exportPrometheus();

      expect(output).toContain("propagation_success_rate");
      expect(output).toContain("propagation_safe_hold_rate");
    });

    it("should format labels correctly", () => {
      const packet = createTestPacket();
      const result = createTestModeResult({
        mode: PropagationMode.REMOTE_COHERENCE,
      });

      telemetry.recordPropagation(packet, result, "success", 10);

      const output = telemetry.exportPrometheus();

      // Should have properly formatted labels
      expect(output).toMatch(/propagation_coupling\{[^}]+\}/);
    });

    it("should handle +Inf bucket for histogram", () => {
      const packet = createTestPacket();
      const result = createTestModeResult();

      telemetry.recordPropagation(packet, result, "success", 10000); // Very long duration

      const output = telemetry.exportPrometheus();

      expect(output).toContain('propagation_duration_ms_bucket{le="+Inf"}');
    });
  });

  describe("getCardinalityStats", () => {
    it("should return cardinality statistics", () => {
      const packet = createTestPacket();
      const result = createTestModeResult();

      telemetry.recordPropagation(packet, result, "success", 10);

      const stats = telemetry.getCardinalityStats();

      expect(stats.uniqueModes).toBe(4); // All 4 modes in enum
      expect(stats.uniqueScopes).toBe(1);
      expect(stats.totalSamples).toBeGreaterThan(0);
    });

    it("should track unique scopes", () => {
      const result = createTestModeResult();

      telemetry.recordPropagation(
        createTestPacket({ target_selector: { allSites: true } }),
        result,
        "success",
        10
      );
      telemetry.recordPropagation(
        createTestPacket({ target_selector: { siteIds: ["s1", "s2"] } }),
        result,
        "success",
        10
      );
      telemetry.recordPropagation(
        createTestPacket({ target_selector: { assetIds: ["a1"] } }),
        result,
        "success",
        10
      );

      const stats = telemetry.getCardinalityStats();
      expect(stats.uniqueScopes).toBe(3);
    });

    it("should track SAFE_HOLD reasons", () => {
      const evidence1 = createTestEvidence({
        primaryReason: PolicyFlag.AUTHORITY_EXCEEDED,
      });
      const evidence2 = createTestEvidence({
        primaryReason: PolicyFlag.LOW_CONFIDENCE,
      });

      telemetry.recordSafeHold(evidence1, 10);
      telemetry.recordSafeHold(evidence2, 10);

      const stats = telemetry.getCardinalityStats();
      expect(stats.uniqueReasons).toBe(2);
    });
  });

  describe("reset", () => {
    it("should reset all metrics", () => {
      const packet = createTestPacket();
      const result = createTestModeResult();

      telemetry.recordPropagation(packet, result, "success", 10);
      telemetry.recordSafeHold(createTestEvidence(), 10);
      telemetry.recordFallback(FallbackStrategy.ROLLBACK, true, 10);

      telemetry.reset();

      const metrics = telemetry.getMetrics();
      expect(metrics.totalPropagations).toBe(0);
      expect(metrics.coupling.length).toBe(0);
      expect(metrics.durationCount).toBe(0);
    });

    it("should clear all events", () => {
      const packet = createTestPacket();
      const result = createTestModeResult();

      telemetry.recordPropagation(packet, result, "success", 10);
      telemetry.reset();

      const events = telemetry.getEvents();
      expect(events.length).toBe(0);
    });

    it("should reset histogram buckets", () => {
      const packet = createTestPacket();
      const result = createTestModeResult();

      telemetry.recordPropagation(packet, result, "success", 10);
      telemetry.reset();

      const metrics = telemetry.getMetrics();
      expect(metrics.durationSum).toBe(0);
      expect(metrics.durationCount).toBe(0);
    });
  });
});

describe("Singleton Functions", () => {
  beforeEach(() => {
    resetPropagationTelemetry();
  });

  describe("getPropagationTelemetry", () => {
    it("should return the same instance", () => {
      const instance1 = getPropagationTelemetry();
      const instance2 = getPropagationTelemetry();

      expect(instance1).toBe(instance2);
    });

    it("should accept options on first call", () => {
      const instance = getPropagationTelemetry({ maxEvents: 100 });

      // Record more than default to verify options were applied
      const packet = {
        intent_id: "test-id",
        target_selector: { siteIds: ["s1"] },
      } as any;
      const result = {
        mode: PropagationMode.LOCAL_COHERENCE,
        effectiveCoupling: 0.8,
        reason: "test",
        rationale: { coupling: 0.9, loss: 0.1 },
        forcedByPolicy: false,
        activeFlags: [],
      } as any;

      for (let i = 0; i < 150; i++) {
        instance.recordPropagation(packet, result, "success", 10);
      }

      const events = instance.getEvents();
      expect(events.length).toBe(100);
    });
  });

  describe("resetPropagationTelemetry", () => {
    it("should create a new instance on next get", () => {
      const instance1 = getPropagationTelemetry();
      instance1.recordPropagation(
        { intent_id: "test", target_selector: {} } as any,
        {
          mode: PropagationMode.LOCAL_COHERENCE,
          effectiveCoupling: 0.8,
          rationale: { coupling: 0.9, loss: 0.1 },
          forcedByPolicy: false,
          activeFlags: [],
        } as any,
        "success",
        10
      );

      resetPropagationTelemetry();

      const instance2 = getPropagationTelemetry();
      expect(instance2.getMetrics().totalPropagations).toBe(0);
    });
  });
});

describe("PropagationTelemetryEvent", () => {
  let telemetry: PropagationTelemetry;

  beforeEach(() => {
    telemetry = new PropagationTelemetry();
  });

  it("should have correct event structure", () => {
    const packet = createTestPacket();
    const result = createTestModeResult();

    const event = telemetry.recordPropagation(packet, result, "success", 15, {
      coherenceBefore: 0.9,
      coherenceAfter: 0.88,
      impactScore: 0.5,
    });

    expect(event).toMatchObject({
      event_type: "PROPAGATION_TELEMETRY",
      intent_id: packet.intent_id,
      metrics: {
        coupling: result.rationale.coupling,
        loss: result.rationale.loss,
        effective_coupling: result.effectiveCoupling,
        coherence_before: 0.9,
        coherence_after: 0.88,
        impact_score: 0.5,
      },
      mode_selected: result.mode,
      mode_rationale: result.reason,
      policy_flags: result.activeFlags,
      outcome: "success",
      duration_ms: 15,
    });

    expect(event.timestamp).toBeDefined();
    expect(new Date(event.timestamp).getTime()).not.toBeNaN();
  });

  it("should handle all outcome types", () => {
    const packet = createTestPacket();
    const result = createTestModeResult();

    const outcomes: PropagationOutcome[] = [
      "success",
      "fallback",
      "held",
      "rejected",
    ];

    for (const outcome of outcomes) {
      const event = telemetry.recordPropagation(packet, result, outcome, 10);
      expect(event.outcome).toBe(outcome);
    }
  });
});

describe("Duration Histogram", () => {
  let telemetry: PropagationTelemetry;

  beforeEach(() => {
    telemetry = new PropagationTelemetry();
  });

  it("should bucket durations correctly", () => {
    const packet = createTestPacket();
    const result = createTestModeResult();

    // Test various bucket boundaries
    const durations = [0.5, 3, 7, 20, 40, 80, 200, 400, 800, 3000, 10000];

    for (const duration of durations) {
      telemetry.recordPropagation(packet, result, "success", duration);
    }

    const metrics = telemetry.getMetrics();
    expect(metrics.durationCount).toBe(durations.length);
    expect(metrics.durationSum).toBe(durations.reduce((a, b) => a + b, 0));
  });

  it("should calculate average duration", () => {
    const packet = createTestPacket();
    const result = createTestModeResult();

    telemetry.recordPropagation(packet, result, "success", 10);
    telemetry.recordPropagation(packet, result, "success", 20);
    telemetry.recordPropagation(packet, result, "success", 30);

    const metrics = telemetry.getMetrics();
    expect(metrics.avgDuration).toBe(20);
  });
});
