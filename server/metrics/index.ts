/**
 * Metrics Module
 * 
 * Prometheus-compatible metrics exporter for 0xSCADA.
 * 
 * Usage:
 * ```typescript
 * import { metricsMiddleware, metricsHandler, eventsTotal } from './metrics';
 * 
 * // Add middleware to Express app
 * app.use(metricsMiddleware());
 * 
 * // Add metrics endpoint
 * app.get('/metrics', metricsHandler);
 * 
 * // Record custom metrics
 * eventsTotal.inc({ type: 'alarm', severity: 'critical', site_id: '1' });
 * ```
 * 
 * @module server/metrics
 */

export {
  // Registry
  registry,
  
  // Express integration
  metricsMiddleware,
  metricsHandler,
  
  // HTTP metrics
  httpRequestsTotal,
  httpRequestDuration,
  
  // Database metrics
  dbQueryTotal,
  dbQueryDuration,
  dbConnectionsActive,
  
  // Blockchain metrics
  blockchainAnchorsTotal,
  blockchainAnchorDuration,
  blockchainGasUsed,
  
  // Event metrics
  eventsTotal,
  eventsQueueSize,
  
  // Site metrics
  sitesActive,
  assetsTotal,
  
  // Process metrics
  processUptime,
  processMemoryUsage,
  processCpuUsage,
} from './prometheus.js';

// Re-export default for convenience
export { default } from './prometheus.js';
