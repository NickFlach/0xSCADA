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
import { fluxRoutes } from "./routes/flux";
import { gatewayRoutes } from "./routes/gateway";
import { intelligenceRoutes } from "./routes/intelligence";
import { twinRoutes } from "./routes/twin";
import { digitalTwinService } from "./services/twin";
import { alarmCorrelationRoutes } from "./routes/alarm-correlation";
import { alarmCorrelationService } from "./services/alarm-correlation";
import { predictiveRoutes } from "./routes/predictive";
import { predictiveMaintenanceService } from "./services/predictive";
import { tuningRoutes } from "./routes/tuning";
import { tuningService } from "./services/tuning";
import { marketplaceRoutes } from "./routes/marketplace";
import { marketplaceService } from "./services/marketplace";
import { nlQueryService } from "./services/nlquery";
import { governanceRoutes } from "./routes/governance";
import { securityRoutes } from "./routes/security";
import { geometryRoutes } from "./routes/geometry";
import {
  nodeRoutes, // #454: cross-node state queries
  nodesRoutes, // #456 slashing & liveness visualizer
} from "./routes/nodes";
import { blueprintSafeStateRoutes } from "./routes/blueprint-safe-state"; // #459
import { blueprintRoutes } from "./routes/blueprints";
import { vendorRoutes } from "./routes/vendors";
import { codegenRoutes } from "./routes/codegen";
import { adminAnchorRoutes } from "./routes/admin-anchor"; // #455 Anchor-Backend Switch UX
import { validatorRoutes } from "./routes/validators"; // #453 Validator Dashboard proxy
import { getFluxPublisher } from "./services/flux";

import { tagStreamServer } from "./websocket/tag-stream";
import { unifiedStreamServer } from "./websocket/unified-stream";
import { cachedEventBridge } from "./websocket/cached-event-bridge";
import type { WebSocketAuthOptions } from "./websocket/upgrade-auth";

export interface RouteRegistrationOptions {
  websocketAuth?: WebSocketAuthOptions;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express,
  options: RouteRegistrationOptions = {},
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
  app.use("/api/flux", fluxRoutes);
  app.use("/api/gateway", gatewayRoutes);

  // P1 Wiring: Intelligence, Governance, and Security modules
  app.use("/api/intelligence", intelligenceRoutes);
  app.use("/api/twin", twinRoutes);  // ADR-0013 [13.3] (#214)
  app.use("/api/alarm-correlation", alarmCorrelationRoutes);  // ADR-0013 [13.2] (#213)
  app.use("/api/predictive", predictiveRoutes);  // ADR-0013 [13.1] (#212)
  // ADR-0013 [13.4] (#215). PID tuning deliberately does NOT live under
  // /api/pid: that prefix belongs to the P&ID diagram surface the client
  // already calls (client/src/pages/pid-view.tsx -> /api/pid/diagrams/:id).
  app.use("/api/tuning", tuningRoutes);
  app.use("/api/marketplace", marketplaceRoutes);  // ADR-0013 [13.6] (#217)
  app.use("/api/governance", governanceRoutes);
  app.use("/api/security", securityRoutes);
  app.use("/api/geometry", geometryRoutes(getFluxPublisher()));
  app.use("/api/nodes", nodeRoutes); // #454: GET /api/nodes/:id/state/:key
  app.use("/api/blueprint-safe-state", blueprintSafeStateRoutes); // #459 watchdog & safe-state
  // #456 validator attestation history (read-only). The live endpoint fails
  // closed with 503 while no observed-attestation feed is registered; synthetic
  // demo data lives on a separate route that is off unless SLASHING_DEMO_DATA=true.
  // Mounted after nodeRoutes on the same prefix: the two route sets are
  // disjoint, so unmatched requests fall through from one router to the other.
  app.use("/api/nodes", nodesRoutes);

  // Blueprint / vendor / codegen surfaces (extracted from this file, #446).
  // vendorRoutes and codegenRoutes span several top-level prefixes
  // (/vendors, /templates, /generate, /generated-code, ...) so they mount
  // at /api with their own sub-paths.
  app.use("/api/blueprints", blueprintRoutes);
  app.use("/api", vendorRoutes);
  app.use("/api", codegenRoutes);
  app.use("/api/admin/anchor-backend", adminAnchorRoutes); // #455 Anchor-Backend Switch UX
  app.use("/api/validators", validatorRoutes); // #453 Validator Dashboard (server-side node polling)

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
  // Authentication runs in the HTTP upgrade handler because WebSocket
  // handshakes bypass Express middleware.
  const websocketAuth = options.websocketAuth ?? {
    required: false,
    apiKeys: new Map(),
  };
  tagStreamServer.initialize(httpServer, "/ws/tags", websocketAuth);
  unifiedStreamServer.initialize(httpServer, "/ws", websocketAuth); // unified endpoint (#255)
  cachedEventBridge.initializeLocalAlarmFanout();

  // Feed live tag updates into the predictive maintenance engine (#212)
  tagStreamServer.onTagUpdate((update) =>
    predictiveMaintenanceService.ingestTagUpdate(update)
  );

  // Start the periodic predictive analysis sweep here —
  // services/initializeServices() has no callers at startup.
  void predictiveMaintenanceService.initialize();

  // Surface predictive alerts on the alarm WebSocket channel so they reach
  // operators, not just the REST API.
  predictiveMaintenanceService.on("alert", (alert) => {
    void cachedEventBridge.publishAlarm({
      id: alert.id,
      name: `Predictive: ${alert.tagId}`,
      tagId: alert.tagId,
      severity: alert.severity,
      state: "active",
      message: alert.message,
      tagValue: undefined,
      triggeredAt: new Date(alert.timestamp).toISOString(),
      timestamp: new Date(alert.timestamp).toISOString(),
      source: "predictive-maintenance",
      recommendation: alert.recommendation,
    }).catch(() => { /* alarm fan-out failure must not break alerting */ });
  });

  // Start alarm-correlation idle-group sweeps (#213). Registered here rather
  // than in services/initializeServices(), which no startup path invokes.
  void alarmCorrelationService.initialize();

  // Feed live tag updates into the digital twin and start its step timer
  // here — services/initializeServices() has no callers at startup (#214).
  const unsubscribeTwin = tagStreamServer.onTagUpdate(
    (update) => digitalTwinService.ingestTagUpdate(update)
  );
  void digitalTwinService.initialize();
  httpServer.once("close", () => {
    unsubscribeTwin();
    void digitalTwinService.shutdown();
  });

  // Start the tuning service (and its underlying optimization service)
  // here — services/initializeServices() has no callers at startup (#215).
  // initialize() opens the durable tuning-audit store and logs whether the
  // approver allowlist and the gain-apply opt-in are configured, so a
  // fail-closed deployment is visible at boot rather than at first approval.
  void tuningService.initialize();
  httpServer.once("close", () => {
    void tuningService.shutdown();
  });
  // Load marketplace state and register the first-party plugin
  // implementations here — services/initializeServices() has no callers at
  // startup (#217). This is awaited rather than fired-and-forgotten: the
  // publish path checks plugin ownership against the loaded registry, and an
  // ownership check against an unhydrated registry would authorize a hijack.
  await marketplaceService.initialize();

  // Mark the NL query service live here — services/initializeServices() has no
  // callers at startup (#216). There is nothing to subscribe or schedule: the
  // engine reads the historian, the live tag stream, and the alarm-correlation
  // engine at query time rather than keeping a shadow copy of process data, so
  // initialize() only flips the health flag.
  void nlQueryService.initialize();
  httpServer.once("close", () => {
    void nlQueryService.shutdown();
  });

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
