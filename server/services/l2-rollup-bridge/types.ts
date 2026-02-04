/**
 * L2 Rollup Bridge Types
 *
 * Type definitions for the L2 rollup bridge system used for
 * high-throughput event anchoring.
 */

// =============================================================================
// STATE COMMITMENT TYPES
// =============================================================================

/**
 * Represents a single state root commitment
 */
export interface StateCommitment {
  stateRoot: string;          // Merkle root of L2 state
  batchIndex: number;         // Sequential batch number
  timestamp: number;          // Unix timestamp when created
  eventCount: number;         // Number of events in this batch
  prevStateRoot: string;      // Previous state root for chaining
  dataHash: string;           // Hash of batch data for verification
}

/**
 * Rollup batch containing events
 */
export interface RollupBatch {
  batchId: string;
  events: RollupEvent[];
  stateCommitment: StateCommitment;
  status: BatchStatus;
  createdAt: Date;
  submittedAt?: Date;
  finalizedAt?: Date;
  l1TxHash?: string;
  l1BlockNumber?: number;
}

/**
 * Event in the rollup
 */
export interface RollupEvent {
  id: string;
  eventType: string;
  assetId: string;
  siteId: string;
  payload: unknown;
  timestamp: Date;
  hash: string;
  signature?: string;
}

/**
 * Batch status states
 */
export type BatchStatus =
  | 'PENDING'       // Collecting events
  | 'COMMITTED'     // State commitment created
  | 'SUBMITTED'     // Submitted to L1
  | 'CHALLENGED'    // Under dispute (optimistic)
  | 'FINALIZED'     // Finalized on L1
  | 'REJECTED';     // Rejected after challenge

// =============================================================================
// PROOF TYPES
// =============================================================================

/**
 * Fraud proof for optimistic rollups
 */
export interface FraudProof {
  batchIndex: number;
  challenger: string;
  invalidEventIndex: number;
  expectedStateRoot: string;
  actualStateRoot: string;
  proof: string[];
  timestamp: number;
}

/**
 * Validity proof for ZK rollups
 */
export interface ValidityProof {
  batchIndex: number;
  proof: string;          // ZK proof (e.g., SNARK/STARK)
  publicInputs: string[]; // Public inputs for verification
  verifier: string;       // Verifier contract address
}

/**
 * Merkle proof for event inclusion
 */
export interface InclusionProof {
  eventHash: string;
  batchId: string;
  stateRoot: string;
  proof: string[];
  index: number;
}

// =============================================================================
// BRIDGE TYPES
// =============================================================================

/**
 * L1 Bridge message types
 */
export type BridgeMessageType =
  | 'STATE_COMMITMENT'   // Submitting state root
  | 'FRAUD_PROOF'        // Submitting fraud proof
  | 'VALIDITY_PROOF'     // Submitting ZK proof
  | 'FINALIZE'           // Finalizing batch
  | 'WITHDRAW';          // Withdrawal request

/**
 * Bridge message
 */
export interface BridgeMessage {
  type: BridgeMessageType;
  batchIndex: number;
  stateRoot: string;
  data: string;          // Encoded message data
  signature: string;     // Sequencer signature
  timestamp: number;
}

/**
 * Cross-chain message receipt
 */
export interface MessageReceipt {
  messageId: string;
  txHash: string;
  blockNumber: number;
  gasUsed: bigint;
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
  timestamp: number;
}

// =============================================================================
// CONFIGURATION TYPES
// =============================================================================

/**
 * Rollup mode configuration
 */
export type RollupMode = 'OPTIMISTIC' | 'ZK';

/**
 * L2 Rollup Bridge configuration
 */
export interface L2RollupConfig {
  // Basic settings
  enabled: boolean;
  mode: RollupMode;

  // Batch settings
  maxBatchSize: number;           // Max events per batch
  maxBatchAgeMs: number;          // Max time before batch submission
  minBatchSize: number;           // Min events to create batch

  // L1 settings
  l1ChainId: number;
  l1RpcUrl: string;
  l1BridgeAddress: string;

  // L2 settings
  l2ChainId: number;
  sequencerAddress: string;

  // Optimistic settings (if mode === 'OPTIMISTIC')
  challengePeriodMs: number;      // Time window for challenges
  fraudProofWindow: number;       // Blocks for fraud proof submission

  // ZK settings (if mode === 'ZK')
  proofGenerationTimeoutMs: number;
  proverEndpoint?: string;

  // Gas settings
  maxGasPrice: bigint;
  gasPriceMultiplier: number;
}

/**
 * Default configuration
 */
export const DEFAULT_L2_ROLLUP_CONFIG: L2RollupConfig = {
  enabled: true,
  mode: 'OPTIMISTIC',

  maxBatchSize: 1000,
  maxBatchAgeMs: 60 * 1000,      // 1 minute
  minBatchSize: 1,

  l1ChainId: 1,
  l1RpcUrl: 'http://127.0.0.1:8545',
  l1BridgeAddress: '',

  l2ChainId: 42161,              // Arbitrum by default
  sequencerAddress: '',

  challengePeriodMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  fraudProofWindow: 50400,       // ~7 days in blocks

  proofGenerationTimeoutMs: 30 * 60 * 1000, // 30 minutes
  proverEndpoint: undefined,

  maxGasPrice: BigInt(100 * 1e9), // 100 gwei
  gasPriceMultiplier: 1.2,
};

// =============================================================================
// STATISTICS TYPES
// =============================================================================

/**
 * Rollup bridge statistics
 */
export interface RollupStats {
  // Batch stats
  totalBatches: number;
  pendingBatches: number;
  finalizedBatches: number;
  rejectedBatches: number;

  // Event stats
  totalEventsProcessed: number;
  pendingEvents: number;

  // L1 stats
  totalL1Transactions: number;
  totalGasUsed: bigint;
  averageGasPerBatch: bigint;

  // Challenge stats (optimistic)
  totalChallenges: number;
  successfulChallenges: number;

  // Timing stats
  averageBatchTime: number;
  averageFinalizationTime: number;
  lastBatchTimestamp: number | null;
  lastL1SubmissionTimestamp: number | null;

  // State
  currentStateRoot: string;
  currentBatchIndex: number;
}

// =============================================================================
// SEQUENCER TYPES
// =============================================================================

/**
 * Sequencer status
 */
export type SequencerStatus =
  | 'ACTIVE'
  | 'PAUSED'
  | 'SYNCING'
  | 'ERROR';

/**
 * Sequencer info
 */
export interface SequencerInfo {
  address: string;
  status: SequencerStatus;
  lastHeartbeat: number;
  currentBatchIndex: number;
  pendingTransactions: number;
}

// =============================================================================
// ERROR TYPES
// =============================================================================

/**
 * Rollup error codes
 */
export enum RollupErrorCode {
  BATCH_SIZE_EXCEEDED = 'BATCH_SIZE_EXCEEDED',
  INVALID_STATE_TRANSITION = 'INVALID_STATE_TRANSITION',
  PROOF_VERIFICATION_FAILED = 'PROOF_VERIFICATION_FAILED',
  CHALLENGE_PERIOD_EXPIRED = 'CHALLENGE_PERIOD_EXPIRED',
  L1_SUBMISSION_FAILED = 'L1_SUBMISSION_FAILED',
  SEQUENCER_UNAVAILABLE = 'SEQUENCER_UNAVAILABLE',
  INVALID_SIGNATURE = 'INVALID_SIGNATURE',
  BATCH_NOT_FOUND = 'BATCH_NOT_FOUND',
  EVENT_NOT_FOUND = 'EVENT_NOT_FOUND',
  CONFIG_ERROR = 'CONFIG_ERROR',
}

/**
 * Rollup error
 */
export class RollupError extends Error {
  constructor(
    public code: RollupErrorCode,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'RollupError';
  }
}
