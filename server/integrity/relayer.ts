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
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private contract: ethers.Contract;
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

  constructor(config: Partial<RelayerConfig> = {}) {
    super();
    
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

    this.initializeBlockchainConnection();
    this.startBatchTimer();
  }

  /**
   * Initialize blockchain connection and contract interface
   */
  private initializeBlockchainConnection(): void {
    this.provider = new ethers.JsonRpcProvider(this.config.rpcUrl);
    this.wallet = new ethers.Wallet(this.config.privateKey, this.provider);
    this.contract = new ethers.Contract(
      this.config.contractAddress,
      AnchorRelayerService.CONTRACT_ABI,
      this.wallet
    );
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
          await this.handleFailure(request, result.error);
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
      // Verify signature before submission
      if (!this.verifySignature(request)) {
        throw new Error('Invalid signature on Merkle root');
      }

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
  private async handleFailure(request: AnchorRequest, error?: string): Promise<void> {
    request.retryCount++;
    this.stats.failedSubmissions++;

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
   * Verify HSM signature on Merkle root
   */
  private verifySignature(request: AnchorRequest): boolean {
    // TODO: Implement actual signature verification with HSM public key
    // For now, just check that signature exists and matches expected format
    const { signatureResult } = request;
    
    return !!(
      signatureResult.signature &&
      signatureResult.merkleRoot === request.merkleRoot &&
      signatureResult.timestamp > 0
    );
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