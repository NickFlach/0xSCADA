/**
 * Blueprint control-plane module (#458)
 *
 * Public surface for the tick-aware scheduler, control runtime, and the glue
 * that lets the rest of the server surface scheduling health in `/health` and
 * tick telemetry in `/metrics`.
 *
 * @module server/blueprint
 */

import { TickScheduler, configFromEnv } from './scheduler.js';
import type { HealthCheck, ServiceCheckResult } from '../health/health-manager.js';

export {
  TickScheduler,
  detectRtCapability,
  normalizeConfig,
  configFromEnv,
  createDefaultHostProbe,
  chrtSyscall,
  DEFAULT_PRIORITY,
  DEFAULT_SCHEDULER_CONFIG,
  type SchedulingMode,
  type SchedPolicy,
  type SchedulerConfig,
  type SchedulerStatus,
  type RtCapability,
  type HostProbe,
  type RtSyscall,
} from './scheduler.js';

export { BlueprintRuntime, type TickFn, type RuntimeOptions, type RuntimeHealth } from './runtime.js';

export {
  exposeBlueprintMetrics,
  resetBlueprintMetrics,
  TickAccountant,
  publishTickStats,
} from '../metrics/blueprint.js';

/**
 * Process-wide scheduler singleton. Constructed lazily from environment config
 * so importing this module is side-effect-light (no syscall until `apply()`).
 * The control runtime and the `/health` check share this instance so the
 * reported mode is consistent.
 */
let sharedScheduler: TickScheduler | null = null;

export function getScheduler(): TickScheduler {
  if (!sharedScheduler) {
    sharedScheduler = new TickScheduler(configFromEnv());
  }
  return sharedScheduler;
}

/**
 * Apply real-time scheduling at server startup. Idempotent (the scheduler only
 * acts once and warns at most once). Call this early in the boot sequence,
 * before the control loop begins.
 */
export function applyScheduler(): ReturnType<TickScheduler['apply']> {
  return getScheduler().apply();
}

/**
 * Health check reporting the scheduling mode. Registered with the HealthManager
 * so `schedulingMode` appears in the `/health` payload (acceptance criterion).
 *
 * Always reports `healthy` and non-required: running in fallback mode is a
 * degraded real-time posture, NOT a service outage — surfacing it honestly is
 * the whole point, but it must not flip readiness to "not ready" on a dev box.
 */
export function createSchedulerCheck(): HealthCheck {
  return {
    name: 'scheduler',
    required: false,
    check: async (): Promise<ServiceCheckResult> => {
      const summary = getScheduler().healthSummary();
      return {
        name: 'scheduler',
        status: 'healthy',
        lastCheck: new Date(),
        message: summary.reason,
        details: {
          schedulingMode: summary.schedulingMode,
          policy: summary.policy,
          priority: summary.priority,
          realtimeKernel: summary.realtimeKernel,
        },
      };
    },
  };
}
