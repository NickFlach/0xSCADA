/**
 * 0xSCADA ZK Artifact Schema
 * 
 * VERITY Architecture - Phase α.2.2: Ethereum Fork ZK Proof Storage
 * 
 * ZK-specific artifacts for the Ethereum fork:
 * - ZK witness data
 * - Oracle snapshots  
 * - Merkle state diffs
 * - Contract execution traces
 * 
 * "What was proven (cryptographic truth)"
 */

import { z } from "zod";
import { 
  contentHashSchema, 
  type ContentHash,
  artifactOriginSchema,
  artifactScopeSchema,
  lfsPointerSchema,
  cryptoSignatureSchema,
} from "./artifact";

// =============================================================================
// ZK ARTIFACT TYPES
// =============================================================================

export const ZKArtifactType = {
  /** ZK witness data - inputs used to generate proofs */
  WITNESS: "zk-witness",
  
  /** Oracle state snapshot - external data captured at a point in time */
  ORACLE_SNAPSHOT: "oracle-snapshot",
  
  /** Merkle state diff - changes between two state roots */
  MERKLE_STATE_DIFF: "merkle-state-diff",
  
  /** Contract execution trace - detailed execution log */
  CONTRACT_TRACE: "contract-trace",
  
  /** ZK proof blob - the proof itself */
  PROOF: "zk-proof",
  
  /** Attestation bundle - signed collection of proofs */
  ATTESTATION_BUNDLE: "attestation-bundle",
} as const;

export type ZKArtifactType = (typeof ZKArtifactType)[keyof typeof ZKArtifactType];

// =============================================================================
// ZK WITNESS DATA
// =============================================================================

export const zkWitnessSchema = z.object({
  /** Unique witness identifier */
  witnessId: z.string(),
  
  /** Circuit identifier this witness is for */
  circuitId: z.string(),
  
  /** Public inputs (visible on-chain) */
  publicInputs: z.array(z.string()),
  
  /** Private inputs hash (actual values in LFS content) */
  privateInputsHash: contentHashSchema,
  
  /** Timestamp when witness was captured */
  capturedAt: z.string().datetime(),
  
  /** Block number at time of capture (if applicable) */
  blockNumber: z.number().int().optional(),
  
  /** Block hash at time of capture */
  blockHash: z.string().optional(),
  
  /** Additional metadata */
  metadata: z.record(z.unknown()).optional(),
});

export type ZKWitness = z.infer<typeof zkWitnessSchema>;

// =============================================================================
// ORACLE SNAPSHOT
// =============================================================================

export const oracleSourceSchema = z.object({
  /** Oracle provider (e.g., "chainlink", "pyth", "custom") */
  provider: z.string(),
  
  /** Feed or endpoint identifier */
  feedId: z.string(),
  
  /** Network/chain ID */
  chainId: z.number().int().optional(),
});

export type OracleSource = z.infer<typeof oracleSourceSchema>;

export const oracleSnapshotSchema = z.object({
  /** Unique snapshot identifier */
  snapshotId: z.string(),
  
  /** Oracle source information */
  source: oracleSourceSchema,
  
  /** Value at time of snapshot */
  value: z.union([z.string(), z.number()]),
  
  /** Timestamp of the oracle data itself */
  oracleTimestamp: z.string().datetime(),
  
  /** Timestamp when we captured it */
  capturedAt: z.string().datetime(),
  
  /** Block number at capture */
  blockNumber: z.number().int().optional(),
  
  /** Round ID (for Chainlink-style oracles) */
  roundId: z.string().optional(),
  
  /** Raw oracle response hash (full response in LFS) */
  rawResponseHash: contentHashSchema.optional(),
  
  /** Signature from oracle (if available) */
  oracleSignature: z.string().optional(),
});

export type OracleSnapshot = z.infer<typeof oracleSnapshotSchema>;

// =============================================================================
// MERKLE STATE DIFF
// =============================================================================

export const stateChangeSchema = z.object({
  /** Storage slot or key */
  key: z.string(),
  
  /** Previous value (null if created) */
  previousValue: z.string().nullable(),
  
  /** New value (null if deleted) */
  newValue: z.string().nullable(),
  
  /** Change type */
  changeType: z.enum(["create", "update", "delete"]),
});

export type StateChange = z.infer<typeof stateChangeSchema>;

export const merkleStateDiffSchema = z.object({
  /** Unique diff identifier */
  diffId: z.string(),
  
  /** Previous state root */
  previousRoot: z.string(),
  
  /** New state root */
  newRoot: z.string(),
  
  /** Block range this diff covers */
  fromBlock: z.number().int(),
  toBlock: z.number().int(),
  
  /** Contract address (if specific to one contract) */
  contractAddress: z.string().optional(),
  
  /** Number of changes in this diff */
  changeCount: z.number().int(),
  
  /** Hash of full change set (stored in LFS) */
  changesHash: contentHashSchema,
  
  /** Summary of top-level changes (detailed changes in LFS) */
  changeSummary: z.array(stateChangeSchema).max(100).optional(),
  
  /** Proof that previousRoot -> newRoot is valid */
  transitionProof: z.string().optional(),
});

export type MerkleStateDiff = z.infer<typeof merkleStateDiffSchema>;

// =============================================================================
// CONTRACT EXECUTION TRACE
// =============================================================================

export const traceStepSchema = z.object({
  /** Step index in trace */
  index: z.number().int(),
  
  /** Program counter / instruction pointer */
  pc: z.number().int(),
  
  /** Opcode name */
  op: z.string(),
  
  /** Gas remaining */
  gas: z.number().int().optional(),
  
  /** Gas cost of this step */
  gasCost: z.number().int().optional(),
  
  /** Memory at this step (hash, full in LFS) */
  memoryHash: z.string().optional(),
  
  /** Stack top elements (limited preview) */
  stackPreview: z.array(z.string()).max(10).optional(),
  
  /** Storage reads at this step */
  storageReads: z.array(z.object({
    slot: z.string(),
    value: z.string(),
  })).optional(),
  
  /** Storage writes at this step */
  storageWrites: z.array(z.object({
    slot: z.string(),
    previousValue: z.string(),
    newValue: z.string(),
  })).optional(),
});

export type TraceStep = z.infer<typeof traceStepSchema>;

export const contractTraceSchema = z.object({
  /** Unique trace identifier */
  traceId: z.string(),
  
  /** Transaction hash */
  txHash: z.string(),
  
  /** Block number */
  blockNumber: z.number().int(),
  
  /** Contract address being traced */
  contractAddress: z.string(),
  
  /** Function selector (first 4 bytes of calldata) */
  functionSelector: z.string().optional(),
  
  /** Function name (if ABI available) */
  functionName: z.string().optional(),
  
  /** Caller address */
  from: z.string(),
  
  /** Value transferred (in wei as string) */
  value: z.string().default("0"),
  
  /** Input data hash (full calldata in LFS) */
  inputHash: contentHashSchema,
  
  /** Output data hash (full return data in LFS) */
  outputHash: contentHashSchema.optional(),
  
  /** Total gas used */
  gasUsed: z.number().int(),
  
  /** Execution status */
  status: z.enum(["success", "revert", "out_of_gas", "invalid"]),
  
  /** Revert reason (if reverted) */
  revertReason: z.string().optional(),
  
  /** Total trace steps */
  stepCount: z.number().int(),
  
  /** Hash of full trace (stored in LFS) */
  fullTraceHash: contentHashSchema,
  
  /** Summary of key steps (detailed trace in LFS) */
  stepSummary: z.array(traceStepSchema).max(50).optional(),
  
  /** Internal calls made during execution */
  internalCalls: z.array(z.object({
    type: z.enum(["call", "delegatecall", "staticcall", "create", "create2"]),
    to: z.string(),
    value: z.string().optional(),
    gasUsed: z.number().int().optional(),
    success: z.boolean(),
  })).optional(),
  
  /** Events emitted */
  eventsEmitted: z.array(z.object({
    address: z.string(),
    topics: z.array(z.string()),
    dataHash: z.string(),
  })).optional(),
});

export type ContractTrace = z.infer<typeof contractTraceSchema>;

// =============================================================================
// ZK PROOF
// =============================================================================

export const zkProofSchema = z.object({
  /** Unique proof identifier */
  proofId: z.string(),
  
  /** Circuit identifier */
  circuitId: z.string(),
  
  /** Proof system (e.g., "groth16", "plonk", "stark") */
  proofSystem: z.string(),
  
  /** Witness this proof was generated from */
  witnessId: z.string(),
  witnessHash: contentHashSchema,
  
  /** Public inputs used */
  publicInputs: z.array(z.string()),
  
  /** Proof data hash (actual proof bytes in LFS) */
  proofHash: contentHashSchema,
  
  /** Verification key hash */
  verificationKeyHash: contentHashSchema,
  
  /** When the proof was generated */
  generatedAt: z.string().datetime(),
  
  /** Generation time in milliseconds */
  generationTimeMs: z.number().int().optional(),
  
  /** Proof size in bytes */
  proofSize: z.number().int(),
  
  /** Whether proof has been verified locally */
  locallyVerified: z.boolean().default(false),
  
  /** Verification result */
  verificationResult: z.object({
    valid: z.boolean(),
    verifiedAt: z.string().datetime(),
    verifierVersion: z.string().optional(),
  }).optional(),
});

export type ZKProof = z.infer<typeof zkProofSchema>;

// =============================================================================
// ATTESTATION BUNDLE
// =============================================================================

export const attestationBundleSchema = z.object({
  /** Unique bundle identifier */
  bundleId: z.string(),
  
  /** Proofs included in this bundle */
  proofIds: z.array(z.string()),
  
  /** Merkle root of all proof hashes */
  proofsMerkleRoot: z.string(),
  
  /** Oracle snapshots referenced */
  oracleSnapshotIds: z.array(z.string()).optional(),
  
  /** State diffs referenced */
  stateDiffIds: z.array(z.string()).optional(),
  
  /** When this bundle was created */
  createdAt: z.string().datetime(),
  
  /** Who/what created this bundle */
  attester: z.object({
    type: z.enum(["agent", "operator", "system"]),
    id: z.string(),
    publicKey: z.string().optional(),
  }),
  
  /** Bundle signature */
  signature: cryptoSignatureSchema.optional(),
  
  /** On-chain anchor (if anchored) */
  anchor: z.object({
    txHash: z.string(),
    blockNumber: z.number().int(),
    anchoredAt: z.string().datetime(),
    chainId: z.number().int(),
  }).optional(),
});

export type AttestationBundle = z.infer<typeof attestationBundleSchema>;

// =============================================================================
// ZK ARTIFACT WRAPPER (Extends base RealityArtifact)
// =============================================================================

export const zkArtifactMetadataSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("zk-witness"),
    witness: zkWitnessSchema,
  }),
  z.object({
    type: z.literal("oracle-snapshot"),
    snapshot: oracleSnapshotSchema,
  }),
  z.object({
    type: z.literal("merkle-state-diff"),
    diff: merkleStateDiffSchema,
  }),
  z.object({
    type: z.literal("contract-trace"),
    trace: contractTraceSchema,
  }),
  z.object({
    type: z.literal("zk-proof"),
    proof: zkProofSchema,
  }),
  z.object({
    type: z.literal("attestation-bundle"),
    bundle: attestationBundleSchema,
  }),
]);

export type ZKArtifactMetadata = z.infer<typeof zkArtifactMetadataSchema>;

// =============================================================================
// INPUT SCHEMAS FOR CREATING ZK ARTIFACTS
// =============================================================================

export const createZKWitnessInputSchema = z.object({
  circuitId: z.string(),
  publicInputs: z.array(z.string()),
  privateInputs: z.union([z.string(), z.instanceof(Buffer), z.instanceof(Uint8Array)]),
  blockNumber: z.number().int().optional(),
  blockHash: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type CreateZKWitnessInput = z.infer<typeof createZKWitnessInputSchema>;

export const createOracleSnapshotInputSchema = z.object({
  source: oracleSourceSchema,
  value: z.union([z.string(), z.number()]),
  oracleTimestamp: z.string().datetime(),
  blockNumber: z.number().int().optional(),
  roundId: z.string().optional(),
  rawResponse: z.union([z.string(), z.instanceof(Buffer)]).optional(),
  oracleSignature: z.string().optional(),
});

export type CreateOracleSnapshotInput = z.infer<typeof createOracleSnapshotInputSchema>;

export const createMerkleStateDiffInputSchema = z.object({
  previousRoot: z.string(),
  newRoot: z.string(),
  fromBlock: z.number().int(),
  toBlock: z.number().int(),
  contractAddress: z.string().optional(),
  changes: z.array(stateChangeSchema),
  transitionProof: z.string().optional(),
});

export type CreateMerkleStateDiffInput = z.infer<typeof createMerkleStateDiffInputSchema>;

export const createContractTraceInputSchema = z.object({
  txHash: z.string(),
  blockNumber: z.number().int(),
  contractAddress: z.string(),
  functionSelector: z.string().optional(),
  functionName: z.string().optional(),
  from: z.string(),
  value: z.string().default("0"),
  input: z.union([z.string(), z.instanceof(Buffer)]),
  output: z.union([z.string(), z.instanceof(Buffer)]).optional(),
  gasUsed: z.number().int(),
  status: z.enum(["success", "revert", "out_of_gas", "invalid"]),
  revertReason: z.string().optional(),
  fullTrace: z.union([z.string(), z.instanceof(Buffer)]),
  stepSummary: z.array(traceStepSchema).max(50).optional(),
  internalCalls: z.array(z.object({
    type: z.enum(["call", "delegatecall", "staticcall", "create", "create2"]),
    to: z.string(),
    value: z.string().optional(),
    gasUsed: z.number().int().optional(),
    success: z.boolean(),
  })).optional(),
  eventsEmitted: z.array(z.object({
    address: z.string(),
    topics: z.array(z.string()),
    data: z.string(),
  })).optional(),
});

export type CreateContractTraceInput = z.infer<typeof createContractTraceInputSchema>;

export const createZKProofInputSchema = z.object({
  circuitId: z.string(),
  proofSystem: z.string(),
  witnessId: z.string(),
  witnessHash: contentHashSchema,
  publicInputs: z.array(z.string()),
  proof: z.union([z.string(), z.instanceof(Buffer)]),
  verificationKey: z.union([z.string(), z.instanceof(Buffer)]),
  generationTimeMs: z.number().int().optional(),
});

export type CreateZKProofInput = z.infer<typeof createZKProofInputSchema>;

// =============================================================================
// ON-CHAIN ANCHORING INTERFACE
// =============================================================================

export const anchorRequestSchema = z.object({
  /** Type of artifact being anchored */
  artifactType: z.enum([
    "zk-witness",
    "oracle-snapshot", 
    "merkle-state-diff",
    "contract-trace",
    "zk-proof",
    "attestation-bundle",
  ]),
  
  /** Content hash of the artifact */
  contentHash: contentHashSchema,
  
  /** Merkle root (if batching multiple artifacts) */
  merkleRoot: z.string().optional(),
  
  /** Number of artifacts in batch */
  batchCount: z.number().int().optional(),
  
  /** Metadata to anchor (limited to fit in calldata) */
  metadata: z.object({
    timestamp: z.string().datetime(),
    attester: z.string().optional(),
  }).optional(),
});

export type AnchorRequest = z.infer<typeof anchorRequestSchema>;

export interface AnchorResult {
  success: boolean;
  txHash?: string;
  blockNumber?: number;
  gasUsed?: bigint;
  error?: string;
  anchoredAt?: Date;
}

export interface OnChainAnchorInterface {
  /**
   * Anchor a single artifact hash on-chain
   */
  anchorArtifact(request: AnchorRequest): Promise<AnchorResult>;
  
  /**
   * Anchor a batch of artifacts via Merkle root
   */
  anchorBatch(
    merkleRoot: string,
    artifactHashes: ContentHash[],
    artifactType: ZKArtifactType
  ): Promise<AnchorResult>;
  
  /**
   * Verify an artifact was anchored on-chain
   */
  verifyAnchor(
    contentHash: ContentHash,
    merkleProof?: string[]
  ): Promise<{ anchored: boolean; blockNumber?: number; txHash?: string }>;
  
  /**
   * Check if anchoring is available
   */
  isEnabled(): boolean;
}

// =============================================================================
// VERIFICATION TYPES
// =============================================================================

export interface WitnessVerificationResult {
  valid: boolean;
  witnessId: string;
  witnessHash: ContentHash;
  proofHash?: ContentHash;
  circuitId: string;
  verifiedAt: Date;
  errors?: string[];
}

export interface ProofVerificationResult {
  valid: boolean;
  proofId: string;
  proofHash: ContentHash;
  witnessHash: ContentHash;
  publicInputsMatch: boolean;
  circuitMatch: boolean;
  signatureValid?: boolean;
  verifiedAt: Date;
  errors?: string[];
}
