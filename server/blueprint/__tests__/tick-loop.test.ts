/**
 * BlueprintTickLoop tests (#458)
 *
 * Drives the control loop deterministically with an injected nanosecond clock
 * and an injected scheduler backed by a fake host probe, verifying scheduler
 * integration, tick accounting, throwing-tick resilience, and the /health
 * snapshot shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BlueprintTickLoop } from '../tick-loop';
import { TickScheduler, type HostProbe } from '../scheduler';
import { resetBlueprintMetrics } from '../../metrics/blueprint';
import * as logger from '../../logger';

/** Stock-kernel probe: forces the scheduler into fallback mode. */
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

/** PREEMPT_RT probe with chrt present, so the RT path can be exercised. */
function rtProbe(applyRtPolicy: HostProbe['applyRtPolicy'] = () => null): HostProbe {
  return {
    platform: () => 'linux',
    readFile: (p) => (p === '/sys/kernel/realtime' ? '1' : null),
    fileExists: (p) => p === '/usr/bin/chrt',
    unameRelease: () => '6.12.0-rt1',
    unameVersion: () => '#1 SMP PREEMPT_RT',
    pid: () => 1,
    applyRtPolicy,
  };
}

/** An opted-in scheduler over the given probe (tests bypass the env parser). */
function optedInScheduler(probe: HostProbe): TickScheduler {
  return new TickScheduler({ forceFallback: false }, probe);
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

describe('BlueprintTickLoop', () => {
  it('starts in fallback mode on a stock kernel', () => {
    const loop = new BlueprintTickLoop({
      blueprintId: 'bp1',
      periodMs: 10,
      scheduler: optedInScheduler(stockProbe()),
      schedulerTarget: { kind: 'dedicated-control-process', pid: 4343 },
      nowNs: scriptedClock([0, 1 * MS]),
    });
    loop.setTickFn(() => {});
    const status = loop.start();
    expect(status.mode).toBe('fallback');
    expect(loop.schedulingMode).toBe('fallback');
    loop.stop();
  });

  it('never elevates scheduling when no dedicated target is supplied', () => {
    const applyRt = vi.fn().mockReturnValue(null);
    const loop = new BlueprintTickLoop({
      blueprintId: 'bp-in-process',
      periodMs: 10,
      // RT-capable host, opted in — but the loop runs in the API server process
      // and therefore supplies no dedicated target.
      scheduler: optedInScheduler(rtProbe(applyRt)),
      nowNs: scriptedClock([0, 1 * MS]),
    });
    loop.setTickFn(() => {});
    const status = loop.start();

    expect(status.mode).toBe('fallback');
    expect(status.applied).toBe(false);
    expect(status.error).toMatch(/no dedicated control process/i);
    expect(applyRt).not.toHaveBeenCalled();
    loop.stop();
  });

  it('applies SCHED_FIFO when a dedicated control process is supplied', () => {
    const applyRt = vi.fn().mockReturnValue(null);
    const loop = new BlueprintTickLoop({
      blueprintId: 'bp-dedicated',
      periodMs: 10,
      scheduler: optedInScheduler(rtProbe(applyRt)),
      schedulerTarget: { kind: 'dedicated-control-process', pid: 9001 },
      nowNs: scriptedClock([0, 1 * MS]),
    });
    loop.setTickFn(() => {});
    const status = loop.start();

    expect(status.mode).toBe('realtime');
    expect(status.applied).toBe(true);
    expect(applyRt).toHaveBeenCalledWith(9001, 'SCHED_FIFO', 50);
    loop.stop();
  });

  it('measures tick duration and period jitter across ticks', () => {
    // Clock script: [start0, end0, start1, end1, start2, end2]
    //  tick0: dur 1ms              (no period yet)
    //  tick1: start +10ms, dur 2ms (period 10ms → jitter 0)
    //  tick2: start +13ms, dur 1ms (period 13ms → jitter +3ms)
    const clock = scriptedClock([0, 1 * MS, 10 * MS, 12 * MS, 23 * MS, 24 * MS]);
    const loop = new BlueprintTickLoop({
      blueprintId: 'bp2',
      periodMs: 10,
      scheduler: optedInScheduler(stockProbe()),
      nowNs: clock,
    });
    const ran: number[] = [];
    loop.setTickFn((idx) => ran.push(idx));
    loop.start();

    const s0 = loop.runOneTick();
    expect(s0.lastJitterNs).toBe(0);

    const s1 = loop.runOneTick();
    expect(s1.lastJitterNs).toBe(0); // period exactly 10ms

    const s2 = loop.runOneTick();
    expect(s2.lastJitterNs).toBe(3 * MS); // 13ms period vs 10ms target
    expect(s2.totalTicks).toBe(3);
    expect(ran).toEqual([0, 1, 2]);
    loop.stop();
  });

  it('counts a missed deadline when a tick overruns its budget', () => {
    // period 10ms, default deadline = 10ms. Tick body runs 15ms.
    const clock = scriptedClock([0, 15 * MS]);
    const loop = new BlueprintTickLoop({
      blueprintId: 'bp3',
      periodMs: 10,
      scheduler: optedInScheduler(stockProbe()),
      nowNs: clock,
    });
    loop.setTickFn(() => {});
    loop.start();
    const stats = loop.runOneTick();
    expect(stats.missedDeadlines).toBe(1);
    loop.stop();
  });

  it('does not crash the loop when a tick body throws', () => {
    const clock = scriptedClock([0, 1 * MS, 2 * MS, 3 * MS]);
    const loop = new BlueprintTickLoop({
      blueprintId: 'bp4',
      periodMs: 10,
      scheduler: optedInScheduler(stockProbe()),
      nowNs: clock,
    });
    loop.setTickFn((idx) => {
      if (idx === 0) throw new Error('boom');
    });
    loop.start();
    expect(() => loop.runOneTick()).not.toThrow();
    const stats = loop.runOneTick();
    expect(stats.totalTicks).toBe(2);
    loop.stop();
  });

  it('exposes a health snapshot with schedulingMode and tick stats', () => {
    const loop = new BlueprintTickLoop({
      blueprintId: 'bp5',
      periodMs: 5,
      scheduler: optedInScheduler(stockProbe()),
      nowNs: scriptedClock([0, 1 * MS]),
    });
    loop.setTickFn(() => {});
    loop.start();
    loop.runOneTick();
    const h = loop.health();
    expect(h.blueprintId).toBe('bp5');
    expect(h.running).toBe(true);
    expect(h.schedulingMode).toBe('fallback');
    expect(h.scheduler.schedulingMode).toBe('fallback');
    expect(h.scheduler.applied).toBe(false);
    expect(h.targetPeriodMs).toBe(5);
    expect(h.tick.totalTicks).toBe(1);
    loop.stop();
    expect(loop.health().running).toBe(false);
  });

  it('rejects invalid construction', () => {
    expect(
      () =>
        new BlueprintTickLoop({
          blueprintId: '',
          periodMs: 10,
          scheduler: optedInScheduler(stockProbe()),
        }),
    ).toThrow();
    expect(
      () =>
        new BlueprintTickLoop({
          blueprintId: 'x',
          periodMs: 0,
          scheduler: optedInScheduler(stockProbe()),
        }),
    ).toThrow();
  });

  it('requires a tick function before start', () => {
    const loop = new BlueprintTickLoop({
      blueprintId: 'x',
      periodMs: 10,
      scheduler: optedInScheduler(stockProbe()),
    });
    expect(() => loop.start()).toThrow(/setTickFn/);
  });
});
