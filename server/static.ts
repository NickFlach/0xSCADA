/**
 * Static file serving
 */
import express from 'express';
import path from 'path';
import { rateLimitMiddleware } from './middleware/api-gateway';

export const serveStatic = (app: express.Application) => {
  // Rate limit for static file serving (generous limit)
  const staticRateLimit = rateLimitMiddleware({ windowMs: 60_000, maxRequests: 200 });

  // Serve built client files
  const clientPath = path.join(process.cwd(), 'dist', 'client');
  app.use(staticRateLimit, express.static(clientPath));
  
  // SPA fallback - serve index.html for unmatched routes
  app.get('*', staticRateLimit, (req, res) => {
    res.sendFile(path.join(clientPath, 'index.html'));
  });
};