/**
 * Event Batcher Unit Tests
 * Issue #289: Wire event-batcher into event stream
 * 
 * Comprehensive tests for EventBatcher functionality including:
 * - Event ingestion and validation
 * - Batch threshold triggers (count, time, size)
 * - Backpressure handling
 * - Merkle tree generation and proof verification
 * - Metrics tracking
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventBatcher, type Event, type EventBatch } from "../kernel/event-batcher";
import crypto from "crypto";

describe("EventBatcher", () => {
  let batcher: EventBatcher;
  let mockEvent: Event;

  beforeEach(() => {
    // Create fresh batcher for each test
    batcher = new EventBatcher({
      max_events_per_batch: 3,
      max_batch_time_ms: 1000,
      max_batch_size_bytes: 1024,
      log_level: "error", // Reduce noise in tests
    });

    // Create mock event
    mockEvent = {
      timestamp: new Date().toISOString(),
      source_id: "test-source-1",
      event_type: "test-event",
      payload_hash: crypto.createHash("sha256").update("test payload").digest("hex"),
      sequence_number: 1,
      payload: { test: "data" },
      metadata: { test: true },
    };
  });

  afterEach(async () => {
    await batcher.shutdown();
  });

  describe("Event Ingestion", () => {
    it("should ingest valid events successfully", async () => {
      const result = await batcher.ingest(mockEvent);
      expect(result).toBe(true);
      
      const metrics = batcher.getMetrics();
      expect(metrics.total_events).toBe(1);
      expect(metrics.queue_depth).toBe(1);
    });

    it("should reject invalid events", async () => {
      const invalidEvent = {
        ...mockEvent,
        timestamp: "invalid-timestamp",
      };

      const result = await batcher.ingest(invalidEvent as Event);
      expect(result).toBe(false);
      
      const metrics = batcher.getMetrics();
      expect(metrics.total_events).toBe(0);
    });

    it("should handle events without optional fields", async () => {
      const minimalEvent: Event = {
        timestamp: mockEvent.timestamp,
        source_id: mockEvent.source_id,
        event_type: mockEvent.event_type,
        payload_hash: mockEvent.payload_hash,
        sequence_number: mockEvent.sequence_number,
      };

      const result = await batcher.ingest(minimalEvent);
      expect(result).toBe(true);
    });

    it("should handle backpressure by dropping events", async () => {
      // Fill queue to capacity (2x max_events_per_batch)
      const promises = [];
      for (let i = 0; i < 7; i++) {
        const event = { ...mockEvent, sequence_number: i };
        promises.push(batcher.ingest(event));
      }

      const results = await Promise.all(promises);
      
      // First 6 should be accepted (3 + 3 for backpressure buffer)
      // 7th should be dropped
      expect(results.slice(0, 6).every(r => r === true)).toBe(true);
      expect(results[6]).toBe(false);
      
      const metrics = batcher.getMetrics();
      expect(metrics.events_dropped).toBeGreaterThan(0);
    });
  });

  describe("Batch Threshold Triggers", () => {
    it("should flush batch when max_events_per_batch reached", async () => {
      const batchPromise = new Promise<EventBatch>((resolve) => {
        batcher.once("batch", resolve);
      });

      // Add events up to threshold
      for (let i = 0; i < 3; i++) {
        const event = { ...mockEvent, sequence_number: i };
        await batcher.ingest(event);
      }

      const batch = await batchPromise;
      expect(batch.events).toHaveLength(3);
      expect(batch.merkle_root).toBeDefined();
      
      const metrics = batcher.getMetrics();
      expect(metrics.total_batches).toBe(1);
      expect(metrics.queue_depth).toBe(0);
    });

    it("should flush batch when max_batch_time_ms exceeded", async () => {
      // Use shorter timeout for test
      const fastBatcher = new EventBatcher({
        max_batch_time_ms: 100,
        log_level: "error",
      });

      const batchPromise = new Promise<EventBatch>((resolve) => {
        fastBatcher.once("batch", resolve);
      });

      // Add single event and wait for timeout
      await fastBatcher.ingest(mockEvent);

      const batch = await batchPromise;
      expect(batch.events).toHaveLength(1);
      expect(batch.metrics.batch_latency_ms).toBeGreaterThanOrEqual(100);

      await fastBatcher.shutdown();
    });

    it("should flush batch when max_batch_size_bytes exceeded", async () => {
      // Use the smallest valid size limit (schema minimum is 1024 bytes) and a
      // payload large enough to push a single event's serialized batch past it.
      const smallBatcher = new EventBatcher({
        max_batch_size_bytes: 1024,
        log_level: "error",
      });

      const batchPromise = new Promise<EventBatch>((resolve) => {
        smallBatcher.once("batch", resolve);
      });

      // Create large event that will exceed the size limit on its own.
      const largeEvent: Event = {
        ...mockEvent,
        payload: { large_data: "x".repeat(2048) },
        payload_hash: crypto.createHash("sha256").update("x".repeat(2048)).digest("hex"),
      };

      await smallBatcher.ingest(largeEvent);

      const batch = await batchPromise;
      expect(batch.events).toHaveLength(1);
      expect(batch.metrics.batch_size_bytes).toBeGreaterThan(1024);

      await smallBatcher.shutdown();
    });
  });

  describe("Batch Creation", () => {
    it("should create batches with proper structure", async () => {
      const batchPromise = new Promise<EventBatch>((resolve) => {
        batcher.once("batch", resolve);
      });

      await batcher.ingest(mockEvent);
      const batch = await batcher.flush();

      expect(batch).toBeDefined();
      if (batch) {
        expect(batch.id).toBeDefined();
        expect(batch.events).toHaveLength(1);
        expect(batch.merkle_root).toMatch(/^[a-f0-9]{64}$/);
        expect(batch.batch_timestamp).toBeDefined();
        expect(batch.metrics.event_count).toBe(1);
        expect(batch.metrics.batch_size_bytes).toBeGreaterThan(0);
      }
    });

    it("should create compressed payloads when enabled", async () => {
      await batcher.ingest(mockEvent);
      const batch = await batcher.flush();

      expect(batch?.compressed_payload).toBeDefined();
      expect(batch?.compressed_payload).toMatch(/^[A-Za-z0-9+/=]+$/); // Base64 format
    });

    it("should return null when flushing empty batch", async () => {
      const batch = await batcher.flush();
      expect(batch).toBeNull();
    });
  });

  describe("Merkle Tree Operations", () => {
    it("should generate valid Merkle proofs", async () => {
      // Use a dedicated batcher whose count threshold is high enough that all
      // four events stay queued until the explicit flush, so the resulting
      // batch contains every event we generate proofs for.
      const proofBatcher = new EventBatcher({
        max_events_per_batch: 10,
        max_batch_time_ms: 1000,
        log_level: "error",
      });

      const events = [];
      for (let i = 0; i < 4; i++) {
        const event = { ...mockEvent, sequence_number: i, source_id: `source-${i}` };
        events.push(event);
        await proofBatcher.ingest(event);
      }

      const batch = await proofBatcher.flush();
      expect(batch).toBeDefined();

      if (batch) {
        // Generate proof for each event
        for (let i = 0; i < events.length; i++) {
          const proof = proofBatcher.generateProof(batch, i);
          const isValid = proofBatcher.verifyProof(events[i], i, proof, batch.merkle_root);
          expect(isValid).toBe(true);
        }
      }

      await proofBatcher.shutdown();
    });

    it("should reject invalid proofs", async () => {
      await batcher.ingest(mockEvent);
      const batch = await batcher.flush();

      if (batch) {
        const proof = batcher.generateProof(batch, 0);
        
        // Test with wrong event
        const wrongEvent = { ...mockEvent, sequence_number: 999 };
        const isValid = batcher.verifyProof(wrongEvent, 0, proof, batch.merkle_root);
        expect(isValid).toBe(false);
        
        // Test with wrong index
        const isValid2 = batcher.verifyProof(mockEvent, 1, proof, batch.merkle_root);
        expect(isValid2).toBe(false);
        
        // Test with wrong merkle root
        const isValid3 = batcher.verifyProof(mockEvent, 0, proof, "wrong_root");
        expect(isValid3).toBe(false);
      }
    });

    it("should handle single event Merkle trees", async () => {
      await batcher.ingest(mockEvent);
      const batch = await batcher.flush();

      if (batch) {
        const proof = batcher.generateProof(batch, 0);
        expect(proof).toHaveLength(0); // Single event has empty proof
        
        const isValid = batcher.verifyProof(mockEvent, 0, proof, batch.merkle_root);
        expect(isValid).toBe(true);
      }
    });

    it("should throw error for invalid proof generation", async () => {
      await batcher.ingest(mockEvent);
      const batch = await batcher.flush();

      if (batch) {
        expect(() => batcher.generateProof(batch, -1)).toThrow("Event index out of bounds");
        expect(() => batcher.generateProof(batch, 999)).toThrow("Event index out of bounds");
      }
    });
  });

  describe("Metrics Tracking", () => {
    it("should track basic metrics correctly", async () => {
      const initialMetrics = batcher.getMetrics();
      expect(initialMetrics.total_events).toBe(0);
      expect(initialMetrics.total_batches).toBe(0);

      // Add some events
      for (let i = 0; i < 5; i++) {
        const event = { ...mockEvent, sequence_number: i };
        await batcher.ingest(event);
      }

      const afterIngestMetrics = batcher.getMetrics();
      expect(afterIngestMetrics.total_events).toBe(5);
      expect(afterIngestMetrics.queue_depth).toBe(2); // 3 batched, 2 remaining

      // Check final metrics
      const finalMetrics = batcher.getMetrics();
      expect(finalMetrics.total_batches).toBe(1);
      expect(finalMetrics.avg_events_per_batch).toBe(3);
    });

    it("should calculate average metrics correctly", async () => {
      // Create two batches with different sizes
      for (let i = 0; i < 3; i++) {
        await batcher.ingest({ ...mockEvent, sequence_number: i });
      }
      // First batch: 3 events

      for (let i = 3; i < 5; i++) {
        await batcher.ingest({ ...mockEvent, sequence_number: i });
      }
      await batcher.flush(); // Second batch: 2 events

      const metrics = batcher.getMetrics();
      expect(metrics.total_batches).toBe(2);
      expect(metrics.avg_events_per_batch).toBe(2.5); // (3 + 2) / 2
    });

    it("should track last batch timestamp", async () => {
      const beforeTimestamp = new Date().toISOString();
      
      await batcher.ingest(mockEvent);
      await batcher.flush();
      
      const metrics = batcher.getMetrics();
      expect(metrics.last_batch_timestamp).toBeDefined();
      expect(new Date(metrics.last_batch_timestamp!).getTime())
        .toBeGreaterThanOrEqual(new Date(beforeTimestamp).getTime());
    });
  });

  describe("Error Handling", () => {
    it("should handle malformed events gracefully", async () => {
      const malformedEvents = [
        { ...mockEvent, timestamp: null },
        { ...mockEvent, source_id: "" },
        { ...mockEvent, sequence_number: "invalid" },
        { ...mockEvent, payload_hash: null },
      ];

      for (const event of malformedEvents) {
        const result = await batcher.ingest(event as any);
        expect(result).toBe(false);
      }

      const metrics = batcher.getMetrics();
      expect(metrics.total_events).toBe(0);
    });

    it("should continue operating after errors", async () => {
      // First, cause an error
      await batcher.ingest({ invalid: "event" } as any);
      
      // Then process valid event
      const result = await batcher.ingest(mockEvent);
      expect(result).toBe(true);
      
      const metrics = batcher.getMetrics();
      expect(metrics.total_events).toBe(1);
    });
  });

  describe("Shutdown", () => {
    it("should flush pending events on shutdown", async () => {
      let batchReceived: EventBatch | null = null;
      batcher.on("batch", (batch) => {
        batchReceived = batch;
      });

      // Add event without triggering flush
      await batcher.ingest(mockEvent);
      expect(batchReceived).toBeNull();

      // Shutdown should flush pending events
      await batcher.shutdown();
      
      expect(batchReceived).toBeDefined();
      expect(batchReceived?.events).toHaveLength(1);
    });

    it("should handle shutdown with no pending events", async () => {
      await expect(batcher.shutdown()).resolves.not.toThrow();
    });
  });

  describe("Configuration", () => {
    it("should use default configuration when none provided", () => {
      const defaultBatcher = new EventBatcher();
      const metrics = defaultBatcher.getMetrics();
      expect(metrics).toBeDefined();
      defaultBatcher.shutdown();
    });

    it("should validate configuration parameters", () => {
      expect(() => new EventBatcher({
        max_events_per_batch: 0, // Invalid
      })).toThrow();

      expect(() => new EventBatcher({
        max_batch_time_ms: 50, // Too small
      })).toThrow();

      expect(() => new EventBatcher({
        compression_level: 10, // Invalid range
      })).toThrow();
    });
  });

  describe("Event Ordering", () => {
    it("should preserve event order within batches", async () => {
      // Use a batcher whose count threshold exceeds the number of events so the
      // explicit flush produces a single batch containing all of them in order.
      const orderBatcher = new EventBatcher({
        max_events_per_batch: 10,
        max_batch_time_ms: 1000,
        log_level: "error",
      });

      const events = [];
      for (let i = 0; i < 3; i++) {
        const event = { ...mockEvent, sequence_number: i, source_id: `source-${i}` };
        events.push(event);
        await orderBatcher.ingest(event);
      }

      const batch = await orderBatcher.flush();
      expect(batch?.events).toHaveLength(3);

      if (batch) {
        for (let i = 0; i < 3; i++) {
          expect(batch.events[i].sequence_number).toBe(i);
          expect(batch.events[i].source_id).toBe(`source-${i}`);
        }
      }

      await orderBatcher.shutdown();
    });
  });
});