/**
 * Event Batch Aggregator Service
 *
 * High-performance event batch aggregation and compression pipeline.
 *
 * Features:
 * - Configurable time-based and count-based windowing
 * - Zlib/gzip compression for batched events
 * - Async flush with backpressure handling
 * - Comprehensive metrics collection
 *
 * Issue #85 - Performance: Event Batch Aggregation & Compression Pipeline
 */

import { EventEmitter } from "events";
import { promisify } from "util";
import { gzip, gunzip, constants } from "zlib";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

// =============================================================================
// TYPES
// =============================================================================

export interface BatchEvent {
  id: string;
  type: string;
  timestamp: Date;
  siteId: string;
  payload: Record<string, unknown>;
}

export interface BatchConfig {
  /** Maximum number of events before auto-flush (default: 100) */
  maxBatchSize: number;
  /** Maximum time window in milliseconds before auto-flush (default: 5000) */
  maxBatchWindowMs: number;
  /** Enable compression for batched events (default: true) */
  enableCompression: boolean;
  /** Compression level 1-9 (default: 6) */
  compressionLevel: number;
  /** Maximum concurrent flush operations (default: 3) */
  maxConcurrentFlushes: number;
  /** Enable backpressure handling (default: true) */
  enableBackpressure: boolean;
  /** Backpressure threshold - pending batches count (default: 10) */
  backpressureThreshold: number;
}

export interface CompressedBatch {
  /** Unique batch identifier */
  batchId: string;
  /** Original event count */
  eventCount: number;
  /** Compressed payload as base64 string */
  compressedData: string;
  /** Original size in bytes */
  originalSize: number;
  /** Compressed size in bytes */
  compressedSize: number;
  /** Compression ratio (compressed/original) */
  compressionRatio: number;
  /** Timestamp when batch was created */
  createdAt: Date;
  /** Timestamp when batch was flushed */
  flushedAt?: Date;
  /** Site IDs included in this batch */
  siteIds: string[];
  /** Event types included in this batch */
  eventTypes: string[];
}

export interface BatchMetrics {
  /** Total events processed */
  totalEventsProcessed: number;
  /** Total batches created */
  totalBatchesCreated: number;
  /** Total batches flushed successfully */
  totalBatchesFlushed: number;
  /** Total batches failed */
  totalBatchesFailed: number;
  /** Average events per batch */
  avgEventsPerBatch: number;
  /** Average compression ratio */
  avgCompressionRatio: number;
  /** Total bytes saved by compression */
  totalBytesSaved: number;
  /** Current pending batches count */
  pendingBatchesCount: number;
  /** Current backpressure status */
  isBackpressured: boolean;
  /** Average flush latency in ms */
  avgFlushLatencyMs: number;
  /** Peak events per second */
  peakEventsPerSecond: number;
  /** Current events in buffer */
  currentBufferSize: number;
}

export interface FlushResult {
  success: boolean;
  batch: CompressedBatch;
  error?: Error;
  latencyMs: number;
}

export type FlushHandler = (batch: CompressedBatch) => Promise<void>;

// =============================================================================
// EVENT BATCH AGGREGATOR
// =============================================================================

export class EventBatchAggregator extends EventEmitter {
  private config: BatchConfig;
  private eventBuffer: BatchEvent[] = [];
  private pendingBatches: Map<string, CompressedBatch> = new Map();
  private flushTimer: NodeJS.Timeout | null = null;
  private flushHandlers: FlushHandler[] = [];
  private activeFlusheCount: number = 0;
  private isShuttingDown: boolean = false;

  // Metrics tracking
  private metrics: {
    totalEventsProcessed: number;
    totalBatchesCreated: number;
    totalBatchesFlushed: number;
    totalBatchesFailed: number;
    totalOriginalBytes: number;
    totalCompressedBytes: number;
    flushLatencies: number[];
    eventsPerSecond: number[];
    lastEventTimestamp: number;
    eventCountSinceLastSecond: number;
  };

  private metricsInterval: NodeJS.Timeout | null = null;

  constructor(config: Partial<BatchConfig> = {}) {
    super();

    this.config = {
      maxBatchSize: config.maxBatchSize ?? 100,
      maxBatchWindowMs: config.maxBatchWindowMs ?? 5000,
      enableCompression: config.enableCompression ?? true,
      compressionLevel: config.compressionLevel ?? 6,
      maxConcurrentFlushes: config.maxConcurrentFlushes ?? 3,
      enableBackpressure: config.enableBackpressure ?? true,
      backpressureThreshold: config.backpressureThreshold ?? 10,
    };

    this.metrics = {
      totalEventsProcessed: 0,
      totalBatchesCreated: 0,
      totalBatchesFlushed: 0,
      totalBatchesFailed: 0,
      totalOriginalBytes: 0,
      totalCompressedBytes: 0,
      flushLatencies: [],
      eventsPerSecond: [],
      lastEventTimestamp: Date.now(),
      eventCountSinceLastSecond: 0,
    };

    this.startMetricsCollection();
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  /**
   * Add an event to the batch buffer
   * Returns false if backpressure is applied
   */
  addEvent(event: BatchEvent): boolean {
    if (this.isShuttingDown) {
      console.warn("[EventBatchAggregator] Cannot add event during shutdown");
      return false;
    }

    // Check backpressure
    if (this.isBackpressured()) {
      this.emit("backpressure", { pendingCount: this.pendingBatches.size });
      return false;
    }

    this.eventBuffer.push(event);
    this.metrics.totalEventsProcessed++;
    this.metrics.eventCountSinceLastSecond++;

    // Start timer if not already running
    if (!this.flushTimer) {
      this.startFlushTimer();
    }

    // Check if we should flush based on count
    if (this.eventBuffer.length >= this.config.maxBatchSize) {
      this.flush().catch((err) => {
        console.error("[EventBatchAggregator] Auto-flush error:", err);
      });
    }

    this.emit("event:added", event);
    return true;
  }

  /**
   * Add multiple events to the batch buffer
   * Returns the count of events successfully added
   */
  addEvents(events: BatchEvent[]): number {
    let addedCount = 0;
    for (const event of events) {
      if (this.addEvent(event)) {
        addedCount++;
      } else {
        break; // Stop on backpressure
      }
    }
    return addedCount;
  }

  /**
   * Register a flush handler
   */
  onFlush(handler: FlushHandler): void {
    this.flushHandlers.push(handler);
  }

  /**
   * Remove a flush handler
   */
  offFlush(handler: FlushHandler): void {
    const index = this.flushHandlers.indexOf(handler);
    if (index !== -1) {
      this.flushHandlers.splice(index, 1);
    }
  }

  /**
   * Force flush the current buffer
   */
  async flush(): Promise<FlushResult | null> {
    if (this.eventBuffer.length === 0) {
      return null;
    }

    // Check concurrent flush limit
    if (this.activeFlusheCount >= this.config.maxConcurrentFlushes) {
      console.warn("[EventBatchAggregator] Max concurrent flushes reached, queueing...");
      return null;
    }

    // Reset timer
    this.stopFlushTimer();

    // Take events from buffer
    const events = [...this.eventBuffer];
    this.eventBuffer = [];

    const startTime = Date.now();
    this.activeFlusheCount++;

    try {
      const batch = await this.createBatch(events);
      this.pendingBatches.set(batch.batchId, batch);
      this.metrics.totalBatchesCreated++;

      this.emit("batch:created", batch);

      // Execute flush handlers
      await this.executeFlushHandlers(batch);

      batch.flushedAt = new Date();
      this.pendingBatches.delete(batch.batchId);
      this.metrics.totalBatchesFlushed++;

      const latencyMs = Date.now() - startTime;
      this.recordFlushLatency(latencyMs);

      const result: FlushResult = {
        success: true,
        batch,
        latencyMs,
      };

      this.emit("batch:flushed", result);
      return result;
    } catch (error) {
      this.metrics.totalBatchesFailed++;
      const latencyMs = Date.now() - startTime;

      const result: FlushResult = {
        success: false,
        batch: {
          batchId: this.generateBatchId(),
          eventCount: events.length,
          compressedData: "",
          originalSize: 0,
          compressedSize: 0,
          compressionRatio: 1,
          createdAt: new Date(),
          siteIds: [],
          eventTypes: [],
        },
        error: error instanceof Error ? error : new Error(String(error)),
        latencyMs,
      };

      this.emit("batch:failed", result);

      // Re-add events to buffer on failure (if not shutting down)
      if (!this.isShuttingDown) {
        this.eventBuffer = [...events, ...this.eventBuffer];
      }

      return result;
    } finally {
      this.activeFlusheCount--;

      // Restart timer if there are still events
      if (this.eventBuffer.length > 0 && !this.flushTimer) {
        this.startFlushTimer();
      }
    }
  }

  /**
   * Get current metrics snapshot
   */
  getMetrics(): BatchMetrics {
    const totalBatches = this.metrics.totalBatchesFlushed + this.metrics.totalBatchesFailed;
    const totalBytesSaved = this.metrics.totalOriginalBytes - this.metrics.totalCompressedBytes;

    return {
      totalEventsProcessed: this.metrics.totalEventsProcessed,
      totalBatchesCreated: this.metrics.totalBatchesCreated,
      totalBatchesFlushed: this.metrics.totalBatchesFlushed,
      totalBatchesFailed: this.metrics.totalBatchesFailed,
      avgEventsPerBatch: totalBatches > 0
        ? this.metrics.totalEventsProcessed / totalBatches
        : 0,
      avgCompressionRatio: this.metrics.totalOriginalBytes > 0
        ? this.metrics.totalCompressedBytes / this.metrics.totalOriginalBytes
        : 1,
      totalBytesSaved: Math.max(0, totalBytesSaved),
      pendingBatchesCount: this.pendingBatches.size,
      isBackpressured: this.isBackpressured(),
      avgFlushLatencyMs: this.calculateAvgLatency(),
      peakEventsPerSecond: Math.max(0, ...this.metrics.eventsPerSecond),
      currentBufferSize: this.eventBuffer.length,
    };
  }

  /**
   * Get Prometheus-compatible metrics string
   */
  toPrometheusMetrics(): string {
    const metrics = this.getMetrics();
    const labels = 'service="0xscada",component="event_batch_aggregator"';
    const lines: string[] = [];

    lines.push("# HELP event_batch_events_total Total events processed");
    lines.push("# TYPE event_batch_events_total counter");
    lines.push(`event_batch_events_total{${labels}} ${metrics.totalEventsProcessed}`);

    lines.push("# HELP event_batch_batches_created_total Total batches created");
    lines.push("# TYPE event_batch_batches_created_total counter");
    lines.push(`event_batch_batches_created_total{${labels}} ${metrics.totalBatchesCreated}`);

    lines.push("# HELP event_batch_batches_flushed_total Total batches flushed successfully");
    lines.push("# TYPE event_batch_batches_flushed_total counter");
    lines.push(`event_batch_batches_flushed_total{${labels}} ${metrics.totalBatchesFlushed}`);

    lines.push("# HELP event_batch_batches_failed_total Total batches failed");
    lines.push("# TYPE event_batch_batches_failed_total counter");
    lines.push(`event_batch_batches_failed_total{${labels}} ${metrics.totalBatchesFailed}`);

    lines.push("# HELP event_batch_compression_ratio Average compression ratio");
    lines.push("# TYPE event_batch_compression_ratio gauge");
    lines.push(`event_batch_compression_ratio{${labels}} ${metrics.avgCompressionRatio.toFixed(4)}`);

    lines.push("# HELP event_batch_bytes_saved_total Total bytes saved by compression");
    lines.push("# TYPE event_batch_bytes_saved_total counter");
    lines.push(`event_batch_bytes_saved_total{${labels}} ${metrics.totalBytesSaved}`);

    lines.push("# HELP event_batch_pending_count Current pending batches");
    lines.push("# TYPE event_batch_pending_count gauge");
    lines.push(`event_batch_pending_count{${labels}} ${metrics.pendingBatchesCount}`);

    lines.push("# HELP event_batch_buffer_size Current buffer size");
    lines.push("# TYPE event_batch_buffer_size gauge");
    lines.push(`event_batch_buffer_size{${labels}} ${metrics.currentBufferSize}`);

    lines.push("# HELP event_batch_backpressured Is backpressure applied");
    lines.push("# TYPE event_batch_backpressured gauge");
    lines.push(`event_batch_backpressured{${labels}} ${metrics.isBackpressured ? 1 : 0}`);

    lines.push("# HELP event_batch_flush_latency_ms Average flush latency");
    lines.push("# TYPE event_batch_flush_latency_ms gauge");
    lines.push(`event_batch_flush_latency_ms{${labels}} ${metrics.avgFlushLatencyMs.toFixed(2)}`);

    return lines.join("\n");
  }

  /**
   * Check if backpressure is currently applied
   */
  isBackpressured(): boolean {
    if (!this.config.enableBackpressure) {
      return false;
    }
    return this.pendingBatches.size >= this.config.backpressureThreshold;
  }

  /**
   * Get current buffer size
   */
  getBufferSize(): number {
    return this.eventBuffer.length;
  }

  /**
   * Get pending batches count
   */
  getPendingBatchesCount(): number {
    return this.pendingBatches.size;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<BatchConfig>): void {
    this.config = { ...this.config, ...config };

    // Restart timer if window changed
    if (config.maxBatchWindowMs !== undefined && this.flushTimer) {
      this.stopFlushTimer();
      this.startFlushTimer();
    }
  }

  /**
   * Decompress a batch for reading
   */
  async decompressBatch(batch: CompressedBatch): Promise<BatchEvent[]> {
    if (!this.config.enableCompression) {
      return JSON.parse(Buffer.from(batch.compressedData, "base64").toString("utf-8"));
    }

    const compressedBuffer = Buffer.from(batch.compressedData, "base64");
    const decompressedBuffer = await gunzipAsync(compressedBuffer);
    return JSON.parse(decompressedBuffer.toString("utf-8"));
  }

  /**
   * Gracefully shutdown the aggregator
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    // Stop timers
    this.stopFlushTimer();
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }

    // Flush remaining events
    if (this.eventBuffer.length > 0) {
      console.log(`[EventBatchAggregator] Flushing ${this.eventBuffer.length} remaining events...`);
      await this.flush();
    }

    // Wait for pending batches (with timeout)
    const timeout = 10000; // 10 seconds
    const startTime = Date.now();

    while (this.pendingBatches.size > 0 && Date.now() - startTime < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (this.pendingBatches.size > 0) {
      console.warn(`[EventBatchAggregator] ${this.pendingBatches.size} batches still pending at shutdown`);
    }

    this.emit("shutdown");
    console.log("[EventBatchAggregator] Shutdown complete");
  }

  /**
   * Reset metrics (for testing)
   */
  resetMetrics(): void {
    this.metrics = {
      totalEventsProcessed: 0,
      totalBatchesCreated: 0,
      totalBatchesFlushed: 0,
      totalBatchesFailed: 0,
      totalOriginalBytes: 0,
      totalCompressedBytes: 0,
      flushLatencies: [],
      eventsPerSecond: [],
      lastEventTimestamp: Date.now(),
      eventCountSinceLastSecond: 0,
    };
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  private async createBatch(events: BatchEvent[]): Promise<CompressedBatch> {
    const batchId = this.generateBatchId();
    const siteIds = [...new Set(events.map((e) => e.siteId))];
    const eventTypes = [...new Set(events.map((e) => e.type))];

    const jsonData = JSON.stringify(events);
    const originalSize = Buffer.byteLength(jsonData, "utf-8");

    let compressedData: string;
    let compressedSize: number;

    if (this.config.enableCompression) {
      const compressed = await gzipAsync(jsonData, {
        level: this.config.compressionLevel,
      });
      compressedData = compressed.toString("base64");
      compressedSize = compressed.length;
    } else {
      compressedData = Buffer.from(jsonData).toString("base64");
      compressedSize = originalSize;
    }

    // Update metrics
    this.metrics.totalOriginalBytes += originalSize;
    this.metrics.totalCompressedBytes += compressedSize;

    return {
      batchId,
      eventCount: events.length,
      compressedData,
      originalSize,
      compressedSize,
      compressionRatio: compressedSize / originalSize,
      createdAt: new Date(),
      siteIds,
      eventTypes,
    };
  }

  private async executeFlushHandlers(batch: CompressedBatch): Promise<void> {
    if (this.flushHandlers.length === 0) {
      return;
    }

    const promises = this.flushHandlers.map(async (handler) => {
      try {
        await handler(batch);
      } catch (error) {
        console.error("[EventBatchAggregator] Flush handler error:", error);
        throw error;
      }
    });

    await Promise.all(promises);
  }

  private generateBatchId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `batch-${timestamp}-${random}`;
  }

  private startFlushTimer(): void {
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((err) => {
        console.error("[EventBatchAggregator] Timer flush error:", err);
      });
    }, this.config.maxBatchWindowMs);
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private recordFlushLatency(latencyMs: number): void {
    this.metrics.flushLatencies.push(latencyMs);
    // Keep only last 100 samples
    if (this.metrics.flushLatencies.length > 100) {
      this.metrics.flushLatencies.shift();
    }
  }

  private calculateAvgLatency(): number {
    if (this.metrics.flushLatencies.length === 0) {
      return 0;
    }
    const sum = this.metrics.flushLatencies.reduce((a, b) => a + b, 0);
    return sum / this.metrics.flushLatencies.length;
  }

  private startMetricsCollection(): void {
    // Collect events per second metric every second
    this.metricsInterval = setInterval(() => {
      this.metrics.eventsPerSecond.push(this.metrics.eventCountSinceLastSecond);
      this.metrics.eventCountSinceLastSecond = 0;

      // Keep only last 60 samples (1 minute)
      if (this.metrics.eventsPerSecond.length > 60) {
        this.metrics.eventsPerSecond.shift();
      }
    }, 1000);
  }
}

// =============================================================================
// SINGLETON & FACTORY
// =============================================================================

let defaultAggregator: EventBatchAggregator | null = null;

/**
 * Get or create the default aggregator instance
 */
export function getEventBatchAggregator(config?: Partial<BatchConfig>): EventBatchAggregator {
  if (!defaultAggregator) {
    defaultAggregator = new EventBatchAggregator(config);
  }
  return defaultAggregator;
}

/**
 * Create a new aggregator instance (for testing or isolated use)
 */
export function createEventBatchAggregator(config?: Partial<BatchConfig>): EventBatchAggregator {
  return new EventBatchAggregator(config);
}

/**
 * Reset the default aggregator (for testing)
 */
export async function resetDefaultAggregator(): Promise<void> {
  if (defaultAggregator) {
    await defaultAggregator.shutdown();
    defaultAggregator = null;
  }
}

export default EventBatchAggregator;
