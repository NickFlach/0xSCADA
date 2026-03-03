/**
 * [12.8] Service Health & Readiness — Wiring
 *
 * Creates a singleton HealthManager, registers concrete checks for
 * every backend dependency, and exports the Express router.
 *
 * Integration: Prometheus metrics are exposed at /healthz/metrics and
 * health status is reported as Prometheus gauges (closes #253).
 */

import { HealthManager, createDatabaseCheck, createBlockchainCheck, createGatewayCheck } from './health-manager';
import { storage } from '../storage';
import { blockchainService } from '../blockchain';
import { registry, metricsHandler } from '../metrics';

// ── Prometheus health gauges ─────────────────────────────────────────────────
// These gauges let Prometheus scrape health status as numeric metrics.

/** 1 = healthy, 0 = unhealthy */
export const healthStatusGauge = registry.gauge(
  'health_status',
  'Overall system health (1=healthy, 0=unhealthy)',
);

/** Per-component health: 1 = up, 0 = down */
export const componentHealthGauge = registry.gauge(
  'health_component_status',
  'Per-component health status (1=up, 0=down)',
  ['component'],
);

/** Timestamp of the last health check evaluation */
export const healthCheckTimestamp = registry.gauge(
  'health_last_check_timestamp_seconds',
  'Unix timestamp of last health evaluation',
);

// ── Singleton ────────────────────────────────────────────────────────────────
export const healthManager = new HealthManager(/* cacheTtlMs */ 10_000);

// ── Register checks ──────────────────────────────────────────────────────────

// 1. Database (required) — must be healthy before anything else
healthManager.register(
  createDatabaseCheck(async () => {
    const h = await storage.healthCheck();
    if (!h.connected) throw new Error('Database not connected');
    return h;
  })
);

// 2. Blockchain RPC (optional, depends on database)
const rpcUrl = process.env.BLOCKCHAIN_RPC_URL || 'http://127.0.0.1:8545';
healthManager.register(createBlockchainCheck(rpcUrl));

// 3. OPC-UA / Field gateway (optional)
healthManager.register(
  createGatewayCheck(() => {
    // Gateway is healthy if the blockchain service bootstrapped (lightweight proxy)
    return blockchainService.isEnabled();
  })
);

// 4. Simulator (optional, non-required)
healthManager.registerSimple(
  'simulator',
  async () => {
    // Just verify the import resolves — the simulator self-reports via events
    const { fieldSimulator } = await import('../simulator');
    return fieldSimulator != null;
  },
  /* required */ false,
);

// 5. Agent runtime (optional)
healthManager.registerSimple(
  'agent-runtime',
  async () => {
    try {
      const { agentRuntime } = await import('../agents/runtime');
      return agentRuntime != null;
    } catch {
      return false;
    }
  },
  false,
);

// 6. Redis cache (optional)
healthManager.registerSimple(
  'redis',
  async () => {
    try {
      const { isRedisHealthy } = await import('../services/cache');
      return isRedisHealthy();
    } catch {
      return false;
    }
  },
  false,
);

// 7. Edge store-and-forward service (required for edge deployments)
healthManager.registerSimple(
  'store-and-forward',
  async () => {
    try {
      const { storeAndForwardService } = await import('../gateway/store-and-forward');
      const status = await storeAndForwardService.healthCheck();
      return status.healthy;
    } catch {
      return false;
    }
  },
  true, // Required for edge deployments
);

// ── Sync health → Prometheus after each check cycle ──────────────────────────
healthManager.onCheckComplete((result) => {
  healthStatusGauge.set(result.healthy ? 1 : 0);
  healthCheckTimestamp.setToCurrentTime();

  for (const [name, component] of Object.entries(result.components ?? {})) {
    const up = (component as any).status === 'up' || (component as any).healthy === true ? 1 : 0;
    componentHealthGauge.set(up, { component: name });
  }
});

// ── Export the pre-built router ──────────────────────────────────────────────
export const healthRouter = healthManager.createRouter();

// Expose Prometheus metrics alongside health routes so /metrics works
healthRouter.get('/metrics', metricsHandler);
