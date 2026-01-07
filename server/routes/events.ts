/**
 * Evolved Events API Routes
 * 
 * Phase 1: Redefine Event Model + Anchoring Semantics
 * 
 * Event Types: Telemetry, Alarm, Command, Acknowledge, Maintenance,
 *              BlueprintChange, GeneratedCode, AgentActionProposal
 * 
 * Each event includes:
 * - Deterministic serialization
 * - Origin signer (gateway / user / agent)
 * - SHA-256 hash
 * - Link to Ethereum anchor batch (tx / block number)
 */

import { Router } from "express";
import { db } from "../db";
import { events, eventBatches } from "@shared/schema";
import { eq, desc, and, gte, lte } from "drizzle-orm";
import { getEventService, EventType, OriginType } from "../events";
import { hashObject, verifyMerkleProof } from "../crypto";

export const eventRoutes = Router();

// =============================================================================
// EVENT QUERIES
// =============================================================================

/**
 * GET /api/v2/events
 * List events with filtering and pagination
 */
eventRoutes.get("/", async (req, res) => {
  try {
    const {
      siteId,
      assetId,
      eventType,
      originType,
      anchorStatus,
      startTime,
      endTime,
      limit = "100",
      offset = "0",
    } = req.query;

    let query = db.select().from(events);
    const conditions: any[] = [];

    if (siteId) conditions.push(eq(events.siteId, siteId as string));
    if (assetId) conditions.push(eq(events.assetId, assetId as string));
    if (eventType) conditions.push(eq(events.eventType, eventType as string));
    if (originType) conditions.push(eq(events.originType, originType as string));
    if (anchorStatus) conditions.push(eq(events.anchorStatus, anchorStatus as string));
    if (startTime) conditions.push(gte(events.sourceTimestamp, new Date(startTime as string)));
    if (endTime) conditions.push(lte(events.sourceTimestamp, new Date(endTime as string)));

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    const results = await query
      .orderBy(desc(events.sourceTimestamp))
      .limit(parseInt(limit as string))
      .offset(parseInt(offset as string));

    res.json({
      events: results,
      pagination: {
        limit: parseInt(limit as string),
        offset: parseInt(offset as string),
        count: results.length,
      },
    });
  } catch (error) {
    console.error("Error fetching events:", error);
    res.status(500).json({ error: "Failed to fetch events" });
  }
});

/**
 * GET /api/v2/events/:id
 * Get single event with full details
 */
eventRoutes.get("/:id", async (req, res) => {
  try {
    const [event] = await db.select().from(events).where(eq(events.id, req.params.id));
    
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    let batch = null;
    if (event.batchId) {
      const [batchResult] = await db.select().from(eventBatches).where(eq(eventBatches.id, event.batchId));
      batch = batchResult;
    }

    res.json({
      event,
      batch,
      verification: {
        hash: event.hash,
        signature: event.signature,
        anchorStatus: event.anchorStatus,
        merkleProof: event.merkleProof,
        anchorTxHash: event.anchorTxHash,
      },
    });
  } catch (error) {
    console.error("Error fetching event:", error);
    res.status(500).json({ error: "Failed to fetch event" });
  }
});

/**
 * GET /api/v2/events/:id/verify
 * Verify event integrity and anchoring
 */
eventRoutes.get("/:id/verify", async (req, res) => {
  try {
    const [event] = await db.select().from(events).where(eq(events.id, req.params.id));
    
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    const verification: any = {
      eventId: event.id,
      checks: {},
    };

    // 1. Verify hash
    const eventForHashing = {
      id: event.id,
      eventType: event.eventType,
      siteId: event.siteId,
      assetId: event.assetId,
      sourceTimestamp: event.sourceTimestamp,
      receiptTimestamp: event.receiptTimestamp,
      originType: event.originType,
      originId: event.originId,
      payload: event.payload,
    };
    const computedHash = hashObject(eventForHashing);
    verification.checks.hashValid = computedHash === event.hash;
    verification.computedHash = computedHash;
    verification.storedHash = event.hash;

    // 2. Verify signature presence
    verification.checks.signaturePresent = !!event.signature;

    // 3. Verify Merkle proof if batched
    if (event.batchId && event.merkleProof && event.merkleIndex !== null) {
      const [batch] = await db.select().from(eventBatches).where(eq(eventBatches.id, event.batchId));
      if (batch) {
        const proofValid = verifyMerkleProof(
          event.hash,
          event.merkleProof as string[],
          batch.merkleRoot,
          event.merkleIndex
        );
        verification.checks.merkleProofValid = proofValid;
        verification.merkleRoot = batch.merkleRoot;
      }
    }

    // 4. Check anchor status
    verification.checks.anchored = event.anchorStatus === "ANCHORED";
    verification.anchorTxHash = event.anchorTxHash;
    verification.anchoredAt = event.anchoredAt;

    // Overall validity
    verification.valid = 
      verification.checks.hashValid && 
      verification.checks.signaturePresent &&
      (event.anchorStatus !== "ANCHORED" || verification.checks.merkleProofValid !== false);

    res.json(verification);
  } catch (error) {
    console.error("Error verifying event:", error);
    res.status(500).json({ error: "Failed to verify event" });
  }
});

// =============================================================================
// EVENT CREATION - UNIFIED ENDPOINT
// =============================================================================

/**
 * POST /api/v2/events
 * Create any event type using the EventService
 */
eventRoutes.post("/", async (req, res) => {
  try {
    const { eventType, siteId, assetId, originType, originId, payload, sourceTimestamp, details } = req.body;

    if (!eventType || !siteId || !originType || !originId || !payload) {
      return res.status(400).json({ 
        error: "Missing required fields: eventType, siteId, originType, originId, payload" 
      });
    }

    // Validate event type
    const validTypes = Object.values(EventType);
    if (!validTypes.includes(eventType)) {
      return res.status(400).json({ 
        error: `Invalid eventType. Must be one of: ${validTypes.join(", ")}` 
      });
    }

    // Validate origin type
    const validOrigins = Object.values(OriginType);
    if (!validOrigins.includes(originType)) {
      return res.status(400).json({ 
        error: `Invalid originType. Must be one of: ${validOrigins.join(", ")}` 
      });
    }

    const eventService = getEventService();
    const signedEvent = eventService.createEvent({
      eventType,
      siteId,
      assetId,
      originType,
      originId,
      payload,
      sourceTimestamp: sourceTimestamp ? new Date(sourceTimestamp) : new Date(),
      details,
    });

    // Store in database
    const [stored] = await db.insert(events).values({
      eventType: signedEvent.eventType,
      siteId: signedEvent.siteId,
      assetId: signedEvent.assetId,
      sourceTimestamp: signedEvent.sourceTimestamp,
      receiptTimestamp: new Date(),
      originType: signedEvent.originType,
      originId: signedEvent.originId,
      payload: signedEvent.payload,
      details: signedEvent.details,
      signature: signedEvent.signature,
      hash: signedEvent.hash,
      anchorStatus: "PENDING",
    }).returning();

    res.status(201).json(stored);
  } catch (error) {
    console.error("Error creating event:", error);
    res.status(500).json({ error: "Failed to create event" });
  }
});

/**
 * POST /api/v2/events/telemetry
 * Convenience endpoint for telemetry events
 */
eventRoutes.post("/telemetry", async (req, res) => {
  try {
    const { siteId, assetId, originId, originType = "GATEWAY", tag, value, unit, quality = "GOOD" } = req.body;

    if (!siteId || !assetId || !originId || !tag || value === undefined) {
      return res.status(400).json({ error: "Missing required fields: siteId, assetId, originId, tag, value" });
    }

    const eventService = getEventService();
    const signedEvent = eventService.createEvent({
      eventType: EventType.TELEMETRY,
      siteId,
      assetId,
      originType,
      originId,
      sourceTimestamp: new Date(),
      payload: { tag, value, unit, quality },
      details: `${tag} = ${value}${unit ? ` ${unit}` : ""}`,
    });

    const [stored] = await db.insert(events).values({
      eventType: signedEvent.eventType,
      siteId: signedEvent.siteId,
      assetId: signedEvent.assetId,
      sourceTimestamp: signedEvent.sourceTimestamp,
      receiptTimestamp: new Date(),
      originType: signedEvent.originType,
      originId: signedEvent.originId,
      payload: signedEvent.payload,
      details: signedEvent.details,
      signature: signedEvent.signature,
      hash: signedEvent.hash,
      anchorStatus: "PENDING",
    }).returning();

    res.status(201).json(stored);
  } catch (error) {
    console.error("Error creating telemetry event:", error);
    res.status(500).json({ error: "Failed to create telemetry event" });
  }
});

/**
 * POST /api/v2/events/alarm
 * Convenience endpoint for alarm events
 */
eventRoutes.post("/alarm", async (req, res) => {
  try {
    const { siteId, assetId, originId, originType = "GATEWAY", alarmId, alarmType, severity, state, message, value, limit } = req.body;

    if (!siteId || !assetId || !originId || !alarmId || !severity || !state || !message) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const eventService = getEventService();
    const signedEvent = eventService.createEvent({
      eventType: EventType.ALARM,
      siteId,
      assetId,
      originType,
      originId,
      sourceTimestamp: new Date(),
      payload: { alarmId, alarmType, severity, state, message, value, limit },
      details: `[${severity}] ${message}`,
    });

    const [stored] = await db.insert(events).values({
      eventType: signedEvent.eventType,
      siteId: signedEvent.siteId,
      assetId: signedEvent.assetId,
      sourceTimestamp: signedEvent.sourceTimestamp,
      receiptTimestamp: new Date(),
      originType: signedEvent.originType,
      originId: signedEvent.originId,
      payload: signedEvent.payload,
      details: signedEvent.details,
      signature: signedEvent.signature,
      hash: signedEvent.hash,
      anchorStatus: "PENDING",
    }).returning();

    res.status(201).json(stored);
  } catch (error) {
    console.error("Error creating alarm event:", error);
    res.status(500).json({ error: "Failed to create alarm event" });
  }
});

/**
 * POST /api/v2/events/command
 * Convenience endpoint for command events
 */
eventRoutes.post("/command", async (req, res) => {
  try {
    const { siteId, assetId, originId, originType = "USER", commandType, target, value, previousValue, reason } = req.body;

    if (!siteId || !assetId || !originId || !commandType || !target) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const eventService = getEventService();
    const signedEvent = eventService.createEvent({
      eventType: EventType.COMMAND,
      siteId,
      assetId,
      originType,
      originId,
      sourceTimestamp: new Date(),
      payload: { commandType, target, value, previousValue, reason, approved: false },
      details: `${commandType} ${target}${value !== undefined ? ` → ${value}` : ""}`,
    });

    const [stored] = await db.insert(events).values({
      eventType: signedEvent.eventType,
      siteId: signedEvent.siteId,
      assetId: signedEvent.assetId,
      sourceTimestamp: signedEvent.sourceTimestamp,
      receiptTimestamp: new Date(),
      originType: signedEvent.originType,
      originId: signedEvent.originId,
      payload: signedEvent.payload,
      details: signedEvent.details,
      signature: signedEvent.signature,
      hash: signedEvent.hash,
      anchorStatus: "PENDING",
    }).returning();

    res.status(201).json(stored);
  } catch (error) {
    console.error("Error creating command event:", error);
    res.status(500).json({ error: "Failed to create command event" });
  }
});

// =============================================================================
// BATCH MANAGEMENT
// =============================================================================

/**
 * GET /api/v2/events/batches
 * List event batches
 */
eventRoutes.get("/batches", async (req, res) => {
  try {
    const { siteId, anchorStatus, limit = "50" } = req.query;
    
    let query = db.select().from(eventBatches);
    const conditions: any[] = [];

    if (siteId) conditions.push(eq(eventBatches.siteId, siteId as string));
    if (anchorStatus) conditions.push(eq(eventBatches.anchorStatus, anchorStatus as string));

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    const batches = await query
      .orderBy(desc(eventBatches.createdAt))
      .limit(parseInt(limit as string));

    res.json(batches);
  } catch (error) {
    console.error("Error fetching batches:", error);
    res.status(500).json({ error: "Failed to fetch batches" });
  }
});

/**
 * GET /api/v2/events/batches/:id
 * Get batch with its events
 */
eventRoutes.get("/batches/:id", async (req, res) => {
  try {
    const [batch] = await db.select().from(eventBatches).where(eq(eventBatches.id, req.params.id));
    
    if (!batch) {
      return res.status(404).json({ error: "Batch not found" });
    }

    const batchEvents = await db
      .select()
      .from(events)
      .where(eq(events.batchId, req.params.id))
      .orderBy(events.merkleIndex);

    res.json({
      batch,
      events: batchEvents,
      verification: {
        merkleRoot: batch.merkleRoot,
        eventCount: batch.eventCount,
        anchorStatus: batch.anchorStatus,
        txHash: batch.txHash,
        blockNumber: batch.blockNumber,
      },
    });
  } catch (error) {
    console.error("Error fetching batch:", error);
    res.status(500).json({ error: "Failed to fetch batch" });
  }
});

/**
 * POST /api/v2/events/batches/:id/anchor
 * Manually trigger anchoring for a batch
 */
eventRoutes.post("/batches/:id/anchor", async (req, res) => {
  try {
    const [batch] = await db.select().from(eventBatches).where(eq(eventBatches.id, req.params.id));
    
    if (!batch) {
      return res.status(404).json({ error: "Batch not found" });
    }

    if (batch.anchorStatus === "ANCHORED") {
      return res.json({ 
        success: true, 
        message: "Already anchored",
        txHash: batch.txHash,
        blockNumber: batch.blockNumber,
      });
    }

    // Simulate anchoring (in production, call blockchain service)
    const txHash = `0x${Date.now().toString(16)}${"0".repeat(48)}`;
    const blockNumber = Math.floor(Date.now() / 1000);

    await db.update(eventBatches)
      .set({
        anchorStatus: "ANCHORED",
        txHash,
        blockNumber,
        anchoredAt: new Date(),
      })
      .where(eq(eventBatches.id, req.params.id));

    await db.update(events)
      .set({
        anchorStatus: "ANCHORED",
        anchorTxHash: txHash,
        anchoredAt: new Date(),
      })
      .where(eq(events.batchId, req.params.id));

    res.json({
      success: true,
      txHash,
      blockNumber,
      anchoredAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error anchoring batch:", error);
    res.status(500).json({ error: "Failed to anchor batch" });
  }
});

// =============================================================================
// STATISTICS & METADATA
// =============================================================================

/**
 * GET /api/v2/events/stats
 * Get event statistics
 */
eventRoutes.get("/stats", async (req, res) => {
  try {
    const { siteId } = req.query;
    const allEvents = await db.select().from(events);
    
    const stats = {
      total: 0,
      byType: {} as Record<string, number>,
      byOrigin: {} as Record<string, number>,
      byAnchorStatus: {} as Record<string, number>,
      recentActivity: { last24h: 0, lastWeek: 0 },
    };

    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const week = 7 * day;

    for (const event of allEvents) {
      if (siteId && event.siteId !== siteId) continue;
      
      stats.total++;
      stats.byType[event.eventType] = (stats.byType[event.eventType] || 0) + 1;
      stats.byOrigin[event.originType] = (stats.byOrigin[event.originType] || 0) + 1;
      stats.byAnchorStatus[event.anchorStatus] = (stats.byAnchorStatus[event.anchorStatus] || 0) + 1;

      const eventTime = new Date(event.sourceTimestamp).getTime();
      if (now - eventTime < day) stats.recentActivity.last24h++;
      if (now - eventTime < week) stats.recentActivity.lastWeek++;
    }

    res.json(stats);
  } catch (error) {
    console.error("Error fetching stats:", error);
    res.status(500).json({ error: "Failed to fetch statistics" });
  }
});

/**
 * GET /api/v2/events/types
 * Get available event types with descriptions
 */
eventRoutes.get("/types", async (_req, res) => {
  res.json({
    types: [
      { type: "TELEMETRY", description: "Sensor readings and process values" },
      { type: "ALARM", description: "Alarm activations and state changes" },
      { type: "COMMAND", description: "Operator or system commands" },
      { type: "ACKNOWLEDGEMENT", description: "Alarm acknowledgements" },
      { type: "MAINTENANCE", description: "Maintenance activities and work orders" },
      { type: "BLUEPRINT_CHANGE", description: "Control module or phase blueprint changes" },
      { type: "CODE_GENERATION", description: "Generated PLC code events" },
      { type: "DEPLOYMENT_INTENT", description: "Deployment proposals and approvals" },
    ],
    origins: [
      { type: "GATEWAY", description: "Edge gateway device" },
      { type: "USER", description: "Human operator or engineer" },
      { type: "AGENT", description: "AI/ML agent" },
      { type: "SYSTEM", description: "System-generated event" },
    ],
    anchorStatuses: [
      { status: "PENDING", description: "Awaiting batch inclusion" },
      { status: "BATCHED", description: "Included in Merkle batch, awaiting anchor" },
      { status: "ANCHORED", description: "Anchored on Ethereum L1" },
      { status: "FAILED", description: "Anchoring failed" },
    ],
  });
});
