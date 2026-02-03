/**
 * 0xSCADA Agent Decision Schema Tests
 * 
 * VERITY Architecture - Phase γ.1.1: Agent Decision Record Schema
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  // Schemas
  agentDecisionSchema,
  decisionInputsSchema,
  decisionReasoningSchema,
  decisionOutputSchema,
  decisionVerificationSchema,
  actionSchema,
  checkResultSchema,
  createAgentDecisionInputSchema,
  agentDecisionQuerySchema,
  
  // Types
  type AgentDecision,
  type CreateAgentDecisionInput,
  type DecisionInputs,
  type DecisionReasoning,
  type DecisionOutput,
  type DecisionVerification,
  type Action,
  type CheckResult,
  type ContentHash,
  
  // Validation helpers
  validateAgentDecision,
  validateDecisionInputs,
  isAgentDecision,
  isAction,
  isCheckResult,
} from "../shared/types";

// =============================================================================
// TEST DATA FACTORIES
// =============================================================================

function makeContentHash(seed: string): ContentHash {
  // Generate a valid 64-character hex string (SHA-256 format)
  // Convert each character to a hex digit (0-f) based on its char code
  let hash = '';
  for (let i = 0; i < 64; i++) {
    const charCode = seed.charCodeAt(i % seed.length);
    hash += (charCode % 16).toString(16);
  }
  return hash as ContentHash;
}

function makeValidAction(overrides: Partial<Action> = {}): Action {
  return {
    type: "command",
    target: "PLC_001",
    parameters: { command: "start" },
    priority: "normal",
    requiresApproval: true,
    ...overrides,
  };
}

function makeValidCheckResult(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    name: "safety_check_001",
    category: "safety",
    status: "pass",
    message: "All safety conditions met",
    checkedAt: new Date().toISOString(),
    durationMs: 42,
    ...overrides,
  };
}

function makeValidInputs(overrides: Partial<DecisionInputs> = {}): DecisionInputs {
  return {
    artifacts: [makeContentHash("artifact1"), makeContentHash("artifact2")],
    context: makeContentHash("context"),
    constraints: makeContentHash("constraints"),
    ...overrides,
  };
}

function makeValidReasoning(overrides: Partial<DecisionReasoning> = {}): DecisionReasoning {
  return {
    chainOfThought: makeContentHash("cot"),
    model: "gpt-4-turbo-2024-04-09",
    temperature: 0.7,
    tokens: 1500,
    tokenBreakdown: { input: 500, output: 1000 },
    durationMs: 2500,
    ...overrides,
  };
}

function makeValidOutput(overrides: Partial<DecisionOutput> = {}): DecisionOutput {
  return {
    decision: "Increase pump flow rate to compensate for downstream pressure drop",
    action: makeValidAction(),
    confidence: 0.85,
    keyFactors: ["pressure_reading", "flow_rate", "safety_margin"],
    uncertainties: ["sensor_calibration_last_updated_30_days_ago"],
    ...overrides,
  };
}

function makeValidVerification(overrides: Partial<DecisionVerification> = {}): DecisionVerification {
  return {
    humanApproved: undefined,
    automatedChecks: [makeValidCheckResult()],
    safetyScore: 0.92,
    riskAssessment: {
      level: "low",
      factors: ["routine_operation", "within_normal_parameters"],
    },
    policyCompliance: {
      compliant: true,
      violations: [],
      warnings: [],
    },
    verifiedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeValidAgentDecision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    id: makeContentHash("decision"),
    schemaVersion: "1.0.0",
    timestamp: new Date().toISOString(),
    agent: {
      id: "agent-001",
      name: "ops-agent",
      type: "OPS",
      version: "1.0.0",
    },
    siteId: "site-001",
    assetIds: ["pump-001", "valve-002"],
    inputs: makeValidInputs(),
    reasoning: makeValidReasoning(),
    output: makeValidOutput(),
    verification: makeValidVerification(),
    signature: {
      algorithm: "hmac-sha256",
      keyId: "agent-001",
      value: "abc123signature",
      signedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

function makeValidCreateInput(overrides: Partial<CreateAgentDecisionInput> = {}): CreateAgentDecisionInput {
  return {
    agent: {
      id: "agent-001",
      name: "ops-agent",
      type: "OPS",
      version: "1.0.0",
    },
    siteId: "site-001",
    assetIds: ["pump-001"],
    inputs: makeValidInputs(),
    reasoning: makeValidReasoning(),
    output: makeValidOutput(),
    verification: makeValidVerification(),
    ...overrides,
  };
}

// =============================================================================
// SCHEMA VALIDATION TESTS
// =============================================================================

describe("AgentDecision Schema", () => {
  describe("ContentHash validation", () => {
    it("accepts valid 64-character hex string", () => {
      const hash = makeContentHash("valid");
      const inputs = makeValidInputs({ context: hash });
      const result = decisionInputsSchema.safeParse(inputs);
      expect(result.success).toBe(true);
    });

    it("rejects short hash", () => {
      const inputs = makeValidInputs({ context: "abc123" as ContentHash });
      const result = decisionInputsSchema.safeParse(inputs);
      expect(result.success).toBe(false);
    });

    it("rejects uppercase hex", () => {
      const uppercase = "ABCDEF".repeat(10) + "ABCD" as ContentHash;
      const inputs = makeValidInputs({ context: uppercase });
      const result = decisionInputsSchema.safeParse(inputs);
      expect(result.success).toBe(false);
    });

    it("rejects non-hex characters", () => {
      const invalid = "xyz123".repeat(10) + "xyz1" as ContentHash;
      const inputs = makeValidInputs({ context: invalid });
      const result = decisionInputsSchema.safeParse(inputs);
      expect(result.success).toBe(false);
    });
  });

  describe("Action schema", () => {
    it("validates complete action", () => {
      const action = makeValidAction();
      const result = actionSchema.safeParse(action);
      expect(result.success).toBe(true);
    });

    it("validates minimal action", () => {
      const action = { type: "no_op", requiresApproval: false };
      const result = actionSchema.safeParse(action);
      expect(result.success).toBe(true);
    });

    it("rejects invalid action type", () => {
      const action = { ...makeValidAction(), type: "invalid_type" };
      const result = actionSchema.safeParse(action);
      expect(result.success).toBe(false);
    });

    it("rejects invalid priority", () => {
      const action = { ...makeValidAction(), priority: "urgent" };
      const result = actionSchema.safeParse(action);
      expect(result.success).toBe(false);
    });
  });

  describe("CheckResult schema", () => {
    it("validates complete check result", () => {
      const check = makeValidCheckResult();
      const result = checkResultSchema.safeParse(check);
      expect(result.success).toBe(true);
    });

    it("validates all status types", () => {
      const statuses = ["pass", "fail", "warn", "skip", "error"];
      for (const status of statuses) {
        const check = makeValidCheckResult({ status: status as CheckResult["status"] });
        const result = checkResultSchema.safeParse(check);
        expect(result.success).toBe(true);
      }
    });

    it("validates all category types", () => {
      const categories = ["safety", "compliance", "consistency", "boundary", "dependency", "policy"];
      for (const category of categories) {
        const check = makeValidCheckResult({ category: category as CheckResult["category"] });
        const result = checkResultSchema.safeParse(check);
        expect(result.success).toBe(true);
      }
    });

    it("rejects missing required fields", () => {
      const check = { name: "test", status: "pass" };
      const result = checkResultSchema.safeParse(check);
      expect(result.success).toBe(false);
    });
  });

  describe("DecisionInputs schema", () => {
    it("validates complete inputs", () => {
      const inputs = makeValidInputs();
      const result = decisionInputsSchema.safeParse(inputs);
      expect(result.success).toBe(true);
    });

    it("validates inputs with optional fields", () => {
      const inputs = makeValidInputs({
        priorDecisions: [makeContentHash("prior1")],
        userPrompt: makeContentHash("prompt"),
      });
      const result = decisionInputsSchema.safeParse(inputs);
      expect(result.success).toBe(true);
    });

    it("validates empty artifacts array", () => {
      const inputs = makeValidInputs({ artifacts: [] });
      const result = decisionInputsSchema.safeParse(inputs);
      expect(result.success).toBe(true);
    });

    it("rejects missing context", () => {
      const inputs = { artifacts: [], constraints: makeContentHash("c") };
      const result = decisionInputsSchema.safeParse(inputs);
      expect(result.success).toBe(false);
    });
  });

  describe("DecisionReasoning schema", () => {
    it("validates complete reasoning", () => {
      const reasoning = makeValidReasoning();
      const result = decisionReasoningSchema.safeParse(reasoning);
      expect(result.success).toBe(true);
    });

    it("validates temperature bounds", () => {
      // Valid: 0 to 2
      expect(decisionReasoningSchema.safeParse(makeValidReasoning({ temperature: 0 })).success).toBe(true);
      expect(decisionReasoningSchema.safeParse(makeValidReasoning({ temperature: 1 })).success).toBe(true);
      expect(decisionReasoningSchema.safeParse(makeValidReasoning({ temperature: 2 })).success).toBe(true);
      
      // Invalid: outside bounds
      expect(decisionReasoningSchema.safeParse(makeValidReasoning({ temperature: -0.1 })).success).toBe(false);
      expect(decisionReasoningSchema.safeParse(makeValidReasoning({ temperature: 2.1 })).success).toBe(false);
    });

    it("validates with tool calls", () => {
      const reasoning = makeValidReasoning({
        toolCalls: [
          {
            tool: "get_sensor_reading",
            input: { sensorId: "temp-001" },
            output: makeContentHash("tool_output"),
            durationMs: 150,
          },
        ],
      });
      const result = decisionReasoningSchema.safeParse(reasoning);
      expect(result.success).toBe(true);
    });
  });

  describe("DecisionOutput schema", () => {
    it("validates complete output", () => {
      const output = makeValidOutput();
      const result = decisionOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it("validates output without action", () => {
      const output = makeValidOutput({ action: undefined });
      const result = decisionOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });

    it("validates confidence bounds", () => {
      expect(decisionOutputSchema.safeParse(makeValidOutput({ confidence: 0 })).success).toBe(true);
      expect(decisionOutputSchema.safeParse(makeValidOutput({ confidence: 0.5 })).success).toBe(true);
      expect(decisionOutputSchema.safeParse(makeValidOutput({ confidence: 1 })).success).toBe(true);
      
      expect(decisionOutputSchema.safeParse(makeValidOutput({ confidence: -0.1 })).success).toBe(false);
      expect(decisionOutputSchema.safeParse(makeValidOutput({ confidence: 1.1 })).success).toBe(false);
    });

    it("validates with alternatives", () => {
      const output = makeValidOutput({
        alternatives: [
          {
            decision: "Maintain current flow rate",
            confidence: 0.6,
            rejectionReason: "Would not address pressure drop",
          },
          {
            decision: "Shut down pump",
            action: makeValidAction({ type: "command" }),
            confidence: 0.3,
            rejectionReason: "Too aggressive given current conditions",
          },
        ],
      });
      const result = decisionOutputSchema.safeParse(output);
      expect(result.success).toBe(true);
    });
  });

  describe("DecisionVerification schema", () => {
    it("validates complete verification", () => {
      const verification = makeValidVerification();
      const result = decisionVerificationSchema.safeParse(verification);
      expect(result.success).toBe(true);
    });

    it("validates with human approval", () => {
      const verification = makeValidVerification({
        humanApproved: true,
        humanApprover: {
          userId: "user-001",
          approvedAt: new Date().toISOString(),
          comment: "Looks good",
          signature: "sig123",
        },
      });
      const result = decisionVerificationSchema.safeParse(verification);
      expect(result.success).toBe(true);
    });

    it("validates safety score bounds", () => {
      expect(decisionVerificationSchema.safeParse(makeValidVerification({ safetyScore: 0 })).success).toBe(true);
      expect(decisionVerificationSchema.safeParse(makeValidVerification({ safetyScore: 1 })).success).toBe(true);
      
      expect(decisionVerificationSchema.safeParse(makeValidVerification({ safetyScore: -0.1 })).success).toBe(false);
      expect(decisionVerificationSchema.safeParse(makeValidVerification({ safetyScore: 1.1 })).success).toBe(false);
    });
  });

  describe("Full AgentDecision schema", () => {
    it("validates complete decision", () => {
      const decision = makeValidAgentDecision();
      const result = agentDecisionSchema.safeParse(decision);
      expect(result.success).toBe(true);
    });

    it("validates decision with execution status", () => {
      const decision = makeValidAgentDecision({
        execution: {
          status: "completed",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          result: { success: true, output: "Flow rate increased" },
        },
      });
      const result = agentDecisionSchema.safeParse(decision);
      expect(result.success).toBe(true);
    });

    it("validates decision with related artifacts", () => {
      const decision = makeValidAgentDecision({
        relatedArtifacts: {
          previousDecision: makeContentHash("prev"),
          twinCheckpoint: makeContentHash("twin"),
          anchor: {
            txHash: "0x1234567890abcdef",
            blockNumber: 12345678,
            anchoredAt: new Date().toISOString(),
          },
        },
      });
      const result = agentDecisionSchema.safeParse(decision);
      expect(result.success).toBe(true);
    });

    it("enforces schema version", () => {
      const decision = makeValidAgentDecision({ schemaVersion: "2.0.0" as any });
      const result = agentDecisionSchema.safeParse(decision);
      expect(result.success).toBe(false);
    });
  });
});

// =============================================================================
// VALIDATION HELPER TESTS
// =============================================================================

describe("Validation Helpers", () => {
  describe("validateAgentDecision", () => {
    it("returns valid result for correct decision", () => {
      const decision = makeValidAgentDecision();
      const result = validateAgentDecision(decision);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.decision).toEqual(decision);
    });

    it("returns errors for invalid decision", () => {
      const result = validateAgentDecision({ invalid: "data" });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.decision).toBeUndefined();
    });

    it("provides path information for errors", () => {
      const badDecision = {
        ...makeValidAgentDecision(),
        output: { ...makeValidOutput(), confidence: 2.0 },
      };
      const result = validateAgentDecision(badDecision);
      expect(result.valid).toBe(false);
      const confidenceError = result.errors.find((e) => e.path.includes("confidence"));
      expect(confidenceError).toBeDefined();
    });
  });

  describe("validateDecisionInputs", () => {
    it("returns valid result for correct inputs", () => {
      const inputs = makeValidInputs();
      const result = validateDecisionInputs(inputs);
      expect(result.valid).toBe(true);
      expect(result.inputs).toEqual(inputs);
    });

    it("returns errors for invalid inputs", () => {
      const result = validateDecisionInputs({ context: "short" });
      expect(result.valid).toBe(false);
    });
  });
});

// =============================================================================
// TYPE GUARD TESTS
// =============================================================================

describe("Type Guards", () => {
  describe("isAgentDecision", () => {
    it("returns true for valid decision", () => {
      expect(isAgentDecision(makeValidAgentDecision())).toBe(true);
    });

    it("returns false for invalid decision", () => {
      expect(isAgentDecision(null)).toBe(false);
      expect(isAgentDecision(undefined)).toBe(false);
      expect(isAgentDecision({})).toBe(false);
      expect(isAgentDecision({ id: "not-a-hash" })).toBe(false);
    });
  });

  describe("isAction", () => {
    it("returns true for valid action", () => {
      expect(isAction(makeValidAction())).toBe(true);
    });

    it("returns false for invalid action", () => {
      expect(isAction(null)).toBe(false);
      expect(isAction({ type: "invalid" })).toBe(false);
    });
  });

  describe("isCheckResult", () => {
    it("returns true for valid check result", () => {
      expect(isCheckResult(makeValidCheckResult())).toBe(true);
    });

    it("returns false for invalid check result", () => {
      expect(isCheckResult(null)).toBe(false);
      expect(isCheckResult({ name: "test" })).toBe(false);
    });
  });
});

// =============================================================================
// QUERY SCHEMA TESTS
// =============================================================================

describe("AgentDecisionQuery Schema", () => {
  it("validates empty query", () => {
    const result = agentDecisionQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    // Check defaults
    if (result.success) {
      expect(result.data.offset).toBe(0);
      expect(result.data.limit).toBe(100);
    }
  });

  it("validates full query", () => {
    const query = {
      agentId: "agent-001",
      agentType: "OPS",
      siteId: "site-001",
      assetIds: ["asset-001"],
      actionType: "command",
      executionStatus: "completed",
      minConfidence: 0.7,
      minSafetyScore: 0.8,
      humanApproved: true,
      dependsOnArtifact: makeContentHash("dep"),
      fromTimestamp: new Date().toISOString(),
      toTimestamp: new Date().toISOString(),
      offset: 10,
      limit: 50,
    };
    const result = agentDecisionQuerySchema.safeParse(query);
    expect(result.success).toBe(true);
  });

  it("enforces limit bounds", () => {
    expect(agentDecisionQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(agentDecisionQuerySchema.safeParse({ limit: 1001 }).success).toBe(false);
    expect(agentDecisionQuerySchema.safeParse({ limit: 1000 }).success).toBe(true);
  });

  it("enforces offset non-negative", () => {
    expect(agentDecisionQuerySchema.safeParse({ offset: -1 }).success).toBe(false);
    expect(agentDecisionQuerySchema.safeParse({ offset: 0 }).success).toBe(true);
  });
});

// =============================================================================
// CREATE INPUT SCHEMA TESTS
// =============================================================================

describe("CreateAgentDecisionInput Schema", () => {
  it("validates complete input", () => {
    const input = makeValidCreateInput();
    const result = createAgentDecisionInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("allows missing verification", () => {
    const input = makeValidCreateInput({ verification: undefined });
    const result = createAgentDecisionInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("requires agent info", () => {
    const input = { ...makeValidCreateInput(), agent: undefined };
    const result = createAgentDecisionInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("requires inputs", () => {
    const input = { ...makeValidCreateInput(), inputs: undefined };
    const result = createAgentDecisionInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("requires reasoning", () => {
    const input = { ...makeValidCreateInput(), reasoning: undefined };
    const result = createAgentDecisionInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("requires output", () => {
    const input = { ...makeValidCreateInput(), output: undefined };
    const result = createAgentDecisionInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});
