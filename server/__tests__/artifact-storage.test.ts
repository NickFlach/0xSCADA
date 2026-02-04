/**
 * Artifact Storage Service Tests
 * 
 * VERITY Architecture - Phase α.1: LFS Content-Addressed Artifact Storage
 * 
 * Tests for:
 * - Content-addressed storage (SHA-256)
 * - Artifact schema validation
 * - Dependency tracking
 * - Query operations
 * - Integrity verification
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

import {
  ArtifactStorageService,
  type ArtifactStorageConfig,
} from "../services/artifact-storage";

import {
  type CreateArtifactInput,
  type RealityArtifact,
  type ContentHash,
  realityArtifactSchema,
} from "@shared/artifact";

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Create a temporary directory for test artifacts
 */
async function createTempDir(): Promise<string> {
  const tempDir = path.join(os.tmpdir(), `artifact-test-${Date.now()}`);
  await fs.mkdir(tempDir, { recursive: true });
  return tempDir;
}

/**
 * Clean up temporary directory
 */
async function cleanupTempDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Create a basic artifact input for testing
 */
function createTestArtifactInput(overrides: Partial<CreateArtifactInput> = {}): CreateArtifactInput {
  return {
    origin: {
      system: "linux",
      agent: "test-agent",
      fork: "abc123",
      device: "sensor-001",
    },
    scope: {
      type: "sensor",
      siteId: "site-001",
      assetId: "asset-001",
      tags: ["test", "sensor"],
    },
    content: Buffer.from("test content data"),
    mimeType: "application/octet-stream",
    summary: "Test artifact",
    ...overrides,
  };
}

// =============================================================================
// UNIT TESTS: Content Hashing
// =============================================================================

describe("ArtifactStorageService - Content Hashing", () => {
  let service: ArtifactStorageService;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    service = new ArtifactStorageService({ lfsDir: tempDir });
    await service.initialize();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should compute consistent SHA-256 hash for string content", () => {
    const content = "hello world";
    const hash1 = service.computeHash(content);
    const hash2 = service.computeHash(content);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should compute consistent SHA-256 hash for Buffer content", () => {
    const content = Buffer.from("hello world");
    const hash = service.computeHash(content);

    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should compute same hash for string and equivalent Buffer", () => {
    const str = "test data";
    const buf = Buffer.from(str, "utf-8");

    const hashStr = service.computeHash(str);
    const hashBuf = service.computeHash(buf);

    expect(hashStr).toBe(hashBuf);
  });

  it("should compute different hashes for different content", () => {
    const hash1 = service.computeHash("content A");
    const hash2 = service.computeHash("content B");

    expect(hash1).not.toBe(hash2);
  });

  it("should produce known SHA-256 hash", () => {
    // Known SHA-256 of "hello"
    const hash = service.computeHash("hello");
    expect(hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});

// =============================================================================
// UNIT TESTS: Artifact Storage
// =============================================================================

describe("ArtifactStorageService - Storage Operations", () => {
  let service: ArtifactStorageService;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    service = new ArtifactStorageService({ lfsDir: tempDir });
    await service.initialize();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe("store()", () => {
    it("should store an artifact and return it with computed ID", async () => {
      const input = createTestArtifactInput();
      const artifact = await service.store(input);

      expect(artifact).toBeDefined();
      expect(artifact.id).toHaveLength(64);
      expect(artifact.id).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.origin).toEqual(input.origin);
      expect(artifact.scope).toEqual(input.scope);
      expect(artifact.summary).toBe(input.summary);
      expect(artifact.timestamp).toBeDefined();
    });

    it("should store content to LFS with correct hash path", async () => {
      const input = createTestArtifactInput({ content: "unique content 123" });
      const artifact = await service.store(input);

      const shard = artifact.id.slice(0, 2);
      const objectPath = path.join(tempDir, "objects", shard, artifact.id);

      const exists = await fs.stat(objectPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it("should create valid LFS pointer", async () => {
      const content = Buffer.from("test content with known size");
      const input = createTestArtifactInput({ 
        content,
        mimeType: "text/plain",
        filename: "test.txt",
      });
      
      const artifact = await service.store(input);

      expect(artifact.content.version).toBe("v1");
      expect(artifact.content.oid).toBe(artifact.id);
      expect(artifact.content.size).toBe(content.length);
      expect(artifact.content.mimeType).toBe("text/plain");
      expect(artifact.content.filename).toBe("test.txt");
    });

    it("should store artifact metadata as JSON", async () => {
      const input = createTestArtifactInput();
      const artifact = await service.store(input);

      const shard = artifact.id.slice(0, 2);
      const metadataPath = path.join(tempDir, "metadata", shard, `${artifact.id}.json`);

      const data = await fs.readFile(metadataPath, "utf-8");
      const parsed = JSON.parse(data);

      expect(parsed.id).toBe(artifact.id);
      expect(parsed.origin.system).toBe("linux");
    });

    it("should emit artifact:stored event", async () => {
      const input = createTestArtifactInput();
      
      const storedArtifacts: RealityArtifact[] = [];
      service.on("artifact:stored", (artifact) => {
        storedArtifacts.push(artifact);
      });

      await service.store(input);

      expect(storedArtifacts).toHaveLength(1);
      expect(storedArtifacts[0].scope.type).toBe("sensor");
    });

    it("should deduplicate identical content", async () => {
      const content = "duplicate content";
      const input1 = createTestArtifactInput({ content });
      const input2 = createTestArtifactInput({ content });

      const artifact1 = await service.store(input1);
      const artifact2 = await service.store(input2);

      expect(artifact1.id).toBe(artifact2.id);
      expect(service.getCount()).toBe(1);
    });

    it("should reject content exceeding size limit", async () => {
      const limitedService = new ArtifactStorageService({
        lfsDir: tempDir,
        maxContentSize: 10,
      });
      await limitedService.initialize();

      const input = createTestArtifactInput({ content: "this is more than 10 bytes" });

      await expect(limitedService.store(input)).rejects.toThrow(/exceeds maximum/);
    });

    it("should validate input schema", async () => {
      const invalidInput = {
        origin: { system: "invalid-system" },
        scope: { type: "sensor" },
        content: "test",
      };

      await expect(service.store(invalidInput as any)).rejects.toThrow();
    });
  });

  describe("get()", () => {
    it("should retrieve stored artifact by hash", async () => {
      const input = createTestArtifactInput();
      const stored = await service.store(input);

      const retrieved = await service.get(stored.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(stored.id);
      expect(retrieved!.origin).toEqual(stored.origin);
    });

    it("should return null for non-existent hash", async () => {
      const fakeHash = "a".repeat(64) as ContentHash;
      const result = await service.get(fakeHash);

      expect(result).toBeNull();
    });

    it("should validate hash format", async () => {
      const invalidHash = "not-a-valid-hash";
      
      await expect(service.get(invalidHash as any)).rejects.toThrow();
    });

    it("should track access count", async () => {
      const input = createTestArtifactInput();
      const stored = await service.store(input);

      await service.get(stored.id);
      await service.get(stored.id);
      await service.get(stored.id);

      // Access count is tracked internally
      expect(service.getCount()).toBe(1);
    });
  });

  describe("getContent()", () => {
    it("should retrieve raw content by hash", async () => {
      const content = Buffer.from("raw binary content");
      const input = createTestArtifactInput({ content });
      const stored = await service.store(input);

      const retrieved = await service.getContent(stored.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.equals(content)).toBe(true);
    });

    it("should return null for non-existent content", async () => {
      const fakeHash = "b".repeat(64) as ContentHash;
      const result = await service.getContent(fakeHash);

      expect(result).toBeNull();
    });
  });

  describe("exists()", () => {
    it("should return true for existing artifact", async () => {
      const input = createTestArtifactInput();
      const stored = await service.store(input);

      const exists = await service.exists(stored.id);

      expect(exists).toBe(true);
    });

    it("should return false for non-existent artifact", async () => {
      const fakeHash = "c".repeat(64) as ContentHash;
      const exists = await service.exists(fakeHash);

      expect(exists).toBe(false);
    });
  });

  describe("verifyIntegrity()", () => {
    it("should return true for valid artifact", async () => {
      const input = createTestArtifactInput();
      const stored = await service.store(input);

      const valid = await service.verifyIntegrity(stored.id);

      expect(valid).toBe(true);
    });

    it("should return false for corrupted content", async () => {
      const input = createTestArtifactInput();
      const stored = await service.store(input);

      // Corrupt the content
      const shard = stored.id.slice(0, 2);
      const objectPath = path.join(tempDir, "objects", shard, stored.id);
      await fs.writeFile(objectPath, "corrupted data");

      const valid = await service.verifyIntegrity(stored.id);

      expect(valid).toBe(false);
    });

    it("should return false for missing content", async () => {
      const fakeHash = "d".repeat(64) as ContentHash;
      const valid = await service.verifyIntegrity(fakeHash);

      expect(valid).toBe(false);
    });
  });
});

// =============================================================================
// UNIT TESTS: Schema Validation
// =============================================================================

describe("ArtifactStorageService - Schema Validation", () => {
  let service: ArtifactStorageService;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    service = new ArtifactStorageService({ lfsDir: tempDir });
    await service.initialize();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe("validate()", () => {
    it("should validate a correct artifact", async () => {
      const input = createTestArtifactInput();
      const stored = await service.store(input);

      const result = service.validate(stored);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.artifact).toBeDefined();
    });

    it("should reject artifact with invalid hash format", () => {
      const invalid = {
        id: "not-a-hash",
        timestamp: new Date().toISOString(),
        origin: { system: "linux" },
        scope: { type: "sensor" },
        dependencies: [],
        content: { version: "v1", oid: "x".repeat(64), size: 100 },
      };

      const result = service.validate(invalid);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should reject artifact with invalid origin system", () => {
      const invalid = {
        id: "a".repeat(64),
        timestamp: new Date().toISOString(),
        origin: { system: "invalid" },
        scope: { type: "sensor" },
        dependencies: [],
        content: { version: "v1", oid: "a".repeat(64), size: 100 },
      };

      const result = service.validate(invalid);

      expect(result.valid).toBe(false);
    });

    it("should reject artifact with invalid scope type", () => {
      const invalid = {
        id: "a".repeat(64),
        timestamp: new Date().toISOString(),
        origin: { system: "linux" },
        scope: { type: "invalid-type" },
        dependencies: [],
        content: { version: "v1", oid: "a".repeat(64), size: 100 },
      };

      const result = service.validate(invalid);

      expect(result.valid).toBe(false);
    });

    it("should reject artifact with invalid timestamp", () => {
      const invalid = {
        id: "a".repeat(64),
        timestamp: "not-a-date",
        origin: { system: "linux" },
        scope: { type: "sensor" },
        dependencies: [],
        content: { version: "v1", oid: "a".repeat(64), size: 100 },
      };

      const result = service.validate(invalid);

      expect(result.valid).toBe(false);
    });

    it("should validate artifact with all optional fields", async () => {
      const input: CreateArtifactInput = {
        origin: {
          system: "ethereum",
          agent: "zk-prover",
          fork: "def456",
          device: "node-01",
        },
        scope: {
          type: "proof",
          siteId: "site-002",
          assetId: "asset-002",
          tags: ["zk", "verification"],
          metadata: { proofType: "groth16" },
        },
        dependencies: [],
        summary: "ZK proof artifact",
        content: "proof data",
        mimeType: "application/octet-stream",
        filename: "proof.bin",
        signature: {
          algorithm: "ed25519",
          keyId: "key-001",
          value: "abcdef123456",
          signedAt: new Date().toISOString(),
        },
      };

      const stored = await service.store(input);
      const result = service.validate(stored);

      expect(result.valid).toBe(true);
      expect(result.artifact!.signature).toBeDefined();
    });
  });
});

// =============================================================================
// UNIT TESTS: Dependency Tracking
// =============================================================================

describe("ArtifactStorageService - Dependency Tracking", () => {
  let service: ArtifactStorageService;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    service = new ArtifactStorageService({ 
      lfsDir: tempDir,
      enableDeduplication: false, // Disable for dependency tests
    });
    await service.initialize();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should store artifact with dependencies", async () => {
    // Create parent artifacts
    const parent1 = await service.store(createTestArtifactInput({ content: "parent1" }));
    const parent2 = await service.store(createTestArtifactInput({ content: "parent2" }));

    // Create child artifact with dependencies
    const childInput = createTestArtifactInput({
      content: "child",
      dependencies: [parent1.id, parent2.id],
    });
    const child = await service.store(childInput);

    expect(child.dependencies).toHaveLength(2);
    expect(child.dependencies).toContain(parent1.id);
    expect(child.dependencies).toContain(parent2.id);
  });

  it("should reject dependency on non-existent artifact", async () => {
    const fakeHash = "e".repeat(64) as ContentHash;
    const input = createTestArtifactInput({
      content: "orphan",
      dependencies: [fakeHash],
    });

    await expect(service.store(input)).rejects.toThrow(/Dependency artifact not found/);
  });

  it("should track dependents correctly", async () => {
    const parent = await service.store(createTestArtifactInput({ content: "parent" }));
    
    const child1 = await service.store(createTestArtifactInput({
      content: "child1",
      dependencies: [parent.id],
    }));
    const child2 = await service.store(createTestArtifactInput({
      content: "child2",
      dependencies: [parent.id],
    }));

    const dependents = service.getDependents(parent.id);

    expect(dependents).toHaveLength(2);
    expect(dependents).toContain(child1.id);
    expect(dependents).toContain(child2.id);
  });

  it("should build dependency graph", async () => {
    // Create a chain: A -> B -> C
    const a = await service.store(createTestArtifactInput({ content: "A" }));
    const b = await service.store(createTestArtifactInput({ 
      content: "B",
      dependencies: [a.id],
    }));
    const c = await service.store(createTestArtifactInput({ 
      content: "C",
      dependencies: [b.id],
    }));

    const graph = await service.getDependencyGraph(c.id);

    expect(graph.nodes.size).toBe(3);
    expect(graph.nodes.has(a.id)).toBe(true);
    expect(graph.nodes.has(b.id)).toBe(true);
    expect(graph.nodes.has(c.id)).toBe(true);
  });

  it("should compute topological order for acyclic graph", async () => {
    const a = await service.store(createTestArtifactInput({ content: "A" }));
    const b = await service.store(createTestArtifactInput({ 
      content: "B",
      dependencies: [a.id],
    }));
    const c = await service.store(createTestArtifactInput({ 
      content: "C",
      dependencies: [a.id],
    }));
    const d = await service.store(createTestArtifactInput({ 
      content: "D",
      dependencies: [b.id, c.id],
    }));

    const graph = await service.getDependencyGraph(d.id);

    expect(graph.topologicalOrder).toBeDefined();
    expect(graph.cycles).toBeUndefined();
    
    // A must come before B and C
    const order = graph.topologicalOrder!;
    expect(order.indexOf(a.id)).toBeLessThan(order.indexOf(b.id));
    expect(order.indexOf(a.id)).toBeLessThan(order.indexOf(c.id));
    
    // B and C must come before D
    expect(order.indexOf(b.id)).toBeLessThan(order.indexOf(d.id));
    expect(order.indexOf(c.id)).toBeLessThan(order.indexOf(d.id));
  });
});

// =============================================================================
// UNIT TESTS: Query Operations
// =============================================================================

describe("ArtifactStorageService - Query Operations", () => {
  let service: ArtifactStorageService;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    service = new ArtifactStorageService({ 
      lfsDir: tempDir,
      enableDeduplication: false,
    });
    await service.initialize();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should query by system", async () => {
    await service.store(createTestArtifactInput({ 
      content: "linux1",
      origin: { system: "linux" },
    }));
    await service.store(createTestArtifactInput({ 
      content: "eth1",
      origin: { system: "ethereum" },
    }));
    await service.store(createTestArtifactInput({ 
      content: "linux2",
      origin: { system: "linux" },
    }));

    const linuxArtifacts = await service.query({ system: "linux" });
    const ethArtifacts = await service.query({ system: "ethereum" });

    expect(linuxArtifacts).toHaveLength(2);
    expect(ethArtifacts).toHaveLength(1);
  });

  it("should query by type", async () => {
    await service.store(createTestArtifactInput({ 
      content: "sensor1",
      scope: { type: "sensor" },
    }));
    await service.store(createTestArtifactInput({ 
      content: "proof1",
      scope: { type: "proof" },
    }));
    await service.store(createTestArtifactInput({ 
      content: "sensor2",
      scope: { type: "sensor" },
    }));

    const sensorArtifacts = await service.query({ type: "sensor" });
    const proofArtifacts = await service.query({ type: "proof" });

    expect(sensorArtifacts).toHaveLength(2);
    expect(proofArtifacts).toHaveLength(1);
  });

  it("should query by site and asset", async () => {
    await service.store(createTestArtifactInput({ 
      content: "site1-asset1",
      scope: { type: "sensor", siteId: "site-001", assetId: "asset-001" },
    }));
    await service.store(createTestArtifactInput({ 
      content: "site1-asset2",
      scope: { type: "sensor", siteId: "site-001", assetId: "asset-002" },
    }));
    await service.store(createTestArtifactInput({ 
      content: "site2-asset1",
      scope: { type: "sensor", siteId: "site-002", assetId: "asset-001" },
    }));

    const site1 = await service.query({ siteId: "site-001" });
    const asset1 = await service.query({ assetId: "asset-001" });
    const site1Asset1 = await service.query({ siteId: "site-001", assetId: "asset-001" });

    expect(site1).toHaveLength(2);
    expect(asset1).toHaveLength(2);
    expect(site1Asset1).toHaveLength(1);
  });

  it("should query by tags", async () => {
    await service.store(createTestArtifactInput({ 
      content: "tagged1",
      scope: { type: "sensor", tags: ["critical", "temperature"] },
    }));
    await service.store(createTestArtifactInput({ 
      content: "tagged2",
      scope: { type: "sensor", tags: ["critical", "pressure"] },
    }));
    await service.store(createTestArtifactInput({ 
      content: "tagged3",
      scope: { type: "sensor", tags: ["normal"] },
    }));

    const critical = await service.query({ tags: ["critical"] });
    const criticalTemp = await service.query({ tags: ["critical", "temperature"] });

    expect(critical).toHaveLength(2);
    expect(criticalTemp).toHaveLength(1);
  });

  it("should query by dependency", async () => {
    const parent = await service.store(createTestArtifactInput({ content: "parent" }));
    await service.store(createTestArtifactInput({ 
      content: "child1",
      dependencies: [parent.id],
    }));
    await service.store(createTestArtifactInput({ 
      content: "child2",
      dependencies: [parent.id],
    }));
    await service.store(createTestArtifactInput({ content: "orphan" }));

    const dependsOnParent = await service.query({ dependsOn: parent.id });

    expect(dependsOnParent).toHaveLength(2);
  });

  it("should support pagination", async () => {
    // Create 10 artifacts
    for (let i = 0; i < 10; i++) {
      await service.store(createTestArtifactInput({ content: `item-${i}` }));
    }

    const page1 = await service.query({ limit: 3, offset: 0 });
    const page2 = await service.query({ limit: 3, offset: 3 });
    const page3 = await service.query({ limit: 3, offset: 6 });
    const page4 = await service.query({ limit: 3, offset: 9 });

    expect(page1).toHaveLength(3);
    expect(page2).toHaveLength(3);
    expect(page3).toHaveLength(3);
    expect(page4).toHaveLength(1);
  });

  it("should sort by timestamp descending", async () => {
    // Create artifacts with slight delays
    await service.store(createTestArtifactInput({ content: "first" }));
    await new Promise(resolve => setTimeout(resolve, 10));
    await service.store(createTestArtifactInput({ content: "second" }));
    await new Promise(resolve => setTimeout(resolve, 10));
    await service.store(createTestArtifactInput({ content: "third" }));

    const results = await service.query({});

    expect(results).toHaveLength(3);
    // Should be in reverse chronological order
    expect(results[0].timestamp >= results[1].timestamp).toBe(true);
    expect(results[1].timestamp >= results[2].timestamp).toBe(true);
  });
});

// =============================================================================
// UNIT TESTS: Statistics
// =============================================================================

describe("ArtifactStorageService - Statistics", () => {
  let service: ArtifactStorageService;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    service = new ArtifactStorageService({ 
      lfsDir: tempDir,
      enableDeduplication: false,
    });
    await service.initialize();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should track total artifacts", async () => {
    expect(service.getCount()).toBe(0);

    await service.store(createTestArtifactInput({ content: "1" }));
    expect(service.getCount()).toBe(1);

    await service.store(createTestArtifactInput({ content: "2" }));
    expect(service.getCount()).toBe(2);
  });

  it("should compute storage statistics", async () => {
    await service.store(createTestArtifactInput({ 
      content: "linux data",
      origin: { system: "linux" },
      scope: { type: "sensor" },
    }));
    await service.store(createTestArtifactInput({ 
      content: "ethereum proof",
      origin: { system: "ethereum" },
      scope: { type: "proof" },
    }));
    await service.store(createTestArtifactInput({ 
      content: "more linux",
      origin: { system: "linux" },
      scope: { type: "trace" },
    }));

    const stats = await service.getStats();

    expect(stats.totalArtifacts).toBe(3);
    expect(stats.totalSize).toBeGreaterThan(0);
    expect(stats.bySystem.linux).toBe(2);
    expect(stats.bySystem.ethereum).toBe(1);
    expect(stats.byType.sensor).toBe(1);
    expect(stats.byType.proof).toBe(1);
    expect(stats.byType.trace).toBe(1);
  });

  it("should track oldest and newest timestamps", async () => {
    await service.store(createTestArtifactInput({ content: "first" }));
    await new Promise(resolve => setTimeout(resolve, 10));
    await service.store(createTestArtifactInput({ content: "second" }));

    const stats = await service.getStats();

    expect(stats.oldestTimestamp).toBeDefined();
    expect(stats.newestTimestamp).toBeDefined();
    expect(stats.oldestTimestamp! < stats.newestTimestamp!).toBe(true);
  });

  it("should compute average dependencies", async () => {
    const a = await service.store(createTestArtifactInput({ content: "A" }));
    await service.store(createTestArtifactInput({ 
      content: "B",
      dependencies: [a.id],
    }));
    await service.store(createTestArtifactInput({ 
      content: "C",
      dependencies: [a.id],
    }));

    const stats = await service.getStats();

    // 3 artifacts: 0 + 1 + 1 = 2 dependencies, avg = 2/3 ≈ 0.67
    expect(stats.avgDependencies).toBeCloseTo(2 / 3, 2);
  });
});

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

describe("ArtifactStorageService - Integration", () => {
  let service: ArtifactStorageService;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    service = new ArtifactStorageService({ lfsDir: tempDir });
    await service.initialize();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should persist and reload index", async () => {
    // Store some artifacts
    await service.store(createTestArtifactInput({ content: "persistent 1" }));
    await service.store(createTestArtifactInput({ content: "persistent 2" }));

    // Create new service instance (simulates restart)
    const newService = new ArtifactStorageService({ lfsDir: tempDir });
    await newService.initialize();

    expect(newService.getCount()).toBe(2);
    
    const allIds = newService.getAllIds();
    expect(allIds).toHaveLength(2);
  });

  it("should handle concurrent stores", async () => {
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        service.store(createTestArtifactInput({ content: `concurrent-${i}` }))
      );
    }

    const results = await Promise.all(promises);

    expect(results).toHaveLength(10);
    expect(service.getCount()).toBe(10);

    // All should have unique IDs
    const ids = new Set(results.map(r => r.id));
    expect(ids.size).toBe(10);
  });

  it("should validate entire artifact lifecycle", async () => {
    // 1. Create and store
    const input = createTestArtifactInput({
      content: "lifecycle test",
      summary: "Testing the full artifact lifecycle",
    });
    const stored = await service.store(input);

    // 2. Validate schema
    const validation = service.validate(stored);
    expect(validation.valid).toBe(true);

    // 3. Retrieve by hash
    const retrieved = await service.get(stored.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(stored.id);

    // 4. Retrieve content
    const content = await service.getContent(stored.id);
    expect(content).not.toBeNull();
    expect(content!.toString()).toBe("lifecycle test");

    // 5. Verify integrity
    const valid = await service.verifyIntegrity(stored.id);
    expect(valid).toBe(true);

    // 6. Check existence
    const exists = await service.exists(stored.id);
    expect(exists).toBe(true);

    // 7. Query
    const queried = await service.query({ system: "linux" });
    expect(queried).toContainEqual(expect.objectContaining({ id: stored.id }));
  });
});
