/**
 * 0xSCADA Reality Artifact Schema
 * 
 * VERITY Architecture - Phase α.1: LFS Content-Addressed Artifact Storage
 * 
 * Artifacts are truth. Any observation, signal, trace, proof, or learned state
 * that materially affects decisions MUST be captured as an artifact.
 * 
 * - Artifacts are immutable once written
 * - Artifacts are stored as large binary objects (LFS-style), referenced by cryptographic hash
 * - Every decision must be replayable via artifact chain
 */

import { z } from "zod";

// =============================================================================
// CONTENT HASH (SHA-256 based content addressing)
// =============================================================================

/**
 * ContentHash: SHA-256 hex string (64 characters)
 * All artifacts are referenced by their content hash
 */
export const contentHashSchema = z.string().regex(
  /^[a-f0-9]{64}$/,
  "ContentHash must be a 64-character lowercase hex string (SHA-256)"
);

export type ContentHash = z.infer<typeof contentHashSchema>;

// =============================================================================
// ARTIFACT ORIGIN (What system/agent produced this artifact)
// =============================================================================

export const OriginSystem = {
  LINUX: "linux",
  ETHEREUM: "ethereum",
  AGENTIC_QE: "agentic-qe",
} as const;

export type OriginSystem = (typeof OriginSystem)[keyof typeof OriginSystem];

export const artifactOriginSchema = z.object({
  /** Which system fork produced this artifact */
  system: z.enum(["linux", "ethereum", "agentic-qe"]),
  
  /** Agent ID if produced by an agent */
  agent: z.string().optional(),
  
  /** Git commit hash context */
  fork: z.string().optional(),
  
  /** Hardware/device source identifier */
  device: z.string().optional(),
});

export type ArtifactOrigin = z.infer<typeof artifactOriginSchema>;

// =============================================================================
// ARTIFACT SCOPE (Cross-domain linkage)
// =============================================================================

export const ArtifactType = {
  // Linux Fork
  TRACE: "trace",           // ftrace dump, eBPF capture
  SENSOR: "sensor",         // Modbus register snapshot
  FIRMWARE: "firmware",     // PLC firmware image
  
  // Ethereum Fork
  PROOF: "proof",           // ZK proof blob
  SNAPSHOT: "snapshot",     // Oracle state snapshot
  MERKLE: "merkle",         // State diff tree
  
  // Agentic-QE Fork
  MODEL: "model",           // World model checkpoint
  DECISION: "decision",     // Agent decision record
  EMBEDDING: "embedding",   // Learned vector representation
  
  // Cross-fork
  TWIN: "twin",             // Digital twin checkpoint
  
  // Generic
  BLOB: "blob",             // Untyped binary blob
  CONFIG: "config",         // Configuration snapshot
  LOG: "log",               // Log capture
} as const;

export type ArtifactType = (typeof ArtifactType)[keyof typeof ArtifactType];

export const artifactScopeSchema = z.object({
  /** Type classification for this artifact */
  type: z.enum([
    "trace", "sensor", "firmware",
    "proof", "snapshot", "merkle",
    "model", "decision", "embedding",
    "twin", "blob", "config", "log"
  ]),
  
  /** Associated site ID */
  siteId: z.string().optional(),
  
  /** Associated asset ID */
  assetId: z.string().optional(),
  
  /** Custom tags for filtering */
  tags: z.array(z.string()).optional(),
  
  /** Domain-specific metadata */
  metadata: z.record(z.unknown()).optional(),
});

export type ArtifactScope = z.infer<typeof artifactScopeSchema>;

// =============================================================================
// LFS POINTER (Content location reference)
// =============================================================================

export const LfsPointerVersion = {
  V1: "v1",
} as const;

export type LfsPointerVersion = (typeof LfsPointerVersion)[keyof typeof LfsPointerVersion];

export const lfsPointerSchema = z.object({
  /** LFS pointer version */
  version: z.enum(["v1"]),
  
  /** SHA-256 hash of the content (OID) */
  oid: contentHashSchema,
  
  /** Size in bytes */
  size: z.number().int().positive(),
  
  /** MIME type if known */
  mimeType: z.string().optional(),
  
  /** Original filename if applicable */
  filename: z.string().optional(),
});

export type LFSPointer = z.infer<typeof lfsPointerSchema>;

// =============================================================================
// CRYPTO SIGNATURE (Optional attestation)
// =============================================================================

export const SignatureAlgorithm = {
  HMAC_SHA256: "hmac-sha256",
  ED25519: "ed25519",
  SECP256K1: "secp256k1",
} as const;

export type SignatureAlgorithm = (typeof SignatureAlgorithm)[keyof typeof SignatureAlgorithm];

export const cryptoSignatureSchema = z.object({
  /** Signature algorithm used */
  algorithm: z.enum(["hmac-sha256", "ed25519", "secp256k1"]),
  
  /** Public key or key ID of signer */
  keyId: z.string(),
  
  /** Signature value (hex encoded) */
  value: z.string(),
  
  /** Timestamp of signing */
  signedAt: z.string().datetime(),
});

export type CryptoSignature = z.infer<typeof cryptoSignatureSchema>;

// =============================================================================
// REALITY ARTIFACT (Main schema)
// =============================================================================

/**
 * RealityArtifact - The core unit of truth in VERITY architecture
 * 
 * Every artifact:
 * - Is content-addressed by SHA-256 hash
 * - Has a timestamp of when it was captured
 * - Knows its origin (system, agent, fork, device)
 * - Can declare dependencies on other artifacts
 * - Can be cryptographically signed for attestation
 */
export const realityArtifactSchema = z.object({
  /** Content-addressed ID (SHA-256 of content) */
  id: contentHashSchema,
  
  /** When the artifact was captured (ISO8601) */
  timestamp: z.string().datetime(),
  
  /** Origin information (who/what created this) */
  origin: artifactOriginSchema,
  
  /** Scope and classification */
  scope: artifactScopeSchema,
  
  /** Dependencies - artifacts this one depends on */
  dependencies: z.array(contentHashSchema).default([]),
  
  /** Optional cryptographic signature for attestation */
  signature: cryptoSignatureSchema.optional(),
  
  /** Human-readable summary */
  summary: z.string().optional(),
  
  /** LFS pointer to actual content */
  content: lfsPointerSchema,
});

export type RealityArtifact = z.infer<typeof realityArtifactSchema>;

// =============================================================================
// ARTIFACT CREATION INPUT (For creating new artifacts)
// =============================================================================

export const createArtifactInputSchema = z.object({
  /** Origin information */
  origin: artifactOriginSchema,
  
  /** Scope and classification */
  scope: artifactScopeSchema,
  
  /** Dependencies - artifacts this one depends on */
  dependencies: z.array(contentHashSchema).optional(),
  
  /** Human-readable summary */
  summary: z.string().optional(),
  
  /** Raw content to store (will be hashed and stored in LFS) */
  content: z.union([
    z.string(),
    z.instanceof(Buffer),
    z.instanceof(Uint8Array),
  ]),
  
  /** MIME type of content */
  mimeType: z.string().optional(),
  
  /** Original filename */
  filename: z.string().optional(),
  
  /** Optional signature to attach */
  signature: cryptoSignatureSchema.optional(),
});

export type CreateArtifactInput = z.infer<typeof createArtifactInputSchema>;

// =============================================================================
// ARTIFACT QUERY (For searching artifacts)
// =============================================================================

export const artifactQuerySchema = z.object({
  /** Filter by origin system */
  system: z.enum(["linux", "ethereum", "agentic-qe"]).optional(),
  
  /** Filter by artifact type */
  type: z.enum([
    "trace", "sensor", "firmware",
    "proof", "snapshot", "merkle",
    "model", "decision", "embedding",
    "twin", "blob", "config", "log"
  ]).optional(),
  
  /** Filter by agent ID */
  agentId: z.string().optional(),
  
  /** Filter by site ID */
  siteId: z.string().optional(),
  
  /** Filter by asset ID */
  assetId: z.string().optional(),
  
  /** Filter by tags (all must match) */
  tags: z.array(z.string()).optional(),
  
  /** Filter by dependency (find artifacts that depend on this hash) */
  dependsOn: contentHashSchema.optional(),
  
  /** Filter by dependent (find artifacts that this hash depends on) */
  dependentOf: contentHashSchema.optional(),
  
  /** Time range start */
  fromTimestamp: z.string().datetime().optional(),
  
  /** Time range end */
  toTimestamp: z.string().datetime().optional(),
  
  /** Pagination offset */
  offset: z.number().int().nonnegative().default(0),
  
  /** Pagination limit */
  limit: z.number().int().positive().max(1000).default(100),
});

export type ArtifactQuery = z.infer<typeof artifactQuerySchema>;

// =============================================================================
// ARTIFACT DEPENDENCY GRAPH
// =============================================================================

export interface ArtifactDependencyNode {
  /** Artifact ID */
  id: ContentHash;
  
  /** Direct dependencies */
  dependencies: ContentHash[];
  
  /** Artifacts that depend on this one */
  dependents: ContentHash[];
}

export interface ArtifactDependencyGraph {
  /** All nodes in the graph */
  nodes: Map<ContentHash, ArtifactDependencyNode>;
  
  /** Topological order (if acyclic) */
  topologicalOrder?: ContentHash[];
  
  /** Detected cycles (if any) */
  cycles?: ContentHash[][];
}

// =============================================================================
// ARTIFACT VALIDATION RESULT
// =============================================================================

export interface ArtifactValidationResult {
  valid: boolean;
  errors: Array<{
    path: string;
    message: string;
  }>;
  artifact?: RealityArtifact;
}

// =============================================================================
// ARTIFACT STORAGE STATS
// =============================================================================

export interface ArtifactStorageStats {
  /** Total number of artifacts */
  totalArtifacts: number;
  
  /** Total size of all content in bytes */
  totalSize: number;
  
  /** Artifacts by type */
  byType: Record<ArtifactType, number>;
  
  /** Artifacts by system */
  bySystem: Record<OriginSystem, number>;
  
  /** Average dependencies per artifact */
  avgDependencies: number;
  
  /** Oldest artifact timestamp */
  oldestTimestamp?: string;
  
  /** Newest artifact timestamp */
  newestTimestamp?: string;
}
