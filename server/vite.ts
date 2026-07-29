/**
 * Vite development server integration
 */
import type { Application } from "express";
import type { Server } from "http";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { rateLimit as expressRateLimit } from "express-rate-limit";
import { rateLimitMiddleware } from "./middleware/api-gateway";

export async function setupVite(httpServer: Server, app: Application) {
  const vite = await createViteServer({
    configFile: path.resolve(process.cwd(), "vite.config.ts"),
    server: {
      middlewareMode: true,
      hmr: {
        server: httpServer,
      },
    },
    appType: "custom",
  });

  // Use Vite's connect instance as middleware
  app.use(vite.middlewares);

  // Rate limit for SPA fallback file system access.
  //
  // Paired for the reason documented on the `/api/` limiters in
  // `middleware/api-gateway.ts`: `rateLimitMiddleware` is the real, optionally
  // Redis-backed one but is invisible to static analysis; `express-rate-limit`
  // is modelled by CodeQL and, being per-process, can only be stricter.
  const spaRateLimit = rateLimitMiddleware({ windowMs: 60_000, maxRequests: 200 });
  const scannerVisibleLimit = expressRateLimit({
    windowMs: 60_000,
    limit: 200,
    standardHeaders: false,
    legacyHeaders: false,
  });

  // Serve index.html for all non-API routes (SPA fallback)
  app.use("*", spaRateLimit, scannerVisibleLimit, async (req, res, next) => {
    const url = req.originalUrl;

    // Skip API routes
    if (url.startsWith("/api")) {
      return next();
    }

    try {
      const htmlPath = path.resolve(process.cwd(), "client", "index.html");
      let html = fs.readFileSync(htmlPath, "utf-8");
      html = await vite.transformIndexHtml(url, html);
      res.status(200).set({ "Content-Type": "text/html" }).end(html);
    } catch (e: any) {
      vite.ssrFixStacktrace(e);
      next(e);
    }
  });
}

export const setupViteDevServer = setupVite;
