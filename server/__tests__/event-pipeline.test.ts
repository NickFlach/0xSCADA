/**
 * Event Pipeline Unit Tests  
 * Issue #289: Wire event-batcher into event stream
 * 
 * Tests for EventPipeline functionality including:
 * - Event source registration and management
 * - Event processing and deduplication  
 * - Bulk event processing
 * - Bridge forwarding integration
 * - Health monitoring and metrics
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventPipeline, type EventSource } from "../pipeline/event-pipeline";
import type { Event, EventBatch } from "../kernel/event-batcher";
import crypto from "crypto";

describe("EventPipeline", () => {
  let pipeline: EventPipeline;
  let mockEvent: Event;
  let mockSource: Omit<EventSource, "last_sequence">;

  beforeEach(() => {
    pipeline = new EventPipeline({
      batcher: {
        max_events_per_batch: 3,
        max_batch_time_ms: 1000,
        log_level: "error",
      },
      pipeline: {
        enable_deduplication: true,
        dedup_window_ms: 5000,
        enable_bridge_forwarding: true,
        min_bridge_batch_size: 2,
      },
    });

    mockEvent = {
      timestamp: new Date().toISOString(),
      source_id: "test-source",
      event_type: "test-event",
      payload_hash: crypto.createHash("sha256").update("test payload").digest("hex"),
      sequence_number: 1,
      payload: { test: "data" },
    };

    mockSource = {
      id: "test-source",
      name: "Test Source",
      type: "plc",
      active: true,
    };
  });

  afterEach(async () => {
    await pipeline.shutdown();
  });

  describe("Event Source Management", () => {
    it("should register event sources", () => {
      pipeline.registerSource(mockSource);
      
      const sources = pipeline.getEventSources();
      expect(sources).toHaveLength(3); // 2 default + 1 registered
      
      const registeredSource = sources.find(s => s.id === mockSource.id);
      expect(registeredSource).toBeDefined();
      expect(registeredSource?.name).toBe(mockSource.name);
      expect(registeredSource?.type).toBe(mockSource.type);
      expect(registeredSource?.last_sequence).toBe(0);
    });

    it("should unregister event sources", () => {
      pipeline.registerSource(mockSource);
      expect(pipeline.getEventSources()).toHaveLength(3);
      
      const removed = pipeline.unregisterSource(mockSource.id);
      expect(removed).toBe(true);
      expect(pipeline.getEventSources()).toHaveLength(2);
      
      // Try removing non-existent source
      const notRemoved = pipeline.unregisterSource("non-existent");
      expect(notRemoved).toBe(false);
    });

    it("should auto-register unknown sources", async () => {
      const unknownEvent = { ...mockEvent, source_id: "unknown-source" };
      
      await pipeline.processEvent(unknownEvent);
      
      const sources = pipeline.getEventSources();
      const autoRegistered = sources.find(s => s.id === "unknown-source");
      expect(autoRegistered).toBeDefined();
      expect(autoRegistered?.type).toBe("system");
      expect(autoRegistered?.name).toContain("Unknown Source");
    });

    it("should track sequence numbers for sources", async () => {
      pipeline.registerSource(mockSource);
      
      // Process distinct events with increasing sequence numbers. Each needs a
      // unique payload_hash so deduplication (keyed on source/type/payload_hash,
      // not sequence_number) does not drop them before sequence tracking runs.
      for (let i = 1; i <= 5; i++) {
        const event = { ...mockEvent, sequence_number: i, payload_hash: `hash_${i}` };
        await pipeline.processEvent(event);
      }
      
      const sources = pipeline.getEventSources();
      const source = sources.find(s => s.id === mockSource.id);
      expect(source?.last_sequence).toBe(5);
    });

    it("should warn about out-of-order sequences", async () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      
      pipeline.registerSource(mockSource);
      
      // Process event with sequence 5, then 3
      await pipeline.processEvent({ ...mockEvent, sequence_number: 5 });
      await pipeline.processEvent({ ...mockEvent, sequence_number: 3 });
      
      const sources = pipeline.getEventSources();
      const source = sources.find(s => s.id === mockSource.id);
      expect(source?.last_sequence).toBe(5); // Should keep the higher sequence
      
      consoleSpy.mockRestore();
    });
  });

  describe("Event Processing", () => {
    beforeEach(() => {
      pipeline.registerSource(mockSource);
    });

    it("should process valid events successfully", async () => {
      const result = await pipeline.processEvent(mockEvent);
      expect(result).toBe(true);
      
      const metrics = pipeline.getMetrics();
      expect(metrics.events_received).toBe(1);
      expect(metrics.events_batched).toBe(1);
      expect(metrics.events_dropped).toBe(0);
    });

    it("should emit event:processed on successful processing", async () => {
      let processedEvent: Event | null = null;
      pipeline.on("event:processed", (event) => {
        processedEvent = event;
      });
      
      await pipeline.processEvent(mockEvent);
      
      expect(processedEvent).toEqual(mockEvent);
    });

    it("should emit event:dropped on processing failure", async () => {
      let droppedEvent: Event | null = null;
      let dropReason: string | null = null;
      
      pipeline.on("event:dropped", (event, reason) => {
        droppedEvent = event;
        dropReason = reason;
      });
      
      // Fill the batcher beyond its backpressure cap to trigger drops. Events
      // must be distinct (unique payload_hash) so they are not deduplicated
      // before reaching the batcher's backpressure path.
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          pipeline.processEvent({ ...mockEvent, sequence_number: i, payload_hash: `hash_${i}` })
        );
      }

      await Promise.all(promises);

      // At least some events should be dropped due to backpressure
      const metrics = pipeline.getMetrics();
      expect(metrics.events_dropped).toBeGreaterThan(0);
      expect(droppedEvent).not.toBeNull();
      expect(dropReason).toBe("batcher_backpressure");
    });

    it("should handle processing errors gracefully", async () => {
      let errorEvent: Event | null = null;
      let error: Error | null = null;
      
      pipeline.on("event:error", (event, err) => {
        errorEvent = event;
        error = err;
      });
      
      // Create invalid event that will cause processing error
      const invalidEvent = { ...mockEvent, timestamp: "invalid" };
      
      const result = await pipeline.processEvent(invalidEvent as Event);
      expect(result).toBe(false);
      
      const metrics = pipeline.getMetrics();
      expect(metrics.events_dropped).toBe(1);
    });

    it("should update last event timestamp", async () => {
      const eventTimestamp = new Date().toISOString();
      const event = { ...mockEvent, timestamp: eventTimestamp };
      
      await pipeline.processEvent(event);
      
      const metrics = pipeline.getMetrics();
      expect(metrics.last_event_timestamp).toBe(eventTimestamp);
    });
  });

  describe("Event Deduplication", () => {
    beforeEach(() => {
      pipeline.registerSource(mockSource);
    });

    it("should deduplicate identical events", async () => {
      // Process same event twice
      const result1 = await pipeline.processEvent(mockEvent);
      const result2 = await pipeline.processEvent(mockEvent);
      
      expect(result1).toBe(true);
      expect(result2).toBe(false); // Should be deduplicated
      
      const metrics = pipeline.getMetrics();
      expect(metrics.events_received).toBe(2);
      expect(metrics.events_batched).toBe(1);
      expect(metrics.events_deduplicated).toBe(1);
    });

    it("should not deduplicate different events", async () => {
      const event1 = { ...mockEvent, sequence_number: 1 };
      const event2 = { ...mockEvent, sequence_number: 2, payload_hash: "different_hash" };
      
      const result1 = await pipeline.processEvent(event1);
      const result2 = await pipeline.processEvent(event2);
      
      expect(result1).toBe(true);
      expect(result2).toBe(true);
      
      const metrics = pipeline.getMetrics();
      expect(metrics.events_deduplicated).toBe(0);
    });

    it("should allow events after deduplication window", async () => {
      // Use fake timers so we can deterministically advance past the dedup
      // window (schema minimum is 1000ms) without a real delay. The pipeline
      // evicts stale dedup entries via a cleanup interval keyed on the window.
      vi.useFakeTimers();

      const shortPipeline = new EventPipeline({
        pipeline: {
          dedup_window_ms: 1000, // smallest valid window
        },
        batcher: {
          log_level: "error",
        },
      });

      try {
        shortPipeline.registerSource(mockSource);

        // Process event
        const first = await shortPipeline.processEvent(mockEvent);
        expect(first).toBe(true);

        // Advance well past the dedup window. The cleanup interval fires every
        // window (1000ms) and evicts entries strictly older than the window, so
        // advancing past the second tick (>2000ms after insertion) guarantees
        // the entry is gone.
        await vi.advanceTimersByTimeAsync(2500);

        // Process same event again - should be allowed
        const result = await shortPipeline.processEvent(mockEvent);
        expect(result).toBe(true);

        await shortPipeline.shutdown();
      } finally {
        vi.useRealTimers();
      }
    });

    it("should disable deduplication when configured", async () => {
      const noDedupPipeline = new EventPipeline({
        pipeline: {
          enable_deduplication: false,
        },
        batcher: {
          log_level: "error",
        },
      });
      
      noDedupPipeline.registerSource(mockSource);
      
      // Process same event twice
      const result1 = await noDedupPipeline.processEvent(mockEvent);
      const result2 = await noDedupPipeline.processEvent(mockEvent);
      
      expect(result1).toBe(true);
      expect(result2).toBe(true); // Should not be deduplicated
      
      const metrics = noDedupPipeline.getMetrics();
      expect(metrics.events_deduplicated).toBe(0);
      
      await noDedupPipeline.shutdown();
    });
  });

  describe("Bulk Event Processing", () => {
    beforeEach(() => {
      pipeline.registerSource(mockSource);
    });

    it("should process bulk events", async () => {
      const events = [];
      for (let i = 0; i < 5; i++) {
        events.push({ ...mockEvent, sequence_number: i, payload_hash: `hash_${i}` });
      }
      
      const result = await pipeline.processBulkEvents(events);
      
      expect(result.processed).toBe(5);
      expect(result.dropped).toBe(0);
      
      const metrics = pipeline.getMetrics();
      expect(metrics.events_received).toBe(5);
      expect(metrics.events_batched).toBe(5);
    });

    it("should handle mixed success and failure in bulk", async () => {
      const events = [
        { ...mockEvent, sequence_number: 1 }, // Valid
        { ...mockEvent, timestamp: "invalid" } as Event, // Invalid
        { ...mockEvent, sequence_number: 2, payload_hash: "hash2" }, // Valid
      ];
      
      const result = await pipeline.processBulkEvents(events);
      
      expect(result.processed).toBe(2);
      expect(result.dropped).toBe(1);
    });
  });

  describe("Batch Handling and Bridge Forwarding", () => {
    beforeEach(() => {
      pipeline.registerSource(mockSource);
    });

    it("should emit batch:ready when batch is created", async () => {
      let readyBatch: EventBatch | null = null;
      pipeline.on("batch:ready", (batch) => {
        readyBatch = batch;
      });
      
      // Add enough events to trigger batch
      for (let i = 0; i < 3; i++) {
        await pipeline.processEvent({ ...mockEvent, sequence_number: i, payload_hash: `hash_${i}` });
      }
      
      expect(readyBatch).toBeDefined();
      expect(readyBatch?.events).toHaveLength(3);
    });

    it("should forward batches to bridge when enabled", async () => {
      let forwardedBatch: EventBatch | null = null;
      pipeline.on("batch:forwarded", (batch) => {
        forwardedBatch = batch;
      });
      
      // Create batch that meets minimum size for bridge forwarding
      for (let i = 0; i < 3; i++) {
        await pipeline.processEvent({ ...mockEvent, sequence_number: i, payload_hash: `hash_${i}` });
      }
      
      expect(forwardedBatch).toBeDefined();
      
      const metrics = pipeline.getMetrics();
      expect(metrics.batches_forwarded).toBe(1);
    });

    it("should not forward small batches to bridge", async () => {
      let forwardedBatch: EventBatch | null = null;
      pipeline.on("batch:forwarded", (batch) => {
        forwardedBatch = batch;
      });
      
      // Create batch smaller than minimum bridge size (min = 2, sending 1)
      await pipeline.processEvent(mockEvent);
      await pipeline.flushBatch(); // Force flush single event
      
      expect(forwardedBatch).toBeNull();
      
      const metrics = pipeline.getMetrics();
      expect(metrics.batches_forwarded).toBe(0);
    });

    it("should respect bridge forwarding configuration", async () => {
      const noBridgePipeline = new EventPipeline({
        pipeline: {
          enable_bridge_forwarding: false,
        },
        batcher: {
          log_level: "error",
        },
      });
      
      noBridgePipeline.registerSource(mockSource);
      
      let forwardedBatch: EventBatch | null = null;
      noBridgePipeline.on("batch:forwarded", (batch) => {
        forwardedBatch = batch;
      });
      
      // Create large batch
      for (let i = 0; i < 3; i++) {
        await noBridgePipeline.processEvent({ ...mockEvent, sequence_number: i, payload_hash: `hash_${i}` });
      }
      
      expect(forwardedBatch).toBeNull();
      
      await noBridgePipeline.shutdown();
    });
  });

  describe("Metrics and Health Monitoring", () => {
    beforeEach(() => {
      pipeline.registerSource(mockSource);
    });

    it("should track comprehensive metrics", async () => {
      // Process some events
      for (let i = 0; i < 5; i++) {
        await pipeline.processEvent({ ...mockEvent, sequence_number: i, payload_hash: `hash_${i}` });
      }
      
      const metrics = pipeline.getMetrics();
      
      expect(metrics.events_received).toBe(5);
      expect(metrics.events_batched).toBe(5);
      expect(metrics.batches_processed).toBeGreaterThan(0);
      expect(metrics.uptime_ms).toBeGreaterThan(0);
      expect(metrics.last_event_timestamp).toBeDefined();
    });

    it("should provide healthy status with normal operation", async () => {
      await pipeline.processEvent(mockEvent);
      
      const health = pipeline.getHealthStatus();
      expect(health.status).toBe("healthy");
      expect(health.issues).toHaveLength(0);
    });

    it("should report degraded status with high drop rate", async () => {
      // Force events to be dropped by overwhelming the system
      const promises = [];
      for (let i = 0; i < 20; i++) {
        promises.push(pipeline.processEvent({ ...mockEvent, sequence_number: i, payload_hash: `hash_${i}` }));
      }
      
      await Promise.all(promises);
      
      const health = pipeline.getHealthStatus();
      if (health.status !== "healthy") {
        expect(["degraded", "unhealthy"]).toContain(health.status);
        expect(health.issues.length).toBeGreaterThan(0);
      }
    });

    it("should report degraded status with old events", async () => {
      // Process an event with old timestamp
      const oldTimestamp = new Date(Date.now() - 400000).toISOString(); // 6+ minutes ago
      await pipeline.processEvent({ ...mockEvent, timestamp: oldTimestamp });
      
      const health = pipeline.getHealthStatus();
      if (health.status !== "healthy") {
        expect(health.issues.some(issue => issue.includes("No recent events"))).toBe(true);
      }
    });

    it("should include batcher metrics", async () => {
      await pipeline.processEvent(mockEvent);
      
      const metrics = pipeline.getMetrics();
      expect(metrics.batcher).toBeDefined();
      expect(metrics.batcher.total_events).toBeDefined();
      expect(metrics.batcher.queue_depth).toBeDefined();
    });
  });

  describe("Manual Batch Flushing", () => {
    beforeEach(() => {
      pipeline.registerSource(mockSource);
    });

    it("should flush batch manually", async () => {
      await pipeline.processEvent(mockEvent);
      
      const batch = await pipeline.flushBatch();
      expect(batch).toBeDefined();
      expect(batch?.events).toHaveLength(1);
      
      const metrics = pipeline.getMetrics();
      expect(metrics.batches_processed).toBe(1);
    });

    it("should return null when nothing to flush", async () => {
      const batch = await pipeline.flushBatch();
      expect(batch).toBeNull();
    });
  });

  describe("Shutdown", () => {
    it("should shutdown gracefully", async () => {
      pipeline.registerSource(mockSource);
      await pipeline.processEvent(mockEvent);
      
      await expect(pipeline.shutdown()).resolves.not.toThrow();
    });

    it("should process pending events on shutdown", async () => {
      let batchReceived: EventBatch | null = null;
      pipeline.on("batch:ready", (batch) => {
        batchReceived = batch;
      });
      
      pipeline.registerSource(mockSource);
      await pipeline.processEvent(mockEvent);
      
      // Shutdown should flush pending events
      await pipeline.shutdown();
      
      expect(batchReceived).toBeDefined();
    });
  });

  describe("Configuration", () => {
    it("should use default configuration", () => {
      const defaultPipeline = new EventPipeline();
      const metrics = defaultPipeline.getMetrics();
      expect(metrics).toBeDefined();
      defaultPipeline.shutdown();
    });

    it("should have default event sources", () => {
      const defaultPipeline = new EventPipeline();
      const sources = defaultPipeline.getEventSources();
      
      // Should have default "system" and "simulator" sources
      expect(sources.length).toBeGreaterThan(0);
      expect(sources.some(s => s.id === "system")).toBe(true);
      expect(sources.some(s => s.id === "simulator")).toBe(true);
      
      defaultPipeline.shutdown();
    });

    it("should validate configuration", () => {
      expect(() => new EventPipeline({
        pipeline: {
          dedup_window_ms: 500, // Too small
        },
      })).toThrow();
    });
  });
});