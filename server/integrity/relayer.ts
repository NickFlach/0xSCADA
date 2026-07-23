/**
 * Anchor Relayer Service
 * 
 * Takes signed Merkle roots from HSM and submits them to the EventAnchor smart contract.
 * Includes queue-and-retry with exponential backoff, batch coalescing, gas estimation,
 * and configurable confirmation blocks.
 * 
 * Part of the Dual-Time Control Plane (ADR-0021) - Requirement #296.
 */

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { SignatureResult } from './hsm.js';

/**
 * Minimal signature verifier the relayer needs — satisfied by MerkleRootSigner.
 * Injected so the relayer can cryptographically verify the HSM signature over
 * the Merkle root against the signing key's public half before anchoring.
 */
export interface SignatureVerifier {
  verifyMerkleRootSignature(
    merkleRoot: string,
    signature: SignatureResult,
  ): Promise<{ valid: boolean }>;
}

/** Structural subset of the ethers contract the relayer calls (for injection). */
export interface AnchorContractLike {
  anchor: {
    (merkleRoot: string, batchId: number, eventCount: number, overrides?: unknown): Promise<{
      wait(): Promise<{ hash: string; blockNumber: number; gasUsed: bigint }>;
    }>;
    estimateGas(merkleRoot: string, batchId: number, eventCount: number): Promise<bigint>;
  };
}

export interface RelayerDeps {
  provider?: ethers.JsonRpcProvider;
  wallet?: ethers.Wallet;
  contract?: AnchorContractLike;
  /** Cryptographic verifier for HSM signatures (e.g. the MerkleRootSigner). */
  signatureVerifier?: SignatureVerifier;
  /**
   * Explicitly permit anchoring with only the structural signature check when
   * no cryptographic verifier is wired. Default false → fail closed: without a
   * verifier, nothing is anchored. An integrity chain must not fail open.
   */
  allowUnverified?: boolean;
}

export interface RelayerConfig {
  // Blockchain connection
  rpcUrl: string;
  chainId: number;
  contractAddress: string;
  privateKey: string;
  
  // Retry configuration  
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  exponentialBase: number;
  
  // Gas configuration
  gasLimitMultiplier: number;
  maxGasPrice: bigint;
  
  // Confirmation settings
  confirmationBlocks: number;
  
  // Batching configuration
  batchWindowMs: number;
  maxBatchSize: number;
}

export interface AnchorRequest {
  id: string;
  merkleRoot: string;
  batchId: number;
  eventCount: number;
  signatureResult: SignatureResult;
  timestamp: number;
  retryCount: number;
  priority: 'normal' | 'high' | 'urgent';
}

export interface AnchorResult {
  success: boolean;
  transactionHash?: string;
  blockNumber?: number;
  gasUsed?: bigint;
  confirmations: number;
  error?: string;
  finalizedAt?: number;
  /** Permanent failure (e.g. invalid signature) — must NOT be retried. */
  permanent?: boolean;
}

export interface RelayerStats {
  totalSubmissions: number;
  successfulSubmissions: number;
  failedSubmissions: number;
  averageConfirmationTime: number;
  queueLength: number;
  lastSuccessfulSubmission?: number;
}

/**
 * Event Anchor Relayer Service
 * 
 * Manages the reliable submission of signed Merkle roots to the blockchain.
 * Handles retries, gas optimization, and confirmation tracking.
 */
export class AnchorRelayerService extends EventEmitter {
  private config: RelayerConfig;
  private provider!: ethers.JsonRpcProvider;
  private wallet!: ethers.Wallet;
  private contract!: AnchorContractLike;
  private injectedDeps: RelayerDeps;
  private signatureVerifier?: SignatureVerifier;
  private allowUnverified: boolean;
  private queue: AnchorRequest[] = [];
  private processing = false;
  private stats: RelayerStats;
  private batchTimer?: NodeJS.Timeout;
  private currentBatch: AnchorRequest[] = [];
  
  // Event Anchor contract ABI (minimal required functions)
  private static readonly CONTRACT_ABI = [
    'function anchor(bytes32 merkleRoot, uint256 batchId, uint256 eventCount) external',
    'function verify(bytes32 merkleRoot) external view returns (bool exists, uint256 batchId)',
    'function getAnchor(uint256 batchId) external view returns (tuple(bytes32 merkleRoot, uint256 eventCount, uint256 timestamp, bool exists))',
    'function getCurrentBatchId() external view returns (uint256)',
    'event Anchored(uint256 indexed batchId, bytes32 merkleRoot, uint256 eventCount, uint256 timestamp)'
  ];

  constructor(config: Partial<RelayerConfig> = {}, deps: RelayerDeps = {}) {
    super();
    this.injectedDeps = deps;
    this.signatureVerifier = deps.signatureVerifier;
    this.allowUnverified = deps.allowUnverified ?? false;

    this.config = {
      // Default configuration
      rpcUrl: config.rpcUrl || 'http://localhost:8545',
      chainId: config.chainId || 31337,
      contractAddress: config.contractAddress || '',
      privateKey: config.privateKey || '',
      
      maxRetries: config.maxRetries || 5,
      baseDelayMs: config.baseDelayMs || 1000,
      maxDelayMs: config.maxDelayMs || 30000,
      exponentialBase: config.exponentialBase || 2,
      
      gasLimitMultiplier: config.gasLimitMultiplier || 1.2,
      maxGasPrice: config.maxGasPrice || ethers.parseUnits('50', 'gwei'),
      
      confirmationBlocks: config.confirmationBlocks || 2,
      
      batchWindowMs: config.batchWindowMs || 5000,
      maxBatchSize: config.maxBatchSize || 10,
      
      ...config
    };

    this.stats = {
      totalSubmissions: 0,
      successfulSubmissions: 0,
      failedSubmissions: 0,
      averageConfirmationTime: 0,
      queueLength: 0
    };

    // Connection is lazy: `new ethers.Wallet('')` throws, so we don't build the
    // provider/wallet/contract until first use. Injected deps (tests) are stored
    // and any gaps are filled from config by ensureConnection.
    if (deps.provider) this.provider = deps.provider;
    if (deps.wallet) this.wallet = deps.wallet;
    if (deps.contract) this.contract = deps.contract;
    this.startBatchTimer();
  }

  /**
   * Ensure the provider + contract exist, building any missing piece lazily
   * from config. Idempotent and gap-filling: a partial dep injection (e.g. only
   * a contract) still gets a real provider rather than crashing on undefined.
   */
  private ensureConnection(): void {
    if (this.provider && this.contract) return;

    if (!this.provider) {
      this.provider = new ethers.JsonRpcProvider(this.config.rpcUrl);
    }
    if (!this.contract) {
      if (!this.config.privateKey) {
        throw new Error('AnchorRelayerService: no privateKey configured — cannot submit anchors');
      }
      if (!this.config.contractAddress) {
        throw new Error('AnchorRelayerService: no contractAddress configured — cannot submit anchors');
      }
      if (!this.wallet) {
        this.wallet = new ethers.Wallet(this.config.privateKey, this.provider);
      }
      this.contract = new ethers.Contract(
        this.config.contractAddress,
        AnchorRelayerService.CONTRACT_ABI,
        this.wallet,
      ) as unknown as AnchorContractLike;
    }
  }

  /**
   * Submit a signed Merkle root for anchoring
   */
  public async submitAnchor(
    merkleRoot: string,
    batchId: number,
    eventCount: number,
    signatureResult: SignatureResult,
    priority: 'normal' | 'high' | 'urgent' = 'normal'
  ): Promise<void> {
    const request: AnchorRequest = {
      id: `anchor_${batchId}_${Date.now()}`,
      merkleRoot,
      batchId,
      eventCount,
      signatureResult,
      timestamp: Date.now(),
      retryCount: 0,
      priority
    };

    // Add to current batch for coalescing
    this.currentBatch.push(request);
    
    // Urgent requests bypass batching
    if (priority === 'urgent') {
      await this.processBatch();
    }

    this.emit('anchorRequested', request);
  }

  /**
   * Start the batch timer for coalescing requests
   */
  private startBatchTimer(): void {
    this.batchTimer = setInterval(() => {
      if (this.currentBatch.length > 0) {
        this.processBatch();
      }
    }, this.config.batchWindowMs);
  }

  /**
   * Process the current batch of anchor requests
   */
  private async processBatch(): Promise<void> {
    if (this.currentBatch.length === 0) return;

    // Move current batch to queue and clear
    const batchToProcess = [...this.currentBatch];
    this.currentBatch = [];

    // Sort by priority: urgent > high > normal
    batchToProcess.sort((a, b) => {
      const priorityOrder = { urgent: 3, high: 2, normal: 1 };
      return priorityOrder[b.priority] - priorityOrder[a.priority];
    });

    // Add to processing queue
    this.queue.push(...batchToProcess);
    this.updateStats();

    // Start processing if not already running
    if (!this.processing) {
      this.processQueue();
    }
  }

  /**
   * Process the queue of anchor requests
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;
    this.emit('queueProcessingStarted', { queueLength: this.queue.length });

    while (this.queue.length > 0) {
      const request = this.queue.shift()!;
      
      try {
        const result = await this.submitToBlockchain(request);
        
        if (result.success) {
          this.stats.successfulSubmissions++;
          this.stats.lastSuccessfulSubmission = Date.now();
          this.emit('anchorSuccess', { request, result });
        } else {
          await this.handleFailure(request, result.error, result.permanent);
        }
      } catch (error) {
        await this.handleFailure(request, (error as Error).message);
      }
      
      this.updateStats();
    }

    this.processing = false;
    this.emit('queueProcessingCompleted');
  }

  /**
   * Submit anchor request to blockchain
   */
  private async submitToBlockchain(request: AnchorRequest): Promise<AnchorResult> {
    const startTime = Date.now();

    try {
      // Verify signature before submission. A bad signature is a PERMANENT
      // failure — retrying can never make it valid, so don't queue a retry.
      if (!(await this.verifySignature(request))) {
        return { success: false, confirmations: 0, permanent: true, error: 'Invalid signature on Merkle root' };
      }

      this.ensureConnection();

      // Estimate gas
      const gasEstimate = await this.contract.anchor.estimateGas(
        request.merkleRoot,
        request.batchId,
        request.eventCount
      );

      const gasLimit = BigInt(Math.ceil(Number(gasEstimate) * this.config.gasLimitMultiplier));
      
      // Get current gas price
      const feeData = await this.provider.getFeeData();
      const gasPrice = feeData.gasPrice || ethers.parseUnits('1', 'gwei');
      
      if (gasPrice > this.config.maxGasPrice) {
        throw new Error(`Gas price ${ethers.formatUnits(gasPrice, 'gwei')} exceeds maximum ${ethers.formatUnits(this.config.maxGasPrice, 'gwei')}`);
      }

      // Submit transaction
      const tx = await this.contract.anchor(
        request.merkleRoot,
        request.batchId,
        request.eventCount,
        {
          gasLimit,
          gasPrice
        }
      );

      // Wait for inclusion
      const receipt = await tx.wait();
      
      // Wait for confirmations
      await this.waitForConfirmations(receipt.blockNumber);

      const confirmationTime = Date.now() - startTime;
      this.updateAverageConfirmationTime(confirmationTime);

      return {
        success: true,
        transactionHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        confirmations: this.config.confirmationBlocks,
        finalizedAt: Date.now()
      };

    } catch (error) {
      return {
        success: false,
        confirmations: 0,
        error: (error as Error).message
      };
    }
  }

  /**
   * Wait for the specified number of confirmation blocks
   */
  private async waitForConfirmations(blockNumber: number): Promise<void> {
    let currentBlock = await this.provider.getBlockNumber();
    
    while (currentBlock - blockNumber < this.config.confirmationBlocks) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
      currentBlock = await this.provider.getBlockNumber();
    }
  }

  /**
   * Handle submission failure with retry logic
   */
  private async handleFailure(request: AnchorRequest, error?: string, permanent?: boolean): Promise<void> {
    request.retryCount++;
    this.stats.failedSubmissions++;

    // Permanent failures (invalid signature) are never retried.
    if (permanent) {
      this.emit('anchorFailed', { request, error: error || 'Permanent failure', permanent: true });
      return;
    }

    if (request.retryCount >= this.config.maxRetries) {
      this.emit('anchorFailed', { request, error: error || 'Max retries exceeded' });
      return;
    }

    // Calculate exponential backoff delay
    const delay = Math.min(
      this.config.baseDelayMs * Math.pow(this.config.exponentialBase, request.retryCount - 1),
      this.config.maxDelayMs
    );

    this.emit('anchorRetry', { request, delay, error });

    // Schedule retry
    setTimeout(() => {
      this.queue.unshift(request); // Add to front of queue for retry
      this.updateStats();
      
      if (!this.processing) {
        this.processQueue();
      }
    }, delay);
  }

  /**
   * Verify the HSM signature on the Merkle root before anchoring.
   *
   * Structural checks (signature present, bound to THIS root, sane timestamp)
   * run first. Then, if a cryptographic verifier is configured, the signature
   * is verified against the signing key's public half — the real HSM check that
   * replaces the former presence-only TODO. When a verifier IS configured it
   * fails closed: an unverifiable signature is never anchored.
   */
  private async verifySignature(request: AnchorRequest): Promise<boolean> {
    const { signatureResult } = request;

    const structurallyValid = !!(
      signatureResult.signature &&
      signatureResult.merkleRoot === request.merkleRoot &&
      signatureResult.timestamp > 0
    );
    if (!structurallyValid) return false;

    if (this.signatureVerifier) {
      try {
        const { valid } = await this.signatureVerifier.verifyMerkleRootSignature(
          request.merkleRoot,
          signatureResult,
        );
        if (!valid) {
          this.emit('signatureRejected', { batchId: request.batchId, merkleRoot: request.merkleRoot });
        }
        return valid;
      } catch (err) {
        this.emit('signatureRejected', {
          batchId: request.batchId,
          merkleRoot: request.merkleRoot,
          error: (err as Error).message,
        });
        return false;
      }
    }

    // No cryptographic verifier wired. Fail CLOSED by default — an integrity
    // chain must never anchor a root it cannot cryptographically verify. Only
    // the explicit allowUnverified opt-out permits the structural-check-only
    // path. The production AnchorPipeline always injects a verifier.
    if (!this.allowUnverified) {
      this.emit('signatureRejected', {
        batchId: request.batchId,
        merkleRoot: request.merkleRoot,
        error: 'no signature verifier configured (fail-closed)',
      });
      return false;
    }
    return true;
  }

  /**
   * Update rolling average confirmation time
   */
  private updateAverageConfirmationTime(newTime: number): void {
    const alpha = 0.1; // Smoothing factor
    if (this.stats.averageConfirmationTime === 0) {
      this.stats.averageConfirmationTime = newTime;
    } else {
      this.stats.averageConfirmationTime = 
        alpha * newTime + (1 - alpha) * this.stats.averageConfirmationTime;
    }
  }

  /**
   * Update queue statistics
   */
  private updateStats(): void {
    this.stats.queueLength = this.queue.length + this.currentBatch.length;
    this.stats.totalSubmissions = this.stats.successfulSubmissions + this.stats.failedSubmissions;
  }

  /**
   * Get current relayer statistics
   */
  public getStats(): RelayerStats {
    return { ...this.stats };
  }

  /**
   * Get current queue status
   */
  public getQueueStatus(): { queue: number; batch: number; processing: boolean } {
    return {
      queue: this.queue.length,
      batch: this.currentBatch.length,
      processing: this.processing
    };
  }

  /**
   * Check blockchain connection health
   */
  public async getHealth(): Promise<{ connected: boolean; blockNumber?: number; error?: string }> {
    try {
      this.ensureConnection();
      const blockNumber = await this.provider.getBlockNumber();
      return { connected: true, blockNumber };
    } catch (error) {
      return { connected: false, error: (error as Error).message };
    }
  }

  /**
   * Gracefully shutdown the relayer
   */
  public async shutdown(): Promise<void> {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
    }

    // Process any remaining batched requests
    if (this.currentBatch.length > 0) {
      await this.processBatch();
    }

    // Wait for queue to finish processing
    while (this.processing) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    this.emit('shutdown');
  }
}