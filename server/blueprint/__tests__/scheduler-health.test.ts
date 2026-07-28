/**
 * `/health` scheduler-check tests (#458).
 *
 * The check must (a) never mutate scheduling, (b) never fail readiness just
 * because the host is not real-time, and (c) report the mode HONESTLY — a box
 * that never applied SCHED_FIFO must say `fallback`, not imply real-time.
 */

import { describe, it, expect } from 'vitest';
import { createSchedulerCheck } from '../health';

describe('createSchedulerCheck', () => {
  it('is registered as a non-required check', () => {
    const check = createSchedulerCheck();
    expect(check.name).toBe('scheduler');
    expect(check.required).toBe(false);
  });

  it('reports healthy + fallback on a host that never opted in', async () => {
    const result = await createSchedulerCheck().check();

    // Not real-time is a degraded RT posture, not an outage: readiness must
    // stay green so a dev box or a non-RT edge node is not marked down.
    expect(result.status).toBe('healthy');
    expect(result.details).toMatchObject({
      schedulingMode: 'fallback',
      policy: 'SCHED_OTHER',
      priority: 0,
      applied: false,
    });
    expect(typeof result.message).toBe('string');
    expect(result.message).toBeTruthy();
  });

  it('never claims realtime without an applied policy', async () => {
    const result = await createSchedulerCheck().check();
    const details = result.details as { schedulingMode: string; applied: boolean };
    if (details.schedulingMode === 'realtime') {
      expect(details.applied).toBe(true);
    } else {
      expect(details.applied).toBe(false);
    }
  });
});
