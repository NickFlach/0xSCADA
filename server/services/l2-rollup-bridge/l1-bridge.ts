/**
 * L1 Bridge Service
 *
 * Handles communication with L1 (mainnet):
 * - Submitting state commitments
 * - Submitting proofs
 * - Finalizing batches
 * - Handling challenges
 */

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import {
  StateCommitment,
  BridgeMessage,
  BridgeMessageType,
  MessageReceipt,
  FraudProof,
  ValidityProof,
  L2RollupConfig,
  RollupError,
  RollupErrorCode,
  RollupMode,
} from './types';

// =============================================================================
// L1 BRIDGE ABI
// =============================================================================

const L1_BRIDGE_ABI = [
  // State commitment
  'function submitStateCommitment(uint256 batchIndex, bytes32 stateRoot, bytes32 prevStateRoot, bytes32 dataHash, uint256 eventCount, uint256 timestamp) external',
  'function getStateCommitment(uint256 batchIndex) external view returns (bytes32 stateRoot, uint256 eventCount, uint256 timestamp, bool finalized)',

  // Finalization
  'function finalizeBatch(uint256 batchIndex) external',
  'function isBatchFinalized(uint256 batchIndex) external view returns (bool)',

  // Challenges (optimistic)
  'function submitFraudProof(uint256 batchIndex, uint256 invalidEventIndex, bytes32 expectedStateRoot, bytes32[] calldata proof) external',
  'function getChallengeStatus(uint256 batchIndex) external view returns (bool challenged, address challenger, uint256 timestamp)',

  // Validity proofs (ZK)
  'function submitValidityProof(uint256 batchIndex, bytes calldata proof, bytes32[] calldata publicInputs) external',

  // Events
  'event StateCommitmentSubmitted(uint256 indexed batchIndex, bytes32 stateRoot, uint256 eventCount, uint256 timestamp)',
  'event BatchFinalized(uint256 indexed batchIndex, bytes32 stateRoot)',
  'event FraudProofSubmitted(uint256 indexed batchIndex, address indexed challenger)',
  'event BatchChallenged(uint256 indexed batchIndex, address indexed challenger)',
  'event ValidityProofSubmitted(uint256 indexed batchIndex)',
];

// =============================================================================
// L1 BRIDGE SERVICE
// =============================================================================

export class L1BridgeService extends EventEmitter {
  private config: L2RollupConfig;
  private provider: ethers.JsonRpcProvider | null = null;
  private wallet: ethers.Wallet | null = null;
  private bridgeContract: ethers.Contract | null = null;
  private pendingMessages: Map<string, BridgeMessage> = new Map();
  private messageReceipts: Map<string, MessageReceipt> = new Map();
  private enabled: boolean = false;

  constructor(config: L2RollupConfig) {
    super();
    this.config = config;
  }

  /**
   * Initialize the L1 bridge connection
   */
  async initialize(): Promise<boolean> {
    if (!this.config.enabled) {
      console.log('[L1Bridge] Disabled by configuration');
      return false;
    }

    if (!this.config.l1BridgeAddress || !this.config.l1RpcUrl) {
      console.warn('[L1Bridge] Missing L1 configuration');
      return false;
    }

    try {
      // Initialize provider
      this.provider = new ethers.JsonRpcProvider(this.config.l1RpcUrl);

      // Get private key from environment
      const privateKey = process.env.L1_BRIDGE_PRIVATE_KEY || process.env.BLOCKCHAIN_PRIVATE_KEY;
      if (!privateKey) {
        console.warn('[L1Bridge] No private key configured');
        return false;
      }

      // Initialize wallet
      this.wallet = new ethers.Wallet(privateKey, this.provider);

      // Initialize contract
      this.bridgeContract = new ethers.Contract(
        this.config.l1BridgeAddress,
        L1_BRIDGE_ABI,
        this.wallet
      );

      this.enabled = true;
      console.log('[L1Bridge] Initialized successfully');
      console.log(`  L1 RPC: ${this.config.l1RpcUrl}`);
      console.log(`  Bridge: ${this.config.l1BridgeAddress}`);
      console.log(`  Mode: ${this.config.mode}`);

      // Set up event listeners
      this.setupEventListeners();

      return true;
    } catch (error) {
      console.error('[L1Bridge] Initialization failed:', error);
      return false;
    }
  }

  /**
   * Set up L1 contract event listeners
   */
  private setupEventListeners(): void {
    if (!this.bridgeContract) return;

    this.bridgeContract.on('StateCommitmentSubmitted', (
      batchIndex: bigint,
      stateRoot: string,
      eventCount: bigint,
      timestamp: bigint
    ) => {
      this.emit('stateCommitted', {
        batchIndex: Number(batchIndex),
        stateRoot,
        eventCount: Number(eventCount),
        timestamp: Number(timestamp),
      });
    });

    this.bridgeContract.on('BatchFinalized', (batchIndex: bigint, stateRoot: string) => {
      this.emit('batchFinalized', {
        batchIndex: Number(batchIndex),
        stateRoot,
      });
    });

    this.bridgeContract.on('BatchChallenged', (batchIndex: bigint, challenger: string) => {
      this.emit('batchChallenged', {
        batchIndex: Number(batchIndex),
        challenger,
      });
    });
  }

  /**
   * Check if bridge is enabled and ready
   */
  isEnabled(): boolean {
    return this.enabled && this.bridgeContract !== null;
  }

  /**
   * Submit a state commitment to L1
   */
  async submitStateCommitment(
    commitment: StateCommitment
  ): Promise<MessageReceipt | null> {
    if (!this.isEnabled()) {
      console.warn('[L1Bridge] Not enabled, skipping state commitment');
      return null;
    }

    try {
      console.log(`[L1Bridge] Submitting state commitment for batch ${commitment.batchIndex}`);

      // Check gas price
      const feeData = await this.provider!.getFeeData();
      const currentGasPrice = feeData.gasPrice || BigInt(0);
      if (currentGasPrice > this.config.maxGasPrice) {
        console.warn(`[L1Bridge] Gas price too high: ${currentGasPrice}`);
        throw new RollupError(
          RollupErrorCode.L1_SUBMISSION_FAILED,
          'Gas price exceeds maximum'
        );
      }

      // Submit transaction
      const tx = await this.bridgeContract!.submitStateCommitment(
        commitment.batchIndex,
        commitment.stateRoot,
        commitment.prevStateRoot,
        commitment.dataHash,
        commitment.eventCount,
        commitment.timestamp,
        {
          gasPrice: BigInt(Math.floor(Number(currentGasPrice) * this.config.gasPriceMultiplier)),
        }
      );

      const receipt = await tx.wait();

      const messageReceipt: MessageReceipt = {
        messageId: `state-${commitment.batchIndex}-${Date.now()}`,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        status: 'SUCCESS',
        timestamp: Date.now(),
      };

      this.messageReceipts.set(messageReceipt.messageId, messageReceipt);

      console.log(`[L1Bridge] State commitment submitted: ${receipt.hash}`);
      this.emit('stateSubmitted', { commitment, receipt: messageReceipt });

      return messageReceipt;
    } catch (error) {
      console.error('[L1Bridge] Failed to submit state commitment:', error);
      throw new RollupError(
        RollupErrorCode.L1_SUBMISSION_FAILED,
        `Failed to submit state commitment: ${error}`
      );
    }
  }

  /**
   * Finalize a batch on L1
   */
  async finalizeBatch(batchIndex: number): Promise<MessageReceipt | null> {
    if (!this.isEnabled()) {
      console.warn('[L1Bridge] Not enabled, skipping finalization');
      return null;
    }

    try {
      console.log(`[L1Bridge] Finalizing batch ${batchIndex}`);

      const tx = await this.bridgeContract!.finalizeBatch(batchIndex);
      const receipt = await tx.wait();

      const messageReceipt: MessageReceipt = {
        messageId: `finalize-${batchIndex}-${Date.now()}`,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        status: 'SUCCESS',
        timestamp: Date.now(),
      };

      this.messageReceipts.set(messageReceipt.messageId, messageReceipt);

      console.log(`[L1Bridge] Batch ${batchIndex} finalized: ${receipt.hash}`);
      this.emit('finalized', { batchIndex, receipt: messageReceipt });

      return messageReceipt;
    } catch (error) {
      console.error('[L1Bridge] Failed to finalize batch:', error);
      throw new RollupError(
        RollupErrorCode.L1_SUBMISSION_FAILED,
        `Failed to finalize batch: ${error}`
      );
    }
  }

  /**
   * Submit a fraud proof (optimistic mode)
   */
  async submitFraudProof(fraudProof: FraudProof): Promise<MessageReceipt | null> {
    if (!this.isEnabled()) {
      console.warn('[L1Bridge] Not enabled, skipping fraud proof');
      return null;
    }

    if (this.config.mode !== 'OPTIMISTIC') {
      throw new RollupError(
        RollupErrorCode.CONFIG_ERROR,
        'Fraud proofs only available in optimistic mode'
      );
    }

    try {
      console.log(`[L1Bridge] Submitting fraud proof for batch ${fraudProof.batchIndex}`);

      const tx = await this.bridgeContract!.submitFraudProof(
        fraudProof.batchIndex,
        fraudProof.invalidEventIndex,
        fraudProof.expectedStateRoot,
        fraudProof.proof
      );

      const receipt = await tx.wait();

      const messageReceipt: MessageReceipt = {
        messageId: `fraud-${fraudProof.batchIndex}-${Date.now()}`,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        status: 'SUCCESS',
        timestamp: Date.now(),
      };

      this.messageReceipts.set(messageReceipt.messageId, messageReceipt);

      console.log(`[L1Bridge] Fraud proof submitted: ${receipt.hash}`);
      this.emit('fraudProofSubmitted', { fraudProof, receipt: messageReceipt });

      return messageReceipt;
    } catch (error) {
      console.error('[L1Bridge] Failed to submit fraud proof:', error);
      throw new RollupError(
        RollupErrorCode.L1_SUBMISSION_FAILED,
        `Failed to submit fraud proof: ${error}`
      );
    }
  }

  /**
   * Submit a validity proof (ZK mode)
   */
  async submitValidityProof(validityProof: ValidityProof): Promise<MessageReceipt | null> {
    if (!this.isEnabled()) {
      console.warn('[L1Bridge] Not enabled, skipping validity proof');
      return null;
    }

    if (this.config.mode !== 'ZK') {
      throw new RollupError(
        RollupErrorCode.CONFIG_ERROR,
        'Validity proofs only available in ZK mode'
      );
    }

    try {
      console.log(`[L1Bridge] Submitting validity proof for batch ${validityProof.batchIndex}`);

      const tx = await this.bridgeContract!.submitValidityProof(
        validityProof.batchIndex,
        validityProof.proof,
        validityProof.publicInputs
      );

      const receipt = await tx.wait();

      const messageReceipt: MessageReceipt = {
        messageId: `validity-${validityProof.batchIndex}-${Date.now()}`,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        status: 'SUCCESS',
        timestamp: Date.now(),
      };

      this.messageReceipts.set(messageReceipt.messageId, messageReceipt);

      console.log(`[L1Bridge] Validity proof submitted: ${receipt.hash}`);
      this.emit('validityProofSubmitted', { validityProof, receipt: messageReceipt });

      return messageReceipt;
    } catch (error) {
      console.error('[L1Bridge] Failed to submit validity proof:', error);
      throw new RollupError(
        RollupErrorCode.L1_SUBMISSION_FAILED,
        `Failed to submit validity proof: ${error}`
      );
    }
  }

  /**
   * Check if a batch is finalized on L1
   */
  async isBatchFinalized(batchIndex: number): Promise<boolean> {
    if (!this.isEnabled()) {
      return false;
    }

    try {
      return await this.bridgeContract!.isBatchFinalized(batchIndex);
    } catch (error) {
      console.error('[L1Bridge] Failed to check finalization:', error);
      return false;
    }
  }

  /**
   * Get state commitment from L1
   */
  async getStateCommitment(batchIndex: number): Promise<{
    stateRoot: string;
    eventCount: number;
    timestamp: number;
    finalized: boolean;
  } | null> {
    if (!this.isEnabled()) {
      return null;
    }

    try {
      const result = await this.bridgeContract!.getStateCommitment(batchIndex);
      return {
        stateRoot: result.stateRoot,
        eventCount: Number(result.eventCount),
        timestamp: Number(result.timestamp),
        finalized: result.finalized,
      };
    } catch (error) {
      console.error('[L1Bridge] Failed to get state commitment:', error);
      return null;
    }
  }

  /**
   * Get challenge status for a batch
   */
  async getChallengeStatus(batchIndex: number): Promise<{
    challenged: boolean;
    challenger: string;
    timestamp: number;
  } | null> {
    if (!this.isEnabled()) {
      return null;
    }

    try {
      const result = await this.bridgeContract!.getChallengeStatus(batchIndex);
      return {
        challenged: result.challenged,
        challenger: result.challenger,
        timestamp: Number(result.timestamp),
      };
    } catch (error) {
      console.error('[L1Bridge] Failed to get challenge status:', error);
      return null;
    }
  }

  /**
   * Get current gas price
   */
  async getGasPrice(): Promise<bigint | null> {
    if (!this.provider) {
      return null;
    }

    try {
      const feeData = await this.provider.getFeeData();
      return feeData.gasPrice || BigInt(0);
    } catch (error) {
      console.error('[L1Bridge] Failed to get gas price:', error);
      return null;
    }
  }

  /**
   * Get message receipt by ID
   */
  getMessageReceipt(messageId: string): MessageReceipt | undefined {
    return this.messageReceipts.get(messageId);
  }

  /**
   * Get all message receipts
   */
  getAllMessageReceipts(): MessageReceipt[] {
    return Array.from(this.messageReceipts.values());
  }

  /**
   * Get configuration
   */
  getConfig(): L2RollupConfig {
    return { ...this.config };
  }

  /**
   * Shutdown the bridge
   */
  async shutdown(): Promise<void> {
    if (this.bridgeContract) {
      this.bridgeContract.removeAllListeners();
    }
    this.enabled = false;
    console.log('[L1Bridge] Shutdown complete');
  }
}
