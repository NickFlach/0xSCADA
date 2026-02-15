/**
 * Event Anchor Bridge — Connect kernel event batches to EventAnchor contracts
 * Issue #153: [Bridge] Connect kernel event batches to EventAnchor contracts
 *
 * Listens for batched events from the EventBatcher and submits
 * Merkle roots to the on-chain EventAnchor smart contract.
 */

import { EventEmitter } from 'events';
import type { EventBatch, Hash, BatchSubmissionReceipt } from '@shared/types/merkle';
import type { EventBatcher } from '../kernel/event-batcher';
import type { BatchSubmitter, IL2Provider } from '../consensus/batch-submitter';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BridgeConfig {
  /** EventAnchor contract address */
  contractAddress: string;
  /** Chain ID for the target chain */
  chainId: number;
  /** Auto-submit batches as they arrive */
  autoSubmit: boolean;
  /** Minimum batch size to submit (skip tiny batches) */
  minBatchSize: number;
  /** Buffer batches and submit multiple roots in one tx */
  aggregateRoots: boolean;
  /** Max roots to aggregate before force-submitting */
  maxAggregateCount: number;
}

export interface BridgeState {
  connected: boolean;
  pendingBatches: number;
  submittedBatches: number;
  confirmedBatches: number;
  failedBatches: number;
  lastSubmission: number | null;
  lastConfirmation: number | null;
}

// ─── Default Config ──────────────────────────────────────────────────────────

const DEFAULT_BRIDGE_CONFIG: BridgeConfig = {
  contractAddress: '0x0000000000000000000000000000000000000000',
  chainId: 1,
  autoSubmit: true,
  minBatchSize: 1,
  aggregateRoots: false,
  maxAggregateCount: 10,
};

// ─── Event Anchor Bridge ─────────────────────────────────────────────────────

export class EventAnchorBridge extends EventEmitter {
  private config: BridgeConfig;
  private batcher: EventBatcher | null = null;
  private submitter: BatchSubmitter | null = null;
  private pendingRoots: EventBatch[] = [];
  private state: BridgeState = {
    connected: false,
    pendingBatches: 0,
    submittedBatches: 0,
    confirmedBatches: 0,
    failedBatches: 0,
    lastSubmission: null,
    lastConfirmation: null,
  };

  constructor(config: Partial<BridgeConfig> = {}) {
    super();
    this.config = { ...DEFAULT_BRIDGE_CONFIG, ...config };
  }

  /** Connect to a batcher and submitter */
  connect(batcher: EventBatcher, submitter: BatchSubmitter): void {
    this.batcher = batcher;
    this.submitter = submitter;
    this.state.connected = true;

    // Listen for new batches
    batcher.on('batch', (batch: EventBatch) => this.onBatch(batch));

    // Listen for submission results
    submitter.on('confirmed', (receipt: BatchSubmissionReceipt) => {
      this.state.confirmedBatches++;
      this.state.lastConfirmation = Date.now();
      this.emit('anchored', receipt);
    });

    submitter.on('failed', (batchId: string, error: string) => {
      this.state.failedBatches++;
      this.emit('anchor:failed', batchId, error);
    });

    submitter.on('submitted', (batchId: string, txHash: string) => {
      this.state.submittedBatches++;
      this.state.lastSubmission = Date.now();
    });

    this.emit('connected');
  }

  /** Handle incoming batch */
  private onBatch(batch: EventBatch): void {
    if (batch.events.length < this.config.minBatchSize) {
      this.emit('batch:skipped', batch.batchId, 'below minimum size');
      return;
    }

    if (this.config.aggregateRoots) {
      this.pendingRoots.push(batch);
      this.state.pendingBatches = this.pendingRoots.length;

      if (this.pendingRoots.length >= this.config.maxAggregateCount) {
        this.flushAggregated();
      }
    } else if (this.config.autoSubmit && this.submitter) {
      this.submitter.submit(batch);
      this.state.pendingBatches++;
    }
  }

  /** Flush aggregated roots as a single submission */
  private flushAggregated(): void {
    if (!this.submitter || this.pendingRoots.length === 0) return;

    // Create an aggregate batch whose "events" contain sub-batch roots
    const aggregateBatch: EventBatch = {
      batchId: `agg-${Date.now()}`,
      events: this.pendingRoots.flatMap(b => b.events),
      merkleRoot: this.computeAggregateRoot(this.pendingRoots.map(b => b.merkleRoot)),
      createdAt: Date.now(),
    };

    this.submitter.submit(aggregateBatch);
    this.pendingRoots = [];
    this.state.pendingBatches = 0;
  }

  /** Compute a root-of-roots for aggregated batches */
  private computeAggregateRoot(roots: Hash[]): Hash {
    // Simple concatenation hash — in production use a proper Merkle tree of roots
    const { createHash } = require('crypto');
    return createHash('sha256').update(roots.join('')).digest('hex');
  }

  /** Manually submit a batch */
  submitBatch(batch: EventBatch): void {
    if (!this.submitter) throw new Error('Bridge not connected');
    this.submitter.submit(batch);
    this.state.pendingBatches++;
  }

  /** Force flush any aggregated batches */
  flush(): void {
    this.flushAggregated();
  }

  /** Get bridge state */
  getState(): BridgeState {
    return { ...this.state };
  }

  /** Disconnect and clean up */
  disconnect(): void {
    if (this.batcher) this.batcher.removeAllListeners('batch');
    if (this.submitter) this.submitter.stop();
    this.state.connected = false;
    this.emit('disconnected');
  }
}
