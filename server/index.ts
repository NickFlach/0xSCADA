import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { securityHeaders } from "./middleware/security";
import { log, logError } from "./logger";
import { healthRouter, healthManager } from "./health";
import { registerSwaggerRoutes } from "./openapi";
import { apiKeyAuthEnabled, setupApiGateway } from "./middleware/api-gateway";
import { requestLoggingMiddleware } from "./middleware/request-logging";
import { initializeDatabase } from "./storage";
// Stateful startup services must stay in the static graph. On Node 20, tsx can
// give import() a separate module instance from static consumers (#541).
import { fieldSimulator } from "./simulator";
import { initializeDefaultAgents, startDefaultAgents } from "./agents";
import { storeAndForwardService } from "./gateway/store-and-forward";
import { edgeStoreAndForwardRuntime } from "./gateway/store-and-forward-runtime";
import { initializeBridges } from "./bridge";
import { gatewayManager } from "./gateway";
import { startFluxIntegration } from "./services/flux";
import { natsPublisher } from "./services/nats";
import { logAnchorBackendBootState } from "./bridge/anchor-backend";
import { startBlueprintControlLoop } from "./blueprint/control-loop";
// Blueprint watchdog / safe-state composition root (#459). Off unless the
// deployment supplies BLUEPRINT_SAFETY_BINDINGS[_FILE].
import { blueprintSafetyHost } from "./blueprint/safety-host";
// Observed-liveness collector (#456). Off unless
// VALIDATOR_LIVENESS_COLLECTOR_ENABLED=true and ANCHOR_NODE_URLS is set.
import { startValidatorLivenessCollector } from "./blockchain/liveness-collector";

// Re-export log for backward compatibility
export { log } from "./logger";

const app = express();
const httpServer = createServer(app);

// Apply security headers. API rate limiting is installed by setupApiGateway
// after body parsing so one gateway owns authentication and quota state.
app.use(securityHeaders);

// API Gateway middleware (#256) — sets up rate limiting, API key auth, CORS, request IDs
const gatewayRateLimit = {
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  maxRequests: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
};
const gatewayConfig = {
  rateLimit: gatewayRateLimit,
  enableApiKeyAuth: apiKeyAuthEnabled(),
  publicRoutes: ['/api/health', '/api/healthz', '/api/readyz', '/api/docs'],
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:5173').split(','),
};

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

// Install response capture before the gateway's own routes so one-time
// credentials can be returned while being explicitly redacted from logs.
app.use(requestLoggingMiddleware());

// Activate the configured gateway after parsing so its payload guard can
// inspect request bodies.
const apiKeyManager = setupApiGateway(app, gatewayConfig);

// Register every /api route behind the gateway pipeline. The exact probe/docs
// allowlist skips authentication only; those routes still receive request IDs,
// CORS, logging, and rate limiting. /api/metrics is intentionally not public.
app.use('/api', healthRouter);
registerSwaggerRoutes(app, gatewayConfig);

(async () => {
  // Initialize the database first — downstream services and health checks
  // depend on an established connection (SQLite fallback in development).
  await initializeDatabase();
  log("Database initialized");

  await fieldSimulator.initialize();
  
  await initializeDefaultAgents();
  await startDefaultAgents();
  
  // Install a real upstream transport before the shared queue singleton starts.
  // Explicit production enablement without bindings fails startup closed.
  await edgeStoreAndForwardRuntime.initialize();
  if (edgeStoreAndForwardRuntime.isEnabled()) {
    log("Production edge store-and-forward bindings initialized");
  }

  // Initialize edge store-and-forward service
  await storeAndForwardService.initialize();
  log("Edge store-and-forward service initialized");

  // Initialize bridge modules (event-anchor, state-sync)
  await initializeBridges();
  log("Bridge modules (event-anchor, state-sync) initialized");

  // Initialize demo gateway in development mode
  if (process.env.NODE_ENV === "development") {
    // Create demo DNP3 TCP driver
    gatewayManager.addDriver({
      id: "demo-dnp3-tcp",
      protocol: {
        type: "DNP3_TCP",
        name: "Demo DNP3 TCP Driver",
        connectionString: "192.168.1.100:20000",
        enabled: true
      },
      status: "connected",
      lastUpdate: new Date()
    });
    
    // Create demo DNP3 Serial driver
    gatewayManager.addDriver({
      id: "demo-dnp3-serial",
      protocol: {
        type: "DNP3_SERIAL",
        name: "Demo DNP3 Serial Driver", 
        connectionString: "COM1:9600,8,N,1",
        enabled: true
      },
      status: "connected",
      lastUpdate: new Date()
    });
    
    // Create demo IEC61850 MMS driver
    gatewayManager.addDriver({
      id: "demo-iec61850-mms",
      protocol: {
        type: "IEC61850_MMS",
        name: "Demo IEC61850 MMS Driver",
        connectionString: "192.168.1.200:102",
        enabled: true
      },
      status: "connected", 
      lastUpdate: new Date()
    });
    
    log("Initialized demo gateway drivers for development mode");
  }
  
  await registerRoutes(httpServer, app, {
    websocketAuth: {
      required: gatewayConfig.enableApiKeyAuth,
      apiKeys: apiKeyManager.getKeysMap(),
    },
  });

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = process.env.NODE_ENV === "production" && status >= 500
      ? "Internal Server Error"
      : err.message || "Internal Server Error";

    res.status(status).json({ message });
    logError("Unhandled error", err);
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await (setupVite as any)(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
    },
    async () => {
      log(`serving on port ${port}`);
      
      fieldSimulator.start();

      // Start Flux state engine integration (ADR-0015, Issue #260)
      startFluxIntegration();

      // Start MQTT Sparkplug B bridge (Issue #463) — no-op unless
      // SPARKPLUG_BROKER_URL is configured.
      try {
        const { startSparkplugBridge } = await import("./protocols/sparkplug-b");
        startSparkplugBridge();
      } catch (err) {
        logError(err, "Sparkplug B bridge failed to start");
      }

      // Start the IEC 61850 GOOSE subscriber (Issue #465) — no-op unless
      // GOOSE_SUBSCRIPTIONS_FILE is configured. Capture is opt-in: with
      // GOOSE_PCAP_FILE it replays a capture, with GOOSE_CAPTURE=live it
      // captures EtherType 0x88B8 off GOOSE_IFACE through a libpcap tool
      // (needs CAP_NET_RAW), otherwise it starts "unavailable" and logs why.
      try {
        const { startGooseSubscriber } = await import("./protocols/iec61850-goose");
        await startGooseSubscriber();
      } catch (err) {
        logError(err, "IEC 61850 GOOSE subscriber failed to start");
      }

      // Start OPC-UA Server Mode (Issue #461) — OFF unless
      // OPCUA_SERVER_ENABLED=true. Defaults bind loopback with Basic256Sha256
      // and no anonymous access; an invalid configuration throws here and leaves
      // the process without an OPC-UA listener rather than opening a permissive
      // one.
      try {
        const { startOpcuaServer } = await import(
          "./protocols/opcua-server/runtime"
        );
        await startOpcuaServer();
      } catch (err) {
        logError(err, "OPC-UA Server Mode failed to start — not listening");
      }

      // Start Modbus TCP Server Mode (Issue #462) — no-op unless
      // MODBUS_SERVER_ENABLED=true. The protocol has no authentication, so the
      // listener defaults to loopback, refuses peers outside its allowlist, and
      // serves write function codes only when separately opted in. A
      // configuration or register-map failure is terminal for the listener:
      // it is logged and no socket is bound, never downgraded to defaults.
      try {
        const { startModbusServer } = await import("./protocols/modbus-server");
        await startModbusServer();
      } catch (err) {
        logError(err, "Modbus TCP Server Mode not started (failed closed)");
      }

      // Start DNP3 Outstation Mode (Issue #464) — no-op unless
      // DNP3_OUTSTATION_ENABLED=true. DNP3 does not authenticate the TCP peer
      // and does not authenticate reads at all, so the listener defaults to
      // loopback, refuses peers outside its allowlist, and executes
      // SELECT/OPERATE only when separately opted in (which additionally
      // requires an SAv5 Update Key unless the deployment explicitly declares
      // it is running controls unauthenticated). A configuration or point-map
      // failure is terminal for the listener: it is logged and no socket is
      // bound, never downgraded to defaults.
      try {
        const { startDnp3Outstation } = await import(
          "./protocols/dnp3-outstation"
        );
        await startDnp3Outstation();
      } catch (err) {
        logError(err, "DNP3 Outstation Mode not started (failed closed)");
      }

      // Connect to NATS for SCADA event publishing
      await natsPublisher.connect();

      // Record the boot-resolved anchor routing: runtime switches (#455) are
      // process-local, so a restart reverts to env and this makes that visible.
      logAnchorBackendBootState();

      // Deterministic blueprint control loop (#457). OFF unless
      // BLUEPRINT_CONTROL_LOOP_ENABLED === "true" and a blueprint file is
      // configured. It executes compiled control logic on a fixed cadence and
      // publishes scheduling telemetry; it has NO field write path, so enabling
      // it cannot actuate a plant. Fails closed: a bad blueprint is logged and
      // the loop stays off rather than taking the server down.
      startBlueprintControlLoop();
      // Arm the blueprint watchdogs (#459). No-op unless this deployment
      // supplies BLUEPRINT_SAFETY_BINDINGS / BLUEPRINT_SAFETY_BINDINGS_FILE;
      // the resulting state is always reported by /api/blueprint-safe-state.
      const safetyStatus = blueprintSafetyHost.start();
      log(`Blueprint safety host: ${safetyStatus.state} — ${safetyStatus.reason}`);

      // Observed-liveness collector (#456) — OFF unless
      // VALIDATOR_LIVENESS_COLLECTOR_ENABLED=true and ANCHOR_NODE_URLS names at
      // least one node. It polls each node's /status on a cadence and persists
      // whether the node answered and whether the height it reported advanced.
      // That is observed liveness, NOT consensus attestation duty history —
      // which this build still cannot report. When it starts, it registers the
      // live source behind GET /api/nodes/attestation-history; when it does
      // not, that route keeps failing closed with 503.
      try {
        const livenessStatus = await startValidatorLivenessCollector();
        log(
          `Observed-liveness collector: ${livenessStatus.reason}` +
            (livenessStatus.enabled
              ? ` (source ${livenessStatus.sourceId}; observed liveness only, not consensus attestation)`
              : ""),
        );
      } catch (err) {
        logError(err, "Observed-liveness collector failed to start — no source registered");
      }

      // Start periodic health monitoring (every 30 s)
      healthManager.startPeriodicCheck(30_000);
    },
  );
})();
