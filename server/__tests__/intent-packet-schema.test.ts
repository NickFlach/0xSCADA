/**
 * Intent Packet Schema Test Suite
 *
 * GhostOS Propagation Model - Intent Packet Validation Tests
 * See docs/propagation-model.md for specification
 *
 * Issue: #163 - Intent Packet Schema & Validation
 * Epic: #161 - GhostOS Propagation Model
 *
 * Coverage targets:
 * - Valid packet variants pass validation
 * - Invalid packet variants return actionable errors
 * - Edge cases and boundary conditions
 * - Service layer validation
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  intentPacketSchema,
  targetSelectorSchema,
  constraintSchema,
  fallbackPlanSchema,
  observableSchema,
  validateIntentPacket,
  createIntentPacket,
  PropagationMode,
  AuthorityLevel,
  FallbackStrategy,
  ConstraintType,
  ConstraintEnforcement,
  ObservableType,
  AssetType,
  CriticalityLevel,
  TelemetryEvent,
  AUTHORITY_ORDER,
  type IntentPacket,
  type CreateIntentPacket,
} from "../../shared/types/intent-packet";
import {
  IntentPacketService,
  getIntentPacketService,
  resetIntentPacketService,
} from "../services/intent-packet-service";

// =============================================================================
// TEST DATA FIXTURES
// =============================================================================

const validIntentPacket: IntentPacket = {
  intent_id: "7f8e9d0c-1234-5678-9abc-def012345678",
  target_selector: {
    siteIds: ["site-001"],
    assetTypes: [AssetType.MOTOR, AssetType.PUMP],
  },
  mode: PropagationMode.LOCAL_COHERENCE,
  constraints: [
    {
      type: ConstraintType.MAX_DURATION,
      value: 30000,
      enforcement: ConstraintEnforcement.STRICT,
    },
  ],
  confidence: 0.95,
  authority_required: AuthorityLevel.OPERATOR,
  ttl: 60000,
  expected_observables: [
    {
      type: ObservableType.SUMMARY_GENERATED,
      target: "shift-summary",
    },
  ],
  fallback_plan: {
    strategy: FallbackStrategy.ABORT,
  },
  telemetry_hooks: [],
  created_at: "2026-02-09T12:00:00.000Z",
};

const minimalValidPacket: CreateIntentPacket = {
  target_selector: {
    allSites: true,
  },
  mode: PropagationMode.LOCAL_COHERENCE,
  confidence: 0.8,
  authority_required: AuthorityLevel.VIEWER,
  ttl: 30000,
  fallback_plan: {
    strategy: FallbackStrategy.ABORT,
  },
};

// =============================================================================
// INTENT PACKET SCHEMA TESTS
// =============================================================================

describe("Intent Packet Schema", () => {
  describe("Valid Packets", () => {
    it("should validate a complete intent packet", () => {
      const result = intentPacketSchema.safeParse(validIntentPacket);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.intent_id).toBe(validIntentPacket.intent_id);
        expect(result.data.mode).toBe(PropagationMode.LOCAL_COHERENCE);
      }
    });

    it("should validate a minimal intent packet", () => {
      const packet = createIntentPacket(minimalValidPacket);
      const result = intentPacketSchema.safeParse(packet);
      expect(result.success).toBe(true);
    });

    it("should validate all propagation modes", () => {
      const modes = [
        PropagationMode.LOCAL_COHERENCE,
        PropagationMode.REMOTE_COHERENCE,
        PropagationMode.SAFE_HOLD,
        PropagationMode.EXPLORATION,
      ];

      for (const mode of modes) {
        const packet = createIntentPacket({ ...minimalValidPacket, mode });
        const result = intentPacketSchema.safeParse(packet);
        expect(result.success).toBe(true);
      }
    });

    it("should validate all authority levels", () => {
      const levels = [
        AuthorityLevel.VIEWER,
        AuthorityLevel.OPERATOR,
        AuthorityLevel.ENGINEER,
        AuthorityLevel.SUPERVISOR,
        AuthorityLevel.ADMIN,
      ];

      for (const level of levels) {
        const packet = createIntentPacket({
          ...minimalValidPacket,
          authority_required: level,
        });
        const result = intentPacketSchema.safeParse(packet);
        expect(result.success).toBe(true);
      }
    });

    it("should validate packet with all optional fields", () => {
      const fullPacket = createIntentPacket({
        ...minimalValidPacket,
        constraints: [
          {
            type: ConstraintType.MAX_IMPACT,
            value: 100,
            enforcement: ConstraintEnforcement.ADVISORY,
            description: "Limit impact score",
          },
        ],
        expected_observables: [
          {
            type: ObservableType.STATE_CHANGED,
            target: "asset-001",
            expectedValue: "RUNNING",
            timeout: 5000,
          },
        ],
        telemetry_hooks: [
          {
            event: TelemetryEvent.PHASE_COMPLETE,
            metrics: ["progress"],
            labels: { phase: "1" },
          },
        ],
        metadata: { custom_field: "value" },
        originator: {
          agent_id: "12345678-1234-1234-1234-123456789012",
          user_id: "user-001",
          source: "api",
        },
      });

      const result = intentPacketSchema.safeParse(fullPacket);
      if (!result.success) {
        console.error("Validation errors:", JSON.stringify(result.error.issues, null, 2));
      }
      expect(result.success).toBe(true);
    });
  });

  describe("Invalid Packets", () => {
    it("should reject packet without intent_id", () => {
      const { intent_id, ...packetWithoutId } = validIntentPacket;
      const result = intentPacketSchema.safeParse(packetWithoutId);
      expect(result.success).toBe(false);
    });

    it("should reject packet with invalid UUID", () => {
      const packet = { ...validIntentPacket, intent_id: "not-a-uuid" };
      const result = intentPacketSchema.safeParse(packet);
      expect(result.success).toBe(false);
    });

    it("should reject packet without target_selector", () => {
      const { target_selector, ...packetWithoutTarget } = validIntentPacket;
      const result = intentPacketSchema.safeParse(packetWithoutTarget);
      expect(result.success).toBe(false);
    });

    it("should reject packet with invalid mode", () => {
      const packet = { ...validIntentPacket, mode: "INVALID_MODE" };
      const result = intentPacketSchema.safeParse(packet);
      expect(result.success).toBe(false);
    });

    it("should reject packet with confidence out of range", () => {
      const packetLow = { ...validIntentPacket, confidence: -0.1 };
      const packetHigh = { ...validIntentPacket, confidence: 1.1 };

      expect(intentPacketSchema.safeParse(packetLow).success).toBe(false);
      expect(intentPacketSchema.safeParse(packetHigh).success).toBe(false);
    });

    it("should reject packet with negative TTL", () => {
      const packet = { ...validIntentPacket, ttl: -1000 };
      const result = intentPacketSchema.safeParse(packet);
      expect(result.success).toBe(false);
    });

    it("should reject packet with TTL exceeding 24 hours", () => {
      const packet = { ...validIntentPacket, ttl: 86400001 };
      const result = intentPacketSchema.safeParse(packet);
      expect(result.success).toBe(false);
    });

    it("should reject packet without fallback_plan", () => {
      const { fallback_plan, ...packetWithoutFallback } = validIntentPacket;
      const result = intentPacketSchema.safeParse(packetWithoutFallback);
      expect(result.success).toBe(false);
    });
  });

  describe("Boundary Conditions", () => {
    it("should accept confidence at exactly 0", () => {
      const packet = createIntentPacket({ ...minimalValidPacket, confidence: 0 });
      const result = intentPacketSchema.safeParse(packet);
      expect(result.success).toBe(true);
    });

    it("should accept confidence at exactly 1", () => {
      const packet = createIntentPacket({ ...minimalValidPacket, confidence: 1 });
      const result = intentPacketSchema.safeParse(packet);
      expect(result.success).toBe(true);
    });

    it("should accept TTL at exactly 1ms", () => {
      const packet = createIntentPacket({ ...minimalValidPacket, ttl: 1 });
      const result = intentPacketSchema.safeParse(packet);
      expect(result.success).toBe(true);
    });

    it("should accept TTL at exactly 24 hours", () => {
      const packet = createIntentPacket({ ...minimalValidPacket, ttl: 86400000 });
      const result = intentPacketSchema.safeParse(packet);
      expect(result.success).toBe(true);
    });
  });
});

// =============================================================================
// TARGET SELECTOR TESTS
// =============================================================================

describe("Target Selector Schema", () => {
  it("should validate target with allSites", () => {
    const target = { allSites: true };
    const result = targetSelectorSchema.safeParse(target);
    expect(result.success).toBe(true);
  });

  it("should validate target with siteIds", () => {
    const target = { siteIds: ["site-001", "site-002"] };
    const result = targetSelectorSchema.safeParse(target);
    expect(result.success).toBe(true);
  });

  it("should validate target with assetTypes", () => {
    const target = { assetTypes: [AssetType.MOTOR, AssetType.PUMP] };
    const result = targetSelectorSchema.safeParse(target);
    expect(result.success).toBe(true);
  });

  it("should validate target with criticality filter", () => {
    const target = {
      allAssets: true,
      criticality: CriticalityLevel.CRITICAL,
    };
    const result = targetSelectorSchema.safeParse(target);
    expect(result.success).toBe(true);
  });

  it("should reject empty target selector", () => {
    const target = {};
    const result = targetSelectorSchema.safeParse(target);
    expect(result.success).toBe(false);
  });

  it("should reject target with only filtering (no scope)", () => {
    const target = { tags: ["production"] };
    const result = targetSelectorSchema.safeParse(target);
    expect(result.success).toBe(false);
  });

  it("should reject target with empty siteIds array", () => {
    const target = { siteIds: [] };
    const result = targetSelectorSchema.safeParse(target);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// CONSTRAINT SCHEMA TESTS
// =============================================================================

describe("Constraint Schema", () => {
  it("should validate MAX_DURATION constraint", () => {
    const constraint = {
      type: ConstraintType.MAX_DURATION,
      value: 30000,
      enforcement: ConstraintEnforcement.STRICT,
    };
    const result = constraintSchema.safeParse(constraint);
    expect(result.success).toBe(true);
  });

  it("should validate REQUIRE_QUORUM constraint", () => {
    const constraint = {
      type: ConstraintType.REQUIRE_QUORUM,
      value: 2,
      enforcement: ConstraintEnforcement.STRICT,
    };
    const result = constraintSchema.safeParse(constraint);
    expect(result.success).toBe(true);
  });

  it("should validate CUSTOM constraint with description", () => {
    const constraint = {
      type: ConstraintType.CUSTOM,
      value: { maxRetries: 3 },
      enforcement: ConstraintEnforcement.ADVISORY,
      description: "Custom retry limit",
    };
    const result = constraintSchema.safeParse(constraint);
    expect(result.success).toBe(true);
  });

  it("should reject constraint without type", () => {
    const constraint = {
      value: 30000,
      enforcement: ConstraintEnforcement.STRICT,
    };
    const result = constraintSchema.safeParse(constraint);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// FALLBACK PLAN TESTS
// =============================================================================

describe("Fallback Plan Schema", () => {
  it("should validate ROLLBACK strategy", () => {
    const plan = {
      strategy: FallbackStrategy.ROLLBACK,
      max_retries: 1,
    };
    const result = fallbackPlanSchema.safeParse(plan);
    expect(result.success).toBe(true);
  });

  it("should validate ESCALATE strategy with target", () => {
    const plan = {
      strategy: FallbackStrategy.ESCALATE,
      escalation_target: "on-call-engineer",
    };
    const result = fallbackPlanSchema.safeParse(plan);
    expect(result.success).toBe(true);
  });

  it("should validate COMPENSATE strategy with actions", () => {
    const plan = {
      strategy: FallbackStrategy.COMPENSATE,
      compensation_actions: [
        { type: "RESTORE", target: "asset-001", params: { state: "IDLE" } },
      ],
    };
    const result = fallbackPlanSchema.safeParse(plan);
    expect(result.success).toBe(true);
  });

  it("should reject invalid max_retries", () => {
    const plan = {
      strategy: FallbackStrategy.ROLLBACK,
      max_retries: 100, // Max is 10
    };
    const result = fallbackPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// OBSERVABLE SCHEMA TESTS
// =============================================================================

describe("Observable Schema", () => {
  it("should validate STATE_CHANGED observable", () => {
    const observable = {
      type: ObservableType.STATE_CHANGED,
      target: "asset-001",
      expectedValue: "RUNNING",
    };
    const result = observableSchema.safeParse(observable);
    expect(result.success).toBe(true);
  });

  it("should validate observable with timeout", () => {
    const observable = {
      type: ObservableType.HEALTH_CHECK_PASS,
      target: "all-sites",
      timeout: 5000,
    };
    const result = observableSchema.safeParse(observable);
    expect(result.success).toBe(true);
  });

  it("should reject observable without target", () => {
    const observable = {
      type: ObservableType.STATE_CHANGED,
    };
    const result = observableSchema.safeParse(observable);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// VALIDATION HELPER TESTS
// =============================================================================

describe("validateIntentPacket Helper", () => {
  it("should return valid=true for valid packet", () => {
    const result = validateIntentPacket(validIntentPacket);
    expect(result.valid).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.errors).toBeUndefined();
  });

  it("should return actionable errors for invalid packet", () => {
    const invalidPacket = { mode: "INVALID" };
    const result = validateIntentPacket(invalidPacket);

    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
    expect(result.errors![0]).toHaveProperty("field");
    expect(result.errors![0]).toHaveProperty("message");
    expect(result.errors![0]).toHaveProperty("code");
  });

  it("should include field path in errors", () => {
    const invalidPacket = {
      ...validIntentPacket,
      target_selector: { siteIds: [] }, // Empty array - invalid
    };
    const result = validateIntentPacket(invalidPacket);

    expect(result.valid).toBe(false);
    expect(result.errors!.some((e) => e.field.includes("target_selector"))).toBe(
      true
    );
  });
});

// =============================================================================
// CREATE INTENT PACKET TESTS
// =============================================================================

describe("createIntentPacket Helper", () => {
  it("should generate UUID if not provided", () => {
    const packet = createIntentPacket(minimalValidPacket);
    expect(packet.intent_id).toBeDefined();
    expect(packet.intent_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  it("should generate timestamp if not provided", () => {
    const packet = createIntentPacket(minimalValidPacket);
    expect(packet.created_at).toBeDefined();
    expect(new Date(packet.created_at!).getTime()).toBeGreaterThan(0);
  });

  it("should preserve provided UUID", () => {
    const customId = "12345678-1234-1234-1234-123456789012";
    const packet = createIntentPacket({ ...minimalValidPacket, intent_id: customId });
    expect(packet.intent_id).toBe(customId);
  });

  it("should initialize empty arrays for optional fields", () => {
    const packet = createIntentPacket(minimalValidPacket);
    expect(packet.constraints).toEqual([]);
    expect(packet.expected_observables).toEqual([]);
    expect(packet.telemetry_hooks).toEqual([]);
  });
});

// =============================================================================
// AUTHORITY ORDER TESTS
// =============================================================================

describe("Authority Level Ordering", () => {
  it("should have correct ordering", () => {
    expect(AUTHORITY_ORDER.VIEWER).toBeLessThan(AUTHORITY_ORDER.OPERATOR);
    expect(AUTHORITY_ORDER.OPERATOR).toBeLessThan(AUTHORITY_ORDER.ENGINEER);
    expect(AUTHORITY_ORDER.ENGINEER).toBeLessThan(AUTHORITY_ORDER.SUPERVISOR);
    expect(AUTHORITY_ORDER.SUPERVISOR).toBeLessThan(AUTHORITY_ORDER.ADMIN);
  });

  it("should allow authority comparison", () => {
    const required = AuthorityLevel.ENGINEER;
    const hasOperator = AuthorityLevel.OPERATOR;
    const hasSupervisor = AuthorityLevel.SUPERVISOR;

    expect(AUTHORITY_ORDER[hasOperator] >= AUTHORITY_ORDER[required]).toBe(false);
    expect(AUTHORITY_ORDER[hasSupervisor] >= AUTHORITY_ORDER[required]).toBe(true);
  });
});

// =============================================================================
// INTENT PACKET SERVICE TESTS
// =============================================================================

describe("IntentPacketService", () => {
  let service: IntentPacketService;

  beforeEach(() => {
    resetIntentPacketService();
    service = getIntentPacketService();
  });

  afterEach(() => {
    resetIntentPacketService();
  });

  describe("validate", () => {
    it("should validate valid packets", () => {
      const result = service.validate(validIntentPacket);
      expect(result.valid).toBe(true);
      expect(result.packet).toBeDefined();
    });

    it("should return warnings for low confidence", () => {
      const lowConfidencePacket = { ...validIntentPacket, confidence: 0.3 };
      const result = service.validate(lowConfidencePacket);
      expect(result.valid).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings!.some((w) => w.includes("confidence"))).toBe(true);
    });

    it("should return warnings for high TTL", () => {
      const highTtlPacket = { ...validIntentPacket, ttl: 7200000 }; // 2 hours
      const result = service.validate(highTtlPacket);
      expect(result.valid).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings!.some((w) => w.includes("TTL"))).toBe(true);
    });

    it("should return errors for invalid packets", () => {
      const result = service.validate({ mode: "INVALID" });
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
    });
  });

  describe("ingest", () => {
    it("should successfully ingest valid packets", () => {
      const result = service.ingest(validIntentPacket);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.packet.intent_id).toBe(validIntentPacket.intent_id);
      }
    });

    it("should reject invalid packets", () => {
      const result = service.ingest({ mode: "INVALID" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors).toBeDefined();
      }
    });

    it("should check authority when context provided", () => {
      const packet = { ...validIntentPacket, authority_required: AuthorityLevel.ADMIN };
      const result = service.ingest(packet, {
        agentAuthority: AuthorityLevel.OPERATOR,
        source: "test",
      });
      expect(result.success).toBe(false);
    });

    it("should allow sufficient authority", () => {
      const packet = { ...validIntentPacket, authority_required: AuthorityLevel.OPERATOR };
      const result = service.ingest(packet, {
        agentAuthority: AuthorityLevel.SUPERVISOR,
        source: "test",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("pending intents", () => {
    it("should store pending intents", () => {
      service.ingest(validIntentPacket);
      expect(service.getPendingCount()).toBe(1);
    });

    it("should retrieve pending intent by ID", () => {
      service.ingest(validIntentPacket);
      const pending = service.getPending(validIntentPacket.intent_id);
      expect(pending).toBeDefined();
      expect(pending!.intent_id).toBe(validIntentPacket.intent_id);
    });

    it("should remove pending intent", () => {
      service.ingest(validIntentPacket);
      const removed = service.removePending(validIntentPacket.intent_id);
      expect(removed).toBe(true);
      expect(service.getPendingCount()).toBe(0);
    });

    it("should return false when removing non-existent intent", () => {
      const removed = service.removePending("non-existent-id");
      expect(removed).toBe(false);
    });
  });

  describe("checkAuthority", () => {
    it("should authorize matching authority", () => {
      const packet = { ...validIntentPacket, authority_required: AuthorityLevel.OPERATOR };
      const result = service.checkAuthority(packet, AuthorityLevel.OPERATOR);
      expect(result.authorized).toBe(true);
    });

    it("should authorize higher authority", () => {
      const packet = { ...validIntentPacket, authority_required: AuthorityLevel.OPERATOR };
      const result = service.checkAuthority(packet, AuthorityLevel.ADMIN);
      expect(result.authorized).toBe(true);
    });

    it("should reject insufficient authority", () => {
      const packet = { ...validIntentPacket, authority_required: AuthorityLevel.SUPERVISOR };
      const result = service.checkAuthority(packet, AuthorityLevel.OPERATOR);
      expect(result.authorized).toBe(false);
      expect(result.reason).toContain("SUPERVISOR");
    });
  });

  describe("buildRejectionResult", () => {
    it("should build valid rejection result", () => {
      const errors = [{ field: "mode", message: "Invalid mode", code: "invalid_enum" }];
      const result = service.buildRejectionResult("test-id", errors);

      expect(result.outcome).toBe("REJECTED");
      expect(result.mode).toBe(PropagationMode.SAFE_HOLD);
      expect(result.validation_errors).toBeDefined();
      expect(result.validation_errors!.length).toBe(1);
    });
  });
});

// =============================================================================
// SINGLETON TESTS
// =============================================================================

describe("Service Singleton", () => {
  afterEach(() => {
    resetIntentPacketService();
  });

  it("should return same instance", () => {
    const service1 = getIntentPacketService();
    const service2 = getIntentPacketService();
    expect(service1).toBe(service2);
  });

  it("should create new instance after reset", () => {
    const service1 = getIntentPacketService();
    resetIntentPacketService();
    const service2 = getIntentPacketService();
    expect(service1).not.toBe(service2);
  });
});
