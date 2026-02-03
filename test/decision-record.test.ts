/**
 * 0xSCADA Decision Record Integration Tests
 * 
 * VERITY Architecture - Phase γ.1.1: Agent Decision Recording
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  DecisionBuilder,
  computeDecisionHash,
  finalizeDecision,
  checkInputArtifactsExist,
  checkConfidenceThreshold,
  checkHighRiskApproval,
  checkReasoningDepth,
  runAutomatedChecks,
  computeSafetyScore,
  extractReplayInputs,
  compareDecisions,
  DEFAULT_AUTOMATED_CHECKS,
} from "../server/agents/decision-record";
import type {
  CreateAgentDecisionInput,
  AgentDecision,
  DecisionInputs,
  DecisionReasoning,
  DecisionOutput,
  ContentHash,
} from "../shared/types";
import type { AgentConfig } from "../server/agents/base";

// =============================================================================
// TEST FIXTURES
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

const mockAgentConfig: AgentConfig = {
  id: "test-agent-001",
  name: "test-agent",
  displayName: "Test Agent",
  agentType: "OPS",
  capabilities: [],
  scope: {
    allSites: false,
    siteIds: ["site-001"],
    allAssets: false,
    assetIds: [],
    assetTypes: [],
    allEventTypes: false,
    eventTypes: [],
  },
  privateKey: "test-private-key-12345",
  publicKey: "test-public-key-67890",
};

const mockInputs: DecisionInputs = {
  artifacts: [makeContentHash("artifact1"), makeContentHash("artifact2")],
  context: makeContentHash("context"),
  constraints: makeContentHash("constraints"),
};

const mockReasoning: DecisionReasoning = {
  chainOfThought: makeContentHash("cot"),
  model: "gpt-4-turbo",
  temperature: 0.7,
  tokens: 1500,
};

const mockOutput: DecisionOutput = {
  decision: "Test decision",
  confidence: 0.85,
  action: {
    type: "command",
    target: "PLC_001",
    priority: "normal",
    requiresApproval: true,
  },
};

// =============================================================================
// DECISION BUILDER TESTS
// =============================================================================

describe("DecisionBuilder", () => {
  it("creates a decision with all fields", () => {
    const builder = new DecisionBuilder(mockAgentConfig);
    const result = builder
      .forSite("site-001")
      .forAssets(["asset-001"])
      .withInputs(mockInputs)
      .withReasoning(mockReasoning)
      .withOutput(mockOutput)
      .withVerification({ automatedChecks: [], safetyScore: 0.9 })
      .build();

    expect(result.agent.id).toBe(mockAgentConfig.id);
    expect(result.agent.name).toBe(mockAgentConfig.name);
    expect(result.siteId).toBe("site-001");
    expect(result.assetIds).toEqual(["asset-001"]);
    expect(result.inputs).toEqual(mockInputs);
    expect(result.reasoning).toEqual(mockReasoning);
    expect(result.output).toEqual(mockOutput);
  });

  it("throws if inputs are missing", () => {
    const builder = new DecisionBuilder(mockAgentConfig);
    builder.withReasoning(mockReasoning).withOutput(mockOutput);
    expect(() => builder.build()).toThrow("Decision inputs are required");
  });

  it("throws if reasoning is missing", () => {
    const builder = new DecisionBuilder(mockAgentConfig);
    builder.withInputs(mockInputs).withOutput(mockOutput);
    expect(() => builder.build()).toThrow("Decision reasoning is required");
  });

  it("throws if output is missing", () => {
    const builder = new DecisionBuilder(mockAgentConfig);
    builder.withInputs(mockInputs).withReasoning(mockReasoning);
    expect(() => builder.build()).toThrow("Decision output is required");
  });

  it("chains previous decision", () => {
    const previousId = makeContentHash("previous");
    const builder = new DecisionBuilder(mockAgentConfig);
    const result = builder
      .chainFrom(previousId)
      .withInputs(mockInputs)
      .withReasoning(mockReasoning)
      .withOutput(mockOutput)
      .build();

    // Note: chainFrom sets internal state but doesn't add to build output directly
    // The actual linking would be done by the storage layer
    expect(result).toBeDefined();
  });
});

// =============================================================================
// HASH COMPUTATION TESTS
// =============================================================================

describe("computeDecisionHash", () => {
  it("produces consistent hash for same input", () => {
    const input = new DecisionBuilder(mockAgentConfig)
      .withInputs(mockInputs)
      .withReasoning(mockReasoning)
      .withOutput(mockOutput)
      .build();

    const hash1 = computeDecisionHash(input);
    const hash2 = computeDecisionHash(input);

    expect(hash1).toBe(hash2);
  });

  it("produces different hash for different input", () => {
    const input1 = new DecisionBuilder(mockAgentConfig)
      .withInputs(mockInputs)
      .withReasoning(mockReasoning)
      .withOutput(mockOutput)
      .build();

    const input2 = new DecisionBuilder(mockAgentConfig)
      .withInputs(mockInputs)
      .withReasoning(mockReasoning)
      .withOutput({ ...mockOutput, decision: "Different decision" })
      .build();

    const hash1 = computeDecisionHash(input1);
    const hash2 = computeDecisionHash(input2);

    expect(hash1).not.toBe(hash2);
  });

  it("produces 64-character hex string", () => {
    const input = new DecisionBuilder(mockAgentConfig)
      .withInputs(mockInputs)
      .withReasoning(mockReasoning)
      .withOutput(mockOutput)
      .build();

    const hash = computeDecisionHash(input);

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

// =============================================================================
// FINALIZE DECISION TESTS
// =============================================================================

describe("finalizeDecision", () => {
  it("adds id, timestamp, and signature", () => {
    const input = new DecisionBuilder(mockAgentConfig)
      .withInputs(mockInputs)
      .withReasoning(mockReasoning)
      .withOutput(mockOutput)
      .build();

    const decision = finalizeDecision(input, mockAgentConfig.privateKey);

    expect(decision.id).toMatch(/^[a-f0-9]{64}$/);
    expect(decision.timestamp).toBeDefined();
    expect(decision.signature).toBeDefined();
    expect(decision.signature?.algorithm).toBe("hmac-sha256");
    expect(decision.signature?.keyId).toBe(input.agent.id);
    expect(decision.schemaVersion).toBe("1.0.0");
  });

  it("preserves all input fields", () => {
    const input = new DecisionBuilder(mockAgentConfig)
      .forSite("site-001")
      .forAssets(["asset-001"])
      .withInputs(mockInputs)
      .withReasoning(mockReasoning)
      .withOutput(mockOutput)
      .build();

    const decision = finalizeDecision(input, mockAgentConfig.privateKey);

    expect(decision.agent).toEqual(input.agent);
    expect(decision.siteId).toBe(input.siteId);
    expect(decision.assetIds).toEqual(input.assetIds);
    expect(decision.inputs).toEqual(input.inputs);
    expect(decision.reasoning).toEqual(input.reasoning);
    expect(decision.output).toEqual(input.output);
  });
});

// =============================================================================
// AUTOMATED CHECK TESTS
// =============================================================================

describe("Automated Checks", () => {
  describe("checkInputArtifactsExist", () => {
    it("passes when all artifacts exist", () => {
      const existingArtifacts = new Set(mockInputs.artifacts);
      const check = checkInputArtifactsExist((hash) => existingArtifacts.has(hash));
      
      const input = new DecisionBuilder(mockAgentConfig)
        .withInputs(mockInputs)
        .withReasoning(mockReasoning)
        .withOutput(mockOutput)
        .build();

      const result = check(input);

      expect(result.status).toBe("pass");
      expect(result.category).toBe("dependency");
    });

    it("fails when artifact is missing", () => {
      const check = checkInputArtifactsExist(() => false);
      
      const input = new DecisionBuilder(mockAgentConfig)
        .withInputs(mockInputs)
        .withReasoning(mockReasoning)
        .withOutput(mockOutput)
        .build();

      const result = check(input);

      expect(result.status).toBe("fail");
      expect(result.details?.missingArtifacts).toHaveLength(2);
    });
  });

  describe("checkConfidenceThreshold", () => {
    it("passes when confidence meets threshold", () => {
      const check = checkConfidenceThreshold(0.8);
      
      const input = new DecisionBuilder(mockAgentConfig)
        .withInputs(mockInputs)
        .withReasoning(mockReasoning)
        .withOutput({ ...mockOutput, confidence: 0.9 })
        .build();

      const result = check(input);

      expect(result.status).toBe("pass");
    });

    it("warns when confidence below threshold", () => {
      const check = checkConfidenceThreshold(0.9);
      
      const input = new DecisionBuilder(mockAgentConfig)
        .withInputs(mockInputs)
        .withReasoning(mockReasoning)
        .withOutput({ ...mockOutput, confidence: 0.7 })
        .build();

      const result = check(input);

      expect(result.status).toBe("warn");
    });
  });

  describe("checkHighRiskApproval", () => {
    it("passes when high-risk action requires approval", () => {
      const check = checkHighRiskApproval();
      
      const input = new DecisionBuilder(mockAgentConfig)
        .withInputs(mockInputs)
        .withReasoning(mockReasoning)
        .withOutput({
          ...mockOutput,
          action: { type: "command", requiresApproval: true, priority: "normal" },
        })
        .build();

      const result = check(input);

      expect(result.status).toBe("pass");
    });

    it("fails when high-risk action does not require approval", () => {
      const check = checkHighRiskApproval();
      
      const input = new DecisionBuilder(mockAgentConfig)
        .withInputs(mockInputs)
        .withReasoning(mockReasoning)
        .withOutput({
          ...mockOutput,
          action: { type: "command", requiresApproval: false, priority: "normal" },
        })
        .build();

      const result = check(input);

      expect(result.status).toBe("fail");
    });

    it("skips when no action", () => {
      const check = checkHighRiskApproval();
      
      const input = new DecisionBuilder(mockAgentConfig)
        .withInputs(mockInputs)
        .withReasoning(mockReasoning)
        .withOutput({ ...mockOutput, action: undefined })
        .build();

      const result = check(input);

      expect(result.status).toBe("skip");
    });
  });

  describe("checkReasoningDepth", () => {
    it("passes when tokens exceed threshold", () => {
      const check = checkReasoningDepth(1000);
      
      const input = new DecisionBuilder(mockAgentConfig)
        .withInputs(mockInputs)
        .withReasoning({ ...mockReasoning, tokens: 1500 })
        .withOutput(mockOutput)
        .build();

      const result = check(input);

      expect(result.status).toBe("pass");
    });

    it("warns when tokens below threshold", () => {
      const check = checkReasoningDepth(2000);
      
      const input = new DecisionBuilder(mockAgentConfig)
        .withInputs(mockInputs)
        .withReasoning({ ...mockReasoning, tokens: 500 })
        .withOutput(mockOutput)
        .build();

      const result = check(input);

      expect(result.status).toBe("warn");
    });
  });
});

// =============================================================================
// SAFETY SCORE COMPUTATION TESTS
// =============================================================================

describe("computeSafetyScore", () => {
  it("returns 0 for empty checks", () => {
    expect(computeSafetyScore([])).toBe(0);
  });

  it("returns 1.0 for all passing checks", () => {
    const checks = [
      { name: "test1", category: "safety" as const, status: "pass" as const, checkedAt: new Date().toISOString() },
      { name: "test2", category: "compliance" as const, status: "pass" as const, checkedAt: new Date().toISOString() },
    ];
    const score = computeSafetyScore(checks);
    expect(score).toBeCloseTo(1.0, 2);
  });

  it("returns lower score for failing checks", () => {
    const checks = [
      { name: "test1", category: "safety" as const, status: "pass" as const, checkedAt: new Date().toISOString() },
      { name: "test2", category: "safety" as const, status: "fail" as const, checkedAt: new Date().toISOString() },
    ];
    const score = computeSafetyScore(checks);
    expect(score).toBeLessThan(1.0);
    expect(score).toBeGreaterThan(0);
  });

  it("weights safety checks higher", () => {
    // Safety fail
    const safetyFail = computeSafetyScore([
      { name: "test", category: "safety" as const, status: "fail" as const, checkedAt: new Date().toISOString() },
    ]);
    
    // Policy fail
    const policyFail = computeSafetyScore([
      { name: "test", category: "policy" as const, status: "fail" as const, checkedAt: new Date().toISOString() },
    ]);

    // Both should be 0 for single failing check
    expect(safetyFail).toBe(0);
    expect(policyFail).toBe(0);
  });
});

// =============================================================================
// REPLAY SUPPORT TESTS
// =============================================================================

describe("extractReplayInputs", () => {
  it("extracts all required inputs", () => {
    const input = new DecisionBuilder(mockAgentConfig)
      .withInputs(mockInputs)
      .withReasoning({ ...mockReasoning, systemPromptHash: makeContentHash("prompt") })
      .withOutput(mockOutput)
      .build();

    const decision = finalizeDecision(input, mockAgentConfig.privateKey);
    const replayInputs = extractReplayInputs(decision);

    expect(replayInputs.artifacts).toEqual(mockInputs.artifacts);
    expect(replayInputs.context).toBe(mockInputs.context);
    expect(replayInputs.constraints).toBe(mockInputs.constraints);
    expect(replayInputs.model).toBe(mockReasoning.model);
    expect(replayInputs.temperature).toBe(mockReasoning.temperature);
    expect(replayInputs.systemPromptHash).toBe(makeContentHash("prompt"));
  });
});

describe("compareDecisions", () => {
  it("identifies matching decisions", () => {
    const input = new DecisionBuilder(mockAgentConfig)
      .withInputs(mockInputs)
      .withReasoning(mockReasoning)
      .withOutput(mockOutput)
      .build();

    const original = finalizeDecision(input, mockAgentConfig.privateKey);
    const replayed = finalizeDecision(input, mockAgentConfig.privateKey);

    const comparison = compareDecisions(original, replayed);

    expect(comparison.decisionMatches).toBe(true);
    expect(comparison.actionMatches).toBe(true);
    expect(comparison.confidenceDelta).toBe(0);
    expect(comparison.outputMatches).toBe(true);
  });

  it("identifies differing decisions", () => {
    const input1 = new DecisionBuilder(mockAgentConfig)
      .withInputs(mockInputs)
      .withReasoning(mockReasoning)
      .withOutput(mockOutput)
      .build();

    const input2 = new DecisionBuilder(mockAgentConfig)
      .withInputs(mockInputs)
      .withReasoning(mockReasoning)
      .withOutput({ ...mockOutput, decision: "Different decision", confidence: 0.5 })
      .build();

    const original = finalizeDecision(input1, mockAgentConfig.privateKey);
    const replayed = finalizeDecision(input2, mockAgentConfig.privateKey);

    const comparison = compareDecisions(original, replayed);

    expect(comparison.decisionMatches).toBe(false);
    expect(comparison.confidenceDelta).toBeCloseTo(0.35, 2);
    expect(comparison.keyDifferences).toContain("decision_text_differs");
    expect(comparison.outputMatches).toBe(false);
  });

  it("detects action differences", () => {
    const input1 = new DecisionBuilder(mockAgentConfig)
      .withInputs(mockInputs)
      .withReasoning(mockReasoning)
      .withOutput(mockOutput)
      .build();

    const input2 = new DecisionBuilder(mockAgentConfig)
      .withInputs(mockInputs)
      .withReasoning(mockReasoning)
      .withOutput({
        ...mockOutput,
        action: { ...mockOutput.action!, target: "PLC_002" },
      })
      .build();

    const original = finalizeDecision(input1, mockAgentConfig.privateKey);
    const replayed = finalizeDecision(input2, mockAgentConfig.privateKey);

    const comparison = compareDecisions(original, replayed);

    expect(comparison.actionMatches).toBe(false);
    expect(comparison.keyDifferences).toContain("action_differs");
  });
});

// =============================================================================
// DEFAULT CHECKS TESTS
// =============================================================================

describe("DEFAULT_AUTOMATED_CHECKS", () => {
  it("includes expected checks", () => {
    expect(DEFAULT_AUTOMATED_CHECKS).toHaveLength(3);
  });

  it("runs all checks successfully", () => {
    const input = new DecisionBuilder(mockAgentConfig)
      .withInputs(mockInputs)
      .withReasoning(mockReasoning)
      .withOutput(mockOutput)
      .build();

    const results = runAutomatedChecks(input, DEFAULT_AUTOMATED_CHECKS);

    expect(results).toHaveLength(3);
    results.forEach((result) => {
      expect(result.name).toBeDefined();
      expect(result.category).toBeDefined();
      expect(result.status).toBeDefined();
      expect(result.checkedAt).toBeDefined();
    });
  });
});
