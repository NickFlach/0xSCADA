/**
 * Event Integrity Pipeline Core
 * 
 * Handles event ingestion, SHA-256 hashing, and batching by configurable time windows.
 * Part of the Dual-Time Control Plane (ADR-0021).
 */

import { createHash } from 'crypto';
import { EventEmitter } from 'events';

export interface SCADAEvent {
  id: string;
  timestamp: number;
  type: string;
  source: string;
  data: Record<string, any>;
  signature?: string;
}

export interface HashedEvent extends SCADAEvent {
  hash: string;
}

export interface EventBatch {
  id: string;
  windowStart: number;
  windowEnd: number;
  events: HashedEvent[];
  batchHash: string;
  created: number;
}

export interface PipelineConfig {
  windowSizeMs: number; // Time window size in milliseconds
  maxBatchSize: number; // Maximum events per batch
  flushIntervalMs: number; // Force flush interval
}

export class EventIntegrityPipeline extends EventEmitter {
  private config: PipelineConfig;
  private currentBatch: HashedEvent[] = [];
  private currentWindowStart: number = 0;
  private flushTimer?: NodeJS.Timeout;
  private eventCounter = 0;

  constructor(config: Partial<PipelineConfig> = {}) {
    super();
    
    this.config = {
      windowSizeMs: config.windowSizeMs || 60000, // Default 1 minute
      maxBatchSize: config.maxBatchSize || 1000, // Default 1000 events
      flushIntervalMs: config.flushIntervalMs || 30000, // Default 30 seconds
    };

    this.initializeWindow();
    this.startFlushTimer();
  }

  /**
   * Ingest a new event into the pipeline
   */
  async ingestEvent(event: SCADAEvent): Promise<void> {
    try {
      // Hash the event
      const hashedEvent = this.hashEvent(event);
      
      // Check if we need a new time window
      if (this.shouldStartNewWindow(hashedEvent.timestamp)) {
        await this.flushCurrentBatch();
        this.initializeWindow(hashedEvent.timestamp);
      }

      // Add to current batch
      this.currentBatch.push(hashedEvent);
      this.emit('event-ingested', hashedEvent);

      // Check if batch is full
      if (this.currentBatch.length >= this.config.maxBatchSize) {
        await this.flushCurrentBatch();
      }

    } catch (error) {
      this.emit('error', { error, event });
      throw error;
    }
  }

  /**
   * Generate SHA-256 hash for an event
   */
  private hashEvent(event: SCADAEvent): HashedEvent {
    // Create canonical representation for hashing
    const canonical = {
      id: event.id,
      timestamp: event.timestamp,
      type: event.type,
      source: event.source,
      data: this.canonicalizeData(event.data),
    };

    const canonicalString = JSON.stringify(canonical);
    const hash = createHash('sha256').update(canonicalString, 'utf8').digest('hex');

    return {
      ...event,
      hash,
    };
  }

  /**
   * Create canonical representation of event data for consistent hashing
   */
  private canonicalizeData(data: Record<string, any>): Record<string, any> {
    // Sort keys recursively to ensure consistent ordering
    if (typeof data !== 'object' || data === null) {
      return data;
    }

    if (Array.isArray(data)) {
      return data.map(item => this.canonicalizeData(item));
    }

    const sorted: Record<string, any> = {};
    const keys = Object.keys(data).sort();
    for (const key of keys) {
      sorted[key] = this.canonicalizeData(data[key]);
    }

    return sorted;
  }

  /**
   * Check if we should start a new time window
   */
  private shouldStartNewWindow(eventTimestamp: number): boolean {
    if (this.currentWindowStart === 0) {
      return false; // First event
    }

    return eventTimestamp >= this.currentWindowStart + this.config.windowSizeMs;
  }

  /**
   * Initialize a new time window
   */
  private initializeWindow(timestamp?: number): void {
    const now = timestamp || Date.now();
    this.currentWindowStart = Math.floor(now / this.config.windowSizeMs) * this.config.windowSizeMs;
    this.currentBatch = [];
  }

  /**
   * Flush current batch and create an EventBatch
   */
  private async flushCurrentBatch(): Promise<EventBatch | null> {
    if (this.currentBatch.length === 0) {
      return null;
    }

    try {
      const batch: EventBatch = {
        id: `batch_${this.currentWindowStart}_${++this.eventCounter}`,
        windowStart: this.currentWindowStart,
        windowEnd: this.currentWindowStart + this.config.windowSizeMs,
        events: [...this.currentBatch],
        batchHash: this.computeBatchHash(this.currentBatch),
        created: Date.now(),
      };

      this.emit('batch-created', batch);
      this.currentBatch = [];
      
      return batch;
    } catch (error) {
      this.emit('error', { error, context: 'batch-flush' });
      throw error;
    }
  }

  /**
   * Compute hash for an entire batch
   */
  private computeBatchHash(events: HashedEvent[]): string {
    // Sort events by timestamp, then by hash for deterministic ordering
    const sortedEvents = events
      .slice()
      .sort((a, b) => {
        if (a.timestamp !== b.timestamp) {
          return a.timestamp - b.timestamp;
        }
        return a.hash.localeCompare(b.hash);
      });

    // Concatenate all event hashes
    const concatenatedHashes = sortedEvents.map(event => event.hash).join('');
    return createHash('sha256').update(concatenatedHashes, 'utf8').digest('hex');
  }

  /**
   * Start the periodic flush timer
   */
  private startFlushTimer(): void {
    this.flushTimer = setInterval(async () => {
      try {
        await this.flushCurrentBatch();
      } catch (error) {
        this.emit('error', { error, context: 'timer-flush' });
      }
    }, this.config.flushIntervalMs);
  }

  /**
   * Stop the pipeline and clean up resources
   */
  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }

    // Flush any remaining events
    await this.flushCurrentBatch();
    this.emit('stopped');
  }

  /**
   * Get current pipeline statistics
   */
  getStats() {
    return {
      currentBatchSize: this.currentBatch.length,
      currentWindowStart: this.currentWindowStart,
      config: this.config,
      isActive: !!this.flushTimer,
    };
  }
}

export default EventIntegrityPipeline;