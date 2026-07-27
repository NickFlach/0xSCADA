/**
 * Blueprint tick-metrics & TickAccountant tests (#458)
 *
 * Exercises the pure jitter / deadline / WCET accounting and the Prometheus
 * exposition for the exact metric names mandated by the acceptance criteria.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  TickAccountant,
  publishTickStats,
  exposeBlueprintMetrics,
  resetBlueprintMetrics,
  blueprintTickMissedDeadlinesTotal,
  blueprintTickJitterNs,
  blueprintTickWcetNs,
  METRIC_TICK_JITTER_NS,
  METRIC_TICK_MISSED_DEADLINES,
  METRIC_TICK_WCET_NS,
  METRIC_TICK_DURATION_SECONDS,
} from '../blueprint';

const MS = 1_000_000; // ns per ms

describe('TickAccountant', () => {
  it('computes signed period jitter against the target period', () => {
    const acc = new TickAccountant({ targetPeriodNs: 10 * MS });
    // First sample has no period (no prior tick) → jitter stays 0.
    let stats = acc.record({ durationNs: 1 * MS });
    expect(stats.lastJitterNs).toBe(0);

    // Tick arrived 2ms late.
    stats = acc.record({ durationNs: 1 * MS, periodNs: 12 * MS });
    expect(stats.lastJitterNs).toBe(2 * MS);

    // Tick arrived 3ms early.
    stats = acc.record({ durationNs: 1 * MS, periodNs: 7 * MS });
    expect(stats.lastJitterNs).toBe(-3 * MS);
  });

  it('counts a missed deadline only when duration exceeds the budget', () => {
    const acc = new TickAccountant({ targetPeriodNs: 10 * MS, deadlineNs: 8 * MS });
    acc.record({ durationNs: 5 * MS }); // under budget
    acc.record({ durationNs: 8 * MS }); // exactly at budget → NOT missed
    let stats = acc.record({ durationNs: 9 * MS }); // over budget → missed
    expect(stats.missedDeadlines).toBe(1);
    stats = acc.record({ durationNs: 100 * MS }); // way over → missed
    expect(stats.missedDeadlines).toBe(2);
    expect(stats.totalTicks).toBe(4);
  });

  it('defaults the deadline to the target period', () => {
    const acc = new TickAccountant({ targetPeriodNs: 5 * MS });
    const stats = acc.record({ durationNs: 6 * MS });
    expect(stats.missedDeadlines).toBe(1);
  });

  it('tracks worst-case execution time within the rolling window', () => {
    const acc = new TickAccountant({ targetPeriodNs: 10 * MS, windowSize: 3 });
    acc.record({ durationNs: 2 * MS });
    acc.record({ durationNs: 9 * MS });
    let stats = acc.record({ durationNs: 4 * MS });
    expect(stats.wcetNs).toBe(9 * MS); // window = [2,9,4]

    // Window slides; the 9ms peak ages out and WCET drops.
    acc.record({ durationNs: 3 * MS }); // window = [9,4,3] → still 9
    acc.record({ durationNs: 1 * MS }); // window = [4,3,1] → 4
    stats = acc.record({ durationNs: 2 * MS }); // window = [3,1,2] → 3
    expect(stats.wcetNs).toBe(3 * MS);
  });

  it('rejects invalid construction and samples', () => {
    expect(() => new TickAccountant({ targetPeriodNs: 0 })).toThrow();
    const acc = new TickAccountant({ targetPeriodNs: 10 * MS });
    expect(() => acc.record({ durationNs: -1 })).toThrow();
    expect(() => acc.record({ durationNs: 1, periodNs: -5 })).toThrow();
  });
});

describe('blueprint metrics exposition', () => {
  beforeEach(() => resetBlueprintMetrics());

  it('exposes all four metrics under their exact mandated names', () => {
    const out = exposeBlueprintMetrics();
    expect(out).toContain(`# TYPE ${METRIC_TICK_JITTER_NS} gauge`);
    expect(out).toContain(`# TYPE ${METRIC_TICK_MISSED_DEADLINES} counter`);
    expect(out).toContain(`# TYPE ${METRIC_TICK_WCET_NS} gauge`);
    expect(out).toContain(`# TYPE ${METRIC_TICK_DURATION_SECONDS} histogram`);

    // Sanity: the exact strings from the acceptance criteria.
    expect(METRIC_TICK_JITTER_NS).toBe('blueprint_tick_jitter_ns');
    expect(METRIC_TICK_MISSED_DEADLINES).toBe('blueprint_tick_missed_deadlines_total');
    expect(METRIC_TICK_WCET_NS).toBe('blueprint_tick_wcet_ns');
    expect(METRIC_TICK_DURATION_SECONDS).toBe('oxscada_blueprint_tick_duration_seconds');
  });

  it('publishTickStats mirrors accountant stats onto the metrics', () => {
    const acc = new TickAccountant({ targetPeriodNs: 10 * MS, deadlineNs: 8 * MS });
    const labels = { blueprint: 'reactor-1' };

    publishTickStats(acc, { durationNs: 4 * MS, periodNs: 12 * MS }, labels);
    expect(blueprintTickJitterNs.get(labels)).toBe(2 * MS);
    expect(blueprintTickWcetNs.get(labels)).toBe(4 * MS);
    expect(blueprintTickMissedDeadlinesTotal.get(labels)).toBe(0);

    // Over-budget tick increments the missed-deadline counter exactly once.
    publishTickStats(acc, { durationNs: 9 * MS, periodNs: 10 * MS }, labels);
    expect(blueprintTickMissedDeadlinesTotal.get(labels)).toBe(1);
    expect(blueprintTickWcetNs.get(labels)).toBe(9 * MS);
  });

  it('renders a histogram with buckets, sum and count in seconds', () => {
    const acc = new TickAccountant({ targetPeriodNs: 10 * MS });
    publishTickStats(acc, { durationNs: 0.5 * MS }, { blueprint: 'bp' }); // 0.0005 s
    const out = exposeBlueprintMetrics();
    expect(out).toContain(`${METRIC_TICK_DURATION_SECONDS}_bucket`);
    expect(out).toContain('le="+Inf"');
    expect(out).toContain(`${METRIC_TICK_DURATION_SECONDS}_sum{blueprint="bp"} 0.0005`);
    expect(out).toContain(`${METRIC_TICK_DURATION_SECONDS}_count{blueprint="bp"} 1`);
  });

  it('isolates metric series by blueprint label', () => {
    const acc1 = new TickAccountant({ targetPeriodNs: 10 * MS });
    const acc2 = new TickAccountant({ targetPeriodNs: 10 * MS });
    publishTickStats(acc1, { durationNs: 1 * MS, periodNs: 11 * MS }, { blueprint: 'a' });
    publishTickStats(acc2, { durationNs: 1 * MS, periodNs: 9 * MS }, { blueprint: 'b' });
    expect(blueprintTickJitterNs.get({ blueprint: 'a' })).toBe(1 * MS);
    expect(blueprintTickJitterNs.get({ blueprint: 'b' })).toBe(-1 * MS);
  });
});
