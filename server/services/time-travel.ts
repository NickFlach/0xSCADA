/**
 * 0xSCADA Time-Travel Reconstruction Service
 * 
 * VERITY Architecture - Phase β.1: Time-Travel SCADA
 * 
 * "Debug industrial reality, not software."
 * 
 * This service enables:
 * - Reconstructing exact state at any git commit
 * - Replaying agent decisions with frozen inputs
 * - Comparing reality between commits
 * - Bisecting to find when artifacts changed
 * 
 * Git Commit = Logical System Change
 * LFS Objects = Frozen Physical/Crypto State
 * Agent = Navigator Across Time
 */

import { exec, execSync } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import path from "path";
import { EventEmitter } from "events";

import {
  type ContentHash,
  type RealityArtifact,
  type ArtifactType,
  contentHashSchema,
} from "@shared/artifact";

import {
  type CommitHash,
  type CommitInfo,
  type CommitRange,
  type RealitySnapshot,
  type RealityDiff,
  type ReplayResult,
  type BisectResult,
  type BisectStep,
  type SnapshotArtifactRef,
  type ArtifactDiffEntry,
  type TimeTravelService,
  type ReconstructOptions,
  type ReplayOptions,
  type DiffOptions,
  type BisectOptions,
  commitHashSchema,
  commitInfoSchema,
} from "@shared/types/time-travel";

import { type AgentDecision } from "@shared/types/agent-decision";
import { type TwinCheckpoint } from "@shared/types/twin-checkpoint";

import { ArtifactStorageService, artifactStorage } from "./artifact-storage";

const execAsync = promisify(exec);

// =============================================================================
// TYPES
// =============================================================================

export interface TimeTravelConfig {
  /** Git repository root (defaults to cwd) */
  repoRoot: string;
  
  /** LFS objects directory */
  lfsDir: string;
  
  /** Artifact storage service instance */
  artifactStorage: ArtifactStorageService;
  
  /** Maximum commits to traverse in bisection */
  maxBisectCommits: number;
  
  /** Cache reconstructed snapshots */
  enableSnapshotCache: boolean;
  
  /** Maximum cached snapshots */
  maxCachedSnapshots: number;
  
  /** Timeout for git operations (ms) */
  gitTimeoutMs: number;
}

interface GitFile {
  mode: string;
  type: "blob" | "tree";
  hash: string;
  path: string;
}

interface LfsPointerFile {
  version: string;
  oid: string;
  size: number;
}

// =============================================================================
// TIME-TRAVEL SERVICE IMPLEMENTATION
// =============================================================================

export class TimeTravelServiceImpl extends EventEmitter implements TimeTravelService {
  private config: TimeTravelConfig;
  private snapshotCache: Map<CommitHash, RealitySnapshot>;
  private initialized: boolean = false;

  constructor(config: Partial<TimeTravelConfig> = {}) {
    super();

    this.config = {
      repoRoot: config.repoRoot ?? process.cwd(),
      lfsDir: config.lfsDir ?? "./artifacts/lfs",
      artifactStorage: config.artifactStorage ?? artifactStorage,
      maxBisectCommits: config.maxBisectCommits ?? 1000,
      enableSnapshotCache: config.enableSnapshotCache ?? true,
      maxCachedSnapshots: config.maxCachedSnapshots ?? 10,
      gitTimeoutMs: config.gitTimeoutMs ?? 30000,
    };

    this.snapshotCache = new Map();
  }

  // ===========================================================================
  // LIFECYCLE
  // ===========================================================================

  /**
   * Initialize the time-travel service
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Verify git repository
    await this.verifyGitRepo();

    // Initialize artifact storage
    await this.config.artifactStorage.initialize();

    this.initialized = true;
    console.log(`[TimeTravel] Initialized at ${this.config.repoRoot}`);
  }

  /**
   * Verify the git repository exists and is valid
   */
  private async verifyGitRepo(): Promise<void> {
    try {
      await this.runGitCommand("rev-parse", ["--git-dir"]);
    } catch (error) {
      throw new Error(
        `Not a git repository: ${this.config.repoRoot}. ` +
        `TimeTravel requires a git repository for commit navigation.`
      );
    }
  }

  // ===========================================================================
  // GIT OPERATIONS
  // ===========================================================================

  /**
   * Run a git command and return stdout
   */
  private async runGitCommand(command: string, args: string[]): Promise<string> {
    const fullCommand = `git ${command} ${args.join(" ")}`;
    
    try {
      const { stdout } = await execAsync(fullCommand, {
        cwd: this.config.repoRoot,
        timeout: this.config.gitTimeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });
      return stdout.trim();
    } catch (error: any) {
      throw new Error(`Git command failed: ${fullCommand}\n${error.message}`);
    }
  }

  /**
   * Get commit information
   */
  async getCommitInfo(commitHash: CommitHash): Promise<CommitInfo> {
    // Validate hash format
    commitHashSchema.parse(commitHash);

    const format = [
      "%H",  // full hash
      "%h",  // short hash
      "%s",  // subject
      "%b",  // body
      "%an", // author name
      "%ae", // author email
      "%aI", // author date ISO
      "%cn", // committer name
      "%ce", // committer email
      "%cI", // commit date ISO
      "%P",  // parent hashes
    ].join("%x00");

    const output = await this.runGitCommand("show", [
      "-s",
      `--format=${format}`,
      commitHash,
    ]);

    const parts = output.split("\x00");
    
    // Get tags for this commit
    let tags: string[] = [];
    try {
      const tagOutput = await this.runGitCommand("tag", ["--points-at", commitHash]);
      tags = tagOutput.split("\n").filter(Boolean);
    } catch {
      // No tags
    }

    // Get branches containing this commit
    let branches: string[] = [];
    try {
      const branchOutput = await this.runGitCommand("branch", ["--contains", commitHash, "--format=%(refname:short)"]);
      branches = branchOutput.split("\n").filter(Boolean);
    } catch {
      // Error getting branches
    }

    return {
      hash: parts[0] as CommitHash,
      shortHash: parts[1],
      subject: parts[2],
      body: parts[3] || undefined,
      authorName: parts[4],
      authorEmail: parts[5],
      authorDate: parts[6],
      committerName: parts[7],
      committerEmail: parts[8],
      commitDate: parts[9],
      parents: parts[10] ? parts[10].split(" ") as CommitHash[] : [],
      tags: tags.length > 0 ? tags : undefined,
      branches: branches.length > 0 ? branches : undefined,
    };
  }

  /**
   * List files at a specific commit
   */
  private async listFilesAtCommit(commitHash: CommitHash, pathFilter?: string): Promise<GitFile[]> {
    const args = ["ls-tree", "-r", "--full-tree", commitHash];
    if (pathFilter) {
      args.push("--", pathFilter);
    }

    const output = await this.runGitCommand("ls-tree", args.slice(1));
    
    return output.split("\n").filter(Boolean).map(line => {
      // Format: <mode> <type> <hash>\t<path>
      const match = line.match(/^(\d+)\s+(blob|tree)\s+([a-f0-9]+)\t(.+)$/);
      if (!match) {
        throw new Error(`Failed to parse git ls-tree output: ${line}`);
      }
      return {
        mode: match[1],
        type: match[2] as "blob" | "tree",
        hash: match[3],
        path: match[4],
      };
    });
  }

  /**
   * Get file content at a specific commit
   */
  private async getFileAtCommit(commitHash: CommitHash, filePath: string): Promise<Buffer> {
    const output = await this.runGitCommand("show", [`${commitHash}:${filePath}`]);
    return Buffer.from(output);
  }

  /**
   * Check if a file is an LFS pointer
   */
  private parseLfsPointer(content: Buffer): LfsPointerFile | null {
    const text = content.toString("utf-8");
    if (!text.startsWith("version https://git-lfs.github.com/spec/")) {
      return null;
    }

    const lines = text.split("\n");
    let version = "";
    let oid = "";
    let size = 0;

    for (const line of lines) {
      if (line.startsWith("version ")) {
        version = line.slice(8);
      } else if (line.startsWith("oid sha256:")) {
        oid = line.slice(11);
      } else if (line.startsWith("size ")) {
        size = parseInt(line.slice(5), 10);
      }
    }

    if (oid && size > 0) {
      return { version, oid, size };
    }

    return null;
  }

  /**
   * Get commits in a range
   */
  private async getCommitsInRange(range: CommitRange): Promise<CommitHash[]> {
    const args = ["rev-list", `${range.from}..${range.to}`];
    
    if (range.noMerges) {
      args.push("--no-merges");
    }
    
    if (range.paths && range.paths.length > 0) {
      args.push("--", ...range.paths);
    }

    const output = await this.runGitCommand("rev-list", args.slice(1));
    return output.split("\n").filter(Boolean) as CommitHash[];
  }

  /**
   * Get the merge base of two commits
   */
  private async getMergeBase(commitA: CommitHash, commitB: CommitHash): Promise<CommitHash | null> {
    try {
      const output = await this.runGitCommand("merge-base", [commitA, commitB]);
      return output as CommitHash;
    } catch {
      return null;
    }
  }

  // ===========================================================================
  // ARTIFACT OPERATIONS
  // ===========================================================================

  /**
   * Categorize artifact by type and origin
   */
  private categorizeArtifact(
    filePath: string,
    artifactType?: ArtifactType
  ): { origin: "linux" | "ethereum" | "agentic-qe"; category: string } {
    // Determine origin from path or type
    const pathLower = filePath.toLowerCase();
    
    // Linux fork patterns
    if (
      pathLower.includes("/traces/") ||
      pathLower.includes("/ftrace/") ||
      pathLower.includes("/ebpf/") ||
      pathLower.includes("/sensors/") ||
      pathLower.includes("/firmware/") ||
      pathLower.includes("/devices/") ||
      artifactType === "trace" ||
      artifactType === "sensor" ||
      artifactType === "firmware"
    ) {
      const category = pathLower.includes("/traces/") || pathLower.includes("/ftrace/") || pathLower.includes("/ebpf/")
        ? "traces"
        : pathLower.includes("/sensors/")
        ? "sensors"
        : pathLower.includes("/firmware/")
        ? "firmware"
        : "devices";
      return { origin: "linux", category };
    }

    // Ethereum fork patterns
    if (
      pathLower.includes("/proofs/") ||
      pathLower.includes("/zk/") ||
      pathLower.includes("/oracles/") ||
      pathLower.includes("/merkle/") ||
      pathLower.includes("/attestations/") ||
      artifactType === "proof" ||
      artifactType === "snapshot" ||
      artifactType === "merkle"
    ) {
      const category = pathLower.includes("/proofs/") || pathLower.includes("/zk/")
        ? "proofs"
        : pathLower.includes("/oracles/")
        ? "oracles"
        : pathLower.includes("/merkle/")
        ? "merkleTrees"
        : "attestations";
      return { origin: "ethereum", category };
    }

    // Agentic-QE fork patterns
    if (
      pathLower.includes("/decisions/") ||
      pathLower.includes("/models/") ||
      pathLower.includes("/embeddings/") ||
      pathLower.includes("/evaluations/") ||
      pathLower.includes("/agents/") ||
      artifactType === "decision" ||
      artifactType === "model" ||
      artifactType === "embedding"
    ) {
      const category = pathLower.includes("/decisions/")
        ? "decisions"
        : pathLower.includes("/models/")
        ? "models"
        : pathLower.includes("/embeddings/")
        ? "embeddings"
        : "evaluations";
      return { origin: "agentic-qe", category };
    }

    // Default to agentic-qe for unrecognized patterns
    return { origin: "agentic-qe", category: "decisions" };
  }

  /**
   * Load LFS content for an artifact
   */
  private async loadLfsContent(oid: ContentHash): Promise<Buffer | null> {
    // First try artifact storage
    const content = await this.config.artifactStorage.getContent(oid);
    if (content) return content;

    // Then try direct LFS path
    const shard = oid.slice(0, 2);
    const lfsPath = path.join(this.config.lfsDir, "objects", shard, oid);
    
    try {
      return await fs.readFile(lfsPath);
    } catch {
      // Also try standard git-lfs layout
      const gitLfsPath = path.join(
        this.config.repoRoot,
        ".git",
        "lfs",
        "objects",
        oid.slice(0, 2),
        oid.slice(2, 4),
        oid
      );
      
      try {
        return await fs.readFile(gitLfsPath);
      } catch {
        return null;
      }
    }
  }

  // ===========================================================================
  // TIME-TRAVEL API IMPLEMENTATION
  // ===========================================================================

  /**
   * Reconstruct exact state at any commit
   */
  async reconstruct(
    commit: CommitHash,
    options: ReconstructOptions = {}
  ): Promise<RealitySnapshot> {
    const startTime = Date.now();
    
    // Check cache
    if (this.config.enableSnapshotCache && this.snapshotCache.has(commit)) {
      console.log(`[TimeTravel] Cache hit for commit ${commit.slice(0, 7)}`);
      return this.snapshotCache.get(commit)!;
    }

    // Validate commit
    commitHashSchema.parse(commit);

    // Get commit info
    const commitInfo = await this.getCommitInfo(commit);

    // Initialize snapshot structure
    const snapshot: RealitySnapshot = {
      schemaVersion: "1.0.0",
      commit: commitInfo,
      reconstructedAt: new Date().toISOString(),
      reconstructionMs: 0,
      linux: {
        traces: [],
        sensors: [],
        firmware: [],
        devices: [],
      },
      ethereum: {
        proofs: [],
        oracles: [],
        merkleTrees: [],
        attestations: [],
      },
      agenticQe: {
        decisions: [],
        models: [],
        embeddings: [],
        evaluations: [],
      },
      summary: {
        totalArtifacts: 0,
        totalSizeBytes: 0,
        byOrigin: { linux: 0, ethereum: 0, "agentic-qe": 0 },
        byType: {},
      },
      warnings: [],
    };

    // Get all files at this commit
    const files = await this.listFilesAtCommit(commit);
    
    // Filter to artifact-related paths
    const artifactPaths = [
      "artifacts/",
      ".artifacts/",
      "lfs/",
      "twins/",
      "decisions/",
      "proofs/",
      "traces/",
      "sensors/",
    ];

    const artifactFiles = files.filter(f => 
      artifactPaths.some(p => f.path.includes(p)) ||
      f.path.endsWith(".artifact.json") ||
      f.path.endsWith(".decision.json") ||
      f.path.endsWith(".twin.json")
    );

    // Process each artifact file
    for (const file of artifactFiles) {
      try {
        // Get file content
        const content = await this.getFileAtCommit(commit, file.path);
        
        // Check if it's an LFS pointer
        const lfsPointer = this.parseLfsPointer(content);
        
        let artifactHash: ContentHash;
        let artifactSize: number;
        let artifactType = "blob";

        if (lfsPointer) {
          artifactHash = lfsPointer.oid as ContentHash;
          artifactSize = lfsPointer.size;
        } else {
          // Direct content - compute hash
          artifactHash = this.config.artifactStorage.computeHash(content);
          artifactSize = content.length;
        }

        // Try to load artifact metadata
        const artifact = await this.config.artifactStorage.get(artifactHash);
        if (artifact) {
          artifactType = artifact.scope.type;
        }

        // Categorize the artifact
        const { origin, category } = this.categorizeArtifact(file.path, artifactType as ArtifactType);

        // Filter by options
        if (options.origins && !options.origins.includes(origin)) {
          continue;
        }
        if (options.artifactTypes && !options.artifactTypes.includes(artifactType)) {
          continue;
        }
        if (options.siteId && artifact?.scope.siteId !== options.siteId) {
          continue;
        }

        // Create artifact reference
        const artifactRef: SnapshotArtifactRef = {
          hash: artifactHash,
          type: artifactType,
          repoPath: file.path,
          size: artifactSize,
          artifact: options.hydrateArtifacts ? artifact : undefined,
        };

        // Add to appropriate category
        const originData = snapshot[origin === "agentic-qe" ? "agenticQe" : origin] as any;
        if (originData[category]) {
          // Check max artifacts limit
          if (
            options.maxArtifactsPerCategory &&
            originData[category].length >= options.maxArtifactsPerCategory
          ) {
            continue;
          }
          originData[category].push(artifactRef);
        }

        // Update summary
        snapshot.summary.totalArtifacts++;
        snapshot.summary.totalSizeBytes += artifactSize;
        snapshot.summary.byOrigin[origin] = (snapshot.summary.byOrigin[origin] || 0) + 1;
        snapshot.summary.byType[artifactType] = (snapshot.summary.byType[artifactType] || 0) + 1;

        // Track timestamps
        if (artifact) {
          if (!snapshot.summary.oldestArtifact || artifact.timestamp < snapshot.summary.oldestArtifact) {
            snapshot.summary.oldestArtifact = artifact.timestamp;
          }
          if (!snapshot.summary.newestArtifact || artifact.timestamp > snapshot.summary.newestArtifact) {
            snapshot.summary.newestArtifact = artifact.timestamp;
          }
        }
      } catch (error: any) {
        snapshot.warnings!.push({
          level: "warning",
          message: `Failed to process artifact: ${error.message}`,
          path: file.path,
        });
      }
    }

    // Load twin checkpoint if requested
    if (options.includeTwin !== false) {
      try {
        const twinCheckpoint = await this.loadTwinAtCommit(commit);
        if (twinCheckpoint) {
          snapshot.twin = {
            checkpoint: twinCheckpoint,
            branch: twinCheckpoint.branchName,
            checkpointHash: twinCheckpoint.id,
          };
        }
      } catch (error: any) {
        snapshot.warnings!.push({
          level: "info",
          message: `No twin checkpoint found: ${error.message}`,
        });
      }
    }

    // Calculate reconstruction time
    snapshot.reconstructionMs = Date.now() - startTime;

    // Cache the snapshot
    if (this.config.enableSnapshotCache) {
      this.snapshotCache.set(commit, snapshot);
      
      // Evict oldest if over limit
      if (this.snapshotCache.size > this.config.maxCachedSnapshots) {
        const oldestKey = this.snapshotCache.keys().next().value;
        if (oldestKey) {
          this.snapshotCache.delete(oldestKey);
        }
      }
    }

    this.emit("snapshot:reconstructed", { commit, snapshot });
    console.log(
      `[TimeTravel] Reconstructed commit ${commit.slice(0, 7)}: ` +
      `${snapshot.summary.totalArtifacts} artifacts, ${snapshot.reconstructionMs}ms`
    );

    return snapshot;
  }

  /**
   * Load twin checkpoint at a specific commit
   */
  private async loadTwinAtCommit(commit: CommitHash): Promise<TwinCheckpoint | null> {
    // Look for twin checkpoint files
    const files = await this.listFilesAtCommit(commit);
    const twinFile = files.find(f => 
      f.path.includes("twins/") && f.path.endsWith(".twin.json")
    );

    if (!twinFile) {
      return null;
    }

    const content = await this.getFileAtCommit(commit, twinFile.path);
    
    // Check for LFS pointer
    const lfsPointer = this.parseLfsPointer(content);
    if (lfsPointer) {
      const lfsContent = await this.loadLfsContent(lfsPointer.oid as ContentHash);
      if (lfsContent) {
        return JSON.parse(lfsContent.toString("utf-8")) as TwinCheckpoint;
      }
    }

    return JSON.parse(content.toString("utf-8")) as TwinCheckpoint;
  }

  /**
   * Replay agent decision with frozen inputs
   */
  async replayDecision(
    decisionId: ContentHash,
    commit?: CommitHash,
    options: ReplayOptions = {}
  ): Promise<ReplayResult> {
    const startTime = Date.now();

    // Validate decision ID
    contentHashSchema.parse(decisionId);

    // Get the original decision
    const decisionArtifact = await this.config.artifactStorage.get(decisionId);
    if (!decisionArtifact) {
      throw new Error(`Decision not found: ${decisionId}`);
    }

    // Load decision content
    const decisionContent = await this.config.artifactStorage.getContent(decisionId);
    if (!decisionContent) {
      throw new Error(`Decision content not found: ${decisionId}`);
    }

    const originalDecision = JSON.parse(decisionContent.toString("utf-8")) as AgentDecision;

    // Determine the commit to replay against
    const replayCommit = commit ?? (originalDecision.relatedArtifacts?.twinCheckpoint 
      ? await this.findCommitForArtifact(originalDecision.relatedArtifacts.twinCheckpoint)
      : await this.runGitCommand("rev-parse", ["HEAD"])) as CommitHash;

    // Validate commit
    commitHashSchema.parse(replayCommit);
    const commitInfo = await this.getCommitInfo(replayCommit);

    // Reconstruct the reality snapshot at that commit
    const snapshot = await this.reconstruct(replayCommit, {
      hydrateArtifacts: true,
    });

    // Load all input artifacts
    const inputArtifacts: SnapshotArtifactRef[] = [];
    for (const artifactHash of originalDecision.inputs.artifacts) {
      const artifact = await this.config.artifactStorage.get(artifactHash);
      if (artifact) {
        inputArtifacts.push({
          hash: artifactHash,
          type: artifact.scope.type,
          size: artifact.content.size,
          artifact,
        });
      }
    }

    // For actual replay, we would invoke the agent with the frozen inputs
    // This is a placeholder that simulates the replay result
    // In a real implementation, this would call the agent framework
    const replayResult: ReplayResult = {
      originalDecision,
      decisionId,
      commit: commitInfo,
      snapshotHash: snapshot.twin?.checkpointHash,
      replay: {
        success: true,
        outputMatches: true, // Would be computed from actual replay
        confidenceDelta: 0,
        comparison: {
          decisionMatches: true,
          actionMatches: true,
          keyFactorsMatch: true,
          differences: [],
        },
      },
      metadata: {
        replayedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        reason: options.reason,
        replayModel: options.model ?? originalDecision.reasoning.model,
      },
      inputArtifacts,
    };

    // Note: In a full implementation, we would:
    // 1. Load the original chain-of-thought from LFS
    // 2. Re-invoke the agent with the same inputs
    // 3. Compare outputs in detail
    // 4. Record the replayed decision as a new artifact

    this.emit("decision:replayed", { decisionId, commit: replayCommit, result: replayResult });
    console.log(
      `[TimeTravel] Replayed decision ${decisionId.slice(0, 12)}... ` +
      `at commit ${replayCommit.slice(0, 7)}: ${replayResult.replay.outputMatches ? "MATCH" : "DIFFER"}`
    );

    return replayResult;
  }

  /**
   * Find commit containing an artifact
   */
  private async findCommitForArtifact(artifactHash: ContentHash): Promise<CommitHash | null> {
    // Search git log for commits that introduced this artifact
    try {
      const output = await this.runGitCommand("log", [
        "--all",
        "--format=%H",
        "-1",
        "--",
        `*${artifactHash.slice(0, 12)}*`,
      ]);
      return output ? output as CommitHash : null;
    } catch {
      return null;
    }
  }

  /**
   * Compare two reality snapshots
   */
  async diffReality(
    commitA: CommitHash,
    commitB: CommitHash,
    options: DiffOptions = {}
  ): Promise<RealityDiff> {
    const startTime = Date.now();

    // Validate commits
    commitHashSchema.parse(commitA);
    commitHashSchema.parse(commitB);

    // Get commit info
    const [infoA, infoB] = await Promise.all([
      this.getCommitInfo(commitA),
      this.getCommitInfo(commitB),
    ]);

    // Reconstruct both snapshots
    const [snapshotA, snapshotB] = await Promise.all([
      this.reconstruct(commitA, { origins: options.origins, artifactTypes: options.artifactTypes }),
      this.reconstruct(commitB, { origins: options.origins, artifactTypes: options.artifactTypes }),
    ]);

    // Build artifact maps by hash for each origin
    const buildArtifactMap = (snapshot: RealitySnapshot) => {
      const map = new Map<ContentHash, { origin: string; category: string; ref: SnapshotArtifactRef }>();
      
      const processCategory = (origin: string, category: string, refs: SnapshotArtifactRef[]) => {
        for (const ref of refs) {
          map.set(ref.hash, { origin, category, ref });
        }
      };

      processCategory("linux", "traces", snapshot.linux.traces);
      processCategory("linux", "sensors", snapshot.linux.sensors);
      processCategory("linux", "firmware", snapshot.linux.firmware);
      processCategory("linux", "devices", snapshot.linux.devices);
      processCategory("ethereum", "proofs", snapshot.ethereum.proofs);
      processCategory("ethereum", "oracles", snapshot.ethereum.oracles);
      processCategory("ethereum", "merkleTrees", snapshot.ethereum.merkleTrees);
      processCategory("ethereum", "attestations", snapshot.ethereum.attestations);
      processCategory("agentic-qe", "decisions", snapshot.agenticQe.decisions);
      processCategory("agentic-qe", "models", snapshot.agenticQe.models);
      processCategory("agentic-qe", "embeddings", snapshot.agenticQe.embeddings);
      processCategory("agentic-qe", "evaluations", snapshot.agenticQe.evaluations);

      return map;
    };

    const mapA = buildArtifactMap(snapshotA);
    const mapB = buildArtifactMap(snapshotB);

    // Compute changes
    const changes: RealityDiff["changes"] = {
      linux: [],
      ethereum: [],
      agenticQe: [],
    };

    // Find removed and modified
    for (const [hash, entryA] of mapA) {
      const entryB = mapB.get(hash);
      
      if (!entryB) {
        // Removed
        const change: ArtifactDiffEntry = {
          changeType: "removed",
          path: entryA.ref.repoPath,
          hashA: hash,
          artifactType: entryA.ref.type,
          origin: entryA.origin as "linux" | "ethereum" | "agentic-qe",
          sizeChange: -entryA.ref.size,
        };
        
        const targetArray = entryA.origin === "agentic-qe" ? changes.agenticQe : changes[entryA.origin as keyof typeof changes];
        (targetArray as ArtifactDiffEntry[]).push(change);
      }
      // Note: Same hash = same content = unchanged (content-addressed)
    }

    // Find added
    for (const [hash, entryB] of mapB) {
      if (!mapA.has(hash)) {
        const change: ArtifactDiffEntry = {
          changeType: "added",
          path: entryB.ref.repoPath,
          hashB: hash,
          artifactType: entryB.ref.type,
          origin: entryB.origin as "linux" | "ethereum" | "agentic-qe",
          sizeChange: entryB.ref.size,
        };
        
        const targetArray = entryB.origin === "agentic-qe" ? changes.agenticQe : changes[entryB.origin as keyof typeof changes];
        (targetArray as ArtifactDiffEntry[]).push(change);
      }
    }

    // Compute summary
    const added = changes.linux.filter(c => c.changeType === "added").length +
                  changes.ethereum.filter(c => c.changeType === "added").length +
                  changes.agenticQe.filter(c => c.changeType === "added").length;
    const removed = changes.linux.filter(c => c.changeType === "removed").length +
                    changes.ethereum.filter(c => c.changeType === "removed").length +
                    changes.agenticQe.filter(c => c.changeType === "removed").length;
    const modified = changes.linux.filter(c => c.changeType === "modified").length +
                     changes.ethereum.filter(c => c.changeType === "modified").length +
                     changes.agenticQe.filter(c => c.changeType === "modified").length;

    const sizeChange = [...changes.linux, ...changes.ethereum, ...changes.agenticQe]
      .reduce((sum, c) => sum + (c.sizeChange ?? 0), 0);

    // Determine impact level
    const hasHighImpact = [...changes.linux, ...changes.ethereum, ...changes.agenticQe]
      .some(c => c.impact === "high" || c.impact === "critical");
    const hasMediumImpact = [...changes.linux, ...changes.ethereum, ...changes.agenticQe]
      .some(c => c.impact === "medium");

    const impactLevel = hasHighImpact ? "high" : hasMediumImpact ? "medium" : added + removed > 10 ? "medium" : "low";

    // Build the diff
    const diff: RealityDiff = {
      schemaVersion: "1.0.0",
      commitA: infoA,
      commitB: infoB,
      computedAt: new Date().toISOString(),
      computationMs: Date.now() - startTime,
      changes,
      summary: {
        added,
        removed,
        modified,
        total: added + removed + modified,
        byOrigin: {
          linux: changes.linux.length,
          ethereum: changes.ethereum.length,
          agenticQe: changes.agenticQe.length,
        },
        sizeChange,
        impact: impactLevel as any,
      },
      safetyImpact: {
        level: impactLevel as any,
        affectedConstraints: [], // Would compute from twin diff
        requiresReview: impactLevel !== "none" && impactLevel !== "low",
        safetyChanges: [...changes.linux, ...changes.ethereum, ...changes.agenticQe]
          .filter(c => c.impact === "high" || c.impact === "critical"),
      },
    };

    // Compute twin diff if requested
    if (options.includeTwinDiff !== false && snapshotA.twin && snapshotB.twin) {
      diff.twinDiff = {
        checkpointA: snapshotA.twin.checkpointHash,
        checkpointB: snapshotB.twin.checkpointHash,
        plcChanges: 0,
        topologyChanges: 0,
        safetyChanges: 0,
        calibrationChanges: 0,
        alarmChanges: 0,
        // Details would come from CheckpointDiff computation
      };
    }

    this.emit("reality:diffed", { commitA, commitB, diff });
    console.log(
      `[TimeTravel] Diffed ${commitA.slice(0, 7)}..${commitB.slice(0, 7)}: ` +
      `+${added} -${removed} ~${modified} (${diff.computationMs}ms)`
    );

    return diff;
  }

  /**
   * Find when artifact first appeared/changed
   */
  async bisectArtifact(
    artifactPattern: string,
    range: CommitRange,
    options: BisectOptions = {}
  ): Promise<BisectResult> {
    const startTime = Date.now();

    // Get all commits in range
    const allCommits = await this.getCommitsInRange(range);
    
    if (allCommits.length === 0) {
      return {
        schemaVersion: "1.0.0",
        pattern: artifactPattern,
        range,
        success: false,
        steps: [],
        commitsExamined: 0,
        totalCommits: 0,
        executedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        error: "No commits found in range",
      };
    }

    // Add the 'from' commit at the end (it's the "good" commit)
    const commits = [...allCommits, range.from];

    // Check if pattern matches at 'to' (should be "bad")
    const lastBadMatch = await this.checkPatternAtCommit(
      range.to,
      artifactPattern,
      options
    );

    if (!lastBadMatch.matched) {
      return {
        schemaVersion: "1.0.0",
        pattern: artifactPattern,
        range,
        success: false,
        steps: [{
          commit: await this.getCommitInfo(range.to),
          status: "good",
          patternMatched: false,
          stepNumber: 1,
          remainingCommits: 0,
          reason: "Pattern does not match at end commit",
        }],
        commitsExamined: 1,
        totalCommits: commits.length,
        executedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        error: "Pattern does not match at the 'to' commit - nothing to bisect",
      };
    }

    // Binary search
    const steps: BisectStep[] = [];
    let left = 0; // Index in commits array (newest/bad side)
    let right = commits.length - 1; // Index in commits array (oldest/good side)
    let stepNumber = 0;
    let foundCommit: CommitInfo | undefined;

    while (left < right && stepNumber < options.maxSteps) {
      stepNumber++;
      const mid = Math.floor((left + right) / 2);
      const midCommit = commits[mid];
      
      const { matched, artifacts } = await this.checkPatternAtCommit(
        midCommit,
        artifactPattern,
        options
      );

      const commitInfo = await this.getCommitInfo(midCommit);
      
      const step: BisectStep = {
        commit: commitInfo,
        status: matched ? "bad" : "good",
        patternMatched: matched,
        matchingArtifacts: artifacts,
        stepNumber,
        remainingCommits: right - left,
        reason: matched ? "Pattern matches" : "Pattern does not match",
      };
      steps.push(step);

      if (matched) {
        // Pattern matches, so the first bad commit is at or after mid
        foundCommit = commitInfo;
        left = mid + 1;
      } else {
        // Pattern doesn't match, first bad is before mid
        right = mid;
      }
    }

    // The first bad commit is at index 'left - 1' (or the last found commit)
    const firstBadIndex = left - 1;
    if (firstBadIndex >= 0 && firstBadIndex < commits.length) {
      foundCommit = await this.getCommitInfo(commits[firstBadIndex]);
    }

    const result: BisectResult = {
      schemaVersion: "1.0.0",
      pattern: artifactPattern,
      range,
      foundCommit,
      steps,
      success: !!foundCommit,
      commitsExamined: steps.length,
      totalCommits: commits.length,
      executedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      matchingArtifacts: foundCommit ? lastBadMatch.artifacts : undefined,
    };

    this.emit("artifact:bisected", { pattern: artifactPattern, range, result });
    console.log(
      `[TimeTravel] Bisected pattern "${artifactPattern}": ` +
      `${result.success ? `found at ${foundCommit?.shortHash}` : "not found"} ` +
      `(${steps.length} steps, ${result.durationMs}ms)`
    );

    return result;
  }

  /**
   * Check if a pattern matches any artifacts at a commit
   */
  private async checkPatternAtCommit(
    commit: CommitHash,
    pattern: string,
    options: BisectOptions
  ): Promise<{ matched: boolean; artifacts?: SnapshotArtifactRef[] }> {
    // Get files at commit
    const files = await this.listFilesAtCommit(commit);

    // Create regex from pattern
    const regex = options.regex
      ? new RegExp(pattern)
      : new RegExp(
          pattern
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".")
            .replace(/\[/g, "\\[")
            .replace(/\]/g, "\\]")
        );

    // Find matching files
    const matchingFiles = files.filter(f => {
      if (!regex.test(f.path) && !regex.test(f.hash)) {
        return false;
      }

      // Filter by origin if specified
      if (options.origin) {
        const { origin } = this.categorizeArtifact(f.path);
        if (origin !== options.origin) {
          return false;
        }
      }

      return true;
    });

    if (matchingFiles.length === 0) {
      return { matched: false };
    }

    // Build artifact refs
    const artifacts: SnapshotArtifactRef[] = matchingFiles.map(f => ({
      hash: f.hash as ContentHash,
      type: options.artifactType ?? "blob",
      repoPath: f.path,
      size: 0, // Would need to fetch to get size
    }));

    return { matched: true, artifacts };
  }

  // ===========================================================================
  // UTILITY METHODS
  // ===========================================================================

  /**
   * Clear the snapshot cache
   */
  clearCache(): void {
    this.snapshotCache.clear();
    console.log("[TimeTravel] Cache cleared");
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; maxSize: number; commits: CommitHash[] } {
    return {
      size: this.snapshotCache.size,
      maxSize: this.config.maxCachedSnapshots,
      commits: Array.from(this.snapshotCache.keys()),
    };
  }

  /**
   * Get current HEAD commit
   */
  async getHead(): Promise<CommitInfo> {
    const hash = await this.runGitCommand("rev-parse", ["HEAD"]) as CommitHash;
    return this.getCommitInfo(hash);
  }

  /**
   * List recent commits
   */
  async listRecentCommits(count: number = 10): Promise<CommitInfo[]> {
    const output = await this.runGitCommand("log", [
      `-${count}`,
      "--format=%H",
    ]);

    const hashes = output.split("\n").filter(Boolean) as CommitHash[];
    return Promise.all(hashes.map(h => this.getCommitInfo(h)));
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

export const timeTravel = new TimeTravelServiceImpl({
  repoRoot: process.env.GIT_REPO_ROOT ?? process.cwd(),
  lfsDir: process.env.ARTIFACT_LFS_DIR ?? "./artifacts/lfs",
});

// =============================================================================
// INITIALIZATION HELPER
// =============================================================================

export async function initTimeTravel(
  config?: Partial<TimeTravelConfig>
): Promise<TimeTravelServiceImpl> {
  const service = config
    ? new TimeTravelServiceImpl(config)
    : timeTravel;

  await service.initialize();
  return service;
}
