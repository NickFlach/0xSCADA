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
import { fieldSimulator } from '../simulator';
import { storeAndForwardService } from '../gateway/store-and-forward';
import { getBridgeHealthStatus } from '../bridge';
import { describeBlueprintControlLoopHealth, getBlueprintControlLoop } from '../blueprint/control-loop';
import { publishControlLoopProbeStatus } from '../integrity/latency-probe';

// Control-loop latency telemetry (#460): publish the sentinel probe's liveness
// gauge as part of normal server composition so `scada_control_loop_probe_up`
// is a real series on every scrape — 0 while the (opt-in) probe is not running,
// 1 once it is. Without this the "probe absent" alert could never fire because
// the series would simply not exist. This only publishes the current status; it
// never starts a probe (server/bridge/index.ts owns that, behind its opt-in).
publishControlLoopProbeStatus();

// ── Prometheus health gauges ─────────────────────────────────────────────────
// These gauges let Prometheus scrape health status as numeric metrics.

/** 1 = healthy, 0 = unhealthy */
export const healthStatusGauge: any = registry.gauge(
  'health_status',
  'Overall system health (1=healthy, 0=unhealthy)',
);

/** Per-component health: 1 = up, 0 = down */
export const componentHealthGauge: any = registry.gauge(
  'health_component_status',
  'Per-component health status (1=up, 0=down)',
  ['component'],
);

/** Timestamp of the last health check evaluation */
export const healthCheckTimestamp: any = registry.gauge(
  'health_last_check_timestamp_seconds',
  'Unix timestamp of last health evaluation',
);

// ── Singleton ────────────────────────────────────────────────────────────────
export const healthManager = new HealthManager(/* cacheTtlMs */ 10_000);

// ── Register checks ──────────────────────────────────────────────────────────

// 1. Database (required) — must be healthy before anything else
healthManager.register(
  createDatabaseCheck(async () => {
    const h = await (storage as any).healthCheck();
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
    return (blockchainService as any).isEnabled();
  })
);

// 4. Simulator (optional, non-required)
healthManager.registerSimple(
  'simulator',
  async () => {
    // Just verify the singleton resolves — the simulator self-reports via events
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
      const status = await storeAndForwardService.healthCheck();
      return status.healthy;
    } catch {
      return false;
    }
  },
  true, // Required for edge deployments
);

// 8. Bridge modules (event-anchor, state-sync)
healthManager.registerSimple(
  'bridges',
  async () => {
    try {
      const status = await getBridgeHealthStatus();
      return status.eventAnchor.healthy && status.stateSync.healthy;
    } catch {
      return false;
    }
  },
  false, // Optional, depends on configuration
);

// 9. Deterministic blueprint control loop (#457).
//    Optional and OFF by default. "Disabled" is reported as healthy — an
//    intentionally-off subsystem is not a fault — while a fail-closed load error
//    is reported as unhealthy with the reason attached.
healthManager.register({
  name: 'blueprint-control-loop',
  required: false,
  check: async () => {
    const status = getBlueprintControlLoop().status();
    const health = describeBlueprintControlLoopHealth(status);
    return {
      name: 'blueprint-control-loop',
      status: health.status,
      lastCheck: new Date(),
      message: health.message,
      details: status,
    };
  },
});

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
