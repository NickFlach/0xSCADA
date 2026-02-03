/**
 * 0xSCADA Time-Travel Reconstruction API Tests
 * 
 * VERITY Architecture - Phase β.1: Time-Travel SCADA
 * 
 * Tests for:
 * - RealitySnapshot schema validation
 * - RealityDiff schema validation
 * - ReplayResult schema validation
 * - BisectResult schema validation
 * - CommitHash and CommitRange validation
 * - Type guards and validation helpers
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  // Schemas
  commitHashSchema,
  commitRangeSchema,
  commitInfoSchema,
  realitySnapshotSchema,
  realityDiffSchema,
  replayResultSchema,
  bisectResultSchema,
  bisectStepSchema,
  snapshotArtifactRefSchema,
  artifactDiffEntrySchema,
  reconstructOptionsSchema,
  replayOptionsSchema,
  diffOptionsSchema,
  bisectOptionsSchema,
  
  // Types
  type CommitHash,
  type CommitRange,
  type CommitInfo,
  type RealitySnapshot,
  type RealityDiff,
  type ReplayResult,
  type BisectResult,
  type BisectStep,
  type SnapshotArtifactRef,
  type ArtifactDiffEntry,
  type ReconstructOptions,
  type ReplayOptions,
  type DiffOptions,
  type BisectOptions,
  
  // Validation helpers
  validateCommitHash,
  validateCommitRange,
  isRealitySnapshot,
  isRealityDiff,
  isBisectResult,
} from "../shared/types/time-travel";

import { type ContentHash } from "../shared/artifact";

// =============================================================================
// TEST DATA FACTORIES
// =============================================================================

function makeContentHash(seed: string): ContentHash {
  // Generate a valid 64-character hex string (SHA-256 format)
  // Convert seed to hex-like characters only (a-f, 0-9)
  const hexSeed = seed
    .split('')
    .map(c => {
      const code = c.charCodeAt(0) % 16;
      return code.toString(16);
    })
    .join('');
  const padded = hexSeed.padEnd(64, '0').slice(0, 64);
  return padded as ContentHash;
}

function makeCommitHash(seed: string): CommitHash {
  // Generate a valid 40-character hex string (SHA-1 format)
  // Convert seed to hex-like characters only (a-f, 0-9)
  const hexSeed = seed
    .split('')
    .map(c => {
      const code = c.charCodeAt(0) % 16;
      return code.toString(16);
    })
    .join('');
  const padded = hexSeed.padEnd(40, '0').slice(0, 40);
  return padded as CommitHash;
}

function makeValidCommitInfo(overrides: Partial<CommitInfo> = {}): CommitInfo {
  const now = new Date();
  return {
    hash: makeCommitHash("commit1"),
    shortHash: "abc1234",
    subject: "feat: Add time-travel reconstruction API",
    body: "This commit adds the time-travel debugging capabilities.",
    authorName: "Test Author",
    authorEmail: "test@example.com",
    authorDate: now.toISOString(),
    committerName: "Test Committer",
    committerEmail: "committer@example.com",
    commitDate: now.toISOString(),
    parents: [makeCommitHash("parent1")],
    tags: ["v1.0.0"],
    branches: ["main"],
    ...overrides,
  };
}

function makeValidCommitRange(overrides: Partial<CommitRange> = {}): CommitRange {
  return {
    from: makeCommitHash("start"),
    to: makeCommitHash("end"),
    ...overrides,
  };
}

function makeValidSnapshotArtifactRef(overrides: Partial<SnapshotArtifactRef> = {}): SnapshotArtifactRef {
  return {
    hash: makeContentHash("artifact"),
    type: "trace",
    repoPath: "artifacts/traces/sensor-001.trace",
    size: 1024,
    ...overrides,
  };
}

function makeValidRealitySnapshot(overrides: Partial<RealitySnapshot> = {}): RealitySnapshot {
  return {
    schemaVersion: "1.0.0",
    commit: makeValidCommitInfo(),
    reconstructedAt: new Date().toISOString(),
    reconstructionMs: 150,
    linux: {
      traces: [makeValidSnapshotArtifactRef({ type: "trace" })],
      sensors: [makeValidSnapshotArtifactRef({ type: "sensor", repoPath: "artifacts/sensors/temp-001.json" })],
      firmware: [],
      devices: [],
    },
    ethereum: {
      proofs: [makeValidSnapshotArtifactRef({ type: "proof", repoPath: "artifacts/proofs/zk-001.proof" })],
      oracles: [],
      merkleTrees: [],
      attestations: [],
    },
    agenticQe: {
      decisions: [makeValidSnapshotArtifactRef({ type: "decision", repoPath: "artifacts/decisions/dec-001.json" })],
      models: [],
      embeddings: [],
      evaluations: [],
    },
    summary: {
      totalArtifacts: 4,
      totalSizeBytes: 4096,
      byOrigin: { linux: 2, ethereum: 1, "agentic-qe": 1 },
      byType: { trace: 1, sensor: 1, proof: 1, decision: 1 },
      oldestArtifact: new Date(Date.now() - 86400000).toISOString(),
      newestArtifact: new Date().toISOString(),
    },
    ...overrides,
  };
}

function makeValidArtifactDiffEntry(overrides: Partial<ArtifactDiffEntry> = {}): ArtifactDiffEntry {
  return {
    changeType: "added",
    path: "artifacts/traces/new-trace.trace",
    hashB: makeContentHash("new"),
    artifactType: "trace",
    origin: "linux",
    sizeChange: 1024,
    description: "New trace file added",
    impact: "low",
    ...overrides,
  };
}

function makeValidRealityDiff(overrides: Partial<RealityDiff> = {}): RealityDiff {
  return {
    schemaVersion: "1.0.0",
    commitA: makeValidCommitInfo({ hash: makeCommitHash("commitA") }),
    commitB: makeValidCommitInfo({ hash: makeCommitHash("commitB") }),
    computedAt: new Date().toISOString(),
    computationMs: 200,
    changes: {
      linux: [makeValidArtifactDiffEntry()],
      ethereum: [],
      agenticQe: [makeValidArtifactDiffEntry({ origin: "agentic-qe", artifactType: "decision" })],
    },
    summary: {
      added: 2,
      removed: 0,
      modified: 0,
      total: 2,
      byOrigin: { linux: 1, ethereum: 0, agenticQe: 1 },
      sizeChange: 2048,
      impact: "low",
    },
    safetyImpact: {
      level: "low",
      affectedConstraints: [],
      requiresReview: false,
      safetyChanges: [],
    },
    ...overrides,
  };
}

function makeValidBisectStep(overrides: Partial<BisectStep> = {}): BisectStep {
  const base: BisectStep = {
    commit: makeValidCommitInfo(),
    status: "good",
    patternMatched: false,
    stepNumber: 1,
    remainingCommits: 10,
    reason: "Pattern does not match at this commit",
  };
  return { ...base, ...overrides };
}

function makeValidBisectResult(overrides: Partial<BisectResult> = {}): BisectResult {
  return {
    schemaVersion: "1.0.0",
    pattern: "*.trace",
    range: makeValidCommitRange(),
    foundCommit: makeValidCommitInfo(),
    steps: [
      makeValidBisectStep({ stepNumber: 1, status: "good" }),
      makeValidBisectStep({ stepNumber: 2, status: "bad", patternMatched: true }),
    ],
    success: true,
    commitsExamined: 2,
    totalCommits: 15,
    executedAt: new Date().toISOString(),
    durationMs: 500,
    matchingArtifacts: [makeValidSnapshotArtifactRef()],
    ...overrides,
  };
}

function makeValidReplayResult(overrides: Partial<ReplayResult> = {}): ReplayResult {
  const now = new Date();
  const base = {
    originalDecision: {
      id: makeContentHash("decision"),
      schemaVersion: "1.0.0",
      timestamp: now.toISOString(),
      agent: { id: "agent-001", name: "ops-agent", type: "OPS", version: "1.0.0" },
    },
    decisionId: makeContentHash("decision"),
    commit: makeValidCommitInfo(),
    snapshotHash: makeContentHash("snapshot"),
    replay: {
      success: true,
      outputMatches: true,
      confidenceDelta: 0.02,
      comparison: {
        decisionMatches: true,
        actionMatches: true,
        keyFactorsMatch: true,
        differences: [],
      },
    },
    metadata: {
      replayedAt: now.toISOString(),
      durationMs: 1500,
      reason: "Audit verification",
      replayModel: "gpt-4-turbo-2024-04-09",
    },
    inputArtifacts: [makeValidSnapshotArtifactRef()],
  };
  return { ...base, ...overrides } as ReplayResult;
}

// =============================================================================
// COMMIT HASH TESTS
// =============================================================================

describe("CommitHash Schema", () => {
  describe("validation", () => {
    it("accepts valid 40-character lowercase hex string", () => {
      const hash = makeCommitHash("valid");
      const result = commitHashSchema.safeParse(hash);
      expect(result.success).toBe(true);
    });

    it("accepts another valid hash", () => {
      const hash = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
      const result = commitHashSchema.safeParse(hash);
      expect(result.success).toBe(true);
    });

    it("rejects short hash", () => {
      const result = commitHashSchema.safeParse("abc123");
      expect(result.success).toBe(false);
    });

    it("rejects 64-character hash (SHA-256)", () => {
      const result = commitHashSchema.safeParse(makeContentHash("sha256"));
      expect(result.success).toBe(false);
    });

    it("rejects uppercase hex", () => {
      const uppercase = "ABCDEF1234567890".repeat(2) + "ABCDEF12";
      const result = commitHashSchema.safeParse(uppercase);
      expect(result.success).toBe(false);
    });

    it("rejects non-hex characters", () => {
      const invalid = "xyz12345678901234567890123456789012345678";
      const result = commitHashSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it("rejects empty string", () => {
      const result = commitHashSchema.safeParse("");
      expect(result.success).toBe(false);
    });
  });

  describe("validateCommitHash helper", () => {
    it("returns true for valid hash", () => {
      expect(validateCommitHash(makeCommitHash("valid"))).toBe(true);
    });

    it("returns false for invalid hash", () => {
      expect(validateCommitHash("invalid")).toBe(false);
      expect(validateCommitHash("")).toBe(false);
    });
  });
});

// =============================================================================
// COMMIT RANGE TESTS
// =============================================================================

describe("CommitRange Schema", () => {
  it("validates basic range", () => {
    const range = makeValidCommitRange();
    const result = commitRangeSchema.safeParse(range);
    expect(result.success).toBe(true);
  });

  it("validates range with paths", () => {
    const range = makeValidCommitRange({
      paths: ["artifacts/", "decisions/"],
    });
    const result = commitRangeSchema.safeParse(range);
    expect(result.success).toBe(true);
  });

  it("validates range with noMerges", () => {
    const range = makeValidCommitRange({
      noMerges: true,
    });
    const result = commitRangeSchema.safeParse(range);
    expect(result.success).toBe(true);
  });

  it("validates complete range", () => {
    const range = makeValidCommitRange({
      paths: ["src/"],
      noMerges: false,
    });
    const result = commitRangeSchema.safeParse(range);
    expect(result.success).toBe(true);
  });

  it("rejects invalid from hash", () => {
    const range = { from: "invalid", to: makeCommitHash("to") };
    const result = commitRangeSchema.safeParse(range);
    expect(result.success).toBe(false);
  });

  it("rejects invalid to hash", () => {
    const range = { from: makeCommitHash("from"), to: "invalid" };
    const result = commitRangeSchema.safeParse(range);
    expect(result.success).toBe(false);
  });

  it("rejects missing from", () => {
    const range = { to: makeCommitHash("to") };
    const result = commitRangeSchema.safeParse(range);
    expect(result.success).toBe(false);
  });

  describe("validateCommitRange helper", () => {
    it("returns valid result for correct range", () => {
      const range = makeValidCommitRange();
      const result = validateCommitRange(range);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.range).toEqual(range);
    });

    it("returns errors for invalid range", () => {
      const result = validateCommitRange({ from: "bad" });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});

// =============================================================================
// COMMIT INFO TESTS
// =============================================================================

describe("CommitInfo Schema", () => {
  it("validates complete commit info", () => {
    const info = makeValidCommitInfo();
    const result = commitInfoSchema.safeParse(info);
    expect(result.success).toBe(true);
  });

  it("validates minimal commit info", () => {
    const info: CommitInfo = {
      hash: makeCommitHash("hash"),
      shortHash: "abc1234",
      subject: "Test commit",
      authorName: "Test",
      authorEmail: "test@test.com",
      authorDate: new Date().toISOString(),
      committerName: "Test",
      committerEmail: "test@test.com",
      commitDate: new Date().toISOString(),
      parents: [],
    };
    const result = commitInfoSchema.safeParse(info);
    expect(result.success).toBe(true);
  });

  it("validates commit with multiple parents (merge)", () => {
    const info = makeValidCommitInfo({
      parents: [makeCommitHash("parent1"), makeCommitHash("parent2")],
    });
    const result = commitInfoSchema.safeParse(info);
    expect(result.success).toBe(true);
  });

  it("validates commit with no tags or branches", () => {
    const info = makeValidCommitInfo({
      tags: undefined,
      branches: undefined,
    });
    const result = commitInfoSchema.safeParse(info);
    expect(result.success).toBe(true);
  });

  it("rejects invalid hash", () => {
    const info = makeValidCommitInfo({ hash: "invalid" as CommitHash });
    const result = commitInfoSchema.safeParse(info);
    expect(result.success).toBe(false);
  });

  it("rejects invalid date format", () => {
    const info = makeValidCommitInfo({ authorDate: "not-a-date" });
    const result = commitInfoSchema.safeParse(info);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// SNAPSHOT ARTIFACT REF TESTS
// =============================================================================

describe("SnapshotArtifactRef Schema", () => {
  it("validates complete artifact ref", () => {
    const ref = makeValidSnapshotArtifactRef();
    const result = snapshotArtifactRefSchema.safeParse(ref);
    expect(result.success).toBe(true);
  });

  it("validates minimal artifact ref", () => {
    const ref: SnapshotArtifactRef = {
      hash: makeContentHash("hash"),
      type: "blob",
      size: 100,
    };
    const result = snapshotArtifactRefSchema.safeParse(ref);
    expect(result.success).toBe(true);
  });

  it("validates with hydrated artifact", () => {
    const ref = makeValidSnapshotArtifactRef({
      artifact: { id: makeContentHash("id"), someData: "test" },
    });
    const result = snapshotArtifactRefSchema.safeParse(ref);
    expect(result.success).toBe(true);
  });

  it("rejects invalid hash", () => {
    const ref = makeValidSnapshotArtifactRef({ hash: "invalid" as ContentHash });
    const result = snapshotArtifactRefSchema.safeParse(ref);
    expect(result.success).toBe(false);
  });

  it("rejects negative size", () => {
    const ref = makeValidSnapshotArtifactRef({ size: -1 });
    const result = snapshotArtifactRefSchema.safeParse(ref);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// REALITY SNAPSHOT TESTS
// =============================================================================

describe("RealitySnapshot Schema", () => {
  it("validates complete snapshot", () => {
    const snapshot = makeValidRealitySnapshot();
    const result = realitySnapshotSchema.safeParse(snapshot);
    expect(result.success).toBe(true);
  });

  it("validates snapshot with empty categories", () => {
    const snapshot = makeValidRealitySnapshot({
      linux: { traces: [], sensors: [], firmware: [], devices: [] },
      ethereum: { proofs: [], oracles: [], merkleTrees: [], attestations: [] },
      agenticQe: { decisions: [], models: [], embeddings: [], evaluations: [] },
      summary: {
        totalArtifacts: 0,
        totalSizeBytes: 0,
        byOrigin: {},
        byType: {},
      },
    });
    const result = realitySnapshotSchema.safeParse(snapshot);
    expect(result.success).toBe(true);
  });

  it("validates snapshot with twin", () => {
    const snapshot = makeValidRealitySnapshot({
      twin: {
        checkpoint: { id: makeContentHash("twin"), state: {} },
        branch: "main",
        checkpointHash: makeContentHash("twin"),
      },
    });
    const result = realitySnapshotSchema.safeParse(snapshot);
    expect(result.success).toBe(true);
  });

  it("validates snapshot with warnings", () => {
    const snapshot = makeValidRealitySnapshot({
      warnings: [
        { level: "warning", message: "Artifact not found", artifactHash: makeContentHash("missing") },
        { level: "error", message: "Corrupted file", path: "artifacts/bad.json" },
        { level: "info", message: "Reconstruction took longer than expected" },
      ],
    });
    const result = realitySnapshotSchema.safeParse(snapshot);
    expect(result.success).toBe(true);
  });

  it("enforces schema version", () => {
    const snapshot = makeValidRealitySnapshot({ schemaVersion: "2.0.0" as any });
    const result = realitySnapshotSchema.safeParse(snapshot);
    expect(result.success).toBe(false);
  });

  it("rejects negative reconstruction time", () => {
    const snapshot = makeValidRealitySnapshot({ reconstructionMs: -1 });
    const result = realitySnapshotSchema.safeParse(snapshot);
    expect(result.success).toBe(false);
  });

  describe("isRealitySnapshot type guard", () => {
    it("returns true for valid snapshot", () => {
      expect(isRealitySnapshot(makeValidRealitySnapshot())).toBe(true);
    });

    it("returns false for invalid snapshot", () => {
      expect(isRealitySnapshot(null)).toBe(false);
      expect(isRealitySnapshot(undefined)).toBe(false);
      expect(isRealitySnapshot({})).toBe(false);
      expect(isRealitySnapshot({ schemaVersion: "wrong" })).toBe(false);
    });
  });
});

// =============================================================================
// ARTIFACT DIFF ENTRY TESTS
// =============================================================================

describe("ArtifactDiffEntry Schema", () => {
  it("validates added entry", () => {
    const entry = makeValidArtifactDiffEntry({ changeType: "added", hashB: makeContentHash("new") });
    const result = artifactDiffEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it("validates removed entry", () => {
    const entry = makeValidArtifactDiffEntry({ 
      changeType: "removed", 
      hashA: makeContentHash("old"),
      hashB: undefined,
      sizeChange: -1024,
    });
    const result = artifactDiffEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it("validates modified entry", () => {
    const entry = makeValidArtifactDiffEntry({ 
      changeType: "modified", 
      hashA: makeContentHash("old"),
      hashB: makeContentHash("new"),
      sizeChange: 512,
    });
    const result = artifactDiffEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it("validates all origin types", () => {
    const origins: Array<"linux" | "ethereum" | "agentic-qe"> = ["linux", "ethereum", "agentic-qe"];
    for (const origin of origins) {
      const entry = makeValidArtifactDiffEntry({ origin });
      const result = artifactDiffEntrySchema.safeParse(entry);
      expect(result.success).toBe(true);
    }
  });

  it("validates all impact levels", () => {
    const impacts: Array<ArtifactDiffEntry["impact"]> = ["none", "low", "medium", "high", "critical"];
    for (const impact of impacts) {
      const entry = makeValidArtifactDiffEntry({ impact });
      const result = artifactDiffEntrySchema.safeParse(entry);
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid change type", () => {
    const entry = { ...makeValidArtifactDiffEntry(), changeType: "unknown" };
    const result = artifactDiffEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it("rejects invalid origin", () => {
    const entry = { ...makeValidArtifactDiffEntry(), origin: "unknown" };
    const result = artifactDiffEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// REALITY DIFF TESTS
// =============================================================================

describe("RealityDiff Schema", () => {
  it("validates complete diff", () => {
    const diff = makeValidRealityDiff();
    const result = realityDiffSchema.safeParse(diff);
    expect(result.success).toBe(true);
  });

  it("validates diff with empty changes", () => {
    const diff = makeValidRealityDiff({
      changes: { linux: [], ethereum: [], agenticQe: [] },
      summary: {
        added: 0,
        removed: 0,
        modified: 0,
        total: 0,
        byOrigin: { linux: 0, ethereum: 0, agenticQe: 0 },
        sizeChange: 0,
        impact: "none",
      },
    });
    const result = realityDiffSchema.safeParse(diff);
    expect(result.success).toBe(true);
  });

  it("validates diff with twin diff", () => {
    const diff = makeValidRealityDiff({
      twinDiff: {
        checkpointA: makeContentHash("twinA"),
        checkpointB: makeContentHash("twinB"),
        plcChanges: 5,
        topologyChanges: 2,
        safetyChanges: 1,
        calibrationChanges: 3,
        alarmChanges: 0,
      },
    });
    const result = realityDiffSchema.safeParse(diff);
    expect(result.success).toBe(true);
  });

  it("validates diff with warnings", () => {
    const diff = makeValidRealityDiff({
      warnings: ["Some artifacts could not be loaded", "LFS content missing"],
    });
    const result = realityDiffSchema.safeParse(diff);
    expect(result.success).toBe(true);
  });

  it("validates all impact levels in summary", () => {
    const impacts: Array<"none" | "low" | "medium" | "high" | "critical"> = ["none", "low", "medium", "high", "critical"];
    for (const impact of impacts) {
      const diff = makeValidRealityDiff({
        summary: { ...makeValidRealityDiff().summary, impact },
      });
      const result = realityDiffSchema.safeParse(diff);
      expect(result.success).toBe(true);
    }
  });

  it("validates safety impact with affected constraints", () => {
    const diff = makeValidRealityDiff({
      safetyImpact: {
        level: "high",
        affectedConstraints: ["pressure_limit", "temperature_max"],
        requiresReview: true,
        safetyChanges: [makeValidArtifactDiffEntry({ impact: "high" })],
      },
    });
    const result = realityDiffSchema.safeParse(diff);
    expect(result.success).toBe(true);
  });

  it("enforces schema version", () => {
    const diff = makeValidRealityDiff({ schemaVersion: "2.0.0" as any });
    const result = realityDiffSchema.safeParse(diff);
    expect(result.success).toBe(false);
  });

  describe("isRealityDiff type guard", () => {
    it("returns true for valid diff", () => {
      expect(isRealityDiff(makeValidRealityDiff())).toBe(true);
    });

    it("returns false for invalid diff", () => {
      expect(isRealityDiff(null)).toBe(false);
      expect(isRealityDiff({})).toBe(false);
    });
  });
});

// =============================================================================
// BISECT STEP TESTS
// =============================================================================

describe("BisectStep Schema", () => {
  it("validates complete step", () => {
    const step = makeValidBisectStep();
    const result = bisectStepSchema.safeParse(step);
    expect(result.success).toBe(true);
  });

  it("validates all status types", () => {
    const statuses: Array<"good" | "bad" | "skip" | "unknown"> = ["good", "bad", "skip", "unknown"];
    for (const status of statuses) {
      const step = makeValidBisectStep({ status });
      const result = bisectStepSchema.safeParse(step);
      expect(result.success).toBe(true);
    }
  });

  it("validates step with matching artifacts", () => {
    const step = makeValidBisectStep({
      status: "bad",
      patternMatched: true,
      matchingArtifacts: [
        makeValidSnapshotArtifactRef(),
        makeValidSnapshotArtifactRef({ hash: makeContentHash("second") }),
      ],
    });
    const result = bisectStepSchema.safeParse(step);
    expect(result.success).toBe(true);
  });

  it("rejects invalid status", () => {
    const step = { ...makeValidBisectStep(), status: "maybe" };
    const result = bisectStepSchema.safeParse(step);
    expect(result.success).toBe(false);
  });

  it("rejects non-positive step number", () => {
    const step = makeValidBisectStep({ stepNumber: 0 });
    const result = bisectStepSchema.safeParse(step);
    expect(result.success).toBe(false);
  });

  it("rejects negative remaining commits", () => {
    const step = makeValidBisectStep({ remainingCommits: -1 });
    const result = bisectStepSchema.safeParse(step);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// BISECT RESULT TESTS
// =============================================================================

describe("BisectResult Schema", () => {
  it("validates successful bisect result", () => {
    const result = makeValidBisectResult();
    const parseResult = bisectResultSchema.safeParse(result);
    expect(parseResult.success).toBe(true);
  });

  it("validates failed bisect result", () => {
    const result = makeValidBisectResult({
      success: false,
      foundCommit: undefined,
      matchingArtifacts: undefined,
      error: "Pattern never matched in the commit range",
    });
    const parseResult = bisectResultSchema.safeParse(result);
    expect(parseResult.success).toBe(true);
  });

  it("validates bisect with empty steps", () => {
    const result = makeValidBisectResult({
      steps: [],
      commitsExamined: 0,
      success: false,
      error: "No commits in range",
    });
    const parseResult = bisectResultSchema.safeParse(result);
    expect(parseResult.success).toBe(true);
  });

  it("validates bisect with many steps", () => {
    const steps: BisectStep[] = [];
    for (let i = 1; i <= 10; i++) {
      steps.push(makeValidBisectStep({
        stepNumber: i,
        remainingCommits: 100 - i * 10,
        status: i < 8 ? "good" : "bad",
        patternMatched: i >= 8,
      }));
    }
    const result = makeValidBisectResult({
      steps,
      commitsExamined: 10,
      totalCommits: 100,
    });
    const parseResult = bisectResultSchema.safeParse(result);
    expect(parseResult.success).toBe(true);
  });

  it("enforces schema version", () => {
    const result = makeValidBisectResult({ schemaVersion: "2.0.0" as any });
    const parseResult = bisectResultSchema.safeParse(result);
    expect(parseResult.success).toBe(false);
  });

  it("rejects negative duration", () => {
    const result = makeValidBisectResult({ durationMs: -1 });
    const parseResult = bisectResultSchema.safeParse(result);
    expect(parseResult.success).toBe(false);
  });

  describe("isBisectResult type guard", () => {
    it("returns true for valid result", () => {
      expect(isBisectResult(makeValidBisectResult())).toBe(true);
    });

    it("returns false for invalid result", () => {
      expect(isBisectResult(null)).toBe(false);
      expect(isBisectResult({})).toBe(false);
    });
  });
});

// =============================================================================
// REPLAY RESULT TESTS
// =============================================================================

describe("ReplayResult Schema", () => {
  it("validates successful replay", () => {
    const result = makeValidReplayResult();
    const parseResult = replayResultSchema.safeParse(result);
    expect(parseResult.success).toBe(true);
  });

  it("validates replay with differences", () => {
    const result = makeValidReplayResult({
      replay: {
        success: true,
        outputMatches: false,
        confidenceDelta: -0.15,
        comparison: {
          decisionMatches: false,
          actionMatches: true,
          keyFactorsMatch: false,
          differences: [
            "Original confidence: 0.85, Replayed confidence: 0.70",
            "Different key factors identified",
          ],
        },
      },
    });
    const parseResult = replayResultSchema.safeParse(result);
    expect(parseResult.success).toBe(true);
  });

  it("validates failed replay", () => {
    const result = makeValidReplayResult({
      replay: {
        success: false,
        outputMatches: false,
        confidenceDelta: 0,
        comparison: {
          decisionMatches: false,
          actionMatches: false,
          keyFactorsMatch: false,
          differences: [],
        },
      },
      errors: ["Input artifact not found: abc123", "Model invocation failed"],
    });
    const parseResult = replayResultSchema.safeParse(result);
    expect(parseResult.success).toBe(true);
  });

  it("validates replay without snapshot hash", () => {
    const result = makeValidReplayResult({
      snapshotHash: undefined,
    });
    const parseResult = replayResultSchema.safeParse(result);
    expect(parseResult.success).toBe(true);
  });

  it("validates replay with multiple input artifacts", () => {
    const result = makeValidReplayResult({
      inputArtifacts: [
        makeValidSnapshotArtifactRef({ type: "sensor" }),
        makeValidSnapshotArtifactRef({ type: "trace", hash: makeContentHash("trace") }),
        makeValidSnapshotArtifactRef({ type: "decision", hash: makeContentHash("prior") }),
      ],
    });
    const parseResult = replayResultSchema.safeParse(result);
    expect(parseResult.success).toBe(true);
  });

  it("rejects negative duration", () => {
    const result = makeValidReplayResult({
      metadata: {
        ...makeValidReplayResult().metadata,
        durationMs: -100,
      },
    });
    const parseResult = replayResultSchema.safeParse(result);
    expect(parseResult.success).toBe(false);
  });
});

// =============================================================================
// OPTIONS SCHEMA TESTS
// =============================================================================

describe("ReconstructOptions Schema", () => {
  it("validates empty options", () => {
    const result = reconstructOptionsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("validates complete options", () => {
    const options: ReconstructOptions = {
      origins: ["linux", "ethereum"],
      hydrateArtifacts: true,
      includeTwin: false,
      maxArtifactsPerCategory: 100,
      artifactTypes: ["trace", "sensor"],
      siteId: "site-001",
    };
    const result = reconstructOptionsSchema.safeParse(options);
    expect(result.success).toBe(true);
  });

  it("rejects invalid origin", () => {
    const options = { origins: ["invalid"] };
    const result = reconstructOptionsSchema.safeParse(options);
    expect(result.success).toBe(false);
  });

  it("rejects non-positive max artifacts", () => {
    const options = { maxArtifactsPerCategory: 0 };
    const result = reconstructOptionsSchema.safeParse(options);
    expect(result.success).toBe(false);
  });
});

describe("ReplayOptions Schema", () => {
  it("validates empty options", () => {
    const result = replayOptionsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("validates complete options", () => {
    const options: ReplayOptions = {
      model: "gpt-4-turbo",
      temperature: 0.5,
      useOriginalSeed: false,
      reason: "Audit verification",
      detailedComparison: true,
    };
    const result = replayOptionsSchema.safeParse(options);
    expect(result.success).toBe(true);
  });

  it("validates temperature bounds", () => {
    expect(replayOptionsSchema.safeParse({ temperature: 0 }).success).toBe(true);
    expect(replayOptionsSchema.safeParse({ temperature: 2 }).success).toBe(true);
    expect(replayOptionsSchema.safeParse({ temperature: -0.1 }).success).toBe(false);
    expect(replayOptionsSchema.safeParse({ temperature: 2.1 }).success).toBe(false);
  });
});

describe("DiffOptions Schema", () => {
  it("validates empty options", () => {
    const result = diffOptionsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("validates complete options", () => {
    const options: DiffOptions = {
      includeTwinDiff: true,
      computeSafetyImpact: true,
      origins: ["linux", "agentic-qe"],
      artifactTypes: ["decision", "proof"],
      paths: ["artifacts/", "twins/"],
    };
    const result = diffOptionsSchema.safeParse(options);
    expect(result.success).toBe(true);
  });
});

describe("BisectOptions Schema", () => {
  it("validates empty options", () => {
    const result = bisectOptionsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      // Check defaults
      expect(result.data.regex).toBe(false);
      expect(result.data.maxSteps).toBe(100);
    }
  });

  it("validates complete options", () => {
    const options: BisectOptions = {
      regex: true,
      maxSteps: 50,
      origin: "ethereum",
      artifactType: "proof",
      testFunction: "customTest",
    };
    const result = bisectOptionsSchema.safeParse(options);
    expect(result.success).toBe(true);
  });

  it("rejects invalid origin", () => {
    const options = { origin: "invalid" };
    const result = bisectOptionsSchema.safeParse(options);
    expect(result.success).toBe(false);
  });

  it("rejects non-positive maxSteps", () => {
    const options = { maxSteps: 0 };
    const result = bisectOptionsSchema.safeParse(options);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// EDGE CASES AND INTEGRATION SCENARIOS
// =============================================================================

describe("Edge Cases", () => {
  describe("Large data scenarios", () => {
    it("handles snapshot with many artifacts", () => {
      // Test with a moderate number of artifacts
      const manyArtifacts = Array.from({ length: 20 }, (_, i) =>
        makeValidSnapshotArtifactRef({ hash: makeContentHash(`artifact${i.toString().padStart(10, '0')}`) })
      );
      
      const snapshot = makeValidRealitySnapshot();
      snapshot.linux.traces = manyArtifacts.slice(0, 5);
      snapshot.linux.sensors = manyArtifacts.slice(5, 10);
      snapshot.ethereum.proofs = manyArtifacts.slice(10, 15);
      snapshot.agenticQe.decisions = manyArtifacts.slice(15, 20);
      snapshot.summary.totalArtifacts = 20;

      const result = realitySnapshotSchema.safeParse(snapshot);
      expect(result.success).toBe(true);
    });

    it("handles diff with many changes", () => {
      const manyChanges = Array.from({ length: 10 }, (_, i) =>
        makeValidArtifactDiffEntry({
          changeType: i % 3 === 0 ? "added" : i % 3 === 1 ? "removed" : "modified",
          path: `artifacts/file${i}.json`,
          hashB: makeContentHash(`file${i.toString().padStart(10, '0')}`),
        })
      );

      const diff = makeValidRealityDiff();
      diff.changes.linux = manyChanges.slice(0, 4);
      diff.changes.ethereum = manyChanges.slice(4, 7);
      diff.changes.agenticQe = manyChanges.slice(7, 10);

      const result = realityDiffSchema.safeParse(diff);
      expect(result.success).toBe(true);
    });

    it("handles bisect with multiple steps", () => {
      const steps = Array.from({ length: 5 }, (_, i) =>
        makeValidBisectStep({
          stepNumber: i + 1,
          remainingCommits: Math.max(0, 50 - i * 10),
          status: i < 4 ? "good" : "bad",
          commit: makeValidCommitInfo({ hash: makeCommitHash(`step${i.toString().padStart(10, '0')}`) }),
        })
      );

      const bisect = makeValidBisectResult();
      bisect.steps = steps;
      bisect.commitsExamined = 5;

      const result = bisectResultSchema.safeParse(bisect);
      expect(result.success).toBe(true);
    });
  });

  describe("Timestamp handling", () => {
    it("accepts standard ISO8601 format", () => {
      // Zod datetime() primarily expects standard ISO8601 with Z suffix
      const timestamp = "2024-01-15T10:30:00.000Z";
      const snapshot = makeValidRealitySnapshot({ reconstructedAt: timestamp });
      const result = realitySnapshotSchema.safeParse(snapshot);
      expect(result.success).toBe(true);
    });
  });

  describe("Cross-reference integrity", () => {
    it("diff commits match snapshot commits", () => {
      const commitA = makeValidCommitInfo({ 
        hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as CommitHash 
      });
      const commitB = makeValidCommitInfo({ 
        hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as CommitHash 
      });

      const diff = makeValidRealityDiff();
      diff.commitA = commitA;
      diff.commitB = commitB;

      const result = realityDiffSchema.safeParse(diff);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.commitA.hash).toBe(commitA.hash);
        expect(result.data.commitB.hash).toBe(commitB.hash);
      }
    });
  });
});
