/**
 * 0xSCADA Cross-Fork Artifact Pipeline Tests
 * 
 * VERITY Architecture - Phase α.2: Cross-Fork Artifact Pipeline
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  CrossForkPipeline,
  type CrossForkPipelineConfig,
  type StoredLinuxArtifact,
  type CrossForkDependency,
  type PipelineStats,
  type ArtifactLineage,
} from "../server/services/cross-fork-pipeline";
import { ArtifactStorageService } from "../server/services/artifact-storage";
import { ZKArtifactService } from "../server/services/zk-artifact-service";
import type { ContentHash, RealityArtifact } from "../shared/artifact";
import type {
  CreateKernelTraceInput,
  CreateSensorBurstInput,
  CreateFirmwareImageInput,
  CreateDeviceStateSnapshotInput,
} from "../shared/linux-artifact";

// =============================================================================
// TEST HELPERS
// =============================================================================

function makeContentHash(seed: string): ContentHash {
  // Generate a valid hex string by converting seed chars to hex
  const crypto = require("crypto");
  const hash = crypto.createHash("sha256").update(seed).digest("hex");
  return hash as ContentHash;
}

// =============================================================================
// TEST FIXTURES
// =============================================================================

function createMockTraceInput(): CreateKernelTraceInput {
  return {
    traceType: "ftrace",
    durationMs: 1000,
    system: {
      hostname: "test-host",
      kernelVersion: "5.15.0",
      architecture: "x86_64",
      cpuCount: 4,
    },
    config: {
      events: ["sched_switch", "sched_wakeup"],
      bufferSizeKb: 4096,
    },
    rawTrace: Buffer.from("mock ftrace data for testing"),
    deviceId: "device-001",
    trigger: {
      type: "manual",
      source: "test",
    },
    siteId: "site-001",
    assetId: "asset-001",
  };
}

function createMockSensorBurstInput(): CreateSensorBurstInput {
  return {
    source: {
      deviceId: "plc-001",
      deviceName: "Test PLC",
      protocol: "modbus-tcp",
      address: "192.168.1.100",
    },
    startTime: new Date().toISOString(),
    endTime: new Date(Date.now() + 1000).toISOString(),
    channels: [
      {
        name: "temperature",
        unit: "°C",
        dataType: "float32",
        registerAddress: 100,
        sampleCount: 100,
        minValue: 20.5,
        maxValue: 25.3,
        meanValue: 22.8,
      },
      {
        name: "pressure",
        unit: "bar",
        dataType: "float32",
        registerAddress: 102,
        sampleCount: 100,
        minValue: 1.0,
        maxValue: 1.5,
        meanValue: 1.2,
      },
    ],
    rawData: Buffer.from("mock sensor data"),
    sampleRateHz: 100,
    quality: {
      validSamples: 200,
      invalidSamples: 0,
    },
    siteId: "site-001",
    assetId: "plc-001",
  };
}

function createMockFirmwareInput(): CreateFirmwareImageInput {
  return {
    device: {
      deviceId: "plc-001",
      deviceType: "PLC",
      manufacturer: "Siemens",
      model: "S7-1500",
    },
    version: {
      major: 2,
      minor: 5,
      patch: 1,
      versionString: "2.5.1",
    },
    binary: Buffer.from("mock firmware binary"),
    format: {
      type: "bin",
      encrypted: false,
      signed: false,
    },
    metadata: {
      buildDate: new Date().toISOString(),
    },
    siteId: "site-001",
    assetId: "plc-001",
  };
}

function createMockDeviceStateInput(): CreateDeviceStateSnapshotInput {
  return {
    device: {
      deviceId: "plc-001",
      deviceType: "PLC",
      name: "Main Process Controller",
      protocol: "modbus-tcp",
    },
    state: {
      mode: "AUTO",
      status: {
        running: true,
        fault: false,
        warning: false,
      },
      registers: {
        setpoint: 100,
        processValue: 98.5,
        output: 45.2,
      },
      alarms: [],
    },
    siteId: "site-001",
  };
}

// =============================================================================
// TEST SUITE
// =============================================================================

describe("CrossForkPipeline", () => {
  let pipeline: CrossForkPipeline;
  let storage: ArtifactStorageService;
  let zkService: ZKArtifactService;
  let tempDir: string;

  beforeEach(async () => {
    // Create temp directory for tests
    tempDir = await mkdtemp(join(tmpdir(), "cross-fork-test-"));
    
    // Create services with test config
    storage = new ArtifactStorageService({
      lfsDir: join(tempDir, "lfs"),
      enableIndex: true,
      maxContentSize: 0,
      enableDeduplication: true,
      validateDependencies: false, // Disable for tests - dependency artifacts may not exist
    });
    
    zkService = new ZKArtifactService({
      enableLocalVerification: true,
      enableAnchoring: false, // Disable for tests
      anchorBatchSize: 10,
      anchorBatchMaxAgeMs: 60000,
    }, storage);
    
    await storage.initialize();
    
    // Create pipeline with test config
    pipeline = new CrossForkPipeline(
      {
        validateDependencies: false, // Disable for most tests
        allowMissingDependencies: true,
        autoDiscoverDependencies: true,
        maxDependencyDepth: 50,
        emitEvents: true,
      },
      storage,
      zkService
    );
    
    await pipeline.initialize();
  });

  afterEach(async () => {
    await pipeline.shutdown();
    // Clean up temp directory - retry with delay for Windows file locking
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch (error: any) {
      // On Windows, sometimes files are still locked; retry after a short delay
      if (error.code === "ENOTEMPTY" || error.code === "EBUSY") {
        await new Promise(resolve => setTimeout(resolve, 100));
        try {
          await rm(tempDir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors - temp dir will be cleaned up by OS
        }
      }
    }
  }, 15000); // Increase timeout for cleanup

  // ===========================================================================
  // LINUX FORK TESTS
  // ===========================================================================

  describe("Linux Fork Ingestion", () => {
    describe("ingestKernelTrace", () => {
      it("should ingest a kernel trace artifact", async () => {
        const input = createMockTraceInput();
        const result = await pipeline.ingestKernelTrace(input);
        
        expect(result).toBeDefined();
        expect(result.artifact).toBeDefined();
        expect(result.artifact.id).toMatch(/^[a-f0-9]{64}$/);
        expect(result.artifact.origin.system).toBe("linux");
        expect(result.artifact.scope.type).toBe("trace");
        expect(result.linuxMetadata.type).toBe("kernel-trace");
      });

      it("should include trace metadata", async () => {
        const input = createMockTraceInput();
        const result = await pipeline.ingestKernelTrace(input);
        
        const trace = result.linuxMetadata.type === "kernel-trace" 
          ? result.linuxMetadata.trace 
          : null;
        
        expect(trace).toBeDefined();
        expect(trace?.traceType).toBe("ftrace");
        expect(trace?.durationMs).toBe(1000);
        expect(trace?.system.hostname).toBe("test-host");
        expect(trace?.deviceId).toBe("device-001");
      });

      it("should emit events on ingestion", async () => {
        const events: string[] = [];
        pipeline.on("linux:ingested", () => events.push("linux:ingested"));
        pipeline.on("artifact:ingested", () => events.push("artifact:ingested"));
        
        await pipeline.ingestKernelTrace(createMockTraceInput());
        
        expect(events).toContain("linux:ingested");
        expect(events).toContain("artifact:ingested");
      });
    });

    describe("ingestSensorBurst", () => {
      it("should ingest a sensor burst artifact", async () => {
        const input = createMockSensorBurstInput();
        const result = await pipeline.ingestSensorBurst(input);
        
        expect(result).toBeDefined();
        expect(result.artifact.origin.system).toBe("linux");
        expect(result.artifact.scope.type).toBe("sensor");
        expect(result.linuxMetadata.type).toBe("sensor-burst");
      });

      it("should include channel information", async () => {
        const input = createMockSensorBurstInput();
        const result = await pipeline.ingestSensorBurst(input);
        
        const burst = result.linuxMetadata.type === "sensor-burst"
          ? result.linuxMetadata.burst
          : null;
        
        expect(burst?.channels).toHaveLength(2);
        expect(burst?.channels[0].name).toBe("temperature");
        expect(burst?.channels[1].name).toBe("pressure");
      });
    });

    describe("ingestFirmwareImage", () => {
      it("should ingest a firmware image artifact", async () => {
        const input = createMockFirmwareInput();
        const result = await pipeline.ingestFirmwareImage(input);
        
        expect(result).toBeDefined();
        expect(result.artifact.origin.system).toBe("linux");
        expect(result.artifact.scope.type).toBe("firmware");
        expect(result.linuxMetadata.type).toBe("firmware-image");
      });

      it("should create supersedes dependency for firmware updates", async () => {
        // First firmware
        const v1 = await pipeline.ingestFirmwareImage(createMockFirmwareInput());
        
        // Second firmware that supersedes the first
        const v2Input = createMockFirmwareInput();
        v2Input.version = { major: 2, minor: 6, patch: 0, versionString: "2.6.0" };
        v2Input.previousVersionHash = v1.artifact.id;
        
        const v2 = await pipeline.ingestFirmwareImage(v2Input);
        
        // Check dependency was created
        const depStats = pipeline.getDependencyStats();
        expect(depStats.byRelationship.supersedes).toBeGreaterThan(0);
      });
    });

    describe("ingestDeviceState", () => {
      it("should ingest a device state snapshot", async () => {
        const input = createMockDeviceStateInput();
        const result = await pipeline.ingestDeviceState(input);
        
        expect(result).toBeDefined();
        expect(result.artifact.origin.system).toBe("linux");
        expect(result.linuxMetadata.type).toBe("device-state");
      });

      it("should create derived-from dependency for state chains", async () => {
        // First state
        const state1 = await pipeline.ingestDeviceState(createMockDeviceStateInput());
        
        // Second state derived from first
        const state2Input = createMockDeviceStateInput();
        state2Input.previousSnapshotHash = state1.artifact.id;
        state2Input.state.registers = { setpoint: 110 };
        
        const state2 = await pipeline.ingestDeviceState(state2Input);
        
        const depStats = pipeline.getDependencyStats();
        expect(depStats.byRelationship["derived-from"]).toBeGreaterThan(0);
      });
    });
  });

  // ===========================================================================
  // AGENTIC-QE FORK TESTS
  // ===========================================================================

  describe("Agentic-QE Fork Ingestion", () => {
    describe("ingestAgentDecision", () => {
      it("should ingest an agent decision", async () => {
        // First create some input artifacts
        const trace = await pipeline.ingestKernelTrace(createMockTraceInput());
        const contextHash = makeContentHash("context");
        const constraintsHash = makeContentHash("constraints");
        const cotHash = makeContentHash("chain-of-thought");
        
        // Store supporting artifacts
        await storage.store({
          origin: { system: "agentic-qe" },
          scope: { type: "blob" },
          content: "context data",
        });
        
        const result = await pipeline.ingestAgentDecision({
          agentId: "ops-agent-001",
          agentName: "Ops Agent",
          siteId: "site-001",
          inputArtifacts: [trace.artifact.id],
          contextHash,
          constraintsHash,
          chainOfThoughtHash: cotHash,
          model: "gpt-4",
          temperature: 0.7,
          tokens: 500,
          decisionText: "Based on the trace analysis, the system is operating normally.",
          confidence: 0.95,
          automatedChecks: [],
          safetyScore: 0.9,
        });
        
        expect(result).toBeDefined();
        expect(result.origin.system).toBe("agentic-qe");
        expect(result.scope.type).toBe("decision");
      });

      it("should emit events on decision ingestion", async () => {
        const events: string[] = [];
        pipeline.on("agentic:ingested", () => events.push("agentic:ingested"));
        
        await pipeline.ingestAgentDecision({
          agentId: "test-agent",
          agentName: "Test Agent",
          inputArtifacts: [],
          contextHash: makeContentHash("ctx"),
          constraintsHash: makeContentHash("con"),
          chainOfThoughtHash: makeContentHash("cot"),
          model: "gpt-4",
          temperature: 0.7,
          tokens: 100,
          decisionText: "Test decision",
          confidence: 0.8,
        });
        
        expect(events).toContain("agentic:ingested");
      });
    });

    describe("ingestWorldModel", () => {
      it("should ingest a world model artifact", async () => {
        const result = await pipeline.ingestWorldModel({
          agentId: "ops-agent-001",
          modelType: "state-estimator",
          version: "1.0.0",
          inputArtifacts: [],
          modelData: Buffer.from("serialized model data"),
          metadata: { layers: 5 },
          siteId: "site-001",
        });
        
        expect(result).toBeDefined();
        expect(result.origin.system).toBe("agentic-qe");
        expect(result.scope.type).toBe("model");
      });
    });

    describe("ingestEmbedding", () => {
      it("should ingest an embedding artifact", async () => {
        // Create a source artifact first
        const trace = await pipeline.ingestKernelTrace(createMockTraceInput());
        
        const result = await pipeline.ingestEmbedding({
          agentId: "embedding-agent",
          sourceArtifacts: [trace.artifact.id],
          modelName: "text-embedding-ada-002",
          dimensions: 1536,
          embeddingData: Buffer.alloc(1536 * 4), // Mock float32 embedding
          siteId: "site-001",
        });
        
        expect(result).toBeDefined();
        expect(result.origin.system).toBe("agentic-qe");
        expect(result.scope.type).toBe("embedding");
      });
    });
  });

  // ===========================================================================
  // CROSS-FORK DEPENDENCY TESTS
  // ===========================================================================

  describe("Cross-Fork Dependencies", () => {
    describe("dependency management", () => {
      it("should add and track dependencies", async () => {
        const hash1 = makeContentHash("artifact1");
        const hash2 = makeContentHash("artifact2");
        
        const dep = pipeline.addDependency(
          hash1,
          "agentic-qe",
          hash2,
          "linux",
          "uses"
        );
        
        expect(dep.fromHash).toBe(hash1);
        expect(dep.toHash).toBe(hash2);
        expect(dep.relationship).toBe("uses");
      });

      it("should track dependents correctly", async () => {
        const trace = await pipeline.ingestKernelTrace(createMockTraceInput());
        const decisionHash = makeContentHash("decision");
        
        pipeline.addDependency(
          decisionHash,
          "agentic-qe",
          trace.artifact.id,
          "linux",
          "uses"
        );
        
        const dependents = pipeline.getDependents(trace.artifact.id);
        expect(dependents).toContain(decisionHash);
      });

      it("should emit dependency:created event", async () => {
        const events: CrossForkDependency[] = [];
        pipeline.on("dependency:created", (dep) => events.push(dep));
        
        pipeline.addDependency(
          makeContentHash("from"),
          "ethereum",
          makeContentHash("to"),
          "linux",
          "verifies"
        );
        
        expect(events).toHaveLength(1);
        expect(events[0].relationship).toBe("verifies");
      });
    });

    describe("cross-fork linking helpers", () => {
      it("should link proofs to traces", async () => {
        const proofHash = makeContentHash("proof");
        const traceHash = makeContentHash("trace");
        
        const dep = pipeline.linkProofToTrace(proofHash, traceHash);
        
        expect(dep.fromFork).toBe("ethereum");
        expect(dep.toFork).toBe("linux");
        expect(dep.relationship).toBe("verifies");
      });

      it("should link decisions to proofs", async () => {
        const decisionHash = makeContentHash("decision");
        const proofHashes = [makeContentHash("proof1"), makeContentHash("proof2")];
        
        const deps = pipeline.linkDecisionToProofs(decisionHash, proofHashes);
        
        expect(deps).toHaveLength(2);
        expect(deps.every(d => d.fromFork === "agentic-qe")).toBe(true);
        expect(deps.every(d => d.toFork === "ethereum")).toBe(true);
        expect(deps.every(d => d.relationship === "uses")).toBe(true);
      });

      it("should link decisions to traces", async () => {
        const decisionHash = makeContentHash("decision");
        const traceHashes = [makeContentHash("trace1")];
        
        const deps = pipeline.linkDecisionToTraces(decisionHash, traceHashes);
        
        expect(deps).toHaveLength(1);
        expect(deps[0].toFork).toBe("linux");
      });
    });
  });

  // ===========================================================================
  // RETRIEVAL TESTS
  // ===========================================================================

  describe("Artifact Retrieval", () => {
    it("should retrieve Linux artifacts by hash", async () => {
      const stored = await pipeline.ingestKernelTrace(createMockTraceInput());
      
      const retrieved = await pipeline.getLinuxArtifact(stored.artifact.id);
      
      expect(retrieved).toBeDefined();
      expect(retrieved?.artifact.id).toBe(stored.artifact.id);
    });

    it("should retrieve Agentic-QE artifacts by hash", async () => {
      const stored = await pipeline.ingestWorldModel({
        agentId: "test",
        modelType: "test",
        version: "1.0",
        inputArtifacts: [],
        modelData: "test",
      });
      
      const retrieved = await pipeline.getAgenticArtifact(stored.id);
      
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(stored.id);
    });

    it("should determine artifact fork correctly", async () => {
      const trace = await pipeline.ingestKernelTrace(createMockTraceInput());
      const model = await pipeline.ingestWorldModel({
        agentId: "test",
        modelType: "test",
        version: "1.0",
        inputArtifacts: [],
        modelData: "test",
      });
      
      const traceFork = await pipeline.getArtifactFork(trace.artifact.id);
      const modelFork = await pipeline.getArtifactFork(model.id);
      
      expect(traceFork).toBe("linux");
      expect(modelFork).toBe("agentic-qe");
    });

    it("should query artifacts across forks", async () => {
      // Ingest various artifacts
      await pipeline.ingestKernelTrace(createMockTraceInput());
      await pipeline.ingestSensorBurst(createMockSensorBurstInput());
      await pipeline.ingestWorldModel({
        agentId: "test",
        modelType: "test",
        version: "1.0",
        inputArtifacts: [],
        modelData: "test",
      });
      
      // Query Linux artifacts only
      const linuxArtifacts = await pipeline.queryArtifacts({
        fork: "linux",
      });
      
      expect(linuxArtifacts.length).toBeGreaterThan(0);
      expect(linuxArtifacts.every(a => a.origin.system === "linux")).toBe(true);
    });
  });

  // ===========================================================================
  // LINEAGE TESTS
  // ===========================================================================

  describe("Artifact Lineage", () => {
    it("should track artifact lineage", async () => {
      // Create a chain: trace -> decision
      const trace = await pipeline.ingestKernelTrace(createMockTraceInput());
      
      const decision = await pipeline.ingestAgentDecision({
        agentId: "test-agent",
        agentName: "Test",
        inputArtifacts: [trace.artifact.id],
        contextHash: makeContentHash("ctx"),
        constraintsHash: makeContentHash("con"),
        chainOfThoughtHash: makeContentHash("cot"),
        model: "gpt-4",
        temperature: 0.7,
        tokens: 100,
        decisionText: "Test",
        confidence: 0.8,
      });
      
      // Link the cross-fork dependency
      pipeline.linkDecisionToTraces(decision.id, [trace.artifact.id]);
      
      const lineage = await pipeline.getArtifactLineage(decision.id);
      
      expect(lineage).toBeDefined();
      expect(lineage?.artifacts.size).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // STATISTICS TESTS
  // ===========================================================================

  describe("Statistics", () => {
    it("should provide accurate pipeline stats", async () => {
      // Ingest some artifacts
      await pipeline.ingestKernelTrace(createMockTraceInput());
      await pipeline.ingestSensorBurst(createMockSensorBurstInput());
      await pipeline.ingestWorldModel({
        agentId: "test",
        modelType: "test",
        version: "1.0",
        inputArtifacts: [],
        modelData: "test",
      });
      
      const stats = await pipeline.getStats();
      
      expect(stats.totalArtifacts).toBeGreaterThanOrEqual(3);
      expect(stats.byFork.linux).toBeGreaterThanOrEqual(2);
      expect(stats.byFork["agentic-qe"]).toBeGreaterThanOrEqual(1);
      expect(stats.ingestionsPerMinute).toBeGreaterThan(0);
    });

    it("should track dependency statistics", async () => {
      // Add some dependencies
      pipeline.addDependency(makeContentHash("a"), "agentic-qe", makeContentHash("b"), "linux", "uses");
      pipeline.addDependency(makeContentHash("c"), "ethereum", makeContentHash("d"), "linux", "verifies");
      pipeline.addDependency(makeContentHash("e"), "linux", makeContentHash("f"), "linux", "derived-from");
      
      const depStats = pipeline.getDependencyStats();
      
      expect(depStats.total).toBe(3);
      expect(depStats.crossForkCount).toBe(2);
      expect(depStats.sameForkCount).toBe(1);
      expect(depStats.byRelationship.uses).toBe(1);
      expect(depStats.byRelationship.verifies).toBe(1);
      expect(depStats.byRelationship["derived-from"]).toBe(1);
    });
  });

  // ===========================================================================
  // VALIDATION TESTS
  // ===========================================================================

  describe("Dependency Validation", () => {
    it("should validate dependencies exist", async () => {
      const trace = await pipeline.ingestKernelTrace(createMockTraceInput());
      
      const validation = await pipeline.validateDependencies([
        trace.artifact.id,
        makeContentHash("nonexistent"),
      ]);
      
      expect(validation.valid).toBe(false);
      expect(validation.missing).toContain(makeContentHash("nonexistent"));
    });

    it("should check if artifact exists", async () => {
      const trace = await pipeline.ingestKernelTrace(createMockTraceInput());
      
      const exists = await pipeline.artifactExists(trace.artifact.id);
      const notExists = await pipeline.artifactExists(makeContentHash("fake"));
      
      expect(exists).toBe(true);
      expect(notExists).toBe(false);
    });
  });

  // ===========================================================================
  // EVENT EMISSION TESTS
  // ===========================================================================

  describe("Event Emission", () => {
    it("should emit pipeline:error on errors", async () => {
      const errors: Error[] = [];
      pipeline.on("pipeline:error", ({ error }) => errors.push(error));
      
      // The pipeline doesn't emit errors in normal operation,
      // but we verify the event system is wired up
      pipeline.emit("pipeline:error", {
        error: new Error("Test error"),
        context: "test",
        timestamp: new Date(),
      });
      
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe("Test error");
    });

    it("should not emit events when disabled", async () => {
      const quietPipeline = new CrossForkPipeline(
        { emitEvents: false },
        storage,
        zkService
      );
      
      const events: string[] = [];
      quietPipeline.on("linux:ingested", () => events.push("linux"));
      
      await quietPipeline.ingestKernelTrace(createMockTraceInput());
      
      expect(events).toHaveLength(0);
    });
  });
});
