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
import { initializeBridges } from "./bridge";
import { gatewayManager } from "./gateway";
import { startFluxIntegration } from "./services/flux";
import { natsPublisher } from "./services/nats";
import { logAnchorBackendBootState } from "./bridge/anchor-backend";

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

      // Connect to NATS for SCADA event publishing
      await natsPublisher.connect();

      // Record the boot-resolved anchor routing: runtime switches (#455) are
      // process-local, so a restart reverts to env and this makes that visible.
      logAnchorBackendBootState();

      // Start periodic health monitoring (every 30 s)
      healthManager.startPeriodicCheck(30_000);
    },
  );
})();
