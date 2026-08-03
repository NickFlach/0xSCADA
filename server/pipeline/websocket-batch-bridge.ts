/**
 * Production BatchBridge adapter (#39).
 *
 * Bridges the EventPipeline's qualified batches onto the real delivery
 * surface the rest of the server uses: the cached event bridge
 * (server/websocket/cached-event-bridge.ts), which broadcasts locally,
 * caches for catch-up, and fans out via Redis to every server instance.
 *
 * Lives in its own module so the pipeline core never imports the websocket
 * layer; composition roots pass this adapter into createEventPipeline().
 */

import type { EventBatch } from "../kernel/event-batcher";
import type { BatchBridge } from "./event-pipeline";
import { cachedEventBridge } from "../websocket/cached-event-bridge";

/** Structural subset of CachedEventBridge the adapter calls (for injection). */
export interface EventPublisher {
  publishEvent(event: Record<string, unknown>): Promise<void>;
}

export function createWebsocketBatchBridge(
  publisher: EventPublisher = cachedEventBridge,
): BatchBridge {
  return {
    async forwardBatch(batch: EventBatch): Promise<void> {
      await publisher.publishEvent({
        id: batch.id,
        eventType: "event_batch",
        severity: "info",
        message: `Event batch ${batch.id} (${batch.events.length} events)`,
        timestamp: batch.batch_timestamp,
        data: {
          batch_id: batch.id,
          event_count: batch.events.length,
          merkle_root: batch.merkle_root,
          events: batch.events,
        },
      });
    },
  };
}
