/**
 * BlueprintRuntime tests (#458)
 *
 * Drives the control loop deterministically with an injected nanosecond clock
 * and a fake (stock-kernel) host probe, verifying scheduler integration, tick
 * accounting, throwing-tick resilience, and the /health snapshot shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BlueprintRuntime } from '../runtime';
import { resetBlueprintMetrics } from '../../metrics/blueprint';
import type { HostProbe } from '../scheduler';
import * as logger from '../../logger';

/** Stock-kernel probe: forces the runtime into fallback scheduling mode. */
function stockProbe(): HostProbe {
  return {
    platform: () => 'linux',
    readFile: () => null,
    fileExists: () => false,
    unameRelease: () => '6.1.0-generic',
    unameVersion: () => '#1 SMP Debian',
    pid: () => 1,
    applyRtPolicy: () => null,
  };
}

/**
 * Scripted monotonic clock. Each call returns the next value (ns). Build the
 * sequence as alternating tick-start / tick-end timestamps.
 */
function scriptedClock(valuesNs: number[]): () => bigint {
  let i = 0;
  return () => {
    const v = valuesNs[Math.min(i, valuesNs.length - 1)];
    i += 1;
    return BigInt(v);
  };
}

const MS = 1_000_000;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(logger, 'logInfo').mockImplementation(() => {});
  vi.spyOn(logger, 'logWarn').mockImplementation(() => {});
  vi.spyOn(logger, 'logError').mockImplementation(() => {});
  resetBlueprintMetrics();
});

describe('BlueprintRuntime', () => {
  it('starts in fallback mode on a stock kernel', () => {
    const rt = new BlueprintRuntime({
      blueprintId: 'bp1',
      periodMs: 10,
      hostProbe: stockProbe(),
      nowNs: scriptedClock([0, 1 * MS]),
    });
    rt.setTickFn(() => {});
    const status = rt.start();
    expect(status.mode).toBe('fallback');
    expect(rt.schedulingMode).toBe('fallback');
    rt.stop();
  });

  it('measures tick duration and period jitter across ticks', () => {
    // Clock script: [start0, end0, start1, end1, start2, end2]
    //  tick0: dur 1ms              (no period yet)
    //  tick1: start +10ms, dur 2ms (period 10ms → jitter 0)
    //  tick2: start +13ms, dur 1ms (period 13ms → jitter +3ms)
    const clock = scriptedClock([
      0,
      1 * MS,
      10 * MS,
      12 * MS,
      23 * MS,
      24 * MS,
    ]);
    const rt = new BlueprintRuntime({
      blueprintId: 'bp2',
      periodMs: 10,
      hostProbe: stockProbe(),
      nowNs: clock,
    });
    const ran: number[] = [];
    rt.setTickFn((idx) => ran.push(idx));
    rt.start();

    const s0 = rt.runOneTick();
    expect(s0.lastJitterNs).toBe(0);

    const s1 = rt.runOneTick();
    expect(s1.lastJitterNs).toBe(0); // period exactly 10ms

    const s2 = rt.runOneTick();
    expect(s2.lastJitterNs).toBe(3 * MS); // 13ms period vs 10ms target
    expect(s2.totalTicks).toBe(3);
    expect(ran).toEqual([0, 1, 2]);
    rt.stop();
  });

  it('counts a missed deadline when a tick overruns its budget', () => {
    // period 10ms, default deadline = 10ms. Tick body runs 15ms.
    const clock = scriptedClock([0, 15 * MS]);
    const rt = new BlueprintRuntime({
      blueprintId: 'bp3',
      periodMs: 10,
      hostProbe: stockProbe(),
      nowNs: clock,
    });
    rt.setTickFn(() => {});
    rt.start();
    const stats = rt.runOneTick();
    expect(stats.missedDeadlines).toBe(1);
    rt.stop();
  });

  it('does not crash the loop when a tick body throws', () => {
    const clock = scriptedClock([0, 1 * MS, 2 * MS, 3 * MS]);
    const rt = new BlueprintRuntime({
      blueprintId: 'bp4',
      periodMs: 10,
      hostProbe: stockProbe(),
      nowNs: clock,
    });
    rt.setTickFn((idx) => {
      if (idx === 0) throw new Error('boom');
    });
    rt.start();
    expect(() => rt.runOneTick()).not.toThrow();
    const stats = rt.runOneTick();
    expect(stats.totalTicks).toBe(2);
    rt.stop();
  });

  it('exposes a health snapshot with schedulingMode and tick stats', () => {
    const rt = new BlueprintRuntime({
      blueprintId: 'bp5',
      periodMs: 5,
      hostProbe: stockProbe(),
      nowNs: scriptedClock([0, 1 * MS]),
    });
    rt.setTickFn(() => {});
    rt.start();
    rt.runOneTick();
    const h = rt.health();
    expect(h.blueprintId).toBe('bp5');
    expect(h.running).toBe(true);
    expect(h.schedulingMode).toBe('fallback');
    expect(h.scheduler.schedulingMode).toBe('fallback');
    expect(h.targetPeriodMs).toBe(5);
    expect(h.tick.totalTicks).toBe(1);
    rt.stop();
    expect(rt.health().running).toBe(false);
  });

  it('rejects invalid construction', () => {
    expect(() => new BlueprintRuntime({ blueprintId: '', periodMs: 10 })).toThrow();
    expect(() => new BlueprintRuntime({ blueprintId: 'x', periodMs: 0 })).toThrow();
  });

  it('requires a tick function before start', () => {
    const rt = new BlueprintRuntime({ blueprintId: 'x', periodMs: 10, hostProbe: stockProbe() });
    expect(() => rt.start()).toThrow(/setTickFn/);
  });
});
