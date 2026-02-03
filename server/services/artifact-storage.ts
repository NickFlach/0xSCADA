/**
 * 0xSCADA Artifact Storage Service
 * 
 * VERITY Architecture - Phase α.1: LFS Content-Addressed Artifact Storage
 * 
 * This service provides:
 * - Content-addressed storage using SHA-256 hashes
 * - LFS-compatible artifact storage
 * - Schema validation for all artifacts
 * - Dependency tracking between artifacts
 * - Query and retrieval by hash or metadata
 * 
 * "Artifacts are truth. Never overwrite evidence to satisfy intent."
 */

import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { EventEmitter } from "events";

import {
  type RealityArtifact,
  type ContentHash,
  type CreateArtifactInput,
  type ArtifactQuery,
  type ArtifactValidationResult,
  type ArtifactStorageStats,
  type ArtifactDependencyGraph,
  type ArtifactDependencyNode,
  type ArtifactType,
  type OriginSystem,
  type LFSPointer,
  realityArtifactSchema,
  createArtifactInputSchema,
  contentHashSchema,
} from "@shared/artifact";

// =============================================================================
// TYPES
// =============================================================================

export interface ArtifactStorageConfig {
  /** Base directory for LFS object storage */
  lfsDir: string;
  
  /** Enable in-memory index for fast lookups */
  enableIndex: boolean;
  
  /** Maximum content size (0 = unlimited) */
  maxContentSize: number;
  
  /** Enable content deduplication */
  enableDeduplication: boolean;
}

export interface StoredArtifactMetadata {
  artifact: RealityArtifact;
  storedAt: Date;
  accessCount: number;
  lastAccessedAt: Date;
}

// =============================================================================
// ARTIFACT STORAGE SERVICE
// =============================================================================

export class ArtifactStorageService extends EventEmitter {
  private config: ArtifactStorageConfig;
  
  /** In-memory index of artifacts (metadata only, not content) */
  private artifactIndex: Map<ContentHash, StoredArtifactMetadata>;
  
  /** Dependency graph: hash -> dependents (reverse lookup) */
  private dependentIndex: Map<ContentHash, Set<ContentHash>>;
  
  /** Initialization state */
  private initialized: boolean = false;

  constructor(config: Partial<ArtifactStorageConfig> = {}) {
    super();

    this.config = {
      lfsDir: config.lfsDir ?? "./artifacts/lfs",
      enableIndex: config.enableIndex ?? true,
      maxContentSize: config.maxContentSize ?? 0,
      enableDeduplication: config.enableDeduplication ?? true,
    };

    this.artifactIndex = new Map();
    this.dependentIndex = new Map();
  }

  // ===========================================================================
  // LIFECYCLE
  // ===========================================================================

  /**
   * Initialize the storage service
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Create LFS directory structure
    await this.ensureDirectoryStructure();

    // Load existing artifact index if enabled
    if (this.config.enableIndex) {
      await this.loadIndex();
    }

    this.initialized = true;
    console.log(`[ArtifactStorage] Initialized at ${this.config.lfsDir}`);
    console.log(`   Artifacts indexed: ${this.artifactIndex.size}`);
  }

  /**
   * Ensure the LFS directory structure exists
   */
  private async ensureDirectoryStructure(): Promise<void> {
    // Create objects directory with 256 subdirectories (00-ff)
    const objectsDir = path.join(this.config.lfsDir, "objects");
    await fs.mkdir(objectsDir, { recursive: true });

    // Create metadata directory
    const metadataDir = path.join(this.config.lfsDir, "metadata");
    await fs.mkdir(metadataDir, { recursive: true });

    // Create 256 sharded directories for content-addressed storage
    for (let i = 0; i < 256; i++) {
      const shardDir = path.join(objectsDir, i.toString(16).padStart(2, "0"));
      await fs.mkdir(shardDir, { recursive: true });
    }
  }

  /**
   * Load artifact index from disk
   */
  private async loadIndex(): Promise<void> {
    const indexFile = path.join(this.config.lfsDir, "metadata", "index.json");
    
    try {
      const data = await fs.readFile(indexFile, "utf-8");
      const parsed = JSON.parse(data) as Array<{ hash: string; metadata: StoredArtifactMetadata }>;
      
      for (const { hash, metadata } of parsed) {
        // Rehydrate dates
        metadata.storedAt = new Date(metadata.storedAt);
        metadata.lastAccessedAt = new Date(metadata.lastAccessedAt);
        
        this.artifactIndex.set(hash as ContentHash, metadata);
        
        // Rebuild dependent index
        for (const dep of metadata.artifact.dependencies) {
          if (!this.dependentIndex.has(dep)) {
            this.dependentIndex.set(dep, new Set());
          }
          this.dependentIndex.get(dep)!.add(hash as ContentHash);
        }
      }
    } catch (error: any) {
      if (error.code !== "ENOENT") {
        console.warn(`[ArtifactStorage] Failed to load index: ${error.message}`);
      }
    }
  }

  /**
   * Save artifact index to disk
   */
  private async saveIndex(): Promise<void> {
    if (!this.config.enableIndex) return;

    const indexFile = path.join(this.config.lfsDir, "metadata", "index.json");
    const data = Array.from(this.artifactIndex.entries()).map(([hash, metadata]) => ({
      hash,
      metadata,
    }));

    await fs.writeFile(indexFile, JSON.stringify(data, null, 2));
  }

  // ===========================================================================
  // CONTENT HASHING
  // ===========================================================================

  /**
   * Compute SHA-256 hash of content
   */
  computeHash(content: string | Buffer | Uint8Array): ContentHash {
    const buffer = typeof content === "string" 
      ? Buffer.from(content, "utf-8") 
      : Buffer.from(content);
    
    return createHash("sha256").update(buffer).digest("hex") as ContentHash;
  }

  /**
   * Get the storage path for a content hash
   */
  private getObjectPath(hash: ContentHash): string {
    const shard = hash.slice(0, 2);
    return path.join(this.config.lfsDir, "objects", shard, hash);
  }

  /**
   * Get the metadata path for a content hash
   */
  private getMetadataPath(hash: ContentHash): string {
    const shard = hash.slice(0, 2);
    return path.join(this.config.lfsDir, "metadata", shard, `${hash}.json`);
  }

  // ===========================================================================
  // ARTIFACT OPERATIONS
  // ===========================================================================

  /**
   * Store an artifact
   * 
   * @returns The stored RealityArtifact with computed ID
   */
  async store(input: CreateArtifactInput): Promise<RealityArtifact> {
    // Validate input
    const validatedInput = createArtifactInputSchema.parse(input);

    // Convert content to buffer
    const contentBuffer = typeof validatedInput.content === "string"
      ? Buffer.from(validatedInput.content, "utf-8")
      : Buffer.from(validatedInput.content);

    // Check size limit
    if (this.config.maxContentSize > 0 && contentBuffer.length > this.config.maxContentSize) {
      throw new Error(
        `Content size ${contentBuffer.length} exceeds maximum ${this.config.maxContentSize}`
      );
    }

    // Compute content hash
    const contentHash = this.computeHash(contentBuffer);

    // Check for deduplication
    if (this.config.enableDeduplication && this.artifactIndex.has(contentHash)) {
      console.log(`[ArtifactStorage] Deduplication: artifact ${contentHash.slice(0, 12)}... already exists`);
      return this.artifactIndex.get(contentHash)!.artifact;
    }

    // Validate dependencies exist
    for (const depHash of validatedInput.dependencies ?? []) {
      if (!this.artifactIndex.has(depHash)) {
        throw new Error(`Dependency artifact not found: ${depHash}`);
      }
    }

    // Create LFS pointer
    const lfsPointer: LFSPointer = {
      version: "v1",
      oid: contentHash,
      size: contentBuffer.length,
      mimeType: validatedInput.mimeType,
      filename: validatedInput.filename,
    };

    // Create the artifact
    const artifact: RealityArtifact = {
      id: contentHash,
      timestamp: new Date().toISOString(),
      origin: validatedInput.origin,
      scope: validatedInput.scope,
      dependencies: validatedInput.dependencies ?? [],
      signature: validatedInput.signature,
      summary: validatedInput.summary,
      content: lfsPointer,
    };

    // Validate the complete artifact
    realityArtifactSchema.parse(artifact);

    // Store content to LFS
    const objectPath = this.getObjectPath(contentHash);
    await fs.mkdir(path.dirname(objectPath), { recursive: true });
    await fs.writeFile(objectPath, contentBuffer);

    // Store metadata
    const metadataPath = this.getMetadataPath(contentHash);
    await fs.mkdir(path.dirname(metadataPath), { recursive: true });
    await fs.writeFile(metadataPath, JSON.stringify(artifact, null, 2));

    // Update index
    const metadata: StoredArtifactMetadata = {
      artifact,
      storedAt: new Date(),
      accessCount: 0,
      lastAccessedAt: new Date(),
    };
    this.artifactIndex.set(contentHash, metadata);

    // Update dependent index
    for (const depHash of artifact.dependencies) {
      if (!this.dependentIndex.has(depHash)) {
        this.dependentIndex.set(depHash, new Set());
      }
      this.dependentIndex.get(depHash)!.add(contentHash);
    }

    // Save index
    await this.saveIndex();

    // Emit event
    this.emit("artifact:stored", artifact);

    console.log(
      `[ArtifactStorage] Stored artifact ${contentHash.slice(0, 12)}... ` +
      `(${artifact.scope.type}, ${contentBuffer.length} bytes)`
    );

    return artifact;
  }

  /**
   * Retrieve an artifact by hash
   */
  async get(hash: ContentHash): Promise<RealityArtifact | null> {
    // Validate hash format
    contentHashSchema.parse(hash);

    // Check index first
    const metadata = this.artifactIndex.get(hash);
    if (metadata) {
      // Update access stats
      metadata.accessCount++;
      metadata.lastAccessedAt = new Date();
      return metadata.artifact;
    }

    // Try loading from disk
    const metadataPath = this.getMetadataPath(hash);
    try {
      const data = await fs.readFile(metadataPath, "utf-8");
      const artifact = realityArtifactSchema.parse(JSON.parse(data));
      
      // Add to index
      this.artifactIndex.set(hash, {
        artifact,
        storedAt: new Date(),
        accessCount: 1,
        lastAccessedAt: new Date(),
      });

      return artifact;
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  /**
   * Retrieve artifact content by hash
   */
  async getContent(hash: ContentHash): Promise<Buffer | null> {
    const objectPath = this.getObjectPath(hash);
    
    try {
      return await fs.readFile(objectPath);
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  /**
   * Check if an artifact exists
   */
  async exists(hash: ContentHash): Promise<boolean> {
    if (this.artifactIndex.has(hash)) {
      return true;
    }

    const objectPath = this.getObjectPath(hash);
    try {
      await fs.access(objectPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Validate an artifact schema
   */
  validate(artifact: unknown): ArtifactValidationResult {
    try {
      const validated = realityArtifactSchema.parse(artifact);
      return { valid: true, errors: [], artifact: validated };
    } catch (error: any) {
      if (error.errors) {
        return {
          valid: false,
          errors: error.errors.map((e: any) => ({
            path: e.path.join("."),
            message: e.message,
          })),
        };
      }
      return {
        valid: false,
        errors: [{ path: "", message: error.message }],
      };
    }
  }

  /**
   * Validate artifact content integrity
   */
  async verifyIntegrity(hash: ContentHash): Promise<boolean> {
    const content = await this.getContent(hash);
    if (!content) {
      return false;
    }

    const computedHash = this.computeHash(content);
    return computedHash === hash;
  }

  // ===========================================================================
  // QUERY OPERATIONS
  // ===========================================================================

  /**
   * Query artifacts by various criteria
   */
  async query(query: ArtifactQuery): Promise<RealityArtifact[]> {
    const results: RealityArtifact[] = [];

    for (const [_, metadata] of this.artifactIndex) {
      const artifact = metadata.artifact;

      // Apply filters
      if (query.system && artifact.origin.system !== query.system) continue;
      if (query.type && artifact.scope.type !== query.type) continue;
      if (query.agentId && artifact.origin.agent !== query.agentId) continue;
      if (query.siteId && artifact.scope.siteId !== query.siteId) continue;
      if (query.assetId && artifact.scope.assetId !== query.assetId) continue;

      // Tag filter (all must match)
      if (query.tags && query.tags.length > 0) {
        const artifactTags = artifact.scope.tags ?? [];
        if (!query.tags.every(t => artifactTags.includes(t))) continue;
      }

      // Dependency filters
      if (query.dependsOn && !artifact.dependencies.includes(query.dependsOn)) continue;
      if (query.dependentOf) {
        const dependents = this.dependentIndex.get(query.dependentOf);
        if (!dependents || !dependents.has(artifact.id)) continue;
      }

      // Time range filters
      if (query.fromTimestamp && artifact.timestamp < query.fromTimestamp) continue;
      if (query.toTimestamp && artifact.timestamp > query.toTimestamp) continue;

      results.push(artifact);
    }

    // Sort by timestamp descending
    results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    // Apply pagination
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 100;
    return results.slice(offset, offset + limit);
  }

  /**
   * Get all dependents of an artifact
   */
  getDependents(hash: ContentHash): ContentHash[] {
    const dependents = this.dependentIndex.get(hash);
    return dependents ? Array.from(dependents) : [];
  }

  /**
   * Get the full dependency graph for an artifact
   */
  async getDependencyGraph(hash: ContentHash): Promise<ArtifactDependencyGraph> {
    const nodes = new Map<ContentHash, ArtifactDependencyNode>();
    const visited = new Set<ContentHash>();
    const queue = [hash];

    while (queue.length > 0) {
      const currentHash = queue.shift()!;
      if (visited.has(currentHash)) continue;
      visited.add(currentHash);

      const artifact = await this.get(currentHash);
      if (!artifact) continue;

      const node: ArtifactDependencyNode = {
        id: currentHash,
        dependencies: artifact.dependencies,
        dependents: this.getDependents(currentHash),
      };

      nodes.set(currentHash, node);

      // Add dependencies to queue
      for (const dep of artifact.dependencies) {
        if (!visited.has(dep)) {
          queue.push(dep);
        }
      }

      // Add dependents to queue
      for (const dependent of node.dependents) {
        if (!visited.has(dependent)) {
          queue.push(dependent);
        }
      }
    }

    // Detect cycles and compute topological order
    const { topologicalOrder, cycles } = this.computeTopologicalOrder(nodes);

    return { nodes, topologicalOrder, cycles };
  }

  /**
   * Compute topological order and detect cycles
   */
  private computeTopologicalOrder(
    nodes: Map<ContentHash, ArtifactDependencyNode>
  ): { topologicalOrder?: ContentHash[]; cycles?: ContentHash[][] } {
    const inDegree = new Map<ContentHash, number>();
    const adjList = new Map<ContentHash, ContentHash[]>();

    // Initialize
    for (const [hash, node] of nodes) {
      inDegree.set(hash, 0);
      adjList.set(hash, []);
    }

    // Build adjacency list and in-degree count
    for (const [hash, node] of nodes) {
      for (const dep of node.dependencies) {
        if (nodes.has(dep)) {
          adjList.get(dep)!.push(hash);
          inDegree.set(hash, (inDegree.get(hash) ?? 0) + 1);
        }
      }
    }

    // Kahn's algorithm
    const queue: ContentHash[] = [];
    const result: ContentHash[] = [];

    for (const [hash, degree] of inDegree) {
      if (degree === 0) {
        queue.push(hash);
      }
    }

    while (queue.length > 0) {
      const node = queue.shift()!;
      result.push(node);

      for (const neighbor of adjList.get(node) ?? []) {
        const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) {
          queue.push(neighbor);
        }
      }
    }

    if (result.length === nodes.size) {
      return { topologicalOrder: result };
    }

    // Cycle detected - find cycles
    const cycles: ContentHash[][] = [];
    const remaining = new Set(nodes.keys());
    for (const hash of result) {
      remaining.delete(hash);
    }

    // Simple cycle detection (not comprehensive)
    if (remaining.size > 0) {
      cycles.push(Array.from(remaining));
    }

    return { cycles };
  }

  // ===========================================================================
  // STATISTICS
  // ===========================================================================

  /**
   * Get storage statistics
   */
  async getStats(): Promise<ArtifactStorageStats> {
    const byType: Record<string, number> = {};
    const bySystem: Record<string, number> = {};
    let totalSize = 0;
    let totalDependencies = 0;
    let oldestTimestamp: string | undefined;
    let newestTimestamp: string | undefined;

    for (const [_, metadata] of this.artifactIndex) {
      const artifact = metadata.artifact;

      // Count by type
      byType[artifact.scope.type] = (byType[artifact.scope.type] ?? 0) + 1;

      // Count by system
      bySystem[artifact.origin.system] = (bySystem[artifact.origin.system] ?? 0) + 1;

      // Sum size
      totalSize += artifact.content.size;

      // Sum dependencies
      totalDependencies += artifact.dependencies.length;

      // Track timestamps
      if (!oldestTimestamp || artifact.timestamp < oldestTimestamp) {
        oldestTimestamp = artifact.timestamp;
      }
      if (!newestTimestamp || artifact.timestamp > newestTimestamp) {
        newestTimestamp = artifact.timestamp;
      }
    }

    const totalArtifacts = this.artifactIndex.size;

    return {
      totalArtifacts,
      totalSize,
      byType: byType as Record<ArtifactType, number>,
      bySystem: bySystem as Record<OriginSystem, number>,
      avgDependencies: totalArtifacts > 0 ? totalDependencies / totalArtifacts : 0,
      oldestTimestamp,
      newestTimestamp,
    };
  }

  /**
   * Get all artifact IDs
   */
  getAllIds(): ContentHash[] {
    return Array.from(this.artifactIndex.keys());
  }

  /**
   * Get count of stored artifacts
   */
  getCount(): number {
    return this.artifactIndex.size;
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

export const artifactStorage = new ArtifactStorageService({
  lfsDir: process.env.ARTIFACT_LFS_DIR ?? "./artifacts/lfs",
  enableIndex: true,
  maxContentSize: parseInt(process.env.ARTIFACT_MAX_SIZE ?? "0"),
  enableDeduplication: process.env.ARTIFACT_DEDUP !== "false",
});

// =============================================================================
// INITIALIZATION HELPER
// =============================================================================

export async function initArtifactStorage(
  config?: Partial<ArtifactStorageConfig>
): Promise<ArtifactStorageService> {
  const service = config
    ? new ArtifactStorageService(config)
    : artifactStorage;

  await service.initialize();
  return service;
}
