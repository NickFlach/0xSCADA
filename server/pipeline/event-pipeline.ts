/**
 * Event Integrity Pipeline
 * Issue #289: Wire event-batcher into event stream
 * 
 * Central event processing pipeline that orchestrates event ingestion,
 * batching, and forwarding to downstream systems like blockchain anchoring.
 */

import { EventEmitter } from "events";
import pino from "pino";
import { z } from "zod";
import { 
  createEventBatcher, 
  type Event, 
  type EventBatch, 
  type EventBatcher,
  type EventBatcherConfig 
} from "../kernel/event-batcher";

// ─── Pipeline Configuration ─────────────────────────────────────────────────

const EventPipelineConfigSchema = z.object({
  /** Event batcher configuration */
  batcher: z.object({
    max_events_per_batch: z.number().int().min(1).default(100),
    max_batch_time_ms: z.number().int().min(100).default(5000),
    max_batch_size_bytes: z.number().int().min(1024).default(1024 * 1024),
    enable_compression: z.boolean().default(true),
    compression_level: z.number().int().min(1).max(9).default(6),
    log_level: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  }).default({}),
  /** Pipeline-specific settings */
  pipeline: z.object({
    /** Enable automatic forwarding to blockchain bridge */
    enable_bridge_forwarding: z.boolean().default(true),
    /** Minimum batch size to forward to bridge */
    min_bridge_batch_size: z.number().int().min(1).default(5),
    /** Enable event deduplication */
    enable_deduplication: z.boolean().default(true),
    /** Deduplication window in ms */
    dedup_window_ms: z.number().int().min(1000).default(30000),
    /** Maximum pipeline queue depth before backpressure */
    max_pipeline_queue: z.number().int().min(100).default(10000),
  }).default({}),
});

export type EventPipelineConfig = z.infer<typeof EventPipelineConfigSchema>;

// ─── Pipeline Metrics Interface ─────────────────────────────────────────────

export interface EventPipelineMetrics {
  /** Events received by pipeline */
  events_received: number;
  /** Events forwarded to batcher */
  events_batched: number;
  /** Events deduplicated */
  events_deduplicated: number;
  /** Events dropped due to errors */
  events_dropped: number;
  /** Batches processed */
  batches_processed: number;
  /** Batches forwarded to bridge */
  batches_forwarded: number;
  /** Current pipeline queue depth */
  pipeline_queue_depth: number;
  /** Pipeline uptime in ms */
  uptime_ms: number;
  /** Last event timestamp */
  last_event_timestamp: string | null;
}

// ─── Event Source Interface ─────────────────────────────────────────────────

export interface EventSource {
  id: string;
  name: string;
  type: "plc" | "scada" | "historian" | "alarm" | "maintenance" | "system";
  active: boolean;
  last_sequence: number;
  metadata?: Record<string, any>;
}

// ─── Main Event Pipeline Class ──────────────────────────────────────────────

export class EventPipeline extends EventEmitter {
  private readonly config: EventPipelineConfig;
  private readonly logger: pino.Logger;
  private readonly batcher: EventBatcher;
  private readonly eventSources = new Map<string, EventSource>();
  private readonly recentEvents = new Map<string, number>(); // For deduplication
  private readonly startTime = Date.now();
  
  private metrics: EventPipelineMetrics = {
    events_received: 0,
    events_batched: 0,
    events_deduplicated: 0,
    events_dropped: 0,
    batches_processed: 0,
    batches_forwarded: 0,
    pipeline_queue_depth: 0,
    uptime_ms: 0,
    last_event_timestamp: null,
  };

  private dedupCleanupTimer: NodeJS.Timeout;

  constructor(config: Partial<EventPipelineConfig> = {}) {
    super();
    this.config = EventPipelineConfigSchema.parse(config);
    this.logger = pino({ 
      level: this.config.batcher.log_level,
      name: "event-pipeline"
    });

    // Initialize event batcher
    this.batcher = createEventBatcher(this.config.batcher);

    // Listen for batch events
    this.batcher.on("batch", this.handleBatch.bind(this));

    // Setup deduplication cleanup
    this.dedupCleanupTimer = setInterval(
      this.cleanupDeduplication.bind(this),
      this.config.pipeline.dedup_window_ms
    );

    this.logger.info("EventPipeline initialized", { config: this.config });
  }

  /**
   * Register an event source
   */
  public registerSource(source: Omit<EventSource, "last_sequence">): void {
    const fullSource: EventSource = {
      ...source,
      last_sequence: 0,
    };
    
    this.eventSources.set(source.id, fullSource);
    this.logger.info("Event source registered", { source_id: source.id, name: source.name, type: source.type });
  }

  /**
   * Unregister an event source
   */
  public unregisterSource(sourceId: string): boolean {
    const removed = this.eventSources.delete(sourceId);
    if (removed) {
      this.logger.info("Event source unregistered", { source_id: sourceId });
    }
    return removed;
  }

  /**
   * Get registered event sources
   */
  public getEventSources(): EventSource[] {
    return Array.from(this.eventSources.values());
  }

  /**
   * Process an incoming event through the pipeline
   */
  public async processEvent(event: Event): Promise<boolean> {
    this.metrics.events_received++;
    this.metrics.last_event_timestamp = event.timestamp;
    this.updateUptime();

    try {
      // Validate event source
      const source = this.eventSources.get(event.source_id);
      if (!source) {
        this.logger.warn("Event from unregistered source", { source_id: event.source_id });
        // Auto-register unknown sources as "system" type
        this.registerSource({
          id: event.source_id,
          name: `Unknown Source ${event.source_id}`,
          type: "system",
          active: true,
        });
      }

      // Check for deduplication
      if (this.config.pipeline.enable_deduplication) {
        const eventKey = `${event.source_id}:${event.event_type}:${event.payload_hash}`;
        const now = Date.now();
        
        if (this.recentEvents.has(eventKey)) {
          this.metrics.events_deduplicated++;
          this.logger.debug("Duplicate event detected, skipping", { 
            source_id: event.source_id, 
            event_type: event.event_type 
          });
          return false;
        }
        
        this.recentEvents.set(eventKey, now);
      }

      // Update source sequence tracking
      if (source) {
        if (event.sequence_number > source.last_sequence) {
          source.last_sequence = event.sequence_number;
        } else {
          this.logger.warn("Out-of-order event sequence", {
            source_id: event.source_id,
            received_seq: event.sequence_number,
            last_seq: source.last_sequence,
          });
        }
      }

      // Forward to batcher
      const success = await this.batcher.ingest(event);
      
      if (success) {
        this.metrics.events_batched++;
        this.emit("event:processed", event);
      } else {
        this.metrics.events_dropped++;
        this.emit("event:dropped", event, "batcher_backpressure");
      }

      return success;

    } catch (error: any) {
      this.metrics.events_dropped++;
      this.logger.error("Event processing error", { 
        error: error.message,
        source_id: event.source_id,
        event_type: event.event_type,
      });
      this.emit("event:error", event, error);
      return false;
    }
  }

  /**
   * Process multiple events in batch
   */
  public async processBulkEvents(events: Event[]): Promise<{ processed: number; dropped: number }> {
    let processed = 0;
    let dropped = 0;

    for (const event of events) {
      const success = await this.processEvent(event);
      if (success) {
        processed++;
      } else {
        dropped++;
      }
    }

    this.logger.info("Bulk events processed", { 
      total: events.length, 
      processed, 
      dropped 
    });

    return { processed, dropped };
  }

  /**
   * Force flush current batch
   */
  public async flushBatch(): Promise<EventBatch | null> {
    return await this.batcher.flush();
  }

  /**
   * Get pipeline and batcher metrics combined
   */
  public getMetrics(): EventPipelineMetrics & { batcher: any } {
    this.updateUptime();
    const batcherMetrics = this.batcher.getMetrics();
    
    return {
      ...this.metrics,
      batcher: batcherMetrics,
    };
  }

  /**
   * Get pipeline health status
   */
  public getHealthStatus(): { 
    status: "healthy" | "degraded" | "unhealthy";
    issues: string[];
    metrics: EventPipelineMetrics;
  } {
    const issues: string[] = [];
    let status: "healthy" | "degraded" | "unhealthy" = "healthy";

    // Check drop rate
    if (this.metrics.events_received > 0) {
      const dropRate = this.metrics.events_dropped / this.metrics.events_received;
      if (dropRate > 0.05) { // >5% drop rate
        issues.push(`High event drop rate: ${(dropRate * 100).toFixed(1)}%`);
        status = "unhealthy";
      } else if (dropRate > 0.01) { // >1% drop rate
        issues.push(`Elevated event drop rate: ${(dropRate * 100).toFixed(1)}%`);
        if (status === "healthy") status = "degraded";
      }
    }

    // Check queue depth
    if (this.metrics.pipeline_queue_depth > this.config.pipeline.max_pipeline_queue * 0.8) {
      issues.push("Pipeline queue near capacity");
      if (status === "healthy") status = "degraded";
    }

    // Check if no recent events
    if (this.metrics.last_event_timestamp) {
      const timeSinceLastEvent = Date.now() - new Date(this.metrics.last_event_timestamp).getTime();
      if (timeSinceLastEvent > 300000) { // 5 minutes
        issues.push("No recent events received");
        if (status === "healthy") status = "degraded";
      }
    }

    this.updateUptime();
    return { status, issues, metrics: this.metrics };
  }

  // ─── Private Methods ─────────────────────────────────────────────────────

  private handleBatch(batch: EventBatch): void {
    this.metrics.batches_processed++;

    this.logger.info("Batch received from batcher", {
      batch_id: batch.id,
      event_count: batch.events.length,
      merkle_root: batch.merkle_root,
    });

    // Forward to bridge if enabled and batch meets minimum size
    if (this.config.pipeline.enable_bridge_forwarding && 
        batch.events.length >= this.config.pipeline.min_bridge_batch_size) {
      this.forwardToBridge(batch);
    }

    this.emit("batch:ready", batch);
  }

  private forwardToBridge(batch: EventBatch): void {
    this.metrics.batches_forwarded++;
    
    this.logger.info("Forwarding batch to bridge", {
      batch_id: batch.id,
      event_count: batch.events.length,
    });

    // TODO: Implement actual bridge integration
    // For now, just emit an event
    this.emit("batch:forwarded", batch);
  }

  private cleanupDeduplication(): void {
    const now = Date.now();
    const windowMs = this.config.pipeline.dedup_window_ms;
    let cleaned = 0;

    for (const [key, timestamp] of this.recentEvents) {
      if (now - timestamp > windowMs) {
        this.recentEvents.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.debug("Cleaned up deduplication cache", { entries_removed: cleaned });
    }
  }

  private updateUptime(): void {
    this.metrics.uptime_ms = Date.now() - this.startTime;
  }

  /**
   * Graceful shutdown
   */
  public async shutdown(): Promise<void> {
    this.logger.info("EventPipeline shutting down");

    // Clear timers
    if (this.dedupCleanupTimer) {
      clearInterval(this.dedupCleanupTimer);
    }

    // Shutdown batcher
    await this.batcher.shutdown();

    this.logger.info("EventPipeline shutdown complete");
  }
}

// ─── Factory Function ───────────────────────────────────────────────────────

export function createEventPipeline(config?: Partial<EventPipelineConfig>): EventPipeline {
  return new EventPipeline(config);
}

// ─── Default Pipeline Instance ──────────────────────────────────────────────

let defaultPipeline: EventPipeline | null = null;

export function getDefaultEventPipeline(config?: Partial<EventPipelineConfig>): EventPipeline {
  if (!defaultPipeline) {
    defaultPipeline = createEventPipeline(config);
    
    // Register some default event sources
    defaultPipeline.registerSource({
      id: "system",
      name: "System Events",
      type: "system",
      active: true,
    });
    
    defaultPipeline.registerSource({
      id: "simulator",
      name: "PLC Simulator",
      type: "plc",
      active: true,
    });
  }
  
  return defaultPipeline;
}