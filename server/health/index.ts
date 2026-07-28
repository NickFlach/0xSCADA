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
import { registry, collectProcessMetrics } from '../metrics';
import { fieldSimulator } from '../simulator';
import { storeAndForwardService } from '../gateway/store-and-forward';
import { edgeStoreAndForwardRuntime } from '../gateway/store-and-forward-runtime';
import { getBridgeHealthStatus } from '../bridge';
import { federationRuntime } from '../scaling/federation-runtime';
import { describeBlueprintControlLoopHealth, getBlueprintControlLoop } from '../blueprint/control-loop';
import { publishControlLoopProbeStatus } from '../integrity/latency-probe';
import { getBlueprintProductionSafetyStatus } from '../blueprint/production-safety';
import type { Response } from 'express';
// Tick-aware scheduler (#458): surface schedulingMode in /health and append
// blueprint tick telemetry to /metrics.
//
// This module only READS the scheduling posture. Applying real-time scheduling
// is deliberately NOT a health-module import side effect: pinning the process
// that serves Express/WebSocket to SCHED_FIFO can starve the box. Scheduling is
// applied only by an explicit `applyScheduler()` call from a composition root
// that owns a dedicated control process (see server/blueprint/scheduler.ts).
import { createSchedulerCheck, exposeBlueprintMetrics } from '../blueprint';

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
      // Report whether the runtime can actually serve agents, not merely
      // whether the module resolves (#217).
      const { agentRuntime } = await import('../agents/runtime');
      return await agentRuntime.isRunning();
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

// 7. Edge store-and-forward service. Upstream loss is degraded, not unready:
// the durable local queue is specifically required to operate through it.
healthManager.register({
  name: 'store-and-forward',
  required: true,
  check: async () => {
    try {
      const status = await storeAndForwardService.healthCheck();
      return {
        name: 'store-and-forward',
        status: status.healthy
          ? status.degraded
            ? 'degraded'
            : 'healthy'
          : 'unhealthy',
        lastCheck: new Date(),
        message: status.message,
        details: {
          productionBindingsEnabled: edgeStoreAndForwardRuntime.isEnabled(),
          productionBindingsInitialized:
            edgeStoreAndForwardRuntime.isInitialized(),
          ...storeAndForwardService.getStatus(),
        },
      };
    } catch (error) {
      return {
        name: 'store-and-forward',
        status: 'unhealthy',
        lastCheck: new Date(),
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

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

healthManager.register({
  name: 'multi-site-federation',
  required: federationRuntime.isRequired(),
  check: async () => {
    const health = await federationRuntime.health();
    return {
      name: 'multi-site-federation',
      status: health.healthy
        ? health.degraded
          ? 'degraded'
          : 'healthy'
        : 'unhealthy',
      lastCheck: new Date(),
      message: health.message,
      details: health.details ? { ...health.details } : undefined,
    };
  },
});

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

// 10. Blueprint safe-state binding (#459). Optional for general API readiness.
// Reports the real binding state: `healthy` when nothing is configured (nothing
// is loaded, so nothing is being guarded and nothing is being claimed),
// `healthy` when every armed blueprint is running, and `degraded` when a binding
// was refused or an armed blueprint is not RUNNING. The `message`/`details`
// always say which of those it is.
healthManager.register({
  name: 'blueprint-safety-runtime',
  required: false,
  check: async () => {
    const status = getBlueprintProductionSafetyStatus();
    return {
      name: 'blueprint-safety-runtime',
      status: status.state === 'DEGRADED' ? 'degraded' : 'healthy',
      lastCheck: new Date(),
      message: status.reason,
      details: {
        state: status.state,
        capabilities: status.capabilities,
        registeredBlueprintIds: status.registeredBlueprintIds,
        rejected: status.rejected,
      },
    };
  },
});
// 11. Tick-aware scheduler (#458) — REPORTS schedulingMode (realtime|fallback).
//     Read-only by construction: the check calls healthSummary(), which never
//     probes the kernel and never applies a policy. Real-time scheduling stays
//     off unless a dedicated control process opts in via OXSCADA_RT_ENABLED.
healthManager.register(createSchedulerCheck());

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

// Expose Prometheus metrics alongside health routes so /metrics works.
// Blueprint tick telemetry (#458) is appended to the same scrape: the shared
// metrics use the `scada_` prefix while the blueprint tick gauges/histogram
// carry their authoritative un-prefixed / `oxscada_` names, so both coexist in
// one exposition document.
healthRouter.get('/metrics', (_req, res: Response) => {
  collectProcessMetrics();
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(`${registry.metrics()}\n${exposeBlueprintMetrics()}`);
});
