/**
 * 0xSCADA Artifact Doctrine Tests
 * 
 * VERITY Architecture - Doctrine Enforcement Layer Tests
 * 
 * "Artifacts are truth."
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ArtifactDoctrineService,
  DoctrineCategory,
  DoctrineViolationError,
  type TriggerContext,
  enforceDoctrine,
  withDoctrine,
  recordExternalState,
  recordScenarioEval,
  recordProofOperation,
  recordModelUpdate,
  recordCriticalDecision,
  setDoctrineService,
  getDoctrineService,
} from "../middleware/artifact-doctrine";
import { ArtifactStorageService } from "../services/artifact-storage";
import type { RealityArtifact, ContentHash } from "@shared/artifact";

// =============================================================================
// TEST UTILITIES
// =============================================================================

/**
 * Mock artifact storage for testing
 */
class MockArtifactStorage extends ArtifactStorageService {
  public storedArtifacts: RealityArtifact[] = [];
  public storeCallCount = 0;

  constructor() {
    super({
      lfsDir: "./test-artifacts",
      enableIndex: true,
      maxContentSize: 0,
      enableDeduplication: false,
    });
  }

  async initialize(): Promise<void> {
    // No-op for tests
  }

  async store(input: any): Promise<RealityArtifact> {
    this.storeCallCount++;
    
    const artifact: RealityArtifact = {
      id: `test-hash-${this.storeCallCount}`.padEnd(64, "0").slice(0, 64) as ContentHash,
      timestamp: new Date().toISOString(),
      origin: input.origin,
      scope: input.scope,
      dependencies: input.dependencies ?? [],
      summary: input.summary,
      content: {
        version: "v1",
        oid: `test-oid-${this.storeCallCount}`.padEnd(64, "0").slice(0, 64) as ContentHash,
        size: typeof input.content === "string" ? input.content.length : 0,
        mimeType: input.mimeType,
      },
    };

    this.storedArtifacts.push(artifact);
    return artifact;
  }

  reset(): void {
    this.storedArtifacts = [];
    this.storeCallCount = 0;
  }
}

// =============================================================================
// UNIT TESTS: ArtifactDoctrineService
// =============================================================================

describe("ArtifactDoctrineService", () => {
  let service: ArtifactDoctrineService;
  let mockStorage: MockArtifactStorage;

  beforeEach(async () => {
    mockStorage = new MockArtifactStorage();
    await mockStorage.initialize();
    service = new ArtifactDoctrineService({
      storage: mockStorage,
      strictMode: true,
    });
  });

  afterEach(() => {
    mockStorage.reset();
    service.clearAuditLog();
  });

  // ===========================================================================
  // DOCTRINE CATEGORY: EXTERNAL_STATE
  // ===========================================================================

  describe("DoctrineCategory.EXTERNAL_STATE", () => {
    it("should create artifact for valid external state observation", async () => {
      const context: TriggerContext = {
        category: DoctrineCategory.EXTERNAL_STATE,
        data: { temperature: 25.5, humidity: 60 },
        deviceId: "sensor-001",
        siteId: "site-alpha",
        summary: "Sensor reading",
      };

      const artifact = await service.trigger(context);

      expect(artifact).toBeDefined();
      expect(artifact.origin.system).toBe("linux");
      expect(artifact.scope.type).toBe("sensor");
      expect(mockStorage.storeCallCount).toBe(1);
    });

    it("should warn but succeed without source identification", async () => {
      const context: TriggerContext = {
        category: DoctrineCategory.EXTERNAL_STATE,
        data: { value: 42 },
      };

      const artifact = await service.trigger(context);

      expect(artifact).toBeDefined();
      const stats = service.getStats();
      expect(stats.warningViolations).toBeGreaterThan(0);
    });

    it("should fail when data is missing in strict mode", async () => {
      const context: TriggerContext = {
        category: DoctrineCategory.EXTERNAL_STATE,
        data: null,
        deviceId: "sensor-001",
      };

      await expect(service.trigger(context)).rejects.toThrow(DoctrineViolationError);
    });
  });

  // ===========================================================================
  // DOCTRINE CATEGORY: SCENARIO_EVAL
  // ===========================================================================

  describe("DoctrineCategory.SCENARIO_EVAL", () => {
    it("should create artifact for scenario evaluation", async () => {
      const context: TriggerContext = {
        category: DoctrineCategory.SCENARIO_EVAL,
        data: { scenarioId: "scenario-001", result: { passed: true, score: 0.95 } },
        agentId: "agent-alpha",
        summary: "Emergency shutdown scenario evaluation",
      };

      const artifact = await service.trigger(context);

      expect(artifact).toBeDefined();
      expect(artifact.origin.system).toBe("agentic-qe");
      expect(artifact.scope.type).toBe("twin");
    });

    it("should warn when summary is missing", async () => {
      const context: TriggerContext = {
        category: DoctrineCategory.SCENARIO_EVAL,
        data: { result: "pass" },
      };

      const artifact = await service.trigger(context);

      expect(artifact).toBeDefined();
      const violations = service.getViolations();
      expect(violations.some(v => v.message.includes("summary"))).toBe(true);
    });
  });

  // ===========================================================================
  // DOCTRINE CATEGORY: PROOF_OPERATION
  // ===========================================================================

  describe("DoctrineCategory.PROOF_OPERATION", () => {
    it("should create artifact for proof generation", async () => {
      const context: TriggerContext = {
        category: DoctrineCategory.PROOF_OPERATION,
        data: { proofBlob: "base64encodedproof...", inputs: [1, 2, 3] },
        summary: "ZK proof for batch attestation",
        metadata: { proofType: "zk-snark" },
      };

      const artifact = await service.trigger(context);

      expect(artifact).toBeDefined();
      expect(artifact.origin.system).toBe("ethereum");
      expect(artifact.scope.type).toBe("proof");
    });

    it("should warn when proofType is missing in metadata", async () => {
      const context: TriggerContext = {
        category: DoctrineCategory.PROOF_OPERATION,
        data: { proofData: "..." },
      };

      const artifact = await service.trigger(context);

      expect(artifact).toBeDefined();
      const violations = service.getViolations();
      expect(violations.some(v => v.message.includes("proofType"))).toBe(true);
    });

    it("should fail when proof data is missing", async () => {
      const context: TriggerContext = {
        category: DoctrineCategory.PROOF_OPERATION,
        data: null,
        metadata: { proofType: "merkle" },
      };

      await expect(service.trigger(context)).rejects.toThrow(DoctrineViolationError);
    });
  });

  // ===========================================================================
  // DOCTRINE CATEGORY: MODEL_UPDATE
  // ===========================================================================

  describe("DoctrineCategory.MODEL_UPDATE", () => {
    it("should create artifact for model training", async () => {
      const context: TriggerContext = {
        category: DoctrineCategory.MODEL_UPDATE,
        data: { modelHash: "abc123", weights: [0.1, 0.2, 0.3] },
        agentId: "agent-trainer",
        summary: "Model finetuning on sensor data",
        metadata: { updateType: "finetune" },
      };

      const artifact = await service.trigger(context);

      expect(artifact).toBeDefined();
      expect(artifact.origin.system).toBe("agentic-qe");
      expect(artifact.scope.type).toBe("model");
      expect(artifact.origin.agent).toBe("agent-trainer");
    });

    it("should fail when agentId is missing", async () => {
      const context: TriggerContext = {
        category: DoctrineCategory.MODEL_UPDATE,
        data: { modelState: "..." },
        metadata: { updateType: "train" },
      };

      await expect(service.trigger(context)).rejects.toThrow(DoctrineViolationError);
    });

    it("should warn when updateType is missing", async () => {
      const context: TriggerContext = {
        category: DoctrineCategory.MODEL_UPDATE,
        data: { modelState: "..." },
        agentId: "agent-001",
      };

      const artifact = await service.trigger(context);

      expect(artifact).toBeDefined();
      const violations = service.getViolations();
      expect(violations.some(v => v.message.includes("updateType"))).toBe(true);
    });
  });

  // ===========================================================================
  // DOCTRINE CATEGORY: CRITICAL_DECISION
  // ===========================================================================

  describe("DoctrineCategory.CRITICAL_DECISION", () => {
    it("should create artifact for critical decision with all required fields", async () => {
      const context: TriggerContext = {
        category: DoctrineCategory.CRITICAL_DECISION,
        data: {
          decision: "shutdown",
          targetAsset: "pump-001",
          reason: "pressure_exceeded",
        },
        agentId: "safety-agent",
        siteId: "plant-west",
        summary: "Emergency shutdown decision for pump-001",
        metadata: {
          impactScope: "safety",
          justification: "Pressure exceeded safety threshold by 15%",
        },
      };

      const artifact = await service.trigger(context);

      expect(artifact).toBeDefined();
      expect(artifact.origin.system).toBe("agentic-qe");
      expect(artifact.scope.type).toBe("decision");
    });

    it("should fail when summary is missing", async () => {
      const context: TriggerContext = {
        category: DoctrineCategory.CRITICAL_DECISION,
        data: { decision: "approve_transaction" },
        metadata: { impactScope: "financial" },
      };

      await expect(service.trigger(context)).rejects.toThrow(DoctrineViolationError);
    });

    it("should fail when impactScope is missing", async () => {
      const context: TriggerContext = {
        category: DoctrineCategory.CRITICAL_DECISION,
        data: { decision: "approve_transaction" },
        summary: "Transaction approval",
      };

      await expect(service.trigger(context)).rejects.toThrow(DoctrineViolationError);
    });

    it("should warn when justification is missing", async () => {
      const context: TriggerContext = {
        category: DoctrineCategory.CRITICAL_DECISION,
        data: { decision: "approve" },
        summary: "Compliance decision",
        metadata: { impactScope: "compliance" },
      };

      const artifact = await service.trigger(context);

      expect(artifact).toBeDefined();
      const violations = service.getViolations();
      expect(violations.some(v => v.message.includes("justification"))).toBe(true);
    });
  });

  // ===========================================================================
  // AUDIT LOG AND STATISTICS
  // ===========================================================================

  describe("Audit Log and Statistics", () => {
    it("should track successful triggers in audit log", async () => {
      await service.trigger({
        category: DoctrineCategory.EXTERNAL_STATE,
        data: { temp: 20 },
        deviceId: "sensor-001",
      });

      await service.trigger({
        category: DoctrineCategory.EXTERNAL_STATE,
        data: { temp: 21 },
        deviceId: "sensor-002",
      });

      const auditLog = service.getAuditLog();
      expect(auditLog).toHaveLength(2);
      expect(auditLog.every(entry => entry.success)).toBe(true);
    });

    it("should track failed triggers in audit log", async () => {
      try {
        await service.trigger({
          category: DoctrineCategory.CRITICAL_DECISION,
          data: null,
          summary: "Test",
          metadata: { impactScope: "safety" },
        });
      } catch (e) {
        // Expected
      }

      const auditLog = service.getAuditLog();
      expect(auditLog.some(entry => !entry.success)).toBe(true);
    });

    it("should provide accurate statistics", async () => {
      await service.trigger({
        category: DoctrineCategory.EXTERNAL_STATE,
        data: { v: 1 },
        deviceId: "d1",
      });

      await service.trigger({
        category: DoctrineCategory.PROOF_OPERATION,
        data: { proof: "..." },
        metadata: { proofType: "zk" },
      });

      const stats = service.getStats();
      expect(stats.totalTriggers).toBe(2);
      expect(stats.successfulTriggers).toBe(2);
      expect(stats.byCategory[DoctrineCategory.EXTERNAL_STATE]).toBe(1);
      expect(stats.byCategory[DoctrineCategory.PROOF_OPERATION]).toBe(1);
    });
  });

  // ===========================================================================
  // DEPENDENCY TRACKING
  // ===========================================================================

  describe("Dependency Tracking", () => {
    it("should record dependencies in artifact", async () => {
      // First artifact
      const artifact1 = await service.trigger({
        category: DoctrineCategory.EXTERNAL_STATE,
        data: { reading: 100 },
        deviceId: "sensor-001",
      });

      // Second artifact depends on first
      const artifact2 = await service.trigger({
        category: DoctrineCategory.SCENARIO_EVAL,
        data: { evaluation: "pass" },
        summary: "Evaluation based on sensor reading",
        dependencies: [artifact1.id],
      });

      expect(artifact2.dependencies).toContain(artifact1.id);
    });
  });

  // ===========================================================================
  // NON-STRICT MODE
  // ===========================================================================

  describe("Non-Strict Mode", () => {
    let nonStrictService: ArtifactDoctrineService;

    beforeEach(() => {
      nonStrictService = new ArtifactDoctrineService({
        storage: mockStorage,
        strictMode: false,
      });
    });

    it("should create artifact despite validation errors", async () => {
      const context: TriggerContext = {
        category: DoctrineCategory.CRITICAL_DECISION,
        data: { decision: "approve" },
        // Missing summary and impactScope - would fail in strict mode
      };

      const artifact = await nonStrictService.trigger(context);

      expect(artifact).toBeDefined();
    });
  });
});

// =============================================================================
// UNIT TESTS: Decorators
// =============================================================================

describe("Doctrine Decorators", () => {
  let mockStorage: MockArtifactStorage;
  let service: ArtifactDoctrineService;

  beforeEach(async () => {
    mockStorage = new MockArtifactStorage();
    await mockStorage.initialize();
    service = new ArtifactDoctrineService({
      storage: mockStorage,
      strictMode: false, // Use non-strict for decorator tests
    });
    setDoctrineService(service);
  });

  afterEach(() => {
    mockStorage.reset();
    service.clearAuditLog();
  });

  describe("withDoctrine wrapper", () => {
    it("should create artifact after function execution", async () => {
      const originalFn = async (x: number) => x * 2;
      
      const wrappedFn = withDoctrine(originalFn, {
        category: DoctrineCategory.EXTERNAL_STATE,
        captureResult: true,
        contextExtractor: (x) => ({ deviceId: `device-${x}` }),
      });

      const result = await wrappedFn(5);

      expect(result).toBe(10);
      expect(mockStorage.storeCallCount).toBe(1);
    });

    it("should capture both args and result when configured", async () => {
      const originalFn = async (a: number, b: number) => a + b;
      
      const wrappedFn = withDoctrine(originalFn, {
        category: DoctrineCategory.SCENARIO_EVAL,
        captureArgs: true,
        captureResult: true,
      });

      await wrappedFn(3, 4);

      expect(mockStorage.storeCallCount).toBe(1);
      const storedArtifact = mockStorage.storedArtifacts[0];
      expect(storedArtifact).toBeDefined();
    });
  });

  describe("enforceDoctrine decorator", () => {
    class TestService {
      @enforceDoctrine({
        category: DoctrineCategory.EXTERNAL_STATE,
        captureResult: true,
        contextExtractor: (sensorId: string) => ({ deviceId: sensorId }),
      })
      async readSensor(sensorId: string): Promise<{ value: number }> {
        return { value: Math.random() * 100 };
      }

      @enforceDoctrine({
        category: DoctrineCategory.CRITICAL_DECISION,
        captureResult: true,
        metadata: { impactScope: "safety" },
        summary: "Safety check decision",
      })
      async safetyCheck(): Promise<{ safe: boolean }> {
        return { safe: true };
      }
    }

    it("should create artifact when decorated method is called", async () => {
      const testService = new TestService();
      
      const result = await testService.readSensor("sensor-123");

      expect(result).toHaveProperty("value");
      expect(mockStorage.storeCallCount).toBe(1);
    });

    it("should extract context from arguments", async () => {
      const testService = new TestService();
      
      await testService.readSensor("my-sensor-id");

      const auditLog = service.getAuditLog();
      expect(auditLog[0].context.deviceId).toBe("my-sensor-id");
    });
  });
});

// =============================================================================
// UNIT TESTS: Integration Hooks
// =============================================================================

describe("Integration Hooks", () => {
  let mockStorage: MockArtifactStorage;
  let service: ArtifactDoctrineService;

  beforeEach(async () => {
    mockStorage = new MockArtifactStorage();
    await mockStorage.initialize();
    service = new ArtifactDoctrineService({
      storage: mockStorage,
      strictMode: true,
    });
    setDoctrineService(service);
  });

  afterEach(() => {
    mockStorage.reset();
    service.clearAuditLog();
  });

  describe("recordExternalState", () => {
    it("should create artifact for sensor data", async () => {
      const artifact = await recordExternalState(
        { temperature: 25.5, pressure: 101.3 },
        {
          deviceId: "weather-station-01",
          siteId: "north-plant",
          summary: "Ambient conditions reading",
        }
      );

      expect(artifact).toBeDefined();
      expect(artifact.origin.system).toBe("linux");
      expect(artifact.scope.type).toBe("sensor");
    });
  });

  describe("recordScenarioEval", () => {
    it("should create artifact for scenario evaluation", async () => {
      const artifact = await recordScenarioEval(
        "flood-scenario-001",
        { passed: true, metrics: { responseTime: 45 } },
        {
          agentId: "eval-agent",
          summary: "Flood response scenario passed",
        }
      );

      expect(artifact).toBeDefined();
      expect(artifact.scope.type).toBe("twin");
    });
  });

  describe("recordProofOperation", () => {
    it("should create artifact for proof generation", async () => {
      const artifact = await recordProofOperation(
        "generate",
        { proof: "0x123...", publicInputs: [1, 2, 3] },
        {
          summary: "Generated ZK proof for batch",
        }
      );

      expect(artifact).toBeDefined();
      expect(artifact.origin.system).toBe("ethereum");
      expect(artifact.scope.type).toBe("proof");
    });

    it("should create artifact for proof verification", async () => {
      const artifact = await recordProofOperation(
        "verify",
        { proofId: "proof-001", valid: true },
        {
          summary: "Verified attestation proof",
        }
      );

      expect(artifact).toBeDefined();
    });
  });

  describe("recordModelUpdate", () => {
    it("should create artifact for model training", async () => {
      const artifact = await recordModelUpdate(
        "agent-ml-001",
        "train",
        { epoch: 100, loss: 0.02, accuracy: 0.98 },
        {
          summary: "Completed training run",
        }
      );

      expect(artifact).toBeDefined();
      expect(artifact.origin.agent).toBe("agent-ml-001");
      expect(artifact.scope.type).toBe("model");
    });

    it("should create artifact for model refinement", async () => {
      const artifact = await recordModelUpdate(
        "agent-ml-001",
        "refine",
        { adjustedWeights: true, iterations: 50 },
        {
          summary: "Online model refinement",
        }
      );

      expect(artifact).toBeDefined();
    });
  });

  describe("recordCriticalDecision", () => {
    it("should create artifact for safety decision", async () => {
      const artifact = await recordCriticalDecision(
        { action: "emergency_stop", target: "reactor-1" },
        "safety",
        {
          agentId: "safety-controller",
          siteId: "plant-central",
          summary: "Emergency stop initiated due to temperature anomaly",
          justification: "Temperature exceeded threshold by 20%",
        }
      );

      expect(artifact).toBeDefined();
      expect(artifact.scope.type).toBe("decision");
    });

    it("should create artifact for compliance decision", async () => {
      const artifact = await recordCriticalDecision(
        { approved: true, documentId: "doc-001" },
        "compliance",
        {
          summary: "Compliance document approval",
          justification: "All requirements met",
        }
      );

      expect(artifact).toBeDefined();
    });

    it("should create artifact for financial decision", async () => {
      const artifact = await recordCriticalDecision(
        { transactionId: "tx-001", amount: 50000, approved: true },
        "financial",
        {
          summary: "Large transaction approval",
          justification: "Within authorized limits",
          agentId: "finance-agent",
        }
      );

      expect(artifact).toBeDefined();
    });
  });
});

// =============================================================================
// UNIT TESTS: DoctrineViolationError
// =============================================================================

describe("DoctrineViolationError", () => {
  it("should contain category and violations", () => {
    const error = new DoctrineViolationError(
      "Test violation",
      DoctrineCategory.CRITICAL_DECISION,
      ["Missing summary", "Missing impactScope"]
    );

    expect(error.name).toBe("DoctrineViolationError");
    expect(error.category).toBe(DoctrineCategory.CRITICAL_DECISION);
    expect(error.violations).toHaveLength(2);
    expect(error.violations).toContain("Missing summary");
  });
});

// =============================================================================
// UNIT TESTS: Schema Validation
// =============================================================================

describe("Schema Validation", () => {
  let mockStorage: MockArtifactStorage;
  let service: ArtifactDoctrineService;

  beforeEach(async () => {
    mockStorage = new MockArtifactStorage();
    await mockStorage.initialize();
    service = new ArtifactDoctrineService({
      storage: mockStorage,
      strictMode: true,
    });
  });

  it("should reject invalid category", async () => {
    const context = {
      category: "invalid_category" as DoctrineCategory,
      data: { test: true },
    };

    await expect(service.trigger(context)).rejects.toThrow();
  });

  it("should accept valid content hash format in dependencies", async () => {
    const validHash = "a".repeat(64) as ContentHash;
    
    // Store the dependency first
    await service.trigger({
      category: DoctrineCategory.EXTERNAL_STATE,
      data: { test: true },
      deviceId: "test-device",
    });

    // This should work because the schema accepts valid hash format
    const context: TriggerContext = {
      category: DoctrineCategory.SCENARIO_EVAL,
      data: { result: "pass" },
      summary: "Test with dependency",
      dependencies: [validHash],
    };

    // Note: This may fail at storage level due to missing dependency,
    // but schema validation should pass
    try {
      await service.trigger(context);
    } catch (e: any) {
      // If it fails, it should not be a schema validation error
      expect(e.message).not.toContain("ContentHash");
    }
  });
});

// =============================================================================
// INTEGRATION TESTS: Full Workflow
// =============================================================================

describe("Integration: Full Doctrine Workflow", () => {
  let mockStorage: MockArtifactStorage;
  let service: ArtifactDoctrineService;

  beforeEach(async () => {
    mockStorage = new MockArtifactStorage();
    await mockStorage.initialize();
    service = new ArtifactDoctrineService({
      storage: mockStorage,
      strictMode: true,
    });
    setDoctrineService(service);
  });

  afterEach(() => {
    mockStorage.reset();
    service.clearAuditLog();
  });

  it("should track a complete sensor → evaluation → decision workflow", async () => {
    // Step 1: Record external state (sensor reading)
    const sensorArtifact = await recordExternalState(
      { temperature: 95, threshold: 90 },
      {
        deviceId: "temp-sensor-001",
        siteId: "boiler-room",
        summary: "High temperature reading",
      }
    );

    // Step 2: Record scenario evaluation based on sensor data
    const evalArtifact = await recordScenarioEval(
      "temp-threshold-check",
      { exceeded: true, margin: 5 },
      {
        agentId: "monitoring-agent",
        summary: "Temperature threshold exceeded evaluation",
        dependencies: [sensorArtifact.id],
      }
    );

    // Step 3: Record critical safety decision
    const decisionArtifact = await recordCriticalDecision(
      { action: "activate_cooling", level: "high" },
      "safety",
      {
        agentId: "safety-controller",
        siteId: "boiler-room",
        summary: "Activated high-level cooling due to temperature threshold breach",
        justification: "Temperature 5° above threshold requires immediate cooling",
        dependencies: [evalArtifact.id],
      }
    );

    // Verify the chain
    expect(mockStorage.storeCallCount).toBe(3);
    expect(evalArtifact.dependencies).toContain(sensorArtifact.id);
    expect(decisionArtifact.dependencies).toContain(evalArtifact.id);

    // Verify audit log
    const auditLog = service.getAuditLog();
    expect(auditLog).toHaveLength(3);
    expect(auditLog.every(entry => entry.success)).toBe(true);

    // Verify stats
    const stats = service.getStats();
    expect(stats.totalTriggers).toBe(3);
    expect(stats.successfulTriggers).toBe(3);
  });

  it("should handle proof generation and verification workflow", async () => {
    // Generate proof
    const proofGenArtifact = await recordProofOperation(
      "generate",
      { proof: "0xabc...", circuit: "batch-attestation" },
      {
        summary: "Generated proof for sensor batch",
        metadata: { proofType: "zk-snark", batchSize: 100 },
      }
    );

    // Verify proof
    const proofVerifyArtifact = await recordProofOperation(
      "verify",
      { valid: true, verificationTime: 45 },
      {
        summary: "Verified batch attestation proof",
        dependencies: [proofGenArtifact.id],
        metadata: { proofType: "zk-snark" },
      }
    );

    expect(proofVerifyArtifact.dependencies).toContain(proofGenArtifact.id);
    expect(mockStorage.storeCallCount).toBe(2);
  });

  it("should handle model training workflow", async () => {
    // Initial training
    const trainArtifact = await recordModelUpdate(
      "anomaly-detector",
      "train",
      { epoch: 1000, loss: 0.01, accuracy: 0.99 },
      { summary: "Initial model training complete" }
    );

    // Refinement based on new data
    const refineArtifact = await recordModelUpdate(
      "anomaly-detector",
      "refine",
      { iterations: 100, improvement: 0.02 },
      {
        summary: "Model refined with new sensor data",
        dependencies: [trainArtifact.id],
      }
    );

    expect(refineArtifact.dependencies).toContain(trainArtifact.id);
    expect(refineArtifact.origin.agent).toBe("anomaly-detector");
  });
});
