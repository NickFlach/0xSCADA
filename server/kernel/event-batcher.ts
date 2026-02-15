/**
 * Kernel-Space Event Batching
 * Issue #152: [Kernel] Implement kernel-space event batching
 *
 * Collects events, batches by time/count thresholds, compresses,
 * and creates Merkle proofs for each batch.
 */

import { EventEmitter } from 'events';
import { MerkleTree } from './merkle-syscalls';
import type { AnchorableEvent, EventBatch, Hash } from '@shared/types/merkle';
import { createHash, randomUUID } from 'crypto';
import { deflateSync, inflateSync } from 'zlib';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EventBatcherConfig {
  /** Max events per batch before auto-flush */
  maxBatchSize: number;
  /** Max time in ms before auto-flush */
  maxBatchAgeMs: number;
  /** Enable zlib compression of batch payloads */
  compress: boolean;
  /** Compression level (1-9) */
  compressionLevel: number;
}

export interface BatcherMetrics {
  pendingEvents: number;
  totalBatches: number;
  totalEvents: number;
  lastBatchTime: number | null;
  avgBatchSize: number;
}

// ─── Default Config ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: EventBatcherConfig = {
  maxBatchSize: 100,
  maxBatchAgeMs: 5000,
  compress: true,
  compressionLevel: 6,
};

// ─── Event Batcher ───────────────────────────────────────────────────────────

export class EventBatcher extends EventEmitter {
  private config: EventBatcherConfig;
  private pending: AnchorableEvent[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private batches: EventBatch[] = [];
  private totalEvents = 0;
  private lastBatchTime: number | null = null;

  constructor(config: Partial<EventBatcherConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Ingest a new event */
  ingest(event: AnchorableEvent): void {
    this.pending.push(event);
    this.totalEvents++;

    // Start age timer on first event in batch
    if (this.pending.length === 1) {
      this.startTimer();
    }

    // Flush if size threshold reached
    if (this.pending.length >= this.config.maxBatchSize) {
      this.flush();
    }
  }

  /** Force flush current pending events into a batch */
  flush(): EventBatch | null {
    this.clearTimer();

    if (this.pending.length === 0) return null;

    const events = this.pending.splice(0);
    const batch = this.createBatch(events);
    this.batches.push(batch);
    this.lastBatchTime = Date.now();

    this.emit('batch', batch);
    return batch;
  }

  /** Create a batch with Merkle root */
  private createBatch(events: AnchorableEvent[]): EventBatch {
    const tree = new MerkleTree();

    for (const event of events) {
      const serialized = this.serializeEvent(event);
      tree.merkle_insert(serialized);
    }

    const rootResult = tree.merkle_root();

    return {
      batchId: randomUUID(),
      events,
      merkleRoot: rootResult.data?.root ?? '',
      createdAt: Date.now(),
    };
  }

  /** Serialize an event for hashing */
  private serializeEvent(event: AnchorableEvent): string {
    const payload = typeof event.payload === 'string'
      ? event.payload
      : Buffer.from(event.payload).toString('hex');
    return `${event.id}:${event.timestamp}:${event.type}:${event.source}:${payload}`;
  }

  /** Compress a batch's events for storage/transport */
  compressBatch(batch: EventBatch): Buffer {
    const json = JSON.stringify(batch.events);
    if (!this.config.compress) return Buffer.from(json);
    return deflateSync(Buffer.from(json), { level: this.config.compressionLevel });
  }

  /** Decompress batch events */
  static decompressBatch(data: Buffer, compressed = true): AnchorableEvent[] {
    const json = compressed ? inflateSync(data).toString() : data.toString();
    return JSON.parse(json);
  }

  /** Generate a Merkle proof for a specific event in a batch */
  proveEvent(batch: EventBatch, eventIndex: number) {
    const tree = new MerkleTree();
    for (const event of batch.events) {
      const serialized = this.serializeEvent(event);
      tree.merkle_insert(serialized);
    }
    return tree.merkle_prove(eventIndex);
  }

  private startTimer(): void {
    this.clearTimer();
    this.batchTimer = setTimeout(() => this.flush(), this.config.maxBatchAgeMs);
  }

  private clearTimer(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  /** Get all finalized batches */
  getBatches(): EventBatch[] {
    return this.batches.slice();
  }

  /** Get metrics */
  getMetrics(): BatcherMetrics {
    return {
      pendingEvents: this.pending.length,
      totalBatches: this.batches.length,
      totalEvents: this.totalEvents,
      lastBatchTime: this.lastBatchTime,
      avgBatchSize: this.batches.length > 0
        ? this.totalEvents / this.batches.length
        : 0,
    };
  }

  /** Stop the batcher, flushing any remaining events */
  stop(): EventBatch | null {
    return this.flush();
  }
}
