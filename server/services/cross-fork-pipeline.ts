/**
 * 0xSCADA Cross-Fork Artifact Pipeline
 * 
 * VERITY Architecture - Phase α.2: Cross-Fork Artifact Pipeline
 * 
 * This service provides:
 * - Unified API for artifact ingestion from all three forks
 * - Cross-fork dependency linking
 * - Event emission for pipeline monitoring
 * - Artifact lineage tracking
 * 
 * "Artifacts are truth. Every decision must be replayable."
 * 
 * The Three Forks:
 * - Linux: Kernel traces, eBPF captures, sensor bursts, device states
 * - Ethereum: ZK proofs, oracle snapshots, Merkle diffs, contract traces
 * - Agentic-QE: Agent decisions, world models, embeddings, reasoning traces
 */

import { createHash } from "crypto";
import { EventEmitter } from "events";

import {
  type ContentHash,
  type RealityArtifact,
  type CreateArtifactInput,
  type ArtifactType,
  type OriginSystem,
  OriginSystem as OriginSystemEnum,
  ArtifactType as ArtifactTypeEnum,
} from "@shared/artifact";

import {
  type LinuxArtifactType,
  type LinuxArtifactMetadata,
  type KernelTrace,
  type SensorBurst,
  type FirmwareImage,
  type DeviceStateSnapshot,
  type CreateKernelTraceInput,
  type CreateSensorBurstInput,
  type CreateFirmwareImageInput,
  type CreateDeviceStateSnapshotInput,
  createKernelTraceInputSchema,
  createSensorBurstInputSchema,
  createFirmwareImageInputSchema,
  createDeviceStateSnapshotInputSchema,
  LinuxArtifactType as LinuxArtifactTypeEnum,
} from "@shared/linux-artifact";

import { ArtifactStorageService, artifactStorage } from "./artifact-storage";
import { ZKArtifactService, zkArtifactService, type StoredZKArtifact } from "./zk-artifact-service";

// =============================================================================
// TYPES
// =============================================================================

export interface CrossForkPipelineConfig {
  /** Enable cross-fork dependency validation */
  validateDependencies: boolean;
  
  /** Allow artifacts with missing dependencies (log warning instead of error) */
  allowMissingDependencies: boolean;
  
  /** Enable automatic dependency discovery */
  autoDiscoverDependencies: boolean;
  
  /** Maximum dependency chain depth to track */
  maxDependencyDepth: number;
  
  /** Enable event emission */
  emitEvents: boolean;
}

export interface StoredLinuxArtifact {
  artifact: RealityArtifact;
  linuxMetadata: LinuxArtifactMetadata;
}

export interface CrossForkDependency {
  /** The artifact that has the dependency */
  fromHash: ContentHash;
  fromFork: OriginSystem;
  
  /** The artifact being depended on */
  toHash: ContentHash;
  toFork: OriginSystem;
  
  /** Type of dependency relationship */
  relationship: DependencyRelationship;
  
  /** When the dependency was created */
  createdAt: Date;
}

export type DependencyRelationship =
  | "uses"           // Artifact uses another as input
  | "derived-from"   // Artifact is derived from another
  | "verifies"       // Artifact verifies another (proof -> witness)
  | "references"     // Artifact references another
  | "supersedes"     // Artifact supersedes another
  | "triggers";      // Artifact triggered creation of another

export interface PipelineStats {
  totalArtifacts: number;
  byFork: Record<OriginSystem, number>;
  byType: Record<string, number>;
  crossForkDependencies: number;
  lastIngestionAt?: Date;
  ingestionsPerMinute: number;
}

export interface ArtifactLineage {
  /** The root artifact */
  root: ContentHash;
  
  /** All artifacts in the lineage */
  artifacts: Map<ContentHash, { fork: OriginSystem; type: string }>;
  
  /** Dependencies between artifacts */
  dependencies: CrossForkDependency[];
  
  /** Depth of the lineage tree */
  depth: number;
}

// =============================================================================
// PIPELINE EVENTS
// =============================================================================

export interface PipelineEvents {
  /** Emitted when any artifact is ingested */
  "artifact:ingested": {
    hash: ContentHash;
    fork: OriginSystem;
    type: string;
    timestamp: Date;
  };
  
  /** Emitted when a Linux artifact is ingested */
  "linux:ingested": {
    hash: ContentHash;
    type: LinuxArtifactType;
    deviceId?: string;
    timestamp: Date;
  };
  
  /** Emitted when an Ethereum artifact is ingested */
  "ethereum:ingested": {
    hash: ContentHash;
    type: string;
    timestamp: Date;
  };
  
  /** Emitted when an Agentic-QE artifact is ingested */
  "agentic:ingested": {
    hash: ContentHash;
    type: string;
    agentId?: string;
    timestamp: Date;
  };
  
  /** Emitted when a cross-fork dependency is created */
  "dependency:created": CrossForkDependency;
  
  /** Emitted when a dependency validation fails */
  "dependency:missing": {
    fromHash: ContentHash;
    missingHash: ContentHash;
    timestamp: Date;
  };
  
  /** Emitted on pipeline errors */
  "pipeline:error": {
    error: Error;
    context: string;
    timestamp: Date;
  };
}

// =============================================================================
// CROSS-FORK ARTIFACT PIPELINE
// =============================================================================

export class CrossForkPipeline extends EventEmitter {
  private config: CrossForkPipelineConfig;
  private storage: ArtifactStorageService;
  private zkService: ZKArtifactService;
  
  /** Index of Linux artifacts */
  private linuxIndex: Map<ContentHash, StoredLinuxArtifact>;
  
  /** Index of Agentic-QE artifacts (decisions) */
  private agenticIndex: Map<ContentHash, RealityArtifact>;
  
  /** Cross-fork dependencies */
  private dependencies: CrossForkDependency[];
  
  /** Reverse dependency index: toHash -> fromHash[] */
  private reverseDependencyIndex: Map<ContentHash, ContentHash[]>;
  
  /** Stats tracking */
  private stats: {
    ingestionTimes: number[];
    lastStatsReset: Date;
  };

  constructor(
    config: Partial<CrossForkPipelineConfig> = {},
    storage?: ArtifactStorageService,
    zkService?: ZKArtifactService
  ) {
    super();
    
    this.config = {
      validateDependencies: config.validateDependencies ?? true,
      allowMissingDependencies: config.allowMissingDependencies ?? false,
      autoDiscoverDependencies: config.autoDiscoverDependencies ?? true,
      maxDependencyDepth: config.maxDependencyDepth ?? 100,
      emitEvents: config.emitEvents ?? true,
    };
    
    this.storage = storage ?? artifactStorage;
    this.zkService = zkService ?? zkArtifactService;
    
    this.linuxIndex = new Map();
    this.agenticIndex = new Map();
    this.dependencies = [];
    this.reverseDependencyIndex = new Map();
    this.stats = {
      ingestionTimes: [],
      lastStatsReset: new Date(),
    };
  }

  // ===========================================================================
  // UTILITY METHODS
  // ===========================================================================

  private computeHash(content: string | Buffer | Uint8Array): ContentHash {
    const buffer = typeof content === "string"
      ? Buffer.from(content, "utf-8")
      : Buffer.from(content);
    return createHash("sha256").update(buffer).digest("hex") as ContentHash;
  }

  private generateId(prefix: string): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `${prefix}-${timestamp}-${random}`;
  }

  private emit<K extends keyof PipelineEvents>(
    event: K,
    data: PipelineEvents[K]
  ): boolean {
    if (!this.config.emitEvents) return false;
    return super.emit(event, data);
  }

  private trackIngestion(): void {
    const now = Date.now();
    this.stats.ingestionTimes.push(now);
    
    // Keep only last minute of ingestion times
    const oneMinuteAgo = now - 60000;
    this.stats.ingestionTimes = this.stats.ingestionTimes.filter(t => t > oneMinuteAgo);
  }

  // ===========================================================================
  // DEPENDENCY MANAGEMENT
  // ===========================================================================

  /**
   * Add a cross-fork dependency
   */
  addDependency(
    fromHash: ContentHash,
    fromFork: OriginSystem,
    toHash: ContentHash,
    toFork: OriginSystem,
    relationship: DependencyRelationship
  ): CrossForkDependency {
    const dependency: CrossForkDependency = {
      fromHash,
      fromFork,
      toHash,
      toFork,
      relationship,
      createdAt: new Date(),
    };
    
    this.dependencies.push(dependency);
    
    // Update reverse index
    const existing = this.reverseDependencyIndex.get(toHash) ?? [];
    existing.push(fromHash);
    this.reverseDependencyIndex.set(toHash, existing);
    
    this.emit("dependency:created", dependency);
    
    return dependency;
  }

  /**
   * Validate that all dependencies exist
   */
  async validateDependencies(
    dependencies: ContentHash[]
  ): Promise<{ valid: boolean; missing: ContentHash[] }> {
    const missing: ContentHash[] = [];
    
    for (const dep of dependencies) {
      const exists = await this.artifactExists(dep);
      if (!exists) {
        missing.push(dep);
      }
    }
    
    return {
      valid: missing.length === 0,
      missing,
    };
  }

  /**
   * Check if an artifact exists in any fork
   */
  async artifactExists(hash: ContentHash): Promise<boolean> {
    // Check base storage
    if (await this.storage.exists(hash)) {
      return true;
    }
    
    // Check ZK service
    const zkArtifact = await this.zkService.get(hash);
    if (zkArtifact) {
      return true;
    }
    
    // Check local indices
    if (this.linuxIndex.has(hash)) {
      return true;
    }
    if (this.agenticIndex.has(hash)) {
      return true;
    }
    
    return false;
  }

  /**
   * Determine which fork an artifact belongs to
   */
  async getArtifactFork(hash: ContentHash): Promise<OriginSystem | null> {
    const artifact = await this.storage.get(hash);
    if (artifact) {
      return artifact.origin.system;
    }
    
    // Check ZK service (always Ethereum)
    const zkArtifact = await this.zkService.get(hash);
    if (zkArtifact) {
      return OriginSystemEnum.ETHEREUM;
    }
    
    // Check local indices
    if (this.linuxIndex.has(hash)) {
      return OriginSystemEnum.LINUX;
    }
    if (this.agenticIndex.has(hash)) {
      return OriginSystemEnum.AGENTIC_QE;
    }
    
    return null;
  }

  /**
   * Get all dependents of an artifact (artifacts that depend on it)
   */
  getDependents(hash: ContentHash): ContentHash[] {
    return this.reverseDependencyIndex.get(hash) ?? [];
  }

  /**
   * Get the full lineage of an artifact
   */
  async getArtifactLineage(hash: ContentHash): Promise<ArtifactLineage | null> {
    const fork = await this.getArtifactFork(hash);
    if (!fork) {
      return null;
    }
    
    const artifacts = new Map<ContentHash, { fork: OriginSystem; type: string }>();
    const lineageDeps: CrossForkDependency[] = [];
    const visited = new Set<ContentHash>();
    const queue: { hash: ContentHash; depth: number }[] = [{ hash, depth: 0 }];
    let maxDepth = 0;
    
    while (queue.length > 0 && visited.size < this.config.maxDependencyDepth) {
      const { hash: currentHash, depth } = queue.shift()!;
      
      if (visited.has(currentHash)) continue;
      visited.add(currentHash);
      maxDepth = Math.max(maxDepth, depth);
      
      // Get artifact info
      const artifact = await this.storage.get(currentHash);
      if (artifact) {
        artifacts.set(currentHash, {
          fork: artifact.origin.system,
          type: artifact.scope.type,
        });
        
        // Add direct dependencies to queue
        for (const dep of artifact.dependencies) {
          if (!visited.has(dep)) {
            queue.push({ hash: dep, depth: depth + 1 });
          }
        }
      }
      
      // Find cross-fork dependencies
      const crossForkDeps = this.dependencies.filter(
        d => d.fromHash === currentHash || d.toHash === currentHash
      );
      
      for (const dep of crossForkDeps) {
        lineageDeps.push(dep);
        
        // Add the other side of the dependency to queue
        const otherHash = dep.fromHash === currentHash ? dep.toHash : dep.fromHash;
        if (!visited.has(otherHash)) {
          queue.push({ hash: otherHash, depth: depth + 1 });
        }
      }
    }
    
    return {
      root: hash,
      artifacts,
      dependencies: lineageDeps,
      depth: maxDepth,
    };
  }

  // ===========================================================================
  // LINUX FORK INGESTION
  // ===========================================================================

  /**
   * Ingest a kernel trace artifact
   */
  async ingestKernelTrace(input: CreateKernelTraceInput): Promise<StoredLinuxArtifact> {
    const validated = createKernelTraceInputSchema.parse(input);
    
    // Compute raw trace hash
    const rawTraceBuffer = typeof validated.rawTrace === "string"
      ? Buffer.from(validated.rawTrace, "utf-8")
      : Buffer.from(validated.rawTrace);
    const rawTraceHash = this.computeHash(rawTraceBuffer);
    
    // Build trace metadata
    const trace: KernelTrace = {
      traceId: this.generateId("TRACE"),
      traceType: validated.traceType,
      capturedAt: new Date().toISOString(),
      durationMs: validated.durationMs,
      system: validated.system,
      config: validated.config,
      stats: {
        eventCount: 0, // Would be computed from actual trace parsing
        droppedEvents: 0,
        compressedSizeBytes: rawTraceBuffer.length,
        uncompressedSizeBytes: rawTraceBuffer.length,
      },
      rawTraceHash,
      deviceId: validated.deviceId,
      trigger: validated.trigger,
    };
    
    // Create artifact
    const artifactInput: CreateArtifactInput = {
      origin: {
        system: "linux",
        device: validated.deviceId,
      },
      scope: {
        type: "trace",
        siteId: validated.siteId,
        assetId: validated.assetId,
        metadata: {
          linuxType: LinuxArtifactTypeEnum.KERNEL_TRACE,
          trace,
        },
      },
      content: rawTraceBuffer,
      summary: `Kernel trace (${validated.traceType}) - ${validated.durationMs}ms`,
    };
    
    const artifact = await this.storage.store(artifactInput);
    
    const linuxMetadata: LinuxArtifactMetadata = {
      type: "kernel-trace",
      trace,
    };
    
    const stored: StoredLinuxArtifact = {
      artifact,
      linuxMetadata,
    };
    
    this.linuxIndex.set(artifact.id, stored);
    this.trackIngestion();
    
    this.emit("linux:ingested", {
      hash: artifact.id,
      type: LinuxArtifactTypeEnum.KERNEL_TRACE,
      deviceId: validated.deviceId,
      timestamp: new Date(),
    });
    
    this.emit("artifact:ingested", {
      hash: artifact.id,
      fork: OriginSystemEnum.LINUX,
      type: "kernel-trace",
      timestamp: new Date(),
    });
    
    console.log(`[CrossForkPipeline] Ingested kernel trace ${trace.traceId} (${artifact.id.slice(0, 12)}...)`);
    
    return stored;
  }

  /**
   * Ingest a sensor burst artifact
   */
  async ingestSensorBurst(input: CreateSensorBurstInput): Promise<StoredLinuxArtifact> {
    const validated = createSensorBurstInputSchema.parse(input);
    
    // Compute raw data hash
    const rawDataBuffer = typeof validated.rawData === "string"
      ? Buffer.from(validated.rawData, "utf-8")
      : Buffer.from(validated.rawData);
    const rawDataHash = this.computeHash(rawDataBuffer);
    
    // Compute sample count
    const sampleCount = validated.channels.reduce((sum, ch) => sum + ch.sampleCount, 0);
    
    // Build burst metadata
    const burst: SensorBurst = {
      burstId: this.generateId("BURST"),
      source: validated.source,
      startTime: validated.startTime,
      endTime: validated.endTime,
      sampleCount,
      sampleRateHz: validated.sampleRateHz,
      channels: validated.channels,
      rawDataHash,
      compression: {
        algorithm: "none",
        originalSizeBytes: rawDataBuffer.length,
        compressedSizeBytes: rawDataBuffer.length,
      },
      quality: validated.quality,
    };
    
    // Create artifact
    const artifactInput: CreateArtifactInput = {
      origin: {
        system: "linux",
        device: validated.source.deviceId,
      },
      scope: {
        type: "sensor",
        siteId: validated.siteId,
        assetId: validated.assetId,
        metadata: {
          linuxType: LinuxArtifactTypeEnum.SENSOR_BURST,
          burst,
        },
      },
      content: rawDataBuffer,
      summary: `Sensor burst from ${validated.source.deviceName ?? validated.source.deviceId} - ${sampleCount} samples`,
    };
    
    const artifact = await this.storage.store(artifactInput);
    
    const linuxMetadata: LinuxArtifactMetadata = {
      type: "sensor-burst",
      burst,
    };
    
    const stored: StoredLinuxArtifact = {
      artifact,
      linuxMetadata,
    };
    
    this.linuxIndex.set(artifact.id, stored);
    this.trackIngestion();
    
    this.emit("linux:ingested", {
      hash: artifact.id,
      type: LinuxArtifactTypeEnum.SENSOR_BURST,
      deviceId: validated.source.deviceId,
      timestamp: new Date(),
    });
    
    this.emit("artifact:ingested", {
      hash: artifact.id,
      fork: OriginSystemEnum.LINUX,
      type: "sensor-burst",
      timestamp: new Date(),
    });
    
    console.log(`[CrossForkPipeline] Ingested sensor burst ${burst.burstId} (${artifact.id.slice(0, 12)}...)`);
    
    return stored;
  }

  /**
   * Ingest a firmware image artifact
   */
  async ingestFirmwareImage(input: CreateFirmwareImageInput): Promise<StoredLinuxArtifact> {
    const validated = createFirmwareImageInputSchema.parse(input);
    
    // Compute binary hash
    const binaryBuffer = typeof validated.binary === "string"
      ? Buffer.from(validated.binary, "utf-8")
      : Buffer.from(validated.binary);
    const binaryHash = this.computeHash(binaryBuffer);
    
    // Build firmware metadata
    const firmware: FirmwareImage = {
      imageId: this.generateId("FW"),
      device: validated.device,
      version: validated.version,
      capturedAt: new Date().toISOString(),
      binaryHash,
      sizeBytes: binaryBuffer.length,
      format: validated.format,
      metadata: validated.metadata,
      previousVersionHash: validated.previousVersionHash,
    };
    
    // Set up dependencies
    const dependencies: ContentHash[] = [];
    if (validated.previousVersionHash) {
      dependencies.push(validated.previousVersionHash);
    }
    
    // Create artifact
    const artifactInput: CreateArtifactInput = {
      origin: {
        system: "linux",
        device: validated.device.deviceId,
      },
      scope: {
        type: "firmware",
        siteId: validated.siteId,
        assetId: validated.assetId,
        metadata: {
          linuxType: LinuxArtifactTypeEnum.FIRMWARE_IMAGE,
          firmware,
        },
      },
      content: binaryBuffer,
      dependencies,
      summary: `Firmware ${validated.version.versionString} for ${validated.device.deviceType}`,
    };
    
    const artifact = await this.storage.store(artifactInput);
    
    // Add cross-fork dependency if previous version exists
    if (validated.previousVersionHash) {
      this.addDependency(
        artifact.id,
        OriginSystemEnum.LINUX,
        validated.previousVersionHash,
        OriginSystemEnum.LINUX,
        "supersedes"
      );
    }
    
    const linuxMetadata: LinuxArtifactMetadata = {
      type: "firmware-image",
      firmware,
    };
    
    const stored: StoredLinuxArtifact = {
      artifact,
      linuxMetadata,
    };
    
    this.linuxIndex.set(artifact.id, stored);
    this.trackIngestion();
    
    this.emit("linux:ingested", {
      hash: artifact.id,
      type: LinuxArtifactTypeEnum.FIRMWARE_IMAGE,
      deviceId: validated.device.deviceId,
      timestamp: new Date(),
    });
    
    this.emit("artifact:ingested", {
      hash: artifact.id,
      fork: OriginSystemEnum.LINUX,
      type: "firmware-image",
      timestamp: new Date(),
    });
    
    console.log(`[CrossForkPipeline] Ingested firmware ${firmware.imageId} (${artifact.id.slice(0, 12)}...)`);
    
    return stored;
  }

  /**
   * Ingest a device state snapshot
   */
  async ingestDeviceState(input: CreateDeviceStateSnapshotInput): Promise<StoredLinuxArtifact> {
    const validated = createDeviceStateSnapshotInputSchema.parse(input);
    
    // Serialize state and compute hash
    const stateJson = JSON.stringify(validated.state);
    const stateBuffer = Buffer.from(stateJson, "utf-8");
    const stateHash = this.computeHash(stateBuffer);
    
    // Build snapshot metadata
    const snapshot: DeviceStateSnapshot = {
      snapshotId: this.generateId("STATE"),
      device: validated.device,
      capturedAt: new Date().toISOString(),
      state: validated.state,
      stateHash,
      previousSnapshotHash: validated.previousSnapshotHash,
    };
    
    // Set up dependencies
    const dependencies: ContentHash[] = [];
    if (validated.previousSnapshotHash) {
      dependencies.push(validated.previousSnapshotHash);
    }
    
    // Create artifact
    const artifactInput: CreateArtifactInput = {
      origin: {
        system: "linux",
        device: validated.device.deviceId,
      },
      scope: {
        type: "snapshot",
        siteId: validated.siteId,
        assetId: validated.assetId,
        metadata: {
          linuxType: LinuxArtifactTypeEnum.DEVICE_STATE,
          snapshot,
        },
      },
      content: stateBuffer,
      dependencies,
      summary: `Device state for ${validated.device.name ?? validated.device.deviceId}`,
    };
    
    const artifact = await this.storage.store(artifactInput);
    
    // Add dependency link if previous snapshot exists
    if (validated.previousSnapshotHash) {
      this.addDependency(
        artifact.id,
        OriginSystemEnum.LINUX,
        validated.previousSnapshotHash,
        OriginSystemEnum.LINUX,
        "derived-from"
      );
    }
    
    const linuxMetadata: LinuxArtifactMetadata = {
      type: "device-state",
      snapshot,
    };
    
    const stored: StoredLinuxArtifact = {
      artifact,
      linuxMetadata,
    };
    
    this.linuxIndex.set(artifact.id, stored);
    this.trackIngestion();
    
    this.emit("linux:ingested", {
      hash: artifact.id,
      type: LinuxArtifactTypeEnum.DEVICE_STATE,
      deviceId: validated.device.deviceId,
      timestamp: new Date(),
    });
    
    this.emit("artifact:ingested", {
      hash: artifact.id,
      fork: OriginSystemEnum.LINUX,
      type: "device-state",
      timestamp: new Date(),
    });
    
    console.log(`[CrossForkPipeline] Ingested device state ${snapshot.snapshotId} (${artifact.id.slice(0, 12)}...)`);
    
    return stored;
  }

  // ===========================================================================
  // AGENTIC-QE FORK INGESTION
  // ===========================================================================

  /**
   * Ingest an agent decision artifact
   */
  async ingestAgentDecision(
    decision: {
      agentId: string;
      agentName: string;
      siteId?: string;
      assetIds?: string[];
      inputArtifacts: ContentHash[];
      contextHash: ContentHash;
      constraintsHash: ContentHash;
      chainOfThoughtHash: ContentHash;
      model: string;
      temperature: number;
      tokens: number;
      decisionText: string;
      action?: unknown;
      confidence: number;
      automatedChecks?: unknown[];
      safetyScore?: number;
    }
  ): Promise<RealityArtifact> {
    // Validate dependencies
    const allDeps = [
      ...decision.inputArtifacts,
      decision.contextHash,
      decision.constraintsHash,
      decision.chainOfThoughtHash,
    ];
    
    if (this.config.validateDependencies) {
      const validation = await this.validateDependencies(allDeps);
      
      if (!validation.valid) {
        for (const missing of validation.missing) {
          this.emit("dependency:missing", {
            fromHash: "" as ContentHash, // Will be set after creation
            missingHash: missing,
            timestamp: new Date(),
          });
        }
        
        if (!this.config.allowMissingDependencies) {
          throw new Error(
            `Missing dependencies for agent decision: ${validation.missing.join(", ")}`
          );
        }
      }
    }
    
    // Build decision content
    const decisionContent = {
      agentId: decision.agentId,
      agentName: decision.agentName,
      timestamp: new Date().toISOString(),
      inputs: {
        artifacts: decision.inputArtifacts,
        context: decision.contextHash,
        constraints: decision.constraintsHash,
      },
      reasoning: {
        chainOfThought: decision.chainOfThoughtHash,
        model: decision.model,
        temperature: decision.temperature,
        tokens: decision.tokens,
      },
      output: {
        decision: decision.decisionText,
        action: decision.action,
        confidence: decision.confidence,
      },
      verification: {
        automatedChecks: decision.automatedChecks ?? [],
        safetyScore: decision.safetyScore ?? 0,
      },
    };
    
    const contentJson = JSON.stringify(decisionContent, null, 2);
    
    // Create artifact
    const artifactInput: CreateArtifactInput = {
      origin: {
        system: "agentic-qe",
        agent: decision.agentId,
      },
      scope: {
        type: "decision",
        siteId: decision.siteId,
        metadata: {
          agentDecision: decisionContent,
        },
        tags: decision.assetIds,
      },
      content: contentJson,
      dependencies: allDeps,
      summary: `Agent decision by ${decision.agentName}: ${decision.decisionText.slice(0, 100)}...`,
    };
    
    const artifact = await this.storage.store(artifactInput);
    
    // Add cross-fork dependencies
    for (const inputHash of decision.inputArtifacts) {
      const fork = await this.getArtifactFork(inputHash);
      if (fork && fork !== OriginSystemEnum.AGENTIC_QE) {
        this.addDependency(
          artifact.id,
          OriginSystemEnum.AGENTIC_QE,
          inputHash,
          fork,
          "uses"
        );
      }
    }
    
    this.agenticIndex.set(artifact.id, artifact);
    this.trackIngestion();
    
    this.emit("agentic:ingested", {
      hash: artifact.id,
      type: "decision",
      agentId: decision.agentId,
      timestamp: new Date(),
    });
    
    this.emit("artifact:ingested", {
      hash: artifact.id,
      fork: OriginSystemEnum.AGENTIC_QE,
      type: "decision",
      timestamp: new Date(),
    });
    
    console.log(`[CrossForkPipeline] Ingested agent decision (${artifact.id.slice(0, 12)}...)`);
    
    return artifact;
  }

  /**
   * Ingest a world model artifact
   */
  async ingestWorldModel(
    worldModel: {
      agentId: string;
      modelType: string;
      version: string;
      inputArtifacts: ContentHash[];
      modelData: string | Buffer | Uint8Array;
      metadata?: Record<string, unknown>;
      siteId?: string;
    }
  ): Promise<RealityArtifact> {
    const modelBuffer = typeof worldModel.modelData === "string"
      ? Buffer.from(worldModel.modelData, "utf-8")
      : Buffer.from(worldModel.modelData);
    
    const artifactInput: CreateArtifactInput = {
      origin: {
        system: "agentic-qe",
        agent: worldModel.agentId,
      },
      scope: {
        type: "model",
        siteId: worldModel.siteId,
        metadata: {
          modelType: worldModel.modelType,
          version: worldModel.version,
          ...(worldModel.metadata ?? {}),
        },
      },
      content: modelBuffer,
      dependencies: worldModel.inputArtifacts,
      summary: `World model (${worldModel.modelType}) v${worldModel.version}`,
    };
    
    const artifact = await this.storage.store(artifactInput);
    
    // Link cross-fork dependencies
    for (const inputHash of worldModel.inputArtifacts) {
      const fork = await this.getArtifactFork(inputHash);
      if (fork && fork !== OriginSystemEnum.AGENTIC_QE) {
        this.addDependency(
          artifact.id,
          OriginSystemEnum.AGENTIC_QE,
          inputHash,
          fork,
          "derived-from"
        );
      }
    }
    
    this.agenticIndex.set(artifact.id, artifact);
    this.trackIngestion();
    
    this.emit("agentic:ingested", {
      hash: artifact.id,
      type: "model",
      agentId: worldModel.agentId,
      timestamp: new Date(),
    });
    
    this.emit("artifact:ingested", {
      hash: artifact.id,
      fork: OriginSystemEnum.AGENTIC_QE,
      type: "model",
      timestamp: new Date(),
    });
    
    console.log(`[CrossForkPipeline] Ingested world model (${artifact.id.slice(0, 12)}...)`);
    
    return artifact;
  }

  /**
   * Ingest an embedding artifact
   */
  async ingestEmbedding(
    embedding: {
      agentId: string;
      sourceArtifacts: ContentHash[];
      modelName: string;
      dimensions: number;
      embeddingData: string | Buffer | Uint8Array;
      metadata?: Record<string, unknown>;
      siteId?: string;
    }
  ): Promise<RealityArtifact> {
    const embeddingBuffer = typeof embedding.embeddingData === "string"
      ? Buffer.from(embedding.embeddingData, "utf-8")
      : Buffer.from(embedding.embeddingData);
    
    const artifactInput: CreateArtifactInput = {
      origin: {
        system: "agentic-qe",
        agent: embedding.agentId,
      },
      scope: {
        type: "embedding",
        siteId: embedding.siteId,
        metadata: {
          modelName: embedding.modelName,
          dimensions: embedding.dimensions,
          ...(embedding.metadata ?? {}),
        },
      },
      content: embeddingBuffer,
      dependencies: embedding.sourceArtifacts,
      summary: `Embedding (${embedding.modelName}, ${embedding.dimensions}d) from ${embedding.sourceArtifacts.length} sources`,
    };
    
    const artifact = await this.storage.store(artifactInput);
    
    // Link cross-fork dependencies
    for (const sourceHash of embedding.sourceArtifacts) {
      const fork = await this.getArtifactFork(sourceHash);
      if (fork) {
        this.addDependency(
          artifact.id,
          OriginSystemEnum.AGENTIC_QE,
          sourceHash,
          fork,
          "derived-from"
        );
      }
    }
    
    this.agenticIndex.set(artifact.id, artifact);
    this.trackIngestion();
    
    this.emit("agentic:ingested", {
      hash: artifact.id,
      type: "embedding",
      agentId: embedding.agentId,
      timestamp: new Date(),
    });
    
    this.emit("artifact:ingested", {
      hash: artifact.id,
      fork: OriginSystemEnum.AGENTIC_QE,
      type: "embedding",
      timestamp: new Date(),
    });
    
    console.log(`[CrossForkPipeline] Ingested embedding (${artifact.id.slice(0, 12)}...)`);
    
    return artifact;
  }

  // ===========================================================================
  // CROSS-FORK LINKING
  // ===========================================================================

  /**
   * Link a ZK proof to a Linux trace (proof verifies the trace)
   */
  linkProofToTrace(proofHash: ContentHash, traceHash: ContentHash): CrossForkDependency {
    return this.addDependency(
      proofHash,
      OriginSystemEnum.ETHEREUM,
      traceHash,
      OriginSystemEnum.LINUX,
      "verifies"
    );
  }

  /**
   * Link an agent decision to ZK proofs it used
   */
  linkDecisionToProofs(decisionHash: ContentHash, proofHashes: ContentHash[]): CrossForkDependency[] {
    return proofHashes.map(proofHash =>
      this.addDependency(
        decisionHash,
        OriginSystemEnum.AGENTIC_QE,
        proofHash,
        OriginSystemEnum.ETHEREUM,
        "uses"
      )
    );
  }

  /**
   * Link an agent decision to Linux traces it analyzed
   */
  linkDecisionToTraces(decisionHash: ContentHash, traceHashes: ContentHash[]): CrossForkDependency[] {
    return traceHashes.map(traceHash =>
      this.addDependency(
        decisionHash,
        OriginSystemEnum.AGENTIC_QE,
        traceHash,
        OriginSystemEnum.LINUX,
        "uses"
      )
    );
  }

  /**
   * Link a ZK proof to an oracle snapshot it uses
   */
  linkProofToOracleSnapshot(proofHash: ContentHash, snapshotHash: ContentHash): CrossForkDependency {
    return this.addDependency(
      proofHash,
      OriginSystemEnum.ETHEREUM,
      snapshotHash,
      OriginSystemEnum.ETHEREUM,
      "uses"
    );
  }

  // ===========================================================================
  // RETRIEVAL
  // ===========================================================================

  /**
   * Get a Linux artifact by hash
   */
  async getLinuxArtifact(hash: ContentHash): Promise<StoredLinuxArtifact | null> {
    // Check local index first
    const indexed = this.linuxIndex.get(hash);
    if (indexed) {
      return indexed;
    }
    
    // Try loading from base storage
    const artifact = await this.storage.get(hash);
    if (!artifact || artifact.origin.system !== "linux") {
      return null;
    }
    
    const linuxType = artifact.scope.metadata?.linuxType;
    if (!linuxType) {
      return null;
    }
    
    const stored: StoredLinuxArtifact = {
      artifact,
      linuxMetadata: artifact.scope.metadata as unknown as LinuxArtifactMetadata,
    };
    
    this.linuxIndex.set(hash, stored);
    return stored;
  }

  /**
   * Get an Agentic-QE artifact by hash
   */
  async getAgenticArtifact(hash: ContentHash): Promise<RealityArtifact | null> {
    // Check local index first
    const indexed = this.agenticIndex.get(hash);
    if (indexed) {
      return indexed;
    }
    
    // Try loading from base storage
    const artifact = await this.storage.get(hash);
    if (!artifact || artifact.origin.system !== "agentic-qe") {
      return null;
    }
    
    this.agenticIndex.set(hash, artifact);
    return artifact;
  }

  /**
   * Get any artifact by hash (unified access)
   */
  async getArtifact(hash: ContentHash): Promise<RealityArtifact | null> {
    return this.storage.get(hash);
  }

  /**
   * Query artifacts across all forks
   */
  async queryArtifacts(options: {
    fork?: OriginSystem;
    type?: string;
    siteId?: string;
    assetId?: string;
    deviceId?: string;
    agentId?: string;
    fromTimestamp?: string;
    toTimestamp?: string;
    limit?: number;
  }): Promise<RealityArtifact[]> {
    return this.storage.query({
      system: options.fork,
      type: options.type as ArtifactType,
      siteId: options.siteId,
      assetId: options.assetId,
      agentId: options.agentId,
      fromTimestamp: options.fromTimestamp,
      toTimestamp: options.toTimestamp,
      limit: options.limit,
    });
  }

  // ===========================================================================
  // STATISTICS
  // ===========================================================================

  /**
   * Get pipeline statistics
   */
  async getStats(): Promise<PipelineStats> {
    const storageStats = await this.storage.getStats();
    
    // Count by fork from storage
    const byFork: Record<OriginSystem, number> = {
      linux: storageStats.bySystem?.linux ?? 0,
      ethereum: storageStats.bySystem?.ethereum ?? 0,
      "agentic-qe": storageStats.bySystem?.["agentic-qe"] ?? 0,
    };
    
    // Add local indices
    byFork.linux += this.linuxIndex.size;
    byFork["agentic-qe"] += this.agenticIndex.size;
    
    return {
      totalArtifacts: storageStats.totalArtifacts,
      byFork,
      byType: storageStats.byType,
      crossForkDependencies: this.dependencies.length,
      lastIngestionAt: this.stats.ingestionTimes.length > 0
        ? new Date(Math.max(...this.stats.ingestionTimes))
        : undefined,
      ingestionsPerMinute: this.stats.ingestionTimes.length,
    };
  }

  /**
   * Get cross-fork dependency statistics
   */
  getDependencyStats(): {
    total: number;
    byRelationship: Record<DependencyRelationship, number>;
    crossForkCount: number;
    sameForkCount: number;
  } {
    const byRelationship: Record<DependencyRelationship, number> = {
      uses: 0,
      "derived-from": 0,
      verifies: 0,
      references: 0,
      supersedes: 0,
      triggers: 0,
    };
    
    let crossForkCount = 0;
    let sameForkCount = 0;
    
    for (const dep of this.dependencies) {
      byRelationship[dep.relationship]++;
      
      if (dep.fromFork !== dep.toFork) {
        crossForkCount++;
      } else {
        sameForkCount++;
      }
    }
    
    return {
      total: this.dependencies.length,
      byRelationship,
      crossForkCount,
      sameForkCount,
    };
  }

  // ===========================================================================
  // LIFECYCLE
  // ===========================================================================

  /**
   * Initialize the pipeline
   */
  async initialize(): Promise<void> {
    await this.storage.initialize();
    console.log("[CrossForkPipeline] Initialized");
  }

  /**
   * Shutdown the pipeline
   */
  async shutdown(): Promise<void> {
    await this.zkService.shutdown();
    console.log("[CrossForkPipeline] Shutdown complete");
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

export const crossForkPipeline = new CrossForkPipeline({
  validateDependencies: process.env.PIPELINE_VALIDATE_DEPS !== "false",
  allowMissingDependencies: process.env.PIPELINE_ALLOW_MISSING_DEPS === "true",
  autoDiscoverDependencies: process.env.PIPELINE_AUTO_DISCOVER !== "false",
  maxDependencyDepth: parseInt(process.env.PIPELINE_MAX_DEPTH ?? "100"),
  emitEvents: process.env.PIPELINE_EMIT_EVENTS !== "false",
});

// =============================================================================
// INITIALIZATION HELPER
// =============================================================================

export async function initCrossForkPipeline(
  config?: Partial<CrossForkPipelineConfig>
): Promise<CrossForkPipeline> {
  const pipeline = config
    ? new CrossForkPipeline(config)
    : crossForkPipeline;
  
  await pipeline.initialize();
  return pipeline;
}
