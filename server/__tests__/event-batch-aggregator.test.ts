/**
 * Event Batch Aggregator Tests
 *
 * Issue #85 - Performance: Event Batch Aggregation & Compression Pipeline
 *
 * Tests for:
 * - Batch collection with time and count windows
 * - Compression functionality
 * - Backpressure handling
 * - Metrics collection
 * - Async flush operations
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  EventBatchAggregator,
  createEventBatchAggregator,
  type BatchEvent,
  type BatchConfig,
  type CompressedBatch,
  type FlushResult,
} from "../services/event-batch-aggregator";

// =============================================================================
// TEST HELPERS
// =============================================================================

function createTestEvent(overrides: Partial<BatchEvent> = {}): BatchEvent {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
    type: "test-event",
    timestamp: new Date(),
    siteId: "site-001",
    payload: { value: Math.random() * 100 },
    ...overrides,
  };
}

function createTestEvents(count: number, overrides: Partial<BatchEvent> = {}): BatchEvent[] {
  return Array.from({ length: count }, (_, i) =>
    createTestEvent({
      id: `evt-${i}`,
      payload: { value: i, index: i },
      ...overrides,
    })
  );
}

async function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// UNIT TESTS: Basic Functionality
// =============================================================================

describe("EventBatchAggregator - Basic Functionality", () => {
  let aggregator: EventBatchAggregator;

  beforeEach(() => {
    aggregator = createEventBatchAggregator({
      maxBatchSize: 10,
      maxBatchWindowMs: 1000,
      enableCompression: true,
      compressionLevel: 6,
    });
  });

  afterEach(async () => {
    await aggregator.shutdown();
  });

  it("should create an instance with default config", () => {
    const defaultAggregator = createEventBatchAggregator();
    expect(defaultAggregator).toBeInstanceOf(EventBatchAggregator);
    expect(defaultAggregator.getBufferSize()).toBe(0);
    defaultAggregator.shutdown();
  });

  it("should accept custom configuration", () => {
    const customConfig: Partial<BatchConfig> = {
      maxBatchSize: 50,
      maxBatchWindowMs: 2000,
      enableCompression: false,
    };
    const customAggregator = createEventBatchAggregator(customConfig);
    expect(customAggregator).toBeInstanceOf(EventBatchAggregator);
    customAggregator.shutdown();
  });

  it("should add events to the buffer", () => {
    const event = createTestEvent();
    const result = aggregator.addEvent(event);

    expect(result).toBe(true);
    expect(aggregator.getBufferSize()).toBe(1);
  });

  it("should add multiple events at once", () => {
    const events = createTestEvents(5);
    const addedCount = aggregator.addEvents(events);

    expect(addedCount).toBe(5);
    expect(aggregator.getBufferSize()).toBe(5);
  });

  it("should emit event:added when event is added", () => {
    const eventHandler = vi.fn();
    aggregator.on("event:added", eventHandler);

    const event = createTestEvent();
    aggregator.addEvent(event);

    expect(eventHandler).toHaveBeenCalledWith(event);
  });

  it("should track events processed metric", () => {
    const events = createTestEvents(5);
    aggregator.addEvents(events);

    const metrics = aggregator.getMetrics();
    expect(metrics.totalEventsProcessed).toBe(5);
  });
});

// =============================================================================
// UNIT TESTS: Count-Based Windowing
// =============================================================================

describe("EventBatchAggregator - Count-Based Windowing", () => {
  let aggregator: EventBatchAggregator;
  let flushedBatches: CompressedBatch[];

  beforeEach(() => {
    flushedBatches = [];
    aggregator = createEventBatchAggregator({
      maxBatchSize: 5,
      maxBatchWindowMs: 60000, // Long window to avoid time-based flush
      enableCompression: true,
    });

    aggregator.onFlush(async (batch) => {
      flushedBatches.push(batch);
    });
  });

  afterEach(async () => {
    await aggregator.shutdown();
  });

  it("should auto-flush when batch size is reached", async () => {
    const events = createTestEvents(5);
    aggregator.addEvents(events);

    // Wait for async flush
    await waitFor(100);

    expect(flushedBatches.length).toBe(1);
    expect(flushedBatches[0].eventCount).toBe(5);
  });

  it("should flush multiple batches for many events", async () => {
    const events = createTestEvents(12);
    aggregator.addEvents(events);

    // Wait for async flushes
    await waitFor(200);

    // First 5 events should be flushed, next 5 should be flushed
    // Remaining 2 should still be in buffer
    expect(flushedBatches.length).toBe(2);
    expect(aggregator.getBufferSize()).toBe(2);
  });

  it("should include correct event count in batch", async () => {
    const events = createTestEvents(5);
    aggregator.addEvents(events);

    await waitFor(100);

    expect(flushedBatches[0].eventCount).toBe(5);
  });

  it("should track batch created metric", async () => {
    const events = createTestEvents(5);
    aggregator.addEvents(events);

    await waitFor(100);

    const metrics = aggregator.getMetrics();
    expect(metrics.totalBatchesCreated).toBe(1);
  });
});

// =============================================================================
// UNIT TESTS: Time-Based Windowing
// =============================================================================

describe("EventBatchAggregator - Time-Based Windowing", () => {
  let aggregator: EventBatchAggregator;
  let flushedBatches: CompressedBatch[];

  beforeEach(() => {
    flushedBatches = [];
    aggregator = createEventBatchAggregator({
      maxBatchSize: 100, // Large size to avoid count-based flush
      maxBatchWindowMs: 200, // Short window for testing
      enableCompression: true,
    });

    aggregator.onFlush(async (batch) => {
      flushedBatches.push(batch);
    });
  });

  afterEach(async () => {
    await aggregator.shutdown();
  });

  it("should auto-flush after time window expires", async () => {
    const events = createTestEvents(3);
    aggregator.addEvents(events);

    expect(aggregator.getBufferSize()).toBe(3);

    // Wait for time window + some buffer
    await waitFor(300);

    expect(flushedBatches.length).toBe(1);
    expect(flushedBatches[0].eventCount).toBe(3);
    expect(aggregator.getBufferSize()).toBe(0);
  });

  it("should reset timer on manual flush", async () => {
    const events = createTestEvents(3);
    aggregator.addEvents(events);

    // Manual flush before timer
    await aggregator.flush();

    expect(flushedBatches.length).toBe(1);
    expect(aggregator.getBufferSize()).toBe(0);
  });

  it("should not flush empty buffer on timer", async () => {
    // No events added
    await waitFor(300);

    expect(flushedBatches.length).toBe(0);
  });
});

// =============================================================================
// UNIT TESTS: Compression
// =============================================================================

describe("EventBatchAggregator - Compression", () => {
  let aggregator: EventBatchAggregator;

  afterEach(async () => {
    await aggregator.shutdown();
  });

  it("should compress events when enabled", async () => {
    aggregator = createEventBatchAggregator({
      maxBatchSize: 5,
      maxBatchWindowMs: 60000,
      enableCompression: true,
      compressionLevel: 9,
    });

    let flushedBatch: CompressedBatch | null = null;
    aggregator.onFlush(async (batch) => {
      flushedBatch = batch;
    });

    // Add events with repetitive data (compresses well)
    const events = createTestEvents(5, {
      payload: { repeatedData: "a".repeat(1000) },
    });
    aggregator.addEvents(events);

    await waitFor(100);

    expect(flushedBatch).not.toBeNull();
    expect(flushedBatch!.compressionRatio).toBeLessThan(1);
    expect(flushedBatch!.compressedSize).toBeLessThan(flushedBatch!.originalSize);
  });

  it("should not compress when disabled", async () => {
    aggregator = createEventBatchAggregator({
      maxBatchSize: 5,
      maxBatchWindowMs: 60000,
      enableCompression: false,
    });

    let flushedBatch: CompressedBatch | null = null;
    aggregator.onFlush(async (batch) => {
      flushedBatch = batch;
    });

    const events = createTestEvents(5);
    aggregator.addEvents(events);

    await waitFor(100);

    expect(flushedBatch).not.toBeNull();
    // Without compression, sizes should be similar (base64 encoding adds ~33%)
    expect(flushedBatch!.compressionRatio).toBeCloseTo(1, 0);
  });

  it("should decompress batches correctly", async () => {
    aggregator = createEventBatchAggregator({
      maxBatchSize: 5,
      maxBatchWindowMs: 60000,
      enableCompression: true,
    });

    let flushedBatch: CompressedBatch | null = null;
    aggregator.onFlush(async (batch) => {
      flushedBatch = batch;
    });

    const originalEvents = createTestEvents(5);
    aggregator.addEvents(originalEvents);

    await waitFor(100);

    const decompressedEvents = await aggregator.decompressBatch(flushedBatch!);

    expect(decompressedEvents.length).toBe(5);
    expect(decompressedEvents[0].id).toBe(originalEvents[0].id);
    expect(decompressedEvents[0].payload).toEqual(originalEvents[0].payload);
  });

  it("should track compression metrics", async () => {
    aggregator = createEventBatchAggregator({
      maxBatchSize: 5,
      maxBatchWindowMs: 60000,
      enableCompression: true,
    });

    aggregator.onFlush(async () => {});

    const events = createTestEvents(5, {
      payload: { data: "x".repeat(500) },
    });
    aggregator.addEvents(events);

    await waitFor(100);

    const metrics = aggregator.getMetrics();
    expect(metrics.avgCompressionRatio).toBeLessThan(1);
    expect(metrics.totalBytesSaved).toBeGreaterThan(0);
  });
});

// =============================================================================
// UNIT TESTS: Backpressure Handling
// =============================================================================

describe("EventBatchAggregator - Backpressure", () => {
  let aggregator: EventBatchAggregator;

  afterEach(async () => {
    await aggregator.shutdown();
  });

  it("should apply backpressure when threshold is reached", async () => {
    aggregator = createEventBatchAggregator({
      maxBatchSize: 5,
      maxBatchWindowMs: 60000,
      enableBackpressure: true,
      backpressureThreshold: 2,
      maxConcurrentFlushes: 1,
    });

    // Slow flush handler to build up pending batches
    aggregator.onFlush(async () => {
      await waitFor(500);
    });

    // Add events to create multiple batches
    aggregator.addEvents(createTestEvents(5)); // First batch
    aggregator.addEvents(createTestEvents(5)); // Second batch

    await waitFor(50);

    // At this point, backpressure should be applied
    expect(aggregator.isBackpressured()).toBe(true);

    // New events should be rejected
    const result = aggregator.addEvent(createTestEvent());
    expect(result).toBe(false);
  });

  it("should emit backpressure event when applied", async () => {
    aggregator = createEventBatchAggregator({
      maxBatchSize: 5,
      maxBatchWindowMs: 60000,
      enableBackpressure: true,
      backpressureThreshold: 1,
      maxConcurrentFlushes: 1,
    });

    const backpressureHandler = vi.fn();
    aggregator.on("backpressure", backpressureHandler);

    aggregator.onFlush(async () => {
      await waitFor(500);
    });

    aggregator.addEvents(createTestEvents(5));
    await waitFor(50);

    // Try to add more events
    aggregator.addEvent(createTestEvent());

    expect(backpressureHandler).toHaveBeenCalled();
  });

  it("should not apply backpressure when disabled", async () => {
    aggregator = createEventBatchAggregator({
      maxBatchSize: 100,
      maxBatchWindowMs: 60000,
      enableBackpressure: false,
    });

    // Add many events
    const events = createTestEvents(50);
    const addedCount = aggregator.addEvents(events);

    expect(addedCount).toBe(50);
    expect(aggregator.isBackpressured()).toBe(false);
  });

  it("should recover from backpressure when batches complete", async () => {
    aggregator = createEventBatchAggregator({
      maxBatchSize: 5,
      maxBatchWindowMs: 60000,
      enableBackpressure: true,
      backpressureThreshold: 2,
      maxConcurrentFlushes: 3,
    });

    aggregator.onFlush(async () => {
      await waitFor(100);
    });

    // Create backpressure
    aggregator.addEvents(createTestEvents(5));
    aggregator.addEvents(createTestEvents(5));

    await waitFor(50);
    expect(aggregator.isBackpressured()).toBe(true);

    // Wait for flushes to complete
    await waitFor(300);

    expect(aggregator.isBackpressured()).toBe(false);
  });
});

// =============================================================================
// UNIT TESTS: Flush Operations
// =============================================================================

describe("EventBatchAggregator - Flush Operations", () => {
  let aggregator: EventBatchAggregator;

  beforeEach(() => {
    aggregator = createEventBatchAggregator({
      maxBatchSize: 100,
      maxBatchWindowMs: 60000,
      enableCompression: true,
    });
  });

  afterEach(async () => {
    await aggregator.shutdown();
  });

  it("should return null when flushing empty buffer", async () => {
    const result = await aggregator.flush();
    expect(result).toBeNull();
  });

  it("should return flush result with metrics", async () => {
    aggregator.onFlush(async () => {});

    const events = createTestEvents(5);
    aggregator.addEvents(events);

    const result = await aggregator.flush();

    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    expect(result!.batch.eventCount).toBe(5);
    expect(result!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("should emit batch:created event", async () => {
    const createdHandler = vi.fn();
    aggregator.on("batch:created", createdHandler);

    aggregator.onFlush(async () => {});

    aggregator.addEvents(createTestEvents(3));
    await aggregator.flush();

    expect(createdHandler).toHaveBeenCalled();
    expect(createdHandler.mock.calls[0][0].eventCount).toBe(3);
  });

  it("should emit batch:flushed event on success", async () => {
    const flushedHandler = vi.fn();
    aggregator.on("batch:flushed", flushedHandler);

    aggregator.onFlush(async () => {});

    aggregator.addEvents(createTestEvents(3));
    await aggregator.flush();

    expect(flushedHandler).toHaveBeenCalled();
    expect(flushedHandler.mock.calls[0][0].success).toBe(true);
  });

  it("should emit batch:failed event on error", async () => {
    const failedHandler = vi.fn();
    aggregator.on("batch:failed", failedHandler);

    aggregator.onFlush(async () => {
      throw new Error("Flush failed");
    });

    aggregator.addEvents(createTestEvents(3));
    await aggregator.flush();

    expect(failedHandler).toHaveBeenCalled();
    expect(failedHandler.mock.calls[0][0].success).toBe(false);
    expect(failedHandler.mock.calls[0][0].error).toBeInstanceOf(Error);
  });

  it("should re-add events to buffer on flush failure", async () => {
    aggregator.onFlush(async () => {
      throw new Error("Flush failed");
    });

    aggregator.addEvents(createTestEvents(3));
    await aggregator.flush();

    // Events should be back in the buffer
    expect(aggregator.getBufferSize()).toBe(3);
  });

  it("should track failed batches metric", async () => {
    aggregator.onFlush(async () => {
      throw new Error("Flush failed");
    });

    aggregator.addEvents(createTestEvents(3));
    await aggregator.flush();

    const metrics = aggregator.getMetrics();
    expect(metrics.totalBatchesFailed).toBe(1);
  });

  it("should call multiple flush handlers", async () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    aggregator.onFlush(handler1);
    aggregator.onFlush(handler2);

    aggregator.addEvents(createTestEvents(3));
    await aggregator.flush();

    expect(handler1).toHaveBeenCalled();
    expect(handler2).toHaveBeenCalled();
  });

  it("should allow removing flush handlers", async () => {
    const handler = vi.fn();
    aggregator.onFlush(handler);
    aggregator.offFlush(handler);

    aggregator.addEvents(createTestEvents(3));
    await aggregator.flush();

    expect(handler).not.toHaveBeenCalled();
  });
});

// =============================================================================
// UNIT TESTS: Metrics
// =============================================================================

describe("EventBatchAggregator - Metrics", () => {
  let aggregator: EventBatchAggregator;

  beforeEach(() => {
    aggregator = createEventBatchAggregator({
      maxBatchSize: 5,
      maxBatchWindowMs: 60000,
      enableCompression: true,
    });

    aggregator.onFlush(async () => {});
  });

  afterEach(async () => {
    await aggregator.shutdown();
  });

  it("should track total events processed", async () => {
    aggregator.addEvents(createTestEvents(10));
    await waitFor(200);

    const metrics = aggregator.getMetrics();
    expect(metrics.totalEventsProcessed).toBe(10);
  });

  it("should track batches created and flushed", async () => {
    aggregator.addEvents(createTestEvents(10));
    await waitFor(200);

    const metrics = aggregator.getMetrics();
    expect(metrics.totalBatchesCreated).toBe(2);
    expect(metrics.totalBatchesFlushed).toBe(2);
  });

  it("should calculate average events per batch", async () => {
    aggregator.addEvents(createTestEvents(10));
    await waitFor(200);

    const metrics = aggregator.getMetrics();
    expect(metrics.avgEventsPerBatch).toBe(5);
  });

  it("should track current buffer size", () => {
    aggregator.addEvents(createTestEvents(3));

    const metrics = aggregator.getMetrics();
    expect(metrics.currentBufferSize).toBe(3);
  });

  it("should track pending batches count", async () => {
    aggregator = createEventBatchAggregator({
      maxBatchSize: 5,
      maxBatchWindowMs: 60000,
      maxConcurrentFlushes: 1,
    });

    aggregator.onFlush(async () => {
      await waitFor(200);
    });

    aggregator.addEvents(createTestEvents(5));
    await waitFor(50);

    const metrics = aggregator.getMetrics();
    expect(metrics.pendingBatchesCount).toBeGreaterThan(0);
  });

  it("should track flush latency", async () => {
    aggregator.onFlush(async () => {
      await waitFor(50);
    });

    aggregator.addEvents(createTestEvents(5));
    await waitFor(200);

    const metrics = aggregator.getMetrics();
    expect(metrics.avgFlushLatencyMs).toBeGreaterThan(0);
  });

  it("should generate Prometheus metrics", async () => {
    aggregator.addEvents(createTestEvents(5));
    await waitFor(100);

    const prometheusMetrics = aggregator.toPrometheusMetrics();

    expect(prometheusMetrics).toContain("event_batch_events_total");
    expect(prometheusMetrics).toContain("event_batch_batches_created_total");
    expect(prometheusMetrics).toContain("event_batch_compression_ratio");
    expect(prometheusMetrics).toContain('component="event_batch_aggregator"');
  });

  it("should reset metrics", async () => {
    aggregator.addEvents(createTestEvents(5));
    await waitFor(100);

    aggregator.resetMetrics();

    const metrics = aggregator.getMetrics();
    expect(metrics.totalEventsProcessed).toBe(0);
    expect(metrics.totalBatchesCreated).toBe(0);
  });
});

// =============================================================================
// UNIT TESTS: Batch Content
// =============================================================================

describe("EventBatchAggregator - Batch Content", () => {
  let aggregator: EventBatchAggregator;

  beforeEach(() => {
    aggregator = createEventBatchAggregator({
      maxBatchSize: 10,
      maxBatchWindowMs: 60000,
      enableCompression: true,
    });
  });

  afterEach(async () => {
    await aggregator.shutdown();
  });

  it("should include unique site IDs in batch", async () => {
    let batch: CompressedBatch | null = null;
    aggregator.onFlush(async (b) => {
      batch = b;
    });

    const events = [
      createTestEvent({ siteId: "site-001" }),
      createTestEvent({ siteId: "site-002" }),
      createTestEvent({ siteId: "site-001" }),
      createTestEvent({ siteId: "site-003" }),
    ];
    aggregator.addEvents(events);
    await aggregator.flush();

    expect(batch!.siteIds).toHaveLength(3);
    expect(batch!.siteIds).toContain("site-001");
    expect(batch!.siteIds).toContain("site-002");
    expect(batch!.siteIds).toContain("site-003");
  });

  it("should include unique event types in batch", async () => {
    let batch: CompressedBatch | null = null;
    aggregator.onFlush(async (b) => {
      batch = b;
    });

    const events = [
      createTestEvent({ type: "alarm" }),
      createTestEvent({ type: "reading" }),
      createTestEvent({ type: "alarm" }),
      createTestEvent({ type: "status" }),
    ];
    aggregator.addEvents(events);
    await aggregator.flush();

    expect(batch!.eventTypes).toHaveLength(3);
    expect(batch!.eventTypes).toContain("alarm");
    expect(batch!.eventTypes).toContain("reading");
    expect(batch!.eventTypes).toContain("status");
  });

  it("should generate unique batch IDs", async () => {
    const batchIds: string[] = [];
    aggregator.onFlush(async (batch) => {
      batchIds.push(batch.batchId);
    });

    aggregator.addEvents(createTestEvents(10));
    aggregator.addEvents(createTestEvents(10));
    await waitFor(200);

    expect(new Set(batchIds).size).toBe(batchIds.length);
    batchIds.forEach((id) => {
      expect(id).toMatch(/^batch-/);
    });
  });

  it("should include timestamps in batch", async () => {
    let batch: CompressedBatch | null = null;
    aggregator.onFlush(async (b) => {
      batch = b;
    });

    aggregator.addEvents(createTestEvents(5));
    await aggregator.flush();

    expect(batch!.createdAt).toBeInstanceOf(Date);
    expect(batch!.flushedAt).toBeInstanceOf(Date);
  });
});

// =============================================================================
// UNIT TESTS: Configuration Updates
// =============================================================================

describe("EventBatchAggregator - Configuration", () => {
  let aggregator: EventBatchAggregator;

  beforeEach(() => {
    aggregator = createEventBatchAggregator({
      maxBatchSize: 10,
      maxBatchWindowMs: 1000,
    });
  });

  afterEach(async () => {
    await aggregator.shutdown();
  });

  it("should allow updating batch size", async () => {
    aggregator.onFlush(async () => {});

    aggregator.updateConfig({ maxBatchSize: 3 });
    aggregator.addEvents(createTestEvents(3));

    await waitFor(100);

    const metrics = aggregator.getMetrics();
    expect(metrics.totalBatchesFlushed).toBe(1);
  });

  it("should allow updating time window", () => {
    aggregator.updateConfig({ maxBatchWindowMs: 5000 });
    // No assertion needed, just verify no errors
  });

  it("should allow updating compression settings", () => {
    aggregator.updateConfig({
      enableCompression: false,
      compressionLevel: 1,
    });
    // No assertion needed, just verify no errors
  });
});

// =============================================================================
// UNIT TESTS: Shutdown
// =============================================================================

describe("EventBatchAggregator - Shutdown", () => {
  it("should flush remaining events on shutdown", async () => {
    const flushedBatches: CompressedBatch[] = [];
    const aggregator = createEventBatchAggregator({
      maxBatchSize: 100,
      maxBatchWindowMs: 60000,
    });

    aggregator.onFlush(async (batch) => {
      flushedBatches.push(batch);
    });

    aggregator.addEvents(createTestEvents(5));
    expect(aggregator.getBufferSize()).toBe(5);

    await aggregator.shutdown();

    expect(flushedBatches.length).toBe(1);
    expect(flushedBatches[0].eventCount).toBe(5);
  });

  it("should emit shutdown event", async () => {
    const aggregator = createEventBatchAggregator();
    const shutdownHandler = vi.fn();
    aggregator.on("shutdown", shutdownHandler);

    await aggregator.shutdown();

    expect(shutdownHandler).toHaveBeenCalled();
  });

  it("should reject new events after shutdown", async () => {
    const aggregator = createEventBatchAggregator();
    await aggregator.shutdown();

    const result = aggregator.addEvent(createTestEvent());
    expect(result).toBe(false);
  });

  it("should wait for pending batches on shutdown", async () => {
    const aggregator = createEventBatchAggregator({
      maxBatchSize: 5,
      maxConcurrentFlushes: 1,
    });

    let flushCompleted = false;
    aggregator.onFlush(async () => {
      await waitFor(200);
      flushCompleted = true;
    });

    aggregator.addEvents(createTestEvents(5));
    await waitFor(50);

    await aggregator.shutdown();

    expect(flushCompleted).toBe(true);
  });
});

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

describe("EventBatchAggregator - Integration", () => {
  it("should handle high throughput", async () => {
    const aggregator = createEventBatchAggregator({
      maxBatchSize: 100,
      maxBatchWindowMs: 100,
      enableCompression: true,
      maxConcurrentFlushes: 5,
    });

    let totalFlushed = 0;
    aggregator.onFlush(async (batch) => {
      totalFlushed += batch.eventCount;
    });

    // Add 1000 events rapidly
    for (let i = 0; i < 1000; i++) {
      aggregator.addEvent(createTestEvent());
    }

    // Wait for all flushes
    await waitFor(500);
    await aggregator.shutdown();

    expect(totalFlushed).toBe(1000);
  });

  it("should maintain data integrity through compression cycle", async () => {
    const aggregator = createEventBatchAggregator({
      maxBatchSize: 10,
      enableCompression: true,
      compressionLevel: 9,
    });

    let flushedBatch: CompressedBatch | null = null;
    aggregator.onFlush(async (batch) => {
      flushedBatch = batch;
    });

    const originalEvents = createTestEvents(10, {
      payload: {
        complexData: {
          nested: { value: 123 },
          array: [1, 2, 3],
          string: "test data with special chars: <>\"'&",
        },
      },
    });

    aggregator.addEvents(originalEvents);
    await waitFor(100);

    const decompressedEvents = await aggregator.decompressBatch(flushedBatch!);

    expect(decompressedEvents.length).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(decompressedEvents[i].id).toBe(originalEvents[i].id);
      expect(decompressedEvents[i].payload).toEqual(originalEvents[i].payload);
    }

    await aggregator.shutdown();
  });

  it("should handle mixed event types and sites", async () => {
    const aggregator = createEventBatchAggregator({
      maxBatchSize: 20,
      maxBatchWindowMs: 60000,
    });

    let flushedBatch: CompressedBatch | null = null;
    aggregator.onFlush(async (batch) => {
      flushedBatch = batch;
    });

    const events: BatchEvent[] = [];
    const types = ["alarm", "reading", "status", "command"];
    const sites = ["site-001", "site-002", "site-003"];

    for (let i = 0; i < 20; i++) {
      events.push(
        createTestEvent({
          type: types[i % types.length],
          siteId: sites[i % sites.length],
        })
      );
    }

    aggregator.addEvents(events);
    await waitFor(100);

    expect(flushedBatch!.eventTypes).toHaveLength(4);
    expect(flushedBatch!.siteIds).toHaveLength(3);

    await aggregator.shutdown();
  });
});
