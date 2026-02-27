/**
 * Event Integrity Pipeline - Event Batcher
 * Issue #289: Wire event-batcher into event stream
 * 
 * High-performance event batching service that collects kernel events and groups
 * them into Merkle-proved batches for on-chain anchoring. Provides non-blocking
 * queuing with configurable thresholds and comprehensive metrics.
 */

import crypto from "crypto";
import { EventEmitter } from "events";
import pino from "pino";
import { z } from "zod";

// ─── Canonical Event Struct ─────────────────────────────────────────────────

export const EventSchema = z.object({
  /** RFC 3339 timestamp when event occurred */
  timestamp: z.string(),
  /** Unique identifier for the event source (asset, device, or system) */
  source_id: z.string(),
  /** Event type/category (e.g., 'alarm', 'state_change', 'maintenance') */
  event_type: z.string(),
  /** SHA-256 hash of the event payload for integrity verification */
  payload_hash: z.string(),
  /** Monotonic sequence number for ordering within source */
  sequence_number: z.number().int().min(0),
  /** Optional: The actual event payload (not included in hash) */
  payload: z.any().optional(),
  /** Optional: Additional metadata */
  metadata: z.record(z.any()).optional(),
});

export type Event = z.infer<typeof EventSchema>;

// ─── Event Batch Struct ─────────────────────────────────────────────────────

export interface EventBatch {
  /** Unique batch identifier */
  id: string;
  /** Events in this batch */
  events: Event[];
  /** Merkle root hash of the batch */
  merkle_root: string;
  /** Timestamp when batch was created */
  batch_timestamp: string;
  /** Compressed payload (base64-encoded zlib) */
  compressed_payload?: string;
  /** Batch metrics */
  metrics: {
    event_count: number;
    batch_size_bytes: number;
    batch_latency_ms: number;
  };
}

// ─── Configuration Schema ───────────────────────────────────────────────────

export const EventBatcherConfigSchema = z.object({
  /** Maximum events per batch before auto-flush */
  max_events_per_batch: z.number().int().min(1).default(100),
  /** Maximum time in ms before time-triggered flush */
  max_batch_time_ms: z.number().int().min(100).default(5000),
  /** Maximum batch size in bytes before auto-flush */
  max_batch_size_bytes: z.number().int().min(1024).default(1024 * 1024), // 1MB
  /** Enable zlib compression */
  enable_compression: z.boolean().default(true),
  /** Compression level (1-9) */
  compression_level: z.number().int().min(1).max(9).default(6),
  /** Log level */
  log_level: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
});

export type EventBatcherConfig = z.infer<typeof EventBatcherConfigSchema>;

// ─── Metrics Interface ──────────────────────────────────────────────────────

export interface EventBatcherMetrics {
  /** Total events processed */
  total_events: number;
  /** Total batches created */
  total_batches: number;
  /** Average events per batch */
  avg_events_per_batch: number;
  /** Average batch latency in ms */
  avg_batch_latency_ms: number;
  /** Current queue depth */
  queue_depth: number;
  /** Events dropped due to backpressure */
  events_dropped: number;
  /** Last batch timestamp */
  last_batch_timestamp: string | null;
}

// ─── Main EventBatcher Class ────────────────────────────────────────────────

export class EventBatcher extends EventEmitter {
  private readonly config: EventBatcherConfig;
  private readonly logger: pino.Logger;
  private readonly eventQueue: Event[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private metrics: EventBatcherMetrics;
  private currentBatchStartTime: number = 0;

  constructor(config: Partial<EventBatcherConfig> = {}) {
    super();
    this.config = EventBatcherConfigSchema.parse(config);
    this.logger = pino({ 
      level: this.config.log_level,
      name: "event-batcher"
    });
    
    this.metrics = {
      total_events: 0,
      total_batches: 0,
      avg_events_per_batch: 0,
      avg_batch_latency_ms: 0,
      queue_depth: 0,
      events_dropped: 0,
      last_batch_timestamp: null,
    };

    this.logger.info("EventBatcher initialized", { config: this.config });
  }

  /**
   * Ingest a new event into the batch queue (non-blocking)
   * Returns true if event was queued, false if dropped due to backpressure
   */
  public async ingest(event: Event): Promise<boolean> {
    try {
      // Validate event structure
      const validatedEvent = EventSchema.parse(event);
      
      // Non-blocking queue - if we're over capacity, drop the event
      if (this.eventQueue.length >= this.config.max_events_per_batch * 2) {
        this.metrics.events_dropped++;
        this.logger.warn("Event dropped due to backpressure", { 
          queue_depth: this.eventQueue.length,
          event_id: validatedEvent.source_id 
        });
        return false;
      }

      // Add to queue
      this.eventQueue.push(validatedEvent);
      this.metrics.queue_depth = this.eventQueue.length;
      this.metrics.total_events++;

      // Start batch timer if this is the first event
      if (this.eventQueue.length === 1) {
        this.startBatchTimer();
        this.currentBatchStartTime = Date.now();
      }

      // Check if we should flush due to count threshold
      if (this.eventQueue.length >= this.config.max_events_per_batch) {
        this.flushBatch("max_events");
      }

      // Check if we should flush due to size threshold
      const currentBatchSize = this.estimateBatchSize();
      if (currentBatchSize >= this.config.max_batch_size_bytes) {
        this.flushBatch("max_size");
      }

      this.logger.debug("Event ingested", {
        event_type: validatedEvent.event_type,
        source_id: validatedEvent.source_id,
        queue_depth: this.eventQueue.length,
      });

      return true;
    } catch (error) {
      this.logger.error("Failed to ingest event", { error: error.message });
      return false;
    }
  }

  /**
   * Force flush current batch
   */
  public async flush(): Promise<EventBatch | null> {
    return this.flushBatch("manual");
  }

  /**
   * Get current metrics
   */
  public getMetrics(): EventBatcherMetrics {
    return { ...this.metrics };
  }

  /**
   * Generate Merkle proof for an event in a batch
   */
  public generateProof(batch: EventBatch, eventIndex: number): string[] {
    if (eventIndex < 0 || eventIndex >= batch.events.length) {
      throw new Error("Event index out of bounds");
    }

    const leaves = batch.events.map(event => this.hashEvent(event));
    return this.generateMerkleProof(leaves, eventIndex);
  }

  /**
   * Verify a Merkle proof for an event
   */
  public verifyProof(
    event: Event, 
    eventIndex: number, 
    proof: string[], 
    merkleRoot: string
  ): boolean {
    const eventHash = this.hashEvent(event);
    return this.verifyMerkleProof(eventHash, eventIndex, proof, merkleRoot);
  }

  // ─── Private Methods ─────────────────────────────────────────────────────

  private startBatchTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }

    this.flushTimer = setTimeout(() => {
      this.flushBatch("timeout");
    }, this.config.max_batch_time_ms);
  }

  private async flushBatch(trigger: string): Promise<EventBatch | null> {
    if (this.eventQueue.length === 0) {
      return null;
    }

    const batchStartTime = Date.now();
    const events = [...this.eventQueue];
    this.eventQueue.length = 0; // Clear queue
    this.metrics.queue_depth = 0;

    // Clear the timer
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    try {
      // Generate batch
      const batch = await this.createBatch(events);
      const batchLatency = Date.now() - this.currentBatchStartTime;

      // Update metrics
      this.metrics.total_batches++;
      this.metrics.avg_events_per_batch = 
        (this.metrics.avg_events_per_batch * (this.metrics.total_batches - 1) + events.length) / 
        this.metrics.total_batches;
      this.metrics.avg_batch_latency_ms = 
        (this.metrics.avg_batch_latency_ms * (this.metrics.total_batches - 1) + batchLatency) / 
        this.metrics.total_batches;
      this.metrics.last_batch_timestamp = batch.batch_timestamp;

      batch.metrics.batch_latency_ms = batchLatency;

      this.logger.info("Batch flushed", {
        trigger,
        batch_id: batch.id,
        event_count: events.length,
        batch_size_bytes: batch.metrics.batch_size_bytes,
        batch_latency_ms: batchLatency,
        merkle_root: batch.merkle_root,
      });

      // Emit batch event
      this.emit("batch", batch);

      return batch;
    } catch (error) {
      this.logger.error("Failed to create batch", { error: error.message, trigger });
      // Re-queue events on failure
      this.eventQueue.unshift(...events);
      this.metrics.queue_depth = this.eventQueue.length;
      return null;
    }
  }

  private async createBatch(events: Event[]): Promise<EventBatch> {
    const batchId = crypto.randomUUID();
    const batchTimestamp = new Date().toISOString();
    
    // Calculate Merkle root
    const merkleRoot = this.calculateMerkleRoot(events);
    
    // Create batch payload
    const batchPayload = JSON.stringify({ events, merkle_root: merkleRoot });
    const batchSizeBytes = Buffer.byteLength(batchPayload, "utf8");
    
    const batch: EventBatch = {
      id: batchId,
      events,
      merkle_root: merkleRoot,
      batch_timestamp: batchTimestamp,
      metrics: {
        event_count: events.length,
        batch_size_bytes: batchSizeBytes,
        batch_latency_ms: 0, // Set by caller
      },
    };

    // Add compression if enabled
    if (this.config.enable_compression) {
      const zlib = await import("zlib");
      const compressed = zlib.deflateSync(batchPayload, { 
        level: this.config.compression_level 
      });
      batch.compressed_payload = compressed.toString("base64");
      
      this.logger.debug("Batch compressed", {
        original_size: batchSizeBytes,
        compressed_size: compressed.length,
        compression_ratio: (compressed.length / batchSizeBytes * 100).toFixed(1) + "%",
      });
    }

    return batch;
  }

  private calculateMerkleRoot(events: Event[]): string {
    if (events.length === 0) {
      return crypto.createHash("sha256").digest("hex");
    }

    const leaves = events.map(event => this.hashEvent(event));
    return this.buildMerkleTree(leaves);
  }

  private hashEvent(event: Event): string {
    const serialized = `${event.source_id}:${event.timestamp}:${event.event_type}:${event.payload_hash}:${event.sequence_number}`;
    return crypto.createHash("sha256").update(serialized, "utf8").digest("hex");
  }

  private buildMerkleTree(hashes: string[]): string {
    if (hashes.length === 0) {
      return crypto.createHash("sha256").digest("hex");
    }
    
    if (hashes.length === 1) {
      return hashes[0];
    }

    const nextLevel: string[] = [];
    
    for (let i = 0; i < hashes.length; i += 2) {
      const left = hashes[i];
      const right = hashes[i + 1] || hashes[i]; // Duplicate if odd number
      const combined = crypto.createHash("sha256")
        .update(left + right, "utf8")
        .digest("hex");
      nextLevel.push(combined);
    }

    return this.buildMerkleTree(nextLevel);
  }

  private generateMerkleProof(leaves: string[], targetIndex: number): string[] {
    if (leaves.length === 0 || targetIndex >= leaves.length) {
      return [];
    }

    if (leaves.length === 1) {
      return [];
    }

    const proof: string[] = [];
    let hashes = [...leaves];
    let index = targetIndex;

    while (hashes.length > 1) {
      const nextLevel: string[] = [];
      
      for (let i = 0; i < hashes.length; i += 2) {
        const left = hashes[i];
        const right = hashes[i + 1] || hashes[i];
        
        // If our target is at this position, record the sibling
        if (i === index || i + 1 === index) {
          const sibling = (i === index) ? right : left;
          if (sibling !== left || sibling !== right) {
            proof.push(sibling);
          }
        }

        const combined = crypto.createHash("sha256")
          .update(left + right, "utf8")
          .digest("hex");
        nextLevel.push(combined);
      }

      hashes = nextLevel;
      index = Math.floor(index / 2);
    }

    return proof;
  }

  private verifyMerkleProof(
    targetHash: string,
    targetIndex: number,
    proof: string[],
    expectedRoot: string
  ): boolean {
    let hash = targetHash;
    let index = targetIndex;

    for (const proofElement of proof) {
      if (index % 2 === 0) {
        // Target is left child
        hash = crypto.createHash("sha256")
          .update(hash + proofElement, "utf8")
          .digest("hex");
      } else {
        // Target is right child
        hash = crypto.createHash("sha256")
          .update(proofElement + hash, "utf8")
          .digest("hex");
      }
      index = Math.floor(index / 2);
    }

    return hash === expectedRoot;
  }

  private estimateBatchSize(): number {
    if (this.eventQueue.length === 0) return 0;
    
    // Rough estimation based on JSON serialization
    const sampleSize = JSON.stringify(this.eventQueue).length;
    return sampleSize;
  }

  /**
   * Graceful shutdown
   */
  public async shutdown(): Promise<void> {
    this.logger.info("EventBatcher shutting down");
    
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Flush any remaining events
    if (this.eventQueue.length > 0) {
      await this.flushBatch("shutdown");
    }

    this.logger.info("EventBatcher shutdown complete");
  }
}

// ─── Factory Function ───────────────────────────────────────────────────────

export function createEventBatcher(config?: Partial<EventBatcherConfig>): EventBatcher {
  return new EventBatcher(config);
}

// ─── Default Instance ───────────────────────────────────────────────────────

let defaultBatcher: EventBatcher | null = null;

export function getDefaultEventBatcher(config?: Partial<EventBatcherConfig>): EventBatcher {
  if (!defaultBatcher) {
    defaultBatcher = createEventBatcher(config);
  }
  return defaultBatcher;
}