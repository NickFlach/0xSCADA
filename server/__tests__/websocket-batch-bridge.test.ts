/**
 * Websocket BatchBridge adapter tests (#39).
 *
 * The adapter is the production seam between the EventPipeline's qualified
 * batches and the cached event bridge's delivery surface. These tests pin the
 * mapping contract with an injected publisher — the batch's identity, size,
 * merkle root and events must survive the translation, and a publisher
 * failure must propagate so the pipeline can count it as a failed delivery.
 */

import { describe, it, expect, vi } from "vitest";
import { createWebsocketBatchBridge } from "../pipeline/websocket-batch-bridge";
import type { EventBatch } from "../kernel/event-batcher";

const batch: EventBatch = {
  id: "batch-1",
  events: [
    {
      timestamp: new Date().toISOString(),
      source_id: "test-source",
      event_type: "test-event",
      payload_hash: "a".repeat(64),
      sequence_number: 1,
      payload: { test: "data" },
    },
  ],
  merkle_root: "b".repeat(64),
  batch_timestamp: new Date().toISOString(),
  metrics: {
    event_count: 1,
    batch_size_bytes: 256,
    batch_latency_ms: 5,
  },
};

describe("createWebsocketBatchBridge", () => {
  it("publishes the batch through the injected publisher with the full payload", async () => {
    const publishEvent = vi.fn(async (_event: Record<string, unknown>) => {});
    const bridge = createWebsocketBatchBridge({ publishEvent });

    await bridge.forwardBatch(batch);

    expect(publishEvent).toHaveBeenCalledTimes(1);
    const published = publishEvent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(published.id).toBe("batch-1");
    expect(published.eventType).toBe("event_batch");
    expect(published.timestamp).toBe(batch.batch_timestamp);
    const data = published.data as Record<string, unknown>;
    expect(data.batch_id).toBe("batch-1");
    expect(data.event_count).toBe(1);
    expect(data.merkle_root).toBe(batch.merkle_root);
    expect(data.events).toEqual(batch.events);
  });

  it("propagates publisher failures so the pipeline counts them", async () => {
    const bridge = createWebsocketBatchBridge({
      publishEvent: async () => {
        throw new Error("redis unreachable");
      },
    });

    await expect(bridge.forwardBatch(batch)).rejects.toThrow("redis unreachable");
  });
});
