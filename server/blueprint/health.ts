/**
 * Blueprint scheduler → `/health` adapter (#458)
 *
 * Surfaces `schedulingMode` in the `/health` payload without giving the health
 * module any power to *change* scheduling: this file only reads
 * {@link TickScheduler.healthSummary}, which never probes the host and never
 * makes a privileged call.
 *
 * @module server/blueprint/health
 */

import type { HealthCheck, ServiceCheckResult } from '../health/health-manager.js';
import { getScheduler } from './scheduler.js';

/**
 * Health check reporting the real scheduling posture.
 *
 * Always `healthy` and non-required: running without real-time scheduling is a
 * degraded real-time posture, NOT a service outage, and must not flip readiness
 * to "not ready" on a dev box or on any host that simply did not opt in.
 *
 * The details are reported honestly — `schedulingMode` is `'realtime'` only when
 * `SCHED_FIFO` was actually applied; `applied` and `requested` let an operator
 * tell "we never asked" apart from "we asked and it failed".
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
          applied: summary.applied,
          requested: summary.requested,
          realtimeKernel: summary.realtimeKernel,
        },
      };
    },
  };
}
