/**
 * 0xSCADA ZK Artifact Service
 * 
 * VERITY Architecture - Phase α.2.2: Ethereum Fork ZK Proof Storage
 * 
 * This service provides:
 * - Storage of ZK-related artifacts (witnesses, proofs, oracle snapshots, traces)
 * - Proof verification against stored witnesses
 * - On-chain hash anchoring interface
 * - Batch anchoring via Merkle trees
 * 
 * "What was proven (cryptographic truth)"
 */

import { createHash } from "crypto";
import { EventEmitter } from "events";
import { keccak256, toUtf8Bytes, getBytes, concat, hexlify } from "ethers";

import {
  type ContentHash,
  type RealityArtifact,
  type CreateArtifactInput,
} from "@shared/artifact";

import {
  type ZKArtifactType,
  type ZKWitness,
  type OracleSnapshot,
  type MerkleStateDiff,
  type ContractTrace,
  type ZKProof,
  type AttestationBundle,
  type ZKArtifactMetadata,
  type CreateZKWitnessInput,
  type CreateOracleSnapshotInput,
  type CreateMerkleStateDiffInput,
  type CreateContractTraceInput,
  type CreateZKProofInput,
  type AnchorRequest,
  type AnchorResult,
  type OnChainAnchorInterface,
  type WitnessVerificationResult,
  type ProofVerificationResult,
  zkWitnessSchema,
  oracleSnapshotSchema,
  merkleStateDiffSchema,
  contractTraceSchema,
  zkProofSchema,
  attestationBundleSchema,
  createZKWitnessInputSchema,
  createOracleSnapshotInputSchema,
  createMerkleStateDiffInputSchema,
  createContractTraceInputSchema,
  createZKProofInputSchema,
  ZKArtifactType as ZKArtifactTypeEnum,
} from "@shared/zk-artifact";

import { ArtifactStorageService, artifactStorage } from "./artifact-storage";
import { blockchainService } from "../blockchain";

// =============================================================================
// TYPES
// =============================================================================

export interface ZKArtifactServiceConfig {
  /** Enable local proof verification */
  enableLocalVerification: boolean;
  
  /** Enable on-chain anchoring */
  enableAnchoring: boolean;
  
  /** Batch size for automatic anchoring */
  anchorBatchSize: number;
  
  /** Max age before auto-anchoring batch (ms) */
  anchorBatchMaxAgeMs: number;
  
  /** Custom anchor interface (for testing/custom chains) */
  anchorInterface?: OnChainAnchorInterface;
}

export interface StoredZKArtifact {
  artifact: RealityArtifact;
  zkMetadata: ZKArtifactMetadata;
  anchored: boolean;
  anchorTxHash?: string;
  anchorBlockNumber?: number;
}

export interface ZKArtifactStats {
  totalArtifacts: number;
  byType: Record<string, number>;
  anchoredCount: number;
  pendingAnchorCount: number;
  totalSize: number;
}

// =============================================================================
// MERKLE TREE FOR BATCHING
// =============================================================================

class ZKMerkleTree {
  private leaves: string[];
  private layers: string[][];
  private root: string;

  constructor(hashes: string[]) {
    this.leaves = hashes.map(h => this.normalizeHash(h));
    this.layers = [this.leaves];
    this.root = this.buildTree();
  }

  private normalizeHash(hash: string): string {
    // Ensure consistent format (with 0x prefix)
    return hash.startsWith("0x") ? hash : `0x${hash}`;
  }

  private hashPair(a: string, b: string): string {
    const aBytes = getBytes(a);
    const bBytes = getBytes(b);
    // Sort for determinism
    if (a.toLowerCase() < b.toLowerCase()) {
      return keccak256(concat([aBytes, bBytes]));
    }
    return keccak256(concat([bBytes, aBytes]));
  }

  private buildTree(): string {
    if (this.leaves.length === 0) {
      return keccak256(toUtf8Bytes(""));
    }

    let currentLayer = [...this.leaves];

    while (currentLayer.length > 1) {
      const nextLayer: string[] = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        const left = currentLayer[i];
        const right = currentLayer[i + 1] || left;
        nextLayer.push(this.hashPair(left, right));
      }
      this.layers.push(nextLayer);
      currentLayer = nextLayer;
    }

    return currentLayer[0];
  }

  getRoot(): string {
    return this.root;
  }

  getProof(index: number): string[] {
    if (index < 0 || index >= this.leaves.length) {
      return [];
    }

    const proof: string[] = [];
    let currentIndex = index;

    for (let i = 0; i < this.layers.length - 1; i++) {
      const layer = this.layers[i];
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;

      if (siblingIndex < layer.length) {
        proof.push(layer[siblingIndex]);
      }

      currentIndex = Math.floor(currentIndex / 2);
    }

    return proof;
  }

  static verify(leafHash: string, proof: string[], root: string): boolean {
    let computedHash = leafHash.startsWith("0x") ? leafHash : `0x${leafHash}`;

    for (const sibling of proof) {
      const siblingNorm = sibling.startsWith("0x") ? sibling : `0x${sibling}`;
      const aBytes = getBytes(computedHash);
      const bBytes = getBytes(siblingNorm);

      if (computedHash.toLowerCase() < siblingNorm.toLowerCase()) {
        computedHash = keccak256(concat([aBytes, bBytes]));
      } else {
        computedHash = keccak256(concat([bBytes, aBytes]));
      }
    }

    return computedHash.toLowerCase() === root.toLowerCase();
  }
}

// =============================================================================
// DEFAULT ON-CHAIN ANCHOR IMPLEMENTATION
// =============================================================================

class DefaultAnchorInterface implements OnChainAnchorInterface {
  async anchorArtifact(request: AnchorRequest): Promise<AnchorResult> {
    if (!blockchainService.isEnabled()) {
      return {
        success: false,
        error: "Blockchain service not enabled",
      };
    }

    try {
      // Use existing blockchain service batch anchor
      const txHash = await blockchainService.anchorBatchRoot(
        `ZK-${request.artifactType}-${Date.now()}`,
        `0x${request.contentHash}`,
        1
      );

      if (txHash) {
        return {
          success: true,
          txHash,
          anchoredAt: new Date(),
        };
      }

      return {
        success: false,
        error: "Transaction failed",
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async anchorBatch(
    merkleRoot: string,
    artifactHashes: ContentHash[],
    artifactType: ZKArtifactType
  ): Promise<AnchorResult> {
    if (!blockchainService.isEnabled()) {
      return {
        success: false,
        error: "Blockchain service not enabled",
      };
    }

    try {
      const batchId = `ZK-BATCH-${artifactType}-${Date.now()}`;
      const txHash = await blockchainService.anchorBatchRoot(
        batchId,
        merkleRoot,
        artifactHashes.length
      );

      if (txHash) {
        return {
          success: true,
          txHash,
          anchoredAt: new Date(),
        };
      }

      return {
        success: false,
        error: "Batch anchor transaction failed",
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async verifyAnchor(
    contentHash: ContentHash,
    merkleProof?: string[]
  ): Promise<{ anchored: boolean; blockNumber?: number; txHash?: string }> {
    // In a full implementation, this would query the on-chain contract
    // For now, return not anchored (contract verification coming separately)
    return { anchored: false };
  }

  isEnabled(): boolean {
    return blockchainService.isEnabled();
  }
}

// =============================================================================
// ZK ARTIFACT SERVICE
// =============================================================================

export class ZKArtifactService extends EventEmitter {
  private config: ZKArtifactServiceConfig;
  private storage: ArtifactStorageService;
  private anchorInterface: OnChainAnchorInterface;
  
  /** Index of ZK artifacts by type */
  private zkIndex: Map<ContentHash, StoredZKArtifact>;
  
  /** Pending artifacts for batch anchoring */
  private pendingAnchor: Map<ZKArtifactType, ContentHash[]>;
  
  /** Batch anchor timer */
  private anchorTimer: NodeJS.Timeout | null = null;
  
  /** Witness -> Proof mapping for verification */
  private witnessProofMap: Map<ContentHash, ContentHash[]>;

  constructor(
    config: Partial<ZKArtifactServiceConfig> = {},
    storage?: ArtifactStorageService
  ) {
    super();

    this.config = {
      enableLocalVerification: config.enableLocalVerification ?? true,
      enableAnchoring: config.enableAnchoring ?? true,
      anchorBatchSize: config.anchorBatchSize ?? 50,
      anchorBatchMaxAgeMs: config.anchorBatchMaxAgeMs ?? 5 * 60 * 1000, // 5 minutes
      anchorInterface: config.anchorInterface,
    };

    this.storage = storage ?? artifactStorage;
    this.anchorInterface = config.anchorInterface ?? new DefaultAnchorInterface();
    this.zkIndex = new Map();
    this.pendingAnchor = new Map();
    this.witnessProofMap = new Map();

    // Initialize pending anchor queues
    for (const type of Object.values(ZKArtifactTypeEnum)) {
      this.pendingAnchor.set(type as ZKArtifactType, []);
    }

    // Start batch anchor timer if enabled
    if (this.config.enableAnchoring) {
      this.startAnchorTimer();
    }
  }

  // ===========================================================================
  // LIFECYCLE
  // ===========================================================================

  private startAnchorTimer(): void {
    if (this.anchorTimer) {
      clearInterval(this.anchorTimer);
    }

    this.anchorTimer = setInterval(() => {
      this.flushPendingAnchors();
    }, this.config.anchorBatchMaxAgeMs);
  }

  async shutdown(): Promise<void> {
    if (this.anchorTimer) {
      clearInterval(this.anchorTimer);
      this.anchorTimer = null;
    }

    // Flush any remaining pending anchors
    await this.flushPendingAnchors();
  }

  // ===========================================================================
  // HASH COMPUTATION
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

  // ===========================================================================
  // WITNESS STORAGE
  // ===========================================================================

  /**
   * Store a ZK witness
   */
  async storeWitness(input: CreateZKWitnessInput): Promise<StoredZKArtifact> {
    const validated = createZKWitnessInputSchema.parse(input);

    // Serialize private inputs
    const privateInputsBuffer = typeof validated.privateInputs === "string"
      ? Buffer.from(validated.privateInputs, "utf-8")
      : Buffer.from(validated.privateInputs);

    const privateInputsHash = this.computeHash(privateInputsBuffer);

    // Create witness metadata
    const witness: ZKWitness = {
      witnessId: this.generateId("WIT"),
      circuitId: validated.circuitId,
      publicInputs: validated.publicInputs,
      privateInputsHash,
      capturedAt: new Date().toISOString(),
      blockNumber: validated.blockNumber,
      blockHash: validated.blockHash,
      metadata: validated.metadata,
    };

    // Create artifact input
    const artifactInput: CreateArtifactInput = {
      origin: {
        system: "ethereum",
      },
      scope: {
        type: "proof", // Using base artifact type
        metadata: {
          zkType: ZKArtifactTypeEnum.WITNESS,
          witness,
        },
      },
      content: privateInputsBuffer,
      summary: `ZK Witness for circuit ${validated.circuitId}`,
    };

    // Store in base artifact storage
    const artifact = await this.storage.store(artifactInput);

    const zkMetadata: ZKArtifactMetadata = {
      type: "zk-witness",
      witness,
    };

    const stored: StoredZKArtifact = {
      artifact,
      zkMetadata,
      anchored: false,
    };

    // Index
    this.zkIndex.set(artifact.id, stored);
    this.witnessProofMap.set(artifact.id, []);

    // Queue for anchoring
    this.queueForAnchor(ZKArtifactTypeEnum.WITNESS, artifact.id);

    this.emit("witness:stored", stored);
    console.log(`[ZKArtifact] Stored witness ${witness.witnessId} (${artifact.id.slice(0, 12)}...)`);

    return stored;
  }

  // ===========================================================================
  // ORACLE SNAPSHOT STORAGE
  // ===========================================================================

  /**
   * Store an oracle snapshot
   */
  async storeOracleSnapshot(input: CreateOracleSnapshotInput): Promise<StoredZKArtifact> {
    const validated = createOracleSnapshotInputSchema.parse(input);

    let rawResponseHash: ContentHash | undefined;
    let rawResponseBuffer: Buffer | undefined;

    if (validated.rawResponse) {
      rawResponseBuffer = typeof validated.rawResponse === "string"
        ? Buffer.from(validated.rawResponse, "utf-8")
        : Buffer.from(validated.rawResponse);
      rawResponseHash = this.computeHash(rawResponseBuffer);
    }

    const snapshot: OracleSnapshot = {
      snapshotId: this.generateId("ORACLE"),
      source: validated.source,
      value: validated.value,
      oracleTimestamp: validated.oracleTimestamp,
      capturedAt: new Date().toISOString(),
      blockNumber: validated.blockNumber,
      roundId: validated.roundId,
      rawResponseHash,
      oracleSignature: validated.oracleSignature,
    };

    // Content is the snapshot metadata + raw response
    const content = JSON.stringify({
      snapshot,
      rawResponse: rawResponseBuffer ? rawResponseBuffer.toString("base64") : null,
    });

    const artifactInput: CreateArtifactInput = {
      origin: {
        system: "ethereum",
      },
      scope: {
        type: "snapshot",
        metadata: {
          zkType: ZKArtifactTypeEnum.ORACLE_SNAPSHOT,
          snapshot,
        },
      },
      content,
      summary: `Oracle snapshot from ${validated.source.provider}/${validated.source.feedId}`,
    };

    const artifact = await this.storage.store(artifactInput);

    const zkMetadata: ZKArtifactMetadata = {
      type: "oracle-snapshot",
      snapshot,
    };

    const stored: StoredZKArtifact = {
      artifact,
      zkMetadata,
      anchored: false,
    };

    this.zkIndex.set(artifact.id, stored);
    this.queueForAnchor(ZKArtifactTypeEnum.ORACLE_SNAPSHOT, artifact.id);

    this.emit("oracle:stored", stored);
    console.log(`[ZKArtifact] Stored oracle snapshot ${snapshot.snapshotId} (${artifact.id.slice(0, 12)}...)`);

    return stored;
  }

  // ===========================================================================
  // MERKLE STATE DIFF STORAGE
  // ===========================================================================

  /**
   * Store a Merkle state diff
   */
  async storeStateDiff(input: CreateMerkleStateDiffInput): Promise<StoredZKArtifact> {
    const validated = createMerkleStateDiffInputSchema.parse(input);

    // Serialize full changes
    const changesJson = JSON.stringify(validated.changes);
    const changesHash = this.computeHash(changesJson);

    const diff: MerkleStateDiff = {
      diffId: this.generateId("DIFF"),
      previousRoot: validated.previousRoot,
      newRoot: validated.newRoot,
      fromBlock: validated.fromBlock,
      toBlock: validated.toBlock,
      contractAddress: validated.contractAddress,
      changeCount: validated.changes.length,
      changesHash,
      changeSummary: validated.changes.slice(0, 100), // First 100 for summary
      transitionProof: validated.transitionProof,
    };

    const artifactInput: CreateArtifactInput = {
      origin: {
        system: "ethereum",
      },
      scope: {
        type: "merkle",
        metadata: {
          zkType: ZKArtifactTypeEnum.MERKLE_STATE_DIFF,
          diff,
        },
      },
      content: changesJson,
      summary: `State diff blocks ${validated.fromBlock}-${validated.toBlock}`,
    };

    const artifact = await this.storage.store(artifactInput);

    const zkMetadata: ZKArtifactMetadata = {
      type: "merkle-state-diff",
      diff,
    };

    const stored: StoredZKArtifact = {
      artifact,
      zkMetadata,
      anchored: false,
    };

    this.zkIndex.set(artifact.id, stored);
    this.queueForAnchor(ZKArtifactTypeEnum.MERKLE_STATE_DIFF, artifact.id);

    this.emit("stateDiff:stored", stored);
    console.log(`[ZKArtifact] Stored state diff ${diff.diffId} (${artifact.id.slice(0, 12)}...)`);

    return stored;
  }

  // ===========================================================================
  // CONTRACT TRACE STORAGE
  // ===========================================================================

  /**
   * Store a contract execution trace
   */
  async storeContractTrace(input: CreateContractTraceInput): Promise<StoredZKArtifact> {
    const validated = createContractTraceInputSchema.parse(input);

    // Process input/output
    const inputBuffer = typeof validated.input === "string"
      ? Buffer.from(validated.input, "utf-8")
      : Buffer.from(validated.input);
    const inputHash = this.computeHash(inputBuffer);

    let outputHash: ContentHash | undefined;
    if (validated.output) {
      const outputBuffer = typeof validated.output === "string"
        ? Buffer.from(validated.output, "utf-8")
        : Buffer.from(validated.output);
      outputHash = this.computeHash(outputBuffer);
    }

    // Process full trace
    const traceBuffer = typeof validated.fullTrace === "string"
      ? Buffer.from(validated.fullTrace, "utf-8")
      : Buffer.from(validated.fullTrace);
    const fullTraceHash = this.computeHash(traceBuffer);

    // Count steps (estimate from trace size if not provided)
    const stepCount = validated.stepSummary?.length ?? Math.floor(traceBuffer.length / 100);

    // Process events
    const eventsEmitted = validated.eventsEmitted?.map(e => ({
      address: e.address,
      topics: e.topics,
      dataHash: this.computeHash(e.data),
    }));

    const trace: ContractTrace = {
      traceId: this.generateId("TRACE"),
      txHash: validated.txHash,
      blockNumber: validated.blockNumber,
      contractAddress: validated.contractAddress,
      functionSelector: validated.functionSelector,
      functionName: validated.functionName,
      from: validated.from,
      value: validated.value,
      inputHash,
      outputHash,
      gasUsed: validated.gasUsed,
      status: validated.status,
      revertReason: validated.revertReason,
      stepCount,
      fullTraceHash,
      stepSummary: validated.stepSummary,
      internalCalls: validated.internalCalls,
      eventsEmitted,
    };

    // Content is the full trace
    const content = JSON.stringify({
      trace,
      input: inputBuffer.toString("base64"),
      output: validated.output
        ? (typeof validated.output === "string"
            ? Buffer.from(validated.output).toString("base64")
            : Buffer.from(validated.output).toString("base64"))
        : null,
      fullTrace: traceBuffer.toString("base64"),
    });

    const artifactInput: CreateArtifactInput = {
      origin: {
        system: "ethereum",
      },
      scope: {
        type: "trace",
        metadata: {
          zkType: ZKArtifactTypeEnum.CONTRACT_TRACE,
          trace,
        },
      },
      content,
      summary: `Contract trace for tx ${validated.txHash.slice(0, 18)}...`,
    };

    const artifact = await this.storage.store(artifactInput);

    const zkMetadata: ZKArtifactMetadata = {
      type: "contract-trace",
      trace,
    };

    const stored: StoredZKArtifact = {
      artifact,
      zkMetadata,
      anchored: false,
    };

    this.zkIndex.set(artifact.id, stored);
    this.queueForAnchor(ZKArtifactTypeEnum.CONTRACT_TRACE, artifact.id);

    this.emit("trace:stored", stored);
    console.log(`[ZKArtifact] Stored contract trace ${trace.traceId} (${artifact.id.slice(0, 12)}...)`);

    return stored;
  }

  // ===========================================================================
  // ZK PROOF STORAGE
  // ===========================================================================

  /**
   * Store a ZK proof
   */
  async storeProof(input: CreateZKProofInput): Promise<StoredZKArtifact> {
    const validated = createZKProofInputSchema.parse(input);

    // Process proof and verification key
    const proofBuffer = typeof validated.proof === "string"
      ? Buffer.from(validated.proof, "utf-8")
      : Buffer.from(validated.proof);
    const proofHash = this.computeHash(proofBuffer);

    const vkBuffer = typeof validated.verificationKey === "string"
      ? Buffer.from(validated.verificationKey, "utf-8")
      : Buffer.from(validated.verificationKey);
    const verificationKeyHash = this.computeHash(vkBuffer);

    const proof: ZKProof = {
      proofId: this.generateId("PROOF"),
      circuitId: validated.circuitId,
      proofSystem: validated.proofSystem,
      witnessId: validated.witnessId,
      witnessHash: validated.witnessHash,
      publicInputs: validated.publicInputs,
      proofHash,
      verificationKeyHash,
      generatedAt: new Date().toISOString(),
      generationTimeMs: validated.generationTimeMs,
      proofSize: proofBuffer.length,
      locallyVerified: false,
    };

    const content = JSON.stringify({
      proof,
      proofData: proofBuffer.toString("base64"),
      verificationKey: vkBuffer.toString("base64"),
    });

    const artifactInput: CreateArtifactInput = {
      origin: {
        system: "ethereum",
      },
      scope: {
        type: "proof",
        metadata: {
          zkType: ZKArtifactTypeEnum.PROOF,
          proof,
        },
      },
      content,
      dependencies: [validated.witnessHash], // Depends on witness
      summary: `ZK Proof (${validated.proofSystem}) for circuit ${validated.circuitId}`,
    };

    const artifact = await this.storage.store(artifactInput);

    const zkMetadata: ZKArtifactMetadata = {
      type: "zk-proof",
      proof,
    };

    const stored: StoredZKArtifact = {
      artifact,
      zkMetadata,
      anchored: false,
    };

    this.zkIndex.set(artifact.id, stored);

    // Update witness -> proof mapping
    const existingProofs = this.witnessProofMap.get(validated.witnessHash) ?? [];
    existingProofs.push(artifact.id);
    this.witnessProofMap.set(validated.witnessHash, existingProofs);

    this.queueForAnchor(ZKArtifactTypeEnum.PROOF, artifact.id);

    this.emit("proof:stored", stored);
    console.log(`[ZKArtifact] Stored proof ${proof.proofId} (${artifact.id.slice(0, 12)}...)`);

    return stored;
  }

  // ===========================================================================
  // RETRIEVAL
  // ===========================================================================

  /**
   * Get a ZK artifact by hash
   */
  async get(hash: ContentHash): Promise<StoredZKArtifact | null> {
    // Check index first
    const indexed = this.zkIndex.get(hash);
    if (indexed) {
      return indexed;
    }

    // Try loading from base storage
    const artifact = await this.storage.get(hash);
    if (!artifact) {
      return null;
    }

    // Check if it's a ZK artifact
    const zkType = artifact.scope.metadata?.zkType;
    if (!zkType) {
      return null;
    }

    const zkMetadata = artifact.scope.metadata as unknown as ZKArtifactMetadata;
    const stored: StoredZKArtifact = {
      artifact,
      zkMetadata,
      anchored: false, // Would need to check chain
    };

    this.zkIndex.set(hash, stored);
    return stored;
  }

  /**
   * Get all proofs for a witness
   */
  async getProofsForWitness(witnessHash: ContentHash): Promise<StoredZKArtifact[]> {
    const proofHashes = this.witnessProofMap.get(witnessHash) ?? [];
    const proofs: StoredZKArtifact[] = [];

    for (const hash of proofHashes) {
      const proof = await this.get(hash);
      if (proof) {
        proofs.push(proof);
      }
    }

    return proofs;
  }

  /**
   * Query ZK artifacts
   */
  async query(options: {
    type?: ZKArtifactType;
    circuitId?: string;
    fromTimestamp?: string;
    toTimestamp?: string;
    anchored?: boolean;
    limit?: number;
  }): Promise<StoredZKArtifact[]> {
    const results: StoredZKArtifact[] = [];

    for (const [_, stored] of this.zkIndex) {
      // Type filter
      if (options.type && stored.zkMetadata.type !== options.type) {
        continue;
      }

      // Circuit filter (for witnesses and proofs)
      if (options.circuitId) {
        if (stored.zkMetadata.type === "zk-witness" &&
            stored.zkMetadata.witness.circuitId !== options.circuitId) {
          continue;
        }
        if (stored.zkMetadata.type === "zk-proof" &&
            stored.zkMetadata.proof.circuitId !== options.circuitId) {
          continue;
        }
      }

      // Time filters
      if (options.fromTimestamp && stored.artifact.timestamp < options.fromTimestamp) {
        continue;
      }
      if (options.toTimestamp && stored.artifact.timestamp > options.toTimestamp) {
        continue;
      }

      // Anchor filter
      if (options.anchored !== undefined && stored.anchored !== options.anchored) {
        continue;
      }

      results.push(stored);
    }

    // Sort by timestamp descending
    results.sort((a, b) => b.artifact.timestamp.localeCompare(a.artifact.timestamp));

    // Apply limit
    if (options.limit) {
      return results.slice(0, options.limit);
    }

    return results;
  }

  // ===========================================================================
  // PROOF VERIFICATION
  // ===========================================================================

  /**
   * Verify a proof against its stored witness
   */
  async verifyProofAgainstWitness(proofHash: ContentHash): Promise<ProofVerificationResult> {
    const proofArtifact = await this.get(proofHash);
    if (!proofArtifact || proofArtifact.zkMetadata.type !== "zk-proof") {
      return {
        valid: false,
        proofId: "unknown",
        proofHash,
        witnessHash: "" as ContentHash,
        publicInputsMatch: false,
        circuitMatch: false,
        verifiedAt: new Date(),
        errors: ["Proof not found or invalid type"],
      };
    }

    const proof = proofArtifact.zkMetadata.proof;

    // Get witness
    const witnessArtifact = await this.get(proof.witnessHash);
    if (!witnessArtifact || witnessArtifact.zkMetadata.type !== "zk-witness") {
      return {
        valid: false,
        proofId: proof.proofId,
        proofHash,
        witnessHash: proof.witnessHash,
        publicInputsMatch: false,
        circuitMatch: false,
        verifiedAt: new Date(),
        errors: ["Witness not found"],
      };
    }

    const witness = witnessArtifact.zkMetadata.witness;
    const errors: string[] = [];

    // Verify circuit IDs match
    const circuitMatch = proof.circuitId === witness.circuitId;
    if (!circuitMatch) {
      errors.push(`Circuit mismatch: proof=${proof.circuitId}, witness=${witness.circuitId}`);
    }

    // Verify public inputs match
    const publicInputsMatch = 
      proof.publicInputs.length === witness.publicInputs.length &&
      proof.publicInputs.every((input, i) => input === witness.publicInputs[i]);
    if (!publicInputsMatch) {
      errors.push("Public inputs mismatch");
    }

    // Verify witness hash matches
    const witnessHashMatch = proof.witnessHash === witnessArtifact.artifact.id;
    if (!witnessHashMatch) {
      errors.push("Witness hash mismatch");
    }

    const valid = circuitMatch && publicInputsMatch && witnessHashMatch && errors.length === 0;

    const result: ProofVerificationResult = {
      valid,
      proofId: proof.proofId,
      proofHash,
      witnessHash: proof.witnessHash,
      publicInputsMatch,
      circuitMatch,
      verifiedAt: new Date(),
      errors: errors.length > 0 ? errors : undefined,
    };

    this.emit("proof:verified", result);
    return result;
  }

  /**
   * Verify witness integrity
   */
  async verifyWitnessIntegrity(witnessHash: ContentHash): Promise<WitnessVerificationResult> {
    const witnessArtifact = await this.get(witnessHash);
    if (!witnessArtifact || witnessArtifact.zkMetadata.type !== "zk-witness") {
      return {
        valid: false,
        witnessId: "unknown",
        witnessHash,
        circuitId: "unknown",
        verifiedAt: new Date(),
        errors: ["Witness not found"],
      };
    }

    const witness = witnessArtifact.zkMetadata.witness;

    // Verify content integrity
    const contentValid = await this.storage.verifyIntegrity(witnessHash);

    // Get associated proofs
    const proofs = await this.getProofsForWitness(witnessHash);
    const proofHash = proofs.length > 0 ? proofs[0].artifact.id : undefined;

    const errors: string[] = [];
    if (!contentValid) {
      errors.push("Content integrity check failed");
    }

    return {
      valid: contentValid,
      witnessId: witness.witnessId,
      witnessHash,
      proofHash,
      circuitId: witness.circuitId,
      verifiedAt: new Date(),
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  // ===========================================================================
  // ON-CHAIN ANCHORING
  // ===========================================================================

  private queueForAnchor(type: ZKArtifactType, hash: ContentHash): void {
    if (!this.config.enableAnchoring) {
      return;
    }

    const queue = this.pendingAnchor.get(type) ?? [];
    queue.push(hash);
    this.pendingAnchor.set(type, queue);

    // Check if we should flush
    if (queue.length >= this.config.anchorBatchSize) {
      this.flushAnchorQueue(type);
    }
  }

  private async flushAnchorQueue(type: ZKArtifactType): Promise<AnchorResult | null> {
    const queue = this.pendingAnchor.get(type);
    if (!queue || queue.length === 0) {
      return null;
    }

    // Take all pending
    const hashes = [...queue];
    this.pendingAnchor.set(type, []);

    console.log(`[ZKArtifact] Anchoring batch of ${hashes.length} ${type} artifacts...`);

    // Build Merkle tree
    const tree = new ZKMerkleTree(hashes);
    const merkleRoot = tree.getRoot();

    // Anchor on-chain
    const result = await this.anchorInterface.anchorBatch(merkleRoot, hashes, type);

    if (result.success) {
      // Update index with anchor info
      for (let i = 0; i < hashes.length; i++) {
        const stored = this.zkIndex.get(hashes[i]);
        if (stored) {
          stored.anchored = true;
          stored.anchorTxHash = result.txHash;
          stored.anchorBlockNumber = result.blockNumber;
          this.zkIndex.set(hashes[i], stored);
        }
      }

      this.emit("batch:anchored", {
        type,
        merkleRoot,
        hashes,
        txHash: result.txHash,
        blockNumber: result.blockNumber,
      });

      console.log(`[ZKArtifact] Batch anchored: ${result.txHash}`);
    } else {
      // Re-queue on failure
      const existingQueue = this.pendingAnchor.get(type) ?? [];
      this.pendingAnchor.set(type, [...hashes, ...existingQueue]);
      console.error(`[ZKArtifact] Batch anchor failed: ${result.error}`);
    }

    return result;
  }

  private async flushPendingAnchors(): Promise<void> {
    for (const type of Object.values(ZKArtifactTypeEnum)) {
      const queue = this.pendingAnchor.get(type as ZKArtifactType);
      if (queue && queue.length > 0) {
        await this.flushAnchorQueue(type as ZKArtifactType);
      }
    }
  }

  /**
   * Manually anchor an artifact
   */
  async anchorArtifact(hash: ContentHash): Promise<AnchorResult> {
    const stored = await this.get(hash);
    if (!stored) {
      return {
        success: false,
        error: "Artifact not found",
      };
    }

    if (stored.anchored) {
      return {
        success: true,
        txHash: stored.anchorTxHash,
        blockNumber: stored.anchorBlockNumber,
      };
    }

    const request: AnchorRequest = {
      artifactType: stored.zkMetadata.type,
      contentHash: hash,
      metadata: {
        timestamp: stored.artifact.timestamp,
      },
    };

    const result = await this.anchorInterface.anchorArtifact(request);

    if (result.success) {
      stored.anchored = true;
      stored.anchorTxHash = result.txHash;
      stored.anchorBlockNumber = result.blockNumber;
      this.zkIndex.set(hash, stored);
    }

    return result;
  }

  /**
   * Get Merkle proof for an anchored artifact
   */
  getMerkleProof(batchHashes: ContentHash[], targetHash: ContentHash): string[] | null {
    const index = batchHashes.indexOf(targetHash);
    if (index === -1) {
      return null;
    }

    const tree = new ZKMerkleTree(batchHashes);
    return tree.getProof(index);
  }

  /**
   * Verify a Merkle proof
   */
  verifyMerkleProof(leafHash: ContentHash, proof: string[], root: string): boolean {
    return ZKMerkleTree.verify(`0x${leafHash}`, proof, root);
  }

  // ===========================================================================
  // STATISTICS
  // ===========================================================================

  getStats(): ZKArtifactStats {
    const byType: Record<string, number> = {};
    let anchoredCount = 0;
    let totalSize = 0;

    for (const [_, stored] of this.zkIndex) {
      const type = stored.zkMetadata.type;
      byType[type] = (byType[type] ?? 0) + 1;

      if (stored.anchored) {
        anchoredCount++;
      }

      totalSize += stored.artifact.content.size;
    }

    let pendingAnchorCount = 0;
    for (const [_, queue] of this.pendingAnchor) {
      pendingAnchorCount += queue.length;
    }

    return {
      totalArtifacts: this.zkIndex.size,
      byType,
      anchoredCount,
      pendingAnchorCount,
      totalSize,
    };
  }

  /**
   * Check if anchoring is enabled
   */
  isAnchoringEnabled(): boolean {
    return this.config.enableAnchoring && this.anchorInterface.isEnabled();
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

export const zkArtifactService = new ZKArtifactService({
  enableLocalVerification: process.env.ZK_LOCAL_VERIFICATION !== "false",
  enableAnchoring: process.env.ZK_ANCHORING !== "false",
  anchorBatchSize: parseInt(process.env.ZK_ANCHOR_BATCH_SIZE ?? "50"),
  anchorBatchMaxAgeMs: parseInt(process.env.ZK_ANCHOR_BATCH_AGE_MS ?? "300000"),
});

// =============================================================================
// INITIALIZATION HELPER
// =============================================================================

export async function initZKArtifactService(
  config?: Partial<ZKArtifactServiceConfig>
): Promise<ZKArtifactService> {
  const service = config
    ? new ZKArtifactService(config)
    : zkArtifactService;

  // Ensure underlying storage is initialized
  await artifactStorage.initialize();

  return service;
}
