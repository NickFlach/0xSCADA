/**
 * Event Routes - Event Ingestion API
 * Issue #289: Wire event-batcher into event stream
 * 
 * REST API endpoints for event ingestion, batch management, and metrics.
 * Integrates with EventBatcher for non-blocking event processing.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { fromZodError } from "zod-validation-error";
import pino from "pino";
import crypto from "crypto";
import { 
  getDefaultEventBatcher, 
  EventSchema, 
  EventBatcherConfigSchema,
  type Event,
  type EventBatch,
  type EventBatcherMetrics
} from "../kernel/event-batcher";

const logger = pino({ name: "event-routes" });
const eventBatcher = getDefaultEventBatcher();

export const eventRoutes = Router();

// ─── Event Ingestion ────────────────────────────────────────────────────────

/**
 * POST /api/v2/events/ingest
 * Ingest a single event into the batching system
 */
eventRoutes.post("/ingest", async (req: Request, res: Response) => {
  try {
    let event: Event;
    
    // If event doesn't include payload_hash, generate it
    if (!req.body.payload_hash && req.body.payload) {
      const payloadHash = crypto
        .createHash("sha256")
        .update(JSON.stringify(req.body.payload))
        .digest("hex");
      req.body.payload_hash = payloadHash;
    }

    // If no timestamp provided, use current time
    if (!req.body.timestamp) {
      req.body.timestamp = new Date().toISOString();
    }

    // Validate event structure
    try {
      event = EventSchema.parse(req.body);
    } catch (error) {
      const validationError = fromZodError(error as any);
      return res.status(400).json({
        error: "Invalid event structure",
        details: validationError.message,
      });
    }

    // Ingest event into batcher
    const success = await eventBatcher.ingest(event);
    
    if (!success) {
      return res.status(503).json({
        error: "Event ingestion failed due to backpressure",
        message: "Event was dropped. System is under high load.",
      });
    }

    res.status(202).json({
      message: "Event accepted for batching",
      event_id: `${event.source_id}:${event.sequence_number}`,
      timestamp: event.timestamp,
    });

    logger.info("Event ingested", {
      source_id: event.source_id,
      event_type: event.event_type,
      sequence_number: event.sequence_number,
    });

  } catch (error) {
    logger.error("Event ingestion error", { error: (error as any).message });
    res.status(500).json({
      error: "Internal server error during event ingestion",
      message: (error as any).message,
    });
  }
});

/**
 * POST /api/v2/events/bulk
 * Bulk ingest multiple events
 */
const BulkIngestSchema = z.object({
  events: z.array(EventSchema),
});

eventRoutes.post("/bulk", async (req: Request, res: Response) => {
  try {
    const { events } = BulkIngestSchema.parse(req.body);
    
    const results = {
      accepted: 0,
      dropped: 0,
      errors: [] as string[],
    };

    for (const [index, event] of events.entries()) {
      try {
        // Auto-generate missing fields like in single ingest
        if (!event.payload_hash && event.payload) {
          event.payload_hash = crypto
            .createHash("sha256")
            .update(JSON.stringify(event.payload))
            .digest("hex");
        }
        
        if (!event.timestamp) {
          event.timestamp = new Date().toISOString();
        }

        const success = await eventBatcher.ingest(event);
        if (success) {
          results.accepted++;
        } else {
          results.dropped++;
        }
      } catch (error) {
        results.errors.push(`Event ${index}: ${(error as any).message}`);
      }
    }

    const statusCode = results.errors.length > 0 ? 207 : 202; // 207 Multi-Status if partial success
    
    res.status(statusCode).json({
      message: "Bulk ingestion completed",
      results,
      total_events: events.length,
    });

    logger.info("Bulk events ingested", {
      total: events.length,
      accepted: results.accepted,
      dropped: results.dropped,
      errors: results.errors.length,
    });

  } catch (error) {
    if ((error as any).name === "ZodError") {
      const validationError = fromZodError(error as any);
      return res.status(400).json({
        error: "Invalid bulk request structure",
        details: validationError.message,
      });
    }

    logger.error("Bulk ingestion error", { error: (error as any).message });
    res.status(500).json({
      error: "Internal server error during bulk ingestion",
      message: (error as any).message,
    });
  }
});

// ─── Batch Management ──────────────────────────────────────────────────────

/**
 * POST /api/v2/events/flush
 * Force flush current batch
 */
eventRoutes.post("/flush", async (req: Request, res: Response) => {
  try {
    const batch = await eventBatcher.flush();
    
    if (!batch) {
      return res.status(200).json({
        message: "No events to flush",
        batch: null,
      });
    }

    res.status(200).json({
      message: "Batch flushed successfully",
      batch: {
        id: batch.id,
        event_count: batch.events.length,
        merkle_root: batch.merkle_root,
        batch_timestamp: batch.batch_timestamp,
        metrics: batch.metrics,
      },
    });

    logger.info("Manual batch flush", { batch_id: batch.id, event_count: batch.events.length });

  } catch (error) {
    logger.error("Batch flush error", { error: (error as any).message });
    res.status(500).json({
      error: "Failed to flush batch",
      message: (error as any).message,
    });
  }
});

/**
 * GET /api/v2/events/metrics
 * Get current batcher metrics
 */
eventRoutes.get("/metrics", (req: Request, res: Response) => {
  try {
    const metrics = eventBatcher.getMetrics();
    
    res.status(200).json({
      metrics,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    logger.error("Metrics retrieval error", { error: (error as any).message });
    res.status(500).json({
      error: "Failed to retrieve metrics",
      message: (error as any).message,
    });
  }
});

// ─── Event Verification ────────────────────────────────────────────────────

/**
 * POST /api/v2/events/verify
 * Verify a Merkle proof for an event
 */
const VerifyProofSchema = z.object({
  event: EventSchema,
  event_index: z.number().int().min(0),
  proof: z.array(z.string()),
  merkle_root: z.string(),
});

eventRoutes.post("/verify", (req: Request, res: Response) => {
  try {
    const { event, event_index, proof, merkle_root } = VerifyProofSchema.parse(req.body);
    
    const isValid = eventBatcher.verifyProof(event, event_index, proof, merkle_root);
    
    res.status(200).json({
      valid: isValid,
      event_id: `${event.source_id}:${event.sequence_number}`,
      merkle_root,
      verified_at: new Date().toISOString(),
    });

    logger.debug("Proof verification", {
      event_id: `${event.source_id}:${event.sequence_number}`,
      valid: isValid,
      merkle_root,
    });

  } catch (error) {
    if ((error as any).name === "ZodError") {
      const validationError = fromZodError(error as any);
      return res.status(400).json({
        error: "Invalid verification request",
        details: validationError.message,
      });
    }

    logger.error("Proof verification error", { error: (error as any).message });
    res.status(500).json({
      error: "Failed to verify proof",
      message: (error as any).message,
    });
  }
});

// ─── Configuration ─────────────────────────────────────────────────────────

/**
 * GET /api/v2/events/config
 * Get current batcher configuration
 */
eventRoutes.get("/config", (req: Request, res: Response) => {
  try {
    // We can't directly access the config from the batcher, so return defaults
    const defaultConfig = EventBatcherConfigSchema.parse({});
    
    res.status(200).json({
      config: defaultConfig,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    logger.error("Config retrieval error", { error: (error as any).message });
    res.status(500).json({
      error: "Failed to retrieve configuration",
      message: (error as any).message,
    });
  }
});

// ─── Health Check ──────────────────────────────────────────────────────────

/**
 * GET /api/v2/events/health
 * Health check for event ingestion system
 */
eventRoutes.get("/health", (req: Request, res: Response) => {
  try {
    const metrics = eventBatcher.getMetrics();
    const isHealthy = metrics.events_dropped === 0 || 
                     (metrics.events_dropped / metrics.total_events) < 0.01; // Less than 1% drop rate

    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? "healthy" : "degraded",
      message: isHealthy ? "Event batcher operating normally" : "High event drop rate detected",
      metrics: {
        queue_depth: metrics.queue_depth,
        total_events: metrics.total_events,
        total_batches: metrics.total_batches,
        events_dropped: metrics.events_dropped,
        drop_rate: metrics.total_events > 0 ? 
          (metrics.events_dropped / metrics.total_events * 100).toFixed(2) + "%" : "0%",
      },
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    logger.error("Health check error", { error: (error as any).message });
    res.status(500).json({
      status: "unhealthy",
      error: "Health check failed",
      message: (error as any).message,
    });
  }
});

// ─── Event Listeners ───────────────────────────────────────────────────────

// Listen for batch events to log and potentially forward to other systems
eventBatcher.on("batch", (batch: EventBatch) => {
  logger.info("Batch created", {
    batch_id: batch.id,
    event_count: batch.events.length,
    merkle_root: batch.merkle_root,
    batch_size_bytes: batch.metrics.batch_size_bytes,
    batch_latency_ms: batch.metrics.batch_latency_ms,
  });

  // TODO: Forward to EventAnchorBridge when implemented
  // bridgeService.submitBatch(batch);
});

logger.info("Event routes initialized with event batcher integration");

export { eventBatcher };