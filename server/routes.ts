import type { Express } from "express";
import { type Server } from "http";
import { storage } from "./storage";
import { blockchainService } from "./blockchain";
import { logError } from "./logger";
import { insertSiteSchema, insertEventAnchorSchema, insertMaintenanceRecordSchema } from "@shared/schema";
import { fromZodError } from "zod-validation-error/v4";
import { agentRoutes } from "./routes/agents";
import { eventRoutes } from "./routes/events";
import { batchRoutes } from "./routes/batch";
import { aasRouter } from "./routes/aas";
import ubiquityRoutes from "./routes/ubiquity";
import { certificationRoutes } from "./routes/certifications";
import artifactRoutes from "./routes/ArtifactRoutes";
import { assetRoutes } from "./routes/assets";
import { alarmRoutes } from "./routes/alarms";
import pidRoutes from "./routes/pid";
import { fluxRoutes } from "./routes/flux";
import { gatewayRoutes } from "./routes/gateway";
import { intelligenceRoutes } from "./routes/intelligence";
import { governanceRoutes } from "./routes/governance";
import { securityRoutes } from "./routes/security";
import { geometryRoutes } from "./routes/geometry";
import { blueprintRoutes } from "./routes/blueprints";
import { vendorRoutes } from "./routes/vendors";
import { codegenRoutes } from "./routes/codegen";
import { adminAnchorRoutes } from "./routes/admin-anchor"; // #455 Anchor-Backend Switch UX
import { getFluxPublisher } from "./services/flux";

import { tagStreamServer } from "./websocket/tag-stream";
import { unifiedStreamServer } from "./websocket/unified-stream";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // ==========================================================================
  // MODULAR ROUTES
  // ==========================================================================
  app.use("/api/agents", agentRoutes);
  app.use("/api/v2/events", eventRoutes);
  app.use("/api/batch", batchRoutes);
  app.use("/api/aas", aasRouter);
  app.use("/api/ubiquity", ubiquityRoutes);
  app.use("/api/certifications", certificationRoutes);
  app.use("/api/artifacts", artifactRoutes);
  app.use("/api/assets", assetRoutes);
  app.use("/api/alarms", alarmRoutes);
  app.use("/api/pid", pidRoutes);
  app.use("/api/flux", fluxRoutes);
  app.use("/api/gateway", gatewayRoutes);

  // P1 Wiring: Intelligence, Governance, and Security modules
  app.use("/api/intelligence", intelligenceRoutes);
  app.use("/api/governance", governanceRoutes);
  app.use("/api/security", securityRoutes);
  app.use("/api/geometry", geometryRoutes(getFluxPublisher()));

  // Blueprint / vendor / codegen surfaces (extracted from this file, #446).
  // vendorRoutes and codegenRoutes span several top-level prefixes
  // (/vendors, /templates, /generate, /generated-code, ...) so they mount
  // at /api with their own sub-paths.
  app.use("/api/blueprints", blueprintRoutes);
  app.use("/api", vendorRoutes);
  app.use("/api", codegenRoutes);
  app.use("/api/admin/anchor-backend", adminAnchorRoutes); // #455 Anchor-Backend Switch UX

  // Convenience routes for agent outputs and proposals (redirect to agentRoutes)
  app.get("/api/agent-outputs", async (req, res, next) => {
    req.url = "/outputs";
    agentRoutes(req, res, next);
  });
  app.get("/api/agent-proposals", async (req, res, next) => {
    req.url = "/proposals";
    agentRoutes(req, res, next);
  });

  // ==========================================================================
  // WEBSOCKET EVENT STREAM
  // ==========================================================================
  // WebSocket servers initialize if available
  try { tagStreamServer?.initialize(httpServer, "/ws/tags"); } catch {}
  try { unifiedStreamServer?.initialize(httpServer, "/ws"); } catch {}  // unified endpoint (#255)

  // WebSocket metrics endpoint. The legacy event-stream server was removed;
  // only the tag and unified streams report (#446, #479).
  app.get("/api/ws/metrics", (req, res) => {
    res.json({
      tagStream: tagStreamServer.getMetrics(),
      unified: unifiedStreamServer.getMetrics(),
    });
  });

  app.get("/api/ws/clients", (req, res) => {
    res.json({
      unified: unifiedStreamServer.getConnectedClients(),
    });
  });

  // Tag stream metrics
  app.get("/api/ws/tags/metrics", (req, res) => {
    res.json(tagStreamServer.getMetrics());
  });

  // ==========================================================================
  // HEALTH CHECK
  // ==========================================================================
  app.get("/api/health", async (req, res) => {
    try {
      // Check database connectivity with lightweight query
      const dbHealth = await (storage as any).healthCheck();

      // Check blockchain service
      const blockchainConnected = (blockchainService as any).isEnabled();

      // Determine overall health status
      const isHealthy = dbHealth.connected;

      const response = {
        status: isHealthy ? "healthy" : "unhealthy",
        timestamp: new Date().toISOString(),
        version: "1.0.0",
        uptime: process.uptime(),
        components: {
          database: {
            status: dbHealth.connected ? "up" : "down",
            latencyMs: dbHealth.latencyMs,
          },
          blockchain: {
            status: blockchainConnected ? "up" : "down",
          },
        },
      };

      if (isHealthy) {
        res.status(200).json(response);
      } else {
        res.status(503).json(response);
      }
    } catch (error) {
      logError(error, "Health check failed:");
      res.status(503).json({
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        version: "1.0.0",
        uptime: process.uptime(),
        components: {
          database: { status: "down" },
          blockchain: { status: "unknown" },
        },
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // Sites
  app.get("/api/sites", async (req, res) => {
    try {
      const sites = await (storage as any).getSites();
      res.json(sites);
    } catch (error) {
      logError(error, "Error fetching sites:");
      res.status(500).json({ error: "Failed to fetch sites" });
    }
  });

  app.post("/api/sites", async (req, res) => {
    try {
      const validation = insertSiteSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ error: fromZodError(validation.error).toString() });
      }

      const site = await (storage as any).createSite(validation.data);

      await (blockchainService as any).registerSite(
        site.id,
        site.name,
        site.location,
        site.owner
      );

      res.status(201).json(site);
    } catch (error) {
      logError(error, "Error creating site:");
      res.status(500).json({ error: "Failed to create site" });
    }
  });

  // Events
  app.get("/api/events", async (req, res) => {
    try {
      // Parse and validate pagination parameters
      const parsedPage = req.query.page ? parseInt(req.query.page as string, 10) : 1;
      const parsedLimit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;

      // Validate page (must be positive integer)
      const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;

      // Validate limit (must be between 1 and 100, default 50)
      const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, 100)
        : 50;

      const { data, total } = await (storage as any).getEventAnchorsPaginated(page, limit);

      // Calculate pagination metadata
      const totalPages = Math.ceil(total / limit);
      const hasNextPage = page < totalPages;
      const hasPrevPage = page > 1;

      res.json({
        data,
        total,
        page,
        limit,
        totalPages,
        hasNextPage,
        hasPrevPage,
        nextPage: hasNextPage ? page + 1 : null,
        prevPage: hasPrevPage ? page - 1 : null,
      });
    } catch (error) {
      logError(error, "Error fetching events:");
      res.status(500).json({ error: "Failed to fetch events" });
    }
  });

  app.post("/api/events", async (req, res) => {
    try {
      if (!req.body || req.body.payload === undefined) {
        return res.status(400).json({ error: "Missing payload" });
      }

      const payloadHash = (blockchainService as any).hashPayload(req.body.payload);

      const eventData = {
        assetId: req.body.assetId,
        eventType: req.body.eventType,
        payloadHash,
        timestamp: new Date(),
        recordedBy: req.body.recordedBy || "0xGateway_System",
        txHash: null,
        details: req.body.details || "",
        fullPayload: req.body.payload,
      };

      const validation = insertEventAnchorSchema.safeParse(eventData);
      if (!validation.success) {
        return res.status(400).json({ error: fromZodError(validation.error).toString() });
      }

      const event = await (storage as any).createEventAnchor(validation.data);

      const txHash = await (blockchainService as any).anchorEvent(
        event.assetId,
        event.eventType,
        payloadHash
      );

      if (txHash) {
        await (storage as any).updateEventTxHash(event.id, txHash);
        event.txHash = txHash;
      }

      res.status(201).json(event);
    } catch (error) {
      logError(error, "Error creating event:");
      res.status(500).json({ error: "Failed to create event" });
    }
  });

  // Maintenance Records
  app.get("/api/maintenance", async (req, res) => {
    try {
      const records = await (storage as any).getMaintenanceRecords();
      res.json(records);
    } catch (error) {
      logError(error, "Error fetching maintenance records:");
      res.status(500).json({ error: "Failed to fetch maintenance records" });
    }
  });

  app.post("/api/maintenance", async (req, res) => {
    try {
      const validation = insertMaintenanceRecordSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ error: fromZodError(validation.error).toString() });
      }

      const record = await (storage as any).createMaintenanceRecord(validation.data);

      await (blockchainService as any).anchorMaintenance(
        record.assetId,
        record.workOrderId,
        record.maintenanceType,
        Math.floor(new Date(record.performedAt).getTime() / 1000)
      );

      res.status(201).json(record);
    } catch (error) {
      logError(error, "Error creating maintenance record:");
      res.status(500).json({ error: "Failed to create maintenance record" });
    }
  });

  // Blockchain status
  app.get("/api/blockchain/status", (req, res) => {
    res.json({
      enabled: (blockchainService as any).isEnabled(),
    });
  });

  return httpServer;
}
