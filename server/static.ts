/**
 * Static file serving
 */
import express from 'express';
import path from 'path';
import { rateLimit as expressRateLimit } from 'express-rate-limit';
import { rateLimitMiddleware } from './middleware/api-gateway';

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 200;

export const serveStatic = (app: express.Application) => {
  // Rate limit for static file serving (generous limit).
  //
  // Two limiters at the same window and limit, for the reason documented on the
  // `/api/` pair in `middleware/api-gateway.ts`: `rateLimitMiddleware` is the
  // real one — it can be Redis-backed and so bounds the fleet rather than one
  // process — but it is hand-rolled, so static analysis cannot recognise it and
  // reports every handler behind it as unlimited. `express-rate-limit` is
  // modelled by CodeQL. It is per-process, so it can only ever be stricter than
  // the shared bound, never looser.
  const staticRateLimit = rateLimitMiddleware({ windowMs: WINDOW_MS, maxRequests: MAX_REQUESTS });
  const scannerVisibleLimit = expressRateLimit({
    windowMs: WINDOW_MS,
    limit: MAX_REQUESTS,
    // `rateLimitMiddleware` owns the response headers and the 429 body.
    standardHeaders: false,
    legacyHeaders: false,
  });

  // Serve built client files
  const clientPath = path.join(process.cwd(), 'dist', 'client');
  app.use(staticRateLimit, scannerVisibleLimit, express.static(clientPath));

  // SPA fallback - serve index.html for unmatched routes
  app.get('*', staticRateLimit, scannerVisibleLimit, (req, res) => {
    res.sendFile(path.join(clientPath, 'index.html'));
  });
};