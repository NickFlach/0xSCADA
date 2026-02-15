/**
 * Merkle Tree Types — shared type definitions for kernel Merkle syscalls
 * Issue #150: [Kernel] Create syscalls for Merkle tree operations
 */

/** A hash digest (hex-encoded string) */
export type Hash = string;

/** A single node in a Merkle proof path */
export interface MerkleProofNode {
  /** The sibling hash at this tree level */
  hash: Hash;
  /** Whether the sibling is on the left (true) or right (false) */
  left: boolean;
}

/** A Merkle inclusion proof */
export interface MerkleProof {
  /** The leaf hash being proved */
  leaf: Hash;
  /** The proof path from leaf to root */
  path: MerkleProofNode[];
  /** The Merkle root this proof validates against */
  root: Hash;
  /** Index of the leaf in the tree */
  index: number;
}

/** Result of a Merkle syscall */
export interface MerkleSyscallResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  gasUsed?: number;
}

/** Merkle tree metadata */
export interface MerkleTreeInfo {
  root: Hash;
  leafCount: number;
  depth: number;
  algorithm: 'keccak256' | 'sha256' | 'poseidon';
}

/** Event data to be anchored */
export interface AnchorableEvent {
  id: string;
  timestamp: number;
  type: string;
  payload: Uint8Array | string;
  source: string;
}

/** A batch of events with its Merkle root */
export interface EventBatch {
  batchId: string;
  events: AnchorableEvent[];
  merkleRoot: Hash;
  proof?: MerkleProof;
  createdAt: number;
  finalizedAt?: number;
  submittedAt?: number;
  txHash?: string;
}

/** Batch submission receipt */
export interface BatchSubmissionReceipt {
  batchId: string;
  txHash: string;
  blockNumber: number;
  gasUsed: number;
  timestamp: number;
  confirmed: boolean;
}
