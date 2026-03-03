import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { securityHeaders, rateLimit } from "./middleware/security";
import { log, logError } from "./logger";
import { healthRouter, healthManager } from "./health";
import { registerSwaggerRoutes } from "./openapi";
import { setupApiGateway } from "./middleware/api-gateway";

// Re-export log for backward compatibility
export { log } from "./logger";

const app = express();
const httpServer = createServer(app);

// Apply security headers and rate limiting
app.use(securityHeaders);
app.use("/api/", rateLimit({ windowMs: 60_000, maxRequests: 100 }));

// Health/readiness probes — mounted before auth so k8s probes work unauthenticated
app.use(healthRouter);

// API Gateway middleware (#256) — sets up rate limiting, API key auth, CORS, request IDs
const gatewayRateLimit = {
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  maxRequests: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
};
const gatewayConfig = {
  rateLimit: gatewayRateLimit,
  enableApiKeyAuth: process.env.ENABLE_API_KEYS === 'true',
  publicRoutes: ['/api/health', '/api/healthz', '/api/readyz', '/api/docs'],
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:5173').split(','),
};

// Wire OpenAPI docs to gateway config so Swagger UI reflects live settings
registerSwaggerRoutes(app, gatewayConfig);

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

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  const { fieldSimulator } = await import("./simulator");
  await fieldSimulator.initialize();
  
  const { initializeDefaultAgents, startDefaultAgents } = await import("./agents");
  await initializeDefaultAgents();
  await startDefaultAgents();

  // Initialize edge store-and-forward service
  const { storeAndForwardService } = await import("./gateway/store-and-forward");
  await storeAndForwardService.initialize();
  log("Edge store-and-forward service initialized");
  
  // Initialize demo gateway in development mode
  if (process.env.NODE_ENV === "development") {
    const { gatewayManager } = await import("./gateway");
    
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
  
  await registerRoutes(httpServer, app);

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
    await setupVite(httpServer, app);
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
      reusePort: true,
    },
    async () => {
      log(`serving on port ${port}`);
      
      const { fieldSimulator } = await import("./simulator");
      fieldSimulator.start();

      // Start Flux state engine integration (ADR-0015, Issue #260)
      const { startFluxIntegration } = await import("./services/flux");
      startFluxIntegration();

      // Start periodic health monitoring (every 30 s)
      healthManager.startPeriodicCheck(30_000);
    },
  );
})();
