/**
 * Tests for ADR-0009: Measured Emergence Guardrails
 * 
 * Covers:
 * - Operational envelope constraint checking
 * - Hard limit enforcement
 * - Soft limit with justification
 * - Escalation triggers (confidence drop, anomaly)
 * - Forbidden asset blocking
 * - Mode restriction (M3: SAFE_HOLD blocks actions)
 * - Trust tier promotion and demotion
 * - Mode transitions
 * - Observable traces
 */

import { describe, it, expect, beforeEach } from "vitest";
import { EnvelopeEngine } from "../agents/envelope-engine";
import type { OperationalEnvelope } from "@shared/types/operational-envelope";
import {
  PropagationMode,
  TrustTier,
  TierDemotionTrigger,
  TIER_ENVELOPE_LIMITS,
  TRUST_TIER_ORDER,
} from "@shared/types/operational-envelope";

function makeEnvelope(overrides: Partial<OperationalEnvelope> = {}): OperationalEnvelope {
  return {
    id: "env-001",
    agentId: "test-agent",
    maxSetpointDelta: 10,
    maxActionsPerMinute: 30,
    forbiddenAssets: ["reactor-core-001"],
    requiredApprovals: 0,
    recommendedSetpointDelta: 5,
    recommendedActionIntervalMs: 5000,
    uncertaintyThreshold: 0.6,
    anomalyScoreLimit: 3.0,
    consecutiveFailureLimit: 3,
    trustTier: "T2_SUPERVISED",
    currentMode: "M1_LOCAL_COHERENCE",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("EnvelopeEngine", () => {
  let engine: EnvelopeEngine;

  beforeEach(() => {
    engine = new EnvelopeEngine();
  });

  describe("constraint checking", () => {
    it("should permit actions within hard limits", () => {
      engine.registerAgent(makeEnvelope());

      const { result } = engine.checkAction("test-agent", "adjust_setpoint", {
        setpointDeltaPercent: 3,
        confidence: 0.9,
      });

      expect(result).toBe("PERMITTED");
    });

    it("should block actions exceeding hard limits", () => {
      engine.registerAgent(makeEnvelope());

      const { result } = engine.checkAction("test-agent", "adjust_setpoint", {
        setpointDeltaPercent: 15, // exceeds maxSetpointDelta of 10
        confidence: 0.9,
      });

      expect(result).toBe("HARD_LIMIT_VIOLATED");
    });

    it("should flag soft limit exceeded without justification", () => {
      engine.registerAgent(makeEnvelope());

      const { result } = engine.checkAction("test-agent", "adjust_setpoint", {
        setpointDeltaPercent: 7, // exceeds recommended (5) but within hard (10)
        confidence: 0.9,
      });

      expect(result).toBe("SOFT_LIMIT_EXCEEDED");
    });

    it("should permit soft limit exceeded WITH justification", () => {
      engine.registerAgent(makeEnvelope());

      const { result, requiresApproval } = engine.checkAction("test-agent", "adjust_setpoint", {
        setpointDeltaPercent: 7,
        confidence: 0.9,
        justification: "Process optimization based on upstream sensor data",
      });

      expect(result).toBe("PERMITTED");
      expect(requiresApproval).toBe(true); // Still needs approval
    });

    it("should block actions on forbidden assets", () => {
      engine.registerAgent(makeEnvelope());

      const { result } = engine.checkAction("test-agent", "adjust_setpoint", {
        setpointDeltaPercent: 1,
        targetAsset: "reactor-core-001",
        confidence: 0.9,
      });

      expect(result).toBe("FORBIDDEN_ASSET");
    });

    it("should return HARD_LIMIT_VIOLATED for unregistered agent", () => {
      const { result } = engine.checkAction("unknown-agent", "anything", {});
      expect(result).toBe("HARD_LIMIT_VIOLATED");
    });
  });

  describe("escalation triggers", () => {
    it("should escalate to M3 when confidence drops below threshold", () => {
      engine.registerAgent(makeEnvelope());

      const { result } = engine.checkAction("test-agent", "adjust_setpoint", {
        setpointDeltaPercent: 2,
        confidence: 0.4, // below uncertaintyThreshold of 0.6
      });

      expect(result).toBe("ESCALATION_TRIGGERED");

      // Agent should now be in M3
      const state = engine.getAgentState("test-agent");
      expect(state?.mode).toBe("M3_SAFE_HOLD");
    });

    it("should escalate to M3 when anomaly score exceeds limit", () => {
      engine.registerAgent(makeEnvelope());

      const { result } = engine.checkAction("test-agent", "adjust_setpoint", {
        setpointDeltaPercent: 2,
        confidence: 0.9,
        anomalyScore: 5.0, // exceeds anomalyScoreLimit of 3.0
      });

      expect(result).toBe("ESCALATION_TRIGGERED");
    });

    it("should escalate after consecutive failures", () => {
      engine.registerAgent(makeEnvelope({ consecutiveFailureLimit: 2 }));

      // Two hard limit violations
      engine.checkAction("test-agent", "adjust", { setpointDeltaPercent: 99, confidence: 0.9 });
      engine.checkAction("test-agent", "adjust", { setpointDeltaPercent: 99, confidence: 0.9 });

      const state = engine.getAgentState("test-agent");
      expect(state?.mode).toBe("M3_SAFE_HOLD");
    });
  });

  describe("mode restrictions", () => {
    it("should block all autonomous actions in M3: SAFE_HOLD", () => {
      engine.registerAgent(makeEnvelope({ currentMode: "M3_SAFE_HOLD" }));

      const { result, requiresApproval } = engine.checkAction("test-agent", "adjust_setpoint", {
        setpointDeltaPercent: 1,
        confidence: 0.99,
      });

      expect(result).toBe("MODE_RESTRICTED");
      expect(requiresApproval).toBe(true);
    });

    it("should block M4 actions when no exploration session is active", () => {
      engine.registerAgent(makeEnvelope({ currentMode: "M4_EXPLORATION" }));

      const { result } = engine.checkAction("test-agent", "explore", {
        confidence: 0.9,
      });

      expect(result).toBe("MODE_RESTRICTED");
    });
  });

  describe("mode transitions", () => {
    it("should allow M1 → M3 transition (safety escalation)", () => {
      engine.registerAgent(makeEnvelope());

      const success = engine.transitionMode("test-agent", PropagationMode.M3_SAFE_HOLD, "Test");
      expect(success).toBe(true);

      const state = engine.getAgentState("test-agent");
      expect(state?.mode).toBe("M3_SAFE_HOLD");
    });

    it("should allow M1 → M2 transition", () => {
      engine.registerAgent(makeEnvelope());

      const success = engine.transitionMode("test-agent", PropagationMode.M2_REMOTE_COHERENCE, "Cross-site");
      expect(success).toBe(true);
    });

    it("should deny invalid transitions (e.g., M1 → M4 directly)", () => {
      engine.registerAgent(makeEnvelope());

      const success = engine.transitionMode("test-agent", PropagationMode.M4_EXPLORATION, "Test");
      expect(success).toBe(false);
    });

    it("should require going through M3 to reach M4", () => {
      engine.registerAgent(makeEnvelope());

      // M1 → M3 (valid)
      engine.transitionMode("test-agent", PropagationMode.M3_SAFE_HOLD, "Escalate");
      // M3 → M4 (valid, requires human approval in practice)
      const success = engine.transitionMode("test-agent", PropagationMode.M4_EXPLORATION, "Sandbox test");
      expect(success).toBe(true);
    });
  });

  describe("trust tier promotion", () => {
    it("should deny promotion when clean operation time is insufficient", () => {
      engine.registerAgent(makeEnvelope({ trustTier: "T0_PROBATIONARY" }));

      // T0 → T1 requires 72h clean operation
      const result = engine.promoteTier("test-agent");
      expect(result.promoted).toBe(false);
      expect(result.reason).toContain("clean operation");
    });

    it("should deny promotion at max tier", () => {
      engine.registerAgent(makeEnvelope({ trustTier: "T4_AUTONOMOUS" }));

      const result = engine.promoteTier("test-agent");
      expect(result.promoted).toBe(false);
      expect(result.reason).toContain("maximum trust tier");
    });
  });

  describe("trust tier demotion", () => {
    it("should demote to T0 on safety anomaly", () => {
      engine.registerAgent(makeEnvelope({ trustTier: "T3_TRUSTED" }));

      const result = engine.demoteTier("test-agent", TierDemotionTrigger.SAFETY_ANOMALY);
      expect(result.demoted).toBe(true);
      expect(result.newTier).toBe("T0_PROBATIONARY");

      // Should also be in M3: SAFE_HOLD
      const state = engine.getAgentState("test-agent");
      expect(state?.mode).toBe("M3_SAFE_HOLD");
    });

    it("should reset all promotion progress on demotion", () => {
      engine.registerAgent(makeEnvelope({ trustTier: "T3_TRUSTED" }));
      engine.recordAuditPass("test-agent");

      engine.demoteTier("test-agent", TierDemotionTrigger.OPERATOR_OVERRIDE);

      // Now try to promote — should fail because everything is reset
      const result = engine.promoteTier("test-agent");
      expect(result.promoted).toBe(false);
    });

    it("should demote via recordAnomaly for safety-related events", () => {
      engine.registerAgent(makeEnvelope({ trustTier: "T2_SUPERVISED" }));

      engine.recordAnomaly("test-agent", "Unexpected pressure spike", true);

      const state = engine.getAgentState("test-agent");
      expect(state?.trustTier).toBe("T0_PROBATIONARY");
    });
  });

  describe("T0: PROBATIONARY tier enforcement", () => {
    it("should block all control actions for T0 agents", () => {
      engine.registerAgent(makeEnvelope({
        trustTier: "T0_PROBATIONARY",
        maxSetpointDelta: 0,
      }));

      const { result } = engine.checkAction("test-agent", "adjust_setpoint", {
        setpointDeltaPercent: 0.5, // Even tiny change
        confidence: 0.99,
      });

      expect(result).toBe("HARD_LIMIT_VIOLATED");
    });

    it("should allow read-only actions for T0 agents", () => {
      engine.registerAgent(makeEnvelope({
        trustTier: "T0_PROBATIONARY",
        maxSetpointDelta: 0,
      }));

      const { result } = engine.checkAction("test-agent", "read_telemetry", {
        setpointDeltaPercent: 0,
        confidence: 0.99,
      });

      expect(result).toBe("PERMITTED");
    });
  });

  describe("observability traces", () => {
    it("should produce a trace for every check", () => {
      engine.registerAgent(makeEnvelope());

      engine.checkAction("test-agent", "adjust_setpoint", {
        setpointDeltaPercent: 3,
        confidence: 0.9,
      });

      const traces = engine.getTraces("test-agent");
      expect(traces).toHaveLength(1);
      expect(traces[0].agent).toBe("test-agent");
      expect(traces[0].envelopeCheck.result).toBe("PERMITTED");
      expect(traces[0].envelopeCheck.deltaRequested).toBe(3);
      expect(traces[0].timestamp).toBeDefined();
    });

    it("should accumulate traces across multiple checks", () => {
      engine.registerAgent(makeEnvelope());

      engine.checkAction("test-agent", "action1", { confidence: 0.9 });
      engine.checkAction("test-agent", "action2", { confidence: 0.9 });
      engine.checkAction("test-agent", "action3", { confidence: 0.9 });

      const traces = engine.getTraces("test-agent");
      expect(traces).toHaveLength(3);
    });
  });

  describe("tier envelope limits constants", () => {
    it("should have limits defined for all trust tiers", () => {
      for (const tier of TRUST_TIER_ORDER) {
        expect(TIER_ENVELOPE_LIMITS[tier]).toBeDefined();
        expect(TIER_ENVELOPE_LIMITS[tier].description).toBeTruthy();
      }
    });

    it("should have increasing setpoint limits as trust increases", () => {
      const limits = TRUST_TIER_ORDER.map((t: TrustTier) => TIER_ENVELOPE_LIMITS[t].maxSetpointDeltaPercent);
      for (let i = 1; i < limits.length; i++) {
        expect(limits[i]).toBeGreaterThanOrEqual(limits[i - 1]);
      }
    });
  });
});
