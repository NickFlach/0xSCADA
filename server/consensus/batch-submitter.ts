/**
 * Batch Submitter — Auto-submit finalized batches to L2 bridge
 * Issue #154: [Consensus] Auto-submit finalized batches to L2 bridge
 *
 * Monitors finalized event batches and submits Merkle roots to L2
 * with retry logic, gas estimation, and receipt tracking.
 */

import { EventEmitter } from 'events';
import type { EventBatch, BatchSubmissionReceipt, Hash } from '@shared/types/merkle';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SubmitterConfig {
  /** Max retry attempts per batch */
  maxRetries: number;
  /** Base retry delay in ms (exponential backoff) */
  retryDelayMs: number;
  /** Max retry delay in ms */
  maxRetryDelayMs: number;
  /** Gas price multiplier (1.0 = estimated, 1.2 = 20% buffer) */
  gasPriceMultiplier: number;
  /** Max gas limit per submission tx */
  maxGasLimit: number;
  /** Polling interval for confirmation (ms) */
  confirmationPollMs: number;
  /** Required confirmations before marking confirmed */
  requiredConfirmations: number;
  /** L2 bridge contract address */
  bridgeAddress: string;
  /** RPC endpoint */
  rpcUrl: string;
}

export interface SubmissionState {
  batch: EventBatch;
  attempts: number;
  lastError?: string;
  receipt?: BatchSubmissionReceipt;
  status: 'pending' | 'submitting' | 'submitted' | 'confirmed' | 'failed';
}

// ─── Default Config ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SubmitterConfig = {
  maxRetries: 5,
  retryDelayMs: 1000,
  maxRetryDelayMs: 60000,
  gasPriceMultiplier: 1.2,
  maxGasLimit: 500000,
  confirmationPollMs: 5000,
  requiredConfirmations: 3,
  bridgeAddress: '0x0000000000000000000000000000000000000000',
  rpcUrl: 'http://localhost:8545',
};

// ─── L2 Provider Interface ───────────────────────────────────────────────────

/**
 * Abstract interface for L2 interaction.
 * Implement this for real ethers.js / viem integration.
 */
export interface IL2Provider {
  estimateGas(to: string, data: string): Promise<number>;
  getGasPrice(): Promise<bigint>;
  sendTransaction(params: {
    to: string;
    data: string;
    gasLimit: number;
    gasPrice: bigint;
  }): Promise<string>; // returns txHash
  getTransactionReceipt(txHash: string): Promise<{
    blockNumber: number;
    gasUsed: number;
    status: number;
  } | null>;
  getBlockNumber(): Promise<number>;
  encodeFunctionData(functionName: string, args: unknown[]): string;
}

// ─── Batch Submitter ─────────────────────────────────────────────────────────

export class BatchSubmitter extends EventEmitter {
  private config: SubmitterConfig;
  private provider: IL2Provider;
  private queue: SubmissionState[] = [];
  private processing = false;
  private confirmationTimers: Map<string, ReturnType<typeof setInterval>> = new Map();

  constructor(provider: IL2Provider, config: Partial<SubmitterConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.provider = provider;
  }

  /** Enqueue a finalized batch for submission */
  submit(batch: EventBatch): void {
    const state: SubmissionState = {
      batch,
      attempts: 0,
      status: 'pending',
    };
    this.queue.push(state);
    this.emit('queued', batch.batchId);
    this.processQueue();
  }

  /** Process the submission queue */
  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const state = this.queue.find(s => s.status === 'pending');
      if (!state) break;

      await this.submitBatch(state);
    }

    this.processing = false;
  }

  /** Submit a single batch with retry logic */
  private async submitBatch(state: SubmissionState): Promise<void> {
    state.status = 'submitting';
    this.emit('submitting', state.batch.batchId);

    while (state.attempts < this.config.maxRetries) {
      state.attempts++;

      try {
        // Encode the anchor call: anchorBatch(bytes32 merkleRoot, uint256 batchId, uint256 eventCount)
        const calldata = this.provider.encodeFunctionData('anchorBatch', [
          '0x' + state.batch.merkleRoot,
          state.batch.batchId,
          state.batch.events.length,
        ]);

        // Estimate gas
        const gasEstimate = await this.provider.estimateGas(
          this.config.bridgeAddress,
          calldata
        );
        const gasLimit = Math.min(
          Math.ceil(gasEstimate * this.config.gasPriceMultiplier),
          this.config.maxGasLimit
        );

        // Get gas price
        const gasPrice = await this.provider.getGasPrice();
        const adjustedGasPrice = gasPrice * BigInt(Math.ceil(this.config.gasPriceMultiplier * 100)) / 100n;

        // Send transaction
        const txHash = await this.provider.sendTransaction({
          to: this.config.bridgeAddress,
          data: calldata,
          gasLimit,
          gasPrice: adjustedGasPrice,
        });

        state.batch.txHash = txHash;
        state.batch.submittedAt = Date.now();
        state.status = 'submitted';
        this.emit('submitted', state.batch.batchId, txHash);

        // Start confirmation tracking
        this.trackConfirmation(state, txHash);
        return;
      } catch (err: any) {
        state.lastError = err.message;
        this.emit('retry', state.batch.batchId, state.attempts, err.message);

        // Exponential backoff
        const delay = Math.min(
          this.config.retryDelayMs * Math.pow(2, state.attempts - 1),
          this.config.maxRetryDelayMs
        );
        await new Promise(r => setTimeout(r, delay));
      }
    }

    // All retries exhausted
    state.status = 'failed';
    this.emit('failed', state.batch.batchId, state.lastError);
  }

  /** Track transaction confirmation */
  private trackConfirmation(state: SubmissionState, txHash: string): void {
    const timer = setInterval(async () => {
      try {
        const receipt = await this.provider.getTransactionReceipt(txHash);
        if (!receipt) return;

        if (receipt.status === 0) {
          // Transaction reverted
          clearInterval(timer);
          this.confirmationTimers.delete(txHash);
          state.status = 'failed';
          state.lastError = 'Transaction reverted';
          this.emit('failed', state.batch.batchId, 'Transaction reverted');
          return;
        }

        const currentBlock = await this.provider.getBlockNumber();
        const confirmations = currentBlock - receipt.blockNumber;

        if (confirmations >= this.config.requiredConfirmations) {
          clearInterval(timer);
          this.confirmationTimers.delete(txHash);

          state.status = 'confirmed';
          state.receipt = {
            batchId: state.batch.batchId,
            txHash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed,
            timestamp: Date.now(),
            confirmed: true,
          };
          state.batch.finalizedAt = Date.now();
          this.emit('confirmed', state.receipt);
        }
      } catch {
        // Silently retry on poll failure
      }
    }, this.config.confirmationPollMs);

    this.confirmationTimers.set(txHash, timer);
  }

  /** Get all submission states */
  getStates(): SubmissionState[] {
    return this.queue.slice();
  }

  /** Get pending count */
  getPendingCount(): number {
    return this.queue.filter(s => s.status === 'pending' || s.status === 'submitting').length;
  }

  /** Stop all confirmation tracking */
  stop(): void {
    for (const timer of this.confirmationTimers.values()) {
      clearInterval(timer);
    }
    this.confirmationTimers.clear();
  }
}
