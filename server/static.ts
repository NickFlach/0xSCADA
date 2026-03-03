/**
 * Static file serving
 */
import express from 'express';
import path from 'path';

export const serveStatic = (app: express.Application) => {
  // Serve built client files
  const clientPath = path.join(process.cwd(), 'dist', 'client');
  app.use(express.static(clientPath));
  
  // SPA fallback - serve index.html for unmatched routes
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientPath, 'index.html'));
  });
};