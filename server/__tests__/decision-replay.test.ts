/**
 * 0xSCADA Decision Replay Engine Tests
 * 
 * VERITY Architecture - Phase γ.2: Decision Replay Engine
 * 
 * "Every decision must be replayable: Inputs → Constraints → Reasoning → Outputs"
 * "If replay is impossible, the decision is invalid."
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DecisionReplayService,
  createDecisionReplayService,
  type ReplayContext,
  type DecisionExecutor,
  type ReplayResult,
  type ReplayValidationResult,
  type DecisionDiff,
  type IDecisionStorage,
} from "../services/decision-replay";
import { ArtifactStorageService } from "../services/artifact-storage";
import type { AgentDecision, ContentHash, CreateAgentDecisionInput } from "@shared/types";
import { sha256 } from "../crypto";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// =============================================================================
// TEST FIXTURES
// =============================================================================

const createTestDecision = (overrides?: Partial<AgentDecision>): AgentDecision => {
  const baseId = sha256(JSON.stringify({ test: Date.now(), random: Math.random() })) as ContentHash;
  
  return {
    id: baseId,
    schemaVersion: "1.0.0",
    timestamp: new Date().toISOString(),
    agent: {
      id: "test-agent-001",
      name: "test-agent",
      type: "compliance",
      version: "1.0.0",
    },
    siteId: "site-001",
    assetIds: ["asset-001", "asset-002"],
    inputs: {
      artifacts: [] as ContentHash[],
      context: sha256("test-context") as ContentHash,
      constraints: sha256("test-constraints") as ContentHash,
    },
    reasoning: {
      chainOfThought: sha256("test-cot") as ContentHash,
      model: "gpt-4",
      temperature: 0,
      tokens: 1000,
      seed: 42,
    },
    output: {
      decision: "Approved maintenance window for asset-001",
      action: {
        type: "maintenance",
        target: "asset-001",
        parameters: { duration: 3600 },
        priority: "normal",
        requiresApproval: true,
      },
      confidence: 0.85,
      keyFactors: ["Recent vibration anomaly", "Scheduled maintenance due"],
      uncertainties: ["Weather conditions unknown"],
    },
    verification: {
      automatedChecks: [
        {
          name: "safety_check",
          category: "safety",
          status: "pass",
          message: "All safety constraints satisfied",
          checkedAt: new Date().toISOString(),
        },
      ],
      safetyScore: 0.92,
    },
    ...overrides,
  };
};

const createMockArtifactStorage = (): ArtifactStorageService => {
  const storage = new ArtifactStorageService({
    lfsDir: path.join(os.tmpdir(), `test-lfs-${Date.now()}`),
    enableIndex: true,
    maxContentSize: 0,
    enableDeduplication: true,
  });
  return storage;
};

// =============================================================================
// TEST SUITE
// =============================================================================

describe("DecisionReplayService", () => {
  let service: DecisionReplayService;
  let artifactStorage: ArtifactStorageService;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `decision-replay-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    
    artifactStorage = new ArtifactStorageService({
      lfsDir: tempDir,
      enableIndex: true,
      maxContentSize: 0,
      enableDeduplication: true,
    });
    await artifactStorage.initialize();
    
    service = createDecisionReplayService({
      artifactStorage,
    });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // ===========================================================================
  // VALIDATION TESTS
  // ===========================================================================

  describe("validateReplayability", () => {
    it("should report missing artifacts", async () => {
      const decision = createTestDecision();
      
      const result = await service.validateReplayability(decision);
      
      expect(result.replayable).toBe(false);
      expect(result.missingArtifacts).toContain(decision.inputs.context);
      expect(result.missingArtifacts).toContain(decision.inputs.constraints);
      expect(result.missingArtifacts).toContain(decision.reasoning.chainOfThought);
    });

    it("should validate when all artifacts exist", async () => {
      // Store required artifacts
      const contextArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "config" },
        content: JSON.stringify({ test: "context" }),
        summary: "Test context",
      });
      
      const constraintsArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "config" },
        content: JSON.stringify({ constraints: [] }),
        summary: "Test constraints",
      });
      
      const cotArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "decision" },
        content: "Chain of thought reasoning...",
        summary: "Test chain of thought",
      });

      const decision = createTestDecision({
        inputs: {
          artifacts: [],
          context: contextArtifact.id,
          constraints: constraintsArtifact.id,
        },
        reasoning: {
          chainOfThought: cotArtifact.id,
          model: "gpt-4",
          temperature: 0,
          tokens: 1000,
          seed: 42,
        },
      });

      const result = await service.validateReplayability(decision);
      
      expect(result.replayable).toBe(true);
      expect(result.missingArtifacts).toHaveLength(0);
      expect(result.corruptedArtifacts).toHaveLength(0);
    });

    it("should warn about non-deterministic settings", async () => {
      // Store required artifacts
      const contextArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "config" },
        content: JSON.stringify({ test: "context" }),
      });
      
      const constraintsArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "config" },
        content: JSON.stringify({ constraints: [] }),
      });
      
      const cotArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "decision" },
        content: "Chain of thought...",
      });

      // Create decision with non-deterministic settings
      const decision = createTestDecision({
        inputs: {
          artifacts: [],
          context: contextArtifact.id,
          constraints: constraintsArtifact.id,
        },
        reasoning: {
          chainOfThought: cotArtifact.id,
          model: "gpt-4",
          temperature: 0.7, // Non-zero temperature
          tokens: 1000,
          // No seed
        },
        signature: undefined, // Unsigned
      });

      const result = await service.validateReplayability(decision);
      
      expect(result.replayable).toBe(true);
      expect(result.warnings).toContain("No seed specified - replay may not be deterministic");
      expect(result.warnings.some(w => w.includes("Temperature"))).toBe(true);
      expect(result.warnings.some(w => w.includes("unsigned"))).toBe(true);
    });

    it("should validate input artifact dependencies", async () => {
      const inputArtifact1 = await artifactStorage.store({
        origin: { system: "linux" },
        scope: { type: "sensor" },
        content: JSON.stringify({ value: 42 }),
      });

      const inputArtifact2 = await artifactStorage.store({
        origin: { system: "linux" },
        scope: { type: "sensor" },
        content: JSON.stringify({ value: 100 }),
      });

      const contextArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "config" },
        content: JSON.stringify({ test: "context" }),
      });
      
      const constraintsArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "config" },
        content: JSON.stringify({ constraints: [] }),
      });
      
      const cotArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "decision" },
        content: "Chain of thought...",
      });

      const decision = createTestDecision({
        inputs: {
          artifacts: [inputArtifact1.id, inputArtifact2.id],
          context: contextArtifact.id,
          constraints: constraintsArtifact.id,
        },
        reasoning: {
          chainOfThought: cotArtifact.id,
          model: "gpt-4",
          temperature: 0,
          tokens: 1000,
          seed: 42,
        },
      });

      const result = await service.validateReplayability(decision);
      
      expect(result.replayable).toBe(true);
      expect(result.details.inputArtifactsValid).toBe(true);
    });
  });

  // ===========================================================================
  // COMPARISON TESTS
  // ===========================================================================

  describe("compareDecisions", () => {
    it("should detect identical decisions", () => {
      const original = createTestDecision();
      const replayed = { ...original };

      const diff = service.compareDecisions(original, replayed);

      expect(diff.matches).toBe(true);
      expect(diff.decision.matches).toBe(true);
      expect(diff.action.matches).toBe(true);
      expect(diff.confidence.matches).toBe(true);
      expect(diff.keyDifferences).toHaveLength(0);
    });

    it("should detect decision text differences", () => {
      const original = createTestDecision();
      const replayed = createTestDecision({
        output: {
          ...original.output,
          decision: "Rejected maintenance window",
        },
      });

      const diff = service.compareDecisions(original, replayed);

      expect(diff.matches).toBe(false);
      expect(diff.decision.matches).toBe(false);
      expect(diff.decision.similarity).toBeLessThan(1);
      expect(diff.keyDifferences.some(d => d.includes("Decision text"))).toBe(true);
    });

    it("should detect action type differences", () => {
      const original = createTestDecision();
      const replayed = createTestDecision({
        output: {
          ...original.output,
          action: {
            type: "alert",
            target: "asset-001",
            priority: "high",
            requiresApproval: false,
          },
        },
      });

      const diff = service.compareDecisions(original, replayed);

      expect(diff.matches).toBe(false);
      expect(diff.action.matches).toBe(false);
      expect(diff.action.typeMatches).toBe(false);
      expect(diff.keyDifferences.some(d => d.includes("Action type"))).toBe(true);
    });

    it("should detect action parameter differences", () => {
      const original = createTestDecision();
      const replayed = createTestDecision({
        output: {
          ...original.output,
          action: {
            ...original.output.action!,
            parameters: { duration: 7200 }, // Changed from 3600
          },
        },
      });

      const diff = service.compareDecisions(original, replayed);

      expect(diff.action.parametersMatch).toBe(false);
      expect(diff.keyDifferences.some(d => d.includes("parameters"))).toBe(true);
    });

    it("should detect confidence delta within tolerance", () => {
      const original = createTestDecision();
      const replayed = createTestDecision({
        output: {
          ...original.output,
          confidence: 0.83, // 0.02 delta from 0.85
        },
      });

      const diff = service.compareDecisions(original, replayed, { confidence: 0.05 });

      expect(diff.confidence.withinTolerance).toBe(true);
      expect(diff.confidence.delta).toBeCloseTo(0.02, 5);
      expect(diff.matches).toBe(true);
    });

    it("should detect confidence delta exceeding tolerance", () => {
      const original = createTestDecision();
      const replayed = createTestDecision({
        output: {
          ...original.output,
          confidence: 0.70, // 0.15 delta from 0.85
        },
      });

      const diff = service.compareDecisions(original, replayed, { confidence: 0.05 });

      expect(diff.confidence.withinTolerance).toBe(false);
      expect(diff.matches).toBe(false);
      expect(diff.keyDifferences.some(d => d.includes("Confidence delta"))).toBe(true);
    });

    it("should compare key factors", () => {
      const original = createTestDecision();
      const replayed = createTestDecision({
        output: {
          ...original.output,
          keyFactors: ["Recent vibration anomaly", "New factor"],
        },
      });

      const diff = service.compareDecisions(original, replayed);

      expect(diff.keyFactors.matches).toBe(false);
      expect(diff.keyFactors.added).toContain("New factor");
      expect(diff.keyFactors.removed).toContain("Scheduled maintenance due");
      expect(diff.keyFactors.common).toContain("Recent vibration anomaly");
    });

    it("should compare uncertainties", () => {
      const original = createTestDecision();
      const replayed = createTestDecision({
        output: {
          ...original.output,
          uncertainties: [], // Removed all uncertainties
        },
      });

      const diff = service.compareDecisions(original, replayed);

      expect(diff.uncertainties.matches).toBe(false);
      expect(diff.uncertainties.removed).toContain("Weather conditions unknown");
    });

    it("should detect action added", () => {
      const original = createTestDecision({
        output: {
          decision: "No action needed",
          confidence: 0.9,
          action: undefined,
        },
      });
      const replayed = createTestDecision({
        output: {
          decision: "No action needed",
          confidence: 0.9,
          action: {
            type: "alert",
            priority: "low",
            requiresApproval: false,
          },
        },
      });

      const diff = service.compareDecisions(original, replayed);

      expect(diff.action.matches).toBe(false);
      expect(diff.keyDifferences.some(d => d.includes("Action added"))).toBe(true);
    });

    it("should detect action removed", () => {
      const original = createTestDecision();
      const replayed = createTestDecision({
        output: {
          ...original.output,
          action: undefined,
        },
      });

      const diff = service.compareDecisions(original, replayed);

      expect(diff.action.matches).toBe(false);
      expect(diff.keyDifferences.some(d => d.includes("Action removed"))).toBe(true);
    });
  });

  // ===========================================================================
  // REPLAY EXECUTION TESTS
  // ===========================================================================

  describe("replayDecisionObject", () => {
    it("should replay a decision with frozen inputs", async () => {
      // Store required artifacts
      const contextArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "config" },
        content: JSON.stringify({ plant: "Plant A", state: "normal" }),
      });
      
      const constraintsArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "config" },
        content: JSON.stringify({ maxDowntime: 3600 }),
      });
      
      const cotArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "decision" },
        content: "I analyzed the sensor data and determined...",
      });

      const decision = createTestDecision({
        inputs: {
          artifacts: [],
          context: contextArtifact.id,
          constraints: constraintsArtifact.id,
        },
        reasoning: {
          chainOfThought: cotArtifact.id,
          model: "gpt-4",
          temperature: 0,
          tokens: 1000,
          seed: 42,
        },
      });

      const result = await service.replayDecisionObject(decision);

      expect(result.originalDecisionId).toBe(decision.id);
      expect(result.validation.replayable).toBe(true);
      expect(result.diff.matches).toBe(true);
      expect(result.metadata.replayDurationMs).toBeGreaterThan(0);
    });

    it("should use custom executor for replay", async () => {
      // Store required artifacts
      const contextArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "config" },
        content: JSON.stringify({ test: "context" }),
      });
      
      const constraintsArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "config" },
        content: JSON.stringify({ constraints: [] }),
      });
      
      const cotArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "decision" },
        content: "Reasoning...",
      });

      const decision = createTestDecision({
        inputs: {
          artifacts: [],
          context: contextArtifact.id,
          constraints: constraintsArtifact.id,
        },
        reasoning: {
          chainOfThought: cotArtifact.id,
          model: "gpt-4",
          temperature: 0,
          tokens: 1000,
          seed: 42,
        },
      });

      // Custom executor that changes the decision
      const customExecutor: DecisionExecutor = async (context) => {
        const original = context.originalDecision;
        return {
          agent: original.agent,
          siteId: original.siteId,
          assetIds: original.assetIds,
          inputs: original.inputs,
          reasoning: original.reasoning,
          output: {
            ...original.output,
            decision: "MODIFIED: " + original.output.decision,
            confidence: 0.5,
          },
          verification: original.verification,
        };
      };

      const result = await service.replayDecisionObject(decision, {
        config: { executor: customExecutor },
      });

      expect(result.diff.matches).toBe(false);
      expect(result.diff.decision.matches).toBe(false);
      expect(result.replayedDecision.output.decision).toContain("MODIFIED");
    });

    it("should fail for non-replayable decisions", async () => {
      const decision = createTestDecision();

      await expect(
        service.replayDecisionObject(decision)
      ).rejects.toThrow("not replayable");
    });

    it("should include replay reason in metadata", async () => {
      // Store required artifacts
      const contextArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "config" },
        content: JSON.stringify({ test: "context" }),
      });
      
      const constraintsArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "config" },
        content: JSON.stringify({}),
      });
      
      const cotArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "decision" },
        content: "Reasoning...",
      });

      const decision = createTestDecision({
        inputs: {
          artifacts: [],
          context: contextArtifact.id,
          constraints: constraintsArtifact.id,
        },
        reasoning: {
          chainOfThought: cotArtifact.id,
          model: "gpt-4",
          temperature: 0,
          tokens: 1000,
          seed: 42,
        },
      });

      const result = await service.replayDecisionObject(decision, {
        reason: "Regression test for v2.0 release",
      });

      expect(result.metadata.replayReason).toBe("Regression test for v2.0 release");
    });
  });

  // ===========================================================================
  // EVENT EMISSION TESTS
  // ===========================================================================

  describe("events", () => {
    it("should emit replay:completed event", async () => {
      const contextArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "config" },
        content: JSON.stringify({}),
      });
      
      const constraintsArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "config" },
        content: JSON.stringify({}),
      });
      
      const cotArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "decision" },
        content: "...",
      });

      const decision = createTestDecision({
        inputs: {
          artifacts: [],
          context: contextArtifact.id,
          constraints: constraintsArtifact.id,
        },
        reasoning: {
          chainOfThought: cotArtifact.id,
          model: "gpt-4",
          temperature: 0,
          tokens: 1000,
          seed: 42,
        },
      });

      const completedHandler = vi.fn();
      service.on("replay:completed", completedHandler);

      await service.replayDecisionObject(decision);

      expect(completedHandler).toHaveBeenCalledTimes(1);
      expect(completedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          originalId: decision.id,
          matches: true,
        })
      );
    });

    it("should emit replay:divergence event on mismatch", async () => {
      const contextArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "config" },
        content: JSON.stringify({}),
      });
      
      const constraintsArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "config" },
        content: JSON.stringify({}),
      });
      
      const cotArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "decision" },
        content: "...",
      });

      const decision = createTestDecision({
        inputs: {
          artifacts: [],
          context: contextArtifact.id,
          constraints: constraintsArtifact.id,
        },
        reasoning: {
          chainOfThought: cotArtifact.id,
          model: "gpt-4",
          temperature: 0,
          tokens: 1000,
          seed: 42,
        },
      });

      const customExecutor: DecisionExecutor = async (context) => {
        const original = context.originalDecision;
        return {
          agent: original.agent,
          siteId: original.siteId,
          assetIds: original.assetIds,
          inputs: original.inputs,
          reasoning: original.reasoning,
          output: {
            ...original.output,
            decision: "Different decision",
          },
          verification: original.verification,
        };
      };

      const divergenceHandler = vi.fn();
      service.on("replay:divergence", divergenceHandler);

      await service.replayDecisionObject(decision, {
        config: { executor: customExecutor },
      });

      expect(divergenceHandler).toHaveBeenCalledTimes(1);
      expect(divergenceHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          originalId: decision.id,
          differences: expect.any(Array),
        })
      );
    });
  });

  // ===========================================================================
  // REGRESSION TESTING
  // ===========================================================================

  describe("runRegressionTest", () => {
    it("should run regression tests on multiple decisions", async () => {
      // Create replayable decisions
      const decisions: AgentDecision[] = [];
      
      for (let i = 0; i < 3; i++) {
        const contextArtifact = await artifactStorage.store({
          origin: { system: "agentic-qe" },
          scope: { type: "config" },
          content: JSON.stringify({ index: i }),
        });
        
        const constraintsArtifact = await artifactStorage.store({
          origin: { system: "agentic-qe" },
          scope: { type: "config" },
          content: JSON.stringify({}),
        });
        
        const cotArtifact = await artifactStorage.store({
          origin: { system: "agentic-qe" },
          scope: { type: "decision" },
          content: `Reasoning for decision ${i}`,
        });

        decisions.push(createTestDecision({
          inputs: {
            artifacts: [],
            context: contextArtifact.id,
            constraints: constraintsArtifact.id,
          },
          reasoning: {
            chainOfThought: cotArtifact.id,
            model: "gpt-4",
            temperature: 0,
            tokens: 1000,
            seed: 42,
          },
        }));
      }

      const result = await service.runRegressionTest(decisions);

      expect(result.totalDecisions).toBe(3);
      expect(result.replayed).toBe(3);
      expect(result.passed).toBe(3);
      expect(result.failed).toBe(0);
      expect(result.passRate).toBe(1);
    });

    it("should skip non-replayable decisions", async () => {
      const replayableDecision = await (async () => {
        const contextArtifact = await artifactStorage.store({
          origin: { system: "agentic-qe" },
          scope: { type: "config" },
          content: JSON.stringify({}),
        });
        
        const constraintsArtifact = await artifactStorage.store({
          origin: { system: "agentic-qe" },
          scope: { type: "config" },
          content: JSON.stringify({}),
        });
        
        const cotArtifact = await artifactStorage.store({
          origin: { system: "agentic-qe" },
          scope: { type: "decision" },
          content: "...",
        });

        return createTestDecision({
          inputs: {
            artifacts: [],
            context: contextArtifact.id,
            constraints: constraintsArtifact.id,
          },
          reasoning: {
            chainOfThought: cotArtifact.id,
            model: "gpt-4",
            temperature: 0,
            tokens: 1000,
            seed: 42,
          },
        });
      })();

      const nonReplayableDecision = createTestDecision();

      const result = await service.runRegressionTest([
        replayableDecision,
        nonReplayableDecision,
      ]);

      expect(result.totalDecisions).toBe(2);
      expect(result.replayed).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.skippedDecisions[0].id).toBe(nonReplayableDecision.id);
    });

    it("should report failures with differences", async () => {
      const contextArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "config" },
        content: JSON.stringify({}),
      });
      
      const constraintsArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "config" },
        content: JSON.stringify({}),
      });
      
      const cotArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "decision" },
        content: "...",
      });

      const decision = createTestDecision({
        inputs: {
          artifacts: [],
          context: contextArtifact.id,
          constraints: constraintsArtifact.id,
        },
        reasoning: {
          chainOfThought: cotArtifact.id,
          model: "gpt-4",
          temperature: 0,
          tokens: 1000,
          seed: 42,
        },
      });

      // Use executor that causes divergence
      const divergingExecutor: DecisionExecutor = async (context) => {
        const original = context.originalDecision;
        return {
          agent: original.agent,
          siteId: original.siteId,
          assetIds: original.assetIds,
          inputs: original.inputs,
          reasoning: original.reasoning,
          output: {
            ...original.output,
            decision: "CHANGED",
          },
          verification: original.verification,
        };
      };

      const result = await service.runRegressionTest([decision], {
        executor: divergingExecutor,
      });

      expect(result.failed).toBe(1);
      expect(result.failures[0].decisionId).toBe(decision.id);
      expect(result.failures[0].differences).toBeDefined();
      expect(result.failures[0].differences!.length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // STATISTICS & HISTORY
  // ===========================================================================

  describe("statistics and history", () => {
    it("should track replay history", async () => {
      const contextArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "config" },
        content: JSON.stringify({}),
      });
      
      const constraintsArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "config" },
        content: JSON.stringify({}),
      });
      
      const cotArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "decision" },
        content: "...",
      });

      const decision = createTestDecision({
        inputs: {
          artifacts: [],
          context: contextArtifact.id,
          constraints: constraintsArtifact.id,
        },
        reasoning: {
          chainOfThought: cotArtifact.id,
          model: "gpt-4",
          temperature: 0,
          tokens: 1000,
          seed: 42,
        },
      });

      const result = await service.replayDecisionObject(decision);
      
      const history = service.getReplayHistory();
      expect(history).toHaveLength(1);
      
      const retrieved = service.getReplayResult(result.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.originalDecisionId).toBe(decision.id);
    });

    it("should compute statistics", async () => {
      const contextArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "config" },
        content: JSON.stringify({}),
      });
      
      const constraintsArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "config" },
        content: JSON.stringify({}),
      });
      
      const cotArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "decision" },
        content: "...",
      });

      // Run multiple replays
      for (let i = 0; i < 5; i++) {
        const decision = createTestDecision({
          inputs: {
            artifacts: [],
            context: contextArtifact.id,
            constraints: constraintsArtifact.id,
          },
          reasoning: {
            chainOfThought: cotArtifact.id,
            model: "gpt-4",
            temperature: 0,
            tokens: 1000,
            seed: 42,
          },
        });
        await service.replayDecisionObject(decision);
      }

      const stats = service.getStats();
      expect(stats.totalReplays).toBe(5);
      expect(stats.matchRate).toBe(1);
      expect(stats.avgDurationMs).toBeGreaterThan(0);
    });

    it("should clear history", async () => {
      const contextArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "config" },
        content: JSON.stringify({}),
      });
      
      const constraintsArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "config" },
        content: JSON.stringify({}),
      });
      
      const cotArtifact = await artifactStorage.store({
        origin: { system: "agentic-qe" },
        scope: { type: "decision" },
        content: "...",
      });

      const decision = createTestDecision({
        inputs: {
          artifacts: [],
          context: contextArtifact.id,
          constraints: constraintsArtifact.id,
        },
        reasoning: {
          chainOfThought: cotArtifact.id,
          model: "gpt-4",
          temperature: 0,
          tokens: 1000,
          seed: 42,
        },
      });

      await service.replayDecisionObject(decision);
      expect(service.getReplayHistory()).toHaveLength(1);

      service.clearHistory();
      expect(service.getReplayHistory()).toHaveLength(0);
    });
  });

  // ===========================================================================
  // BATCH OPERATIONS
  // ===========================================================================

  describe("batch operations", () => {
    it("should validate multiple decisions", async () => {
      const decision1 = createTestDecision();
      const decision2 = createTestDecision();

      const results = await service.validateBatch([decision1, decision2]);

      expect(results.size).toBe(2);
      expect(results.get(decision1.id)!.replayable).toBe(false);
      expect(results.get(decision2.id)!.replayable).toBe(false);
    });
  });

  // ===========================================================================
  // EDGE CASES
  // ===========================================================================

  describe("edge cases", () => {
    it("should handle empty key factors and uncertainties", () => {
      const original = createTestDecision({
        output: {
          decision: "Test decision",
          confidence: 0.9,
          keyFactors: undefined,
          uncertainties: undefined,
        },
      });
      const replayed = createTestDecision({
        output: {
          decision: "Test decision",
          confidence: 0.9,
          keyFactors: undefined,
          uncertainties: undefined,
        },
      });

      const diff = service.compareDecisions(original, replayed);

      expect(diff.keyFactors.matches).toBe(true);
      expect(diff.uncertainties.matches).toBe(true);
    });

    it("should handle decisions with no action", () => {
      const original = createTestDecision({
        output: {
          decision: "Observation only - no action required",
          confidence: 0.95,
          action: undefined,
        },
      });
      const replayed = { ...original };

      const diff = service.compareDecisions(original, replayed);

      expect(diff.action.matches).toBe(true);
    });

    it("should calculate correct similarity for very different texts", () => {
      const original = createTestDecision({
        output: {
          decision: "Approve the maintenance request immediately",
          confidence: 0.9,
        },
      });
      const replayed = createTestDecision({
        output: {
          decision: "Reject due to safety concerns",
          confidence: 0.9,
        },
      });

      const diff = service.compareDecisions(original, replayed);

      expect(diff.decision.similarity).toBeLessThan(0.5);
    });
  });
});

// =============================================================================
// DOCTRINE COMPLIANCE TESTS
// =============================================================================

describe("VERITY Doctrine Compliance", () => {
  let service: DecisionReplayService;
  let artifactStorage: ArtifactStorageService;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `doctrine-test-${Date.now()}`);
    
    artifactStorage = new ArtifactStorageService({
      lfsDir: tempDir,
      enableIndex: true,
      maxContentSize: 0,
      enableDeduplication: true,
    });
    await artifactStorage.initialize();
    
    service = createDecisionReplayService({ artifactStorage });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should enforce 'Every decision must be replayable'", async () => {
    // A decision without stored artifacts is NOT replayable
    const invalidDecision = createTestDecision();
    
    const validation = await service.validateReplayability(invalidDecision);
    
    // Doctrine: "If replay is impossible, the decision is invalid"
    expect(validation.replayable).toBe(false);
    expect(validation.missingArtifacts.length).toBeGreaterThan(0);
  });

  it("should preserve exact inputs during replay", async () => {
    const originalContext = JSON.stringify({ 
      temperature: 72.5, 
      pressure: 101.3,
      timestamp: "2024-01-15T10:30:00Z"
    });
    
    const contextArtifact = await artifactStorage.store({
      origin: { system: "agentic-qe" },
      scope: { type: "config" },
      content: originalContext,
    });
    
    const constraintsArtifact = await artifactStorage.store({
      origin: { system: "agentic-qe" },
      scope: { type: "config" },
      content: JSON.stringify({ maxTemp: 100 }),
    });
    
    const cotArtifact = await artifactStorage.store({
      origin: { system: "agentic-qe" },
      scope: { type: "decision" },
      content: "Analysis...",
    });

    const decision = createTestDecision({
      inputs: {
        artifacts: [],
        context: contextArtifact.id,
        constraints: constraintsArtifact.id,
      },
      reasoning: {
        chainOfThought: cotArtifact.id,
        model: "gpt-4",
        temperature: 0,
        tokens: 1000,
        seed: 42,
      },
    });

    // Verify context is preserved
    const storedContext = await artifactStorage.getContent(contextArtifact.id);
    expect(storedContext!.toString()).toBe(originalContext);
    
    // Replay should use exact same inputs
    const validation = await service.validateReplayability(decision);
    expect(validation.replayable).toBe(true);
  });

  it("should track chain of decisions via relatedArtifacts", async () => {
    const contextArtifact = await artifactStorage.store({
      origin: { system: "agentic-qe" },
      scope: { type: "config" },
      content: JSON.stringify({}),
    });
    
    const constraintsArtifact = await artifactStorage.store({
      origin: { system: "agentic-qe" },
      scope: { type: "config" },
      content: JSON.stringify({}),
    });
    
    const cotArtifact = await artifactStorage.store({
      origin: { system: "agentic-qe" },
      scope: { type: "decision" },
      content: "...",
    });

    const decision = createTestDecision({
      inputs: {
        artifacts: [],
        context: contextArtifact.id,
        constraints: constraintsArtifact.id,
      },
      reasoning: {
        chainOfThought: cotArtifact.id,
        model: "gpt-4",
        temperature: 0,
        tokens: 1000,
        seed: 42,
      },
    });

    const result = await service.replayDecisionObject(decision);
    
    // Replayed decision should link back to original
    expect(result.replayedDecision.relatedArtifacts?.previousDecision).toBe(decision.id);
  });
});
