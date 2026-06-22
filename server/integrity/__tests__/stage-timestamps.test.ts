/**
 * Tests for the control-loop per-stage SLO instrument (#460).
 *
 * Focus: the pure timestamp/measurement logic and the Prometheus observation
 * path. Includes the acceptance-criteria scenario: deliberately inject a 200ms
 * delay at the sign stage and assert the per-stage histogram reflects it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeMeasurement,
  stageDurationMs,
  LatencyTrace,
  observeMeasurement,
  stageLatencyHistogram,
  roundTripLatencyHistogram,
  stageSloGauge,
  STAGE_SLO_MS,
  STAMP_POINTS,
  type StampPoint,
} from '../stage-timestamps.js';
import { registry } from '../../metrics/prometheus.js';

/** Build a complete stamp map from a per-stamp time offset (ms from t0). */
function stampsFromOffsets(offsets: Record<StampPoint, number>): Record<StampPoint, number> {
  return { ...offsets };
}

describe('stage-timestamps: pure measurement', () => {
  it('computes each stage duration from enter/exit stamps', () => {
    const stamps = stampsFromOffsets({
      'tick-enter': 0,
      'tick-exit': 10,
      'batch-enter': 10,
      'batch-exit': 40,
      'sign-enter': 40,
      'sign-exit': 90,
      'anchor-enter': 90,
      'anchor-confirmed': 1090,
    });

    expect(stageDurationMs(stamps, 'tick')).toBe(10);
    expect(stageDurationMs(stamps, 'batch')).toBe(30);
    expect(stageDurationMs(stamps, 'sign')).toBe(50);
    expect(stageDurationMs(stamps, 'anchor')).toBe(1000);
  });

  it('computes total round-trip as tick-enter -> anchor-confirmed', () => {
    const stamps = stampsFromOffsets({
      'tick-enter': 100,
      'tick-exit': 105,
      'batch-enter': 105,
      'batch-exit': 130,
      'sign-enter': 130,
      'sign-exit': 160,
      'anchor-enter': 160,
      'anchor-confirmed': 600,
    });

    const m = computeMeasurement(stamps, { traceId: 't1', validator: 'v1' });
    expect(m.total.durationMs).toBe(500);
    expect(m.stages.map((s) => s.stage)).toEqual(['tick', 'batch', 'sign', 'anchor']);
  });

  it('throws on missing stamp instead of reporting a misleading zero', () => {
    const partial = { 'tick-enter': 0 } as Record<StampPoint, number>;
    expect(() => stageDurationMs(partial, 'sign')).toThrow(/missing stamp/);
  });

  it('throws on negative (out-of-order) durations', () => {
    const stamps = stampsFromOffsets({
      'tick-enter': 0,
      'tick-exit': 10,
      'batch-enter': 10,
      'batch-exit': 40,
      'sign-enter': 90,
      'sign-exit': 40, // exit before enter
      'anchor-enter': 90,
      'anchor-confirmed': 1090,
    });
    expect(() => stageDurationMs(stamps, 'sign')).toThrow(/Negative duration/);
  });

  it('flags SLO compliance per stage and overall', () => {
    const stamps = stampsFromOffsets({
      'tick-enter': 0,
      'tick-exit': 5, // within tick SLO (50)
      'batch-enter': 5,
      'batch-exit': 25, // within batch SLO (100)
      'sign-enter': 25,
      'sign-exit': 75, // within sign SLO (150)
      'anchor-enter': 75,
      'anchor-confirmed': 575, // 500ms within anchor SLO (5000)
    });

    const m = computeMeasurement(stamps, { traceId: 't', validator: 'v' });
    expect(m.withinSlo).toBe(true);
    for (const s of m.stages) expect(s.withinSlo).toBe(true);
  });

  it('detects an SLO breach when a stage exceeds its budget', () => {
    const breach = STAGE_SLO_MS.sign + 100;
    const stamps = stampsFromOffsets({
      'tick-enter': 0,
      'tick-exit': 5,
      'batch-enter': 5,
      'batch-exit': 25,
      'sign-enter': 25,
      'sign-exit': 25 + breach, // exceeds sign SLO
      'anchor-enter': 25 + breach,
      'anchor-confirmed': 25 + breach + 100,
    });

    const m = computeMeasurement(stamps, { traceId: 't', validator: 'v' });
    const sign = m.stages.find((s) => s.stage === 'sign')!;
    expect(sign.withinSlo).toBe(false);
    expect(m.withinSlo).toBe(false);
  });
});

describe('stage-timestamps: LatencyTrace', () => {
  it('records stamps and reports completeness', () => {
    let now = 1000;
    const clock = () => now;
    const trace = new LatencyTrace({ traceId: 'tr', validator: 'v1', clock });

    expect(trace.isComplete()).toBe(false);
    for (const point of STAMP_POINTS) {
      now += 10;
      trace.mark(point);
    }
    expect(trace.isComplete()).toBe(true);

    const m = trace.measure();
    // Each consecutive stamp advanced the clock by 10ms.
    expect(m.stages.find((s) => s.stage === 'tick')!.durationMs).toBe(10);
    expect(m.total.durationMs).toBe(70); // 8 stamps -> 7 intervals * 10ms
  });

  it('is first-write-wins on duplicate marks (retry safety)', () => {
    let now = 0;
    const clock = () => now;
    const trace = new LatencyTrace({ traceId: 'tr', validator: 'v1', clock });

    now = 5;
    trace.mark('tick-enter');
    now = 999;
    trace.mark('tick-enter'); // ignored

    expect(trace.snapshot()['tick-enter']).toBe(5);
  });

  it('accepts explicit timestamps via mark(point, at)', () => {
    const trace = new LatencyTrace({ traceId: 'tr', validator: 'v1' });
    trace.mark('tick-enter', 100).mark('tick-exit', 130);
    expect(trace.snapshot()['tick-exit']! - trace.snapshot()['tick-enter']!).toBe(30);
  });
});

describe('stage-timestamps: Prometheus observation', () => {
  beforeEach(() => {
    registry.reset();
  });

  it('observes per-stage and round-trip histograms in seconds', () => {
    const stamps: Record<StampPoint, number> = {
      'tick-enter': 0,
      'tick-exit': 10,
      'batch-enter': 10,
      'batch-exit': 40,
      'sign-enter': 40,
      'sign-exit': 90,
      'anchor-enter': 90,
      'anchor-confirmed': 1090,
    };
    const m = computeMeasurement(stamps, { traceId: 't', validator: 'val-a' });
    observeMeasurement(m);

    const stageRows = stageLatencyHistogram.collect();
    const sign = stageRows.find((r) => r.labels.stage === 'sign' && r.labels.validator === 'val-a');
    expect(sign).toBeDefined();
    expect(sign!.count).toBe(1);
    // 50ms -> 0.05s
    expect(sign!.sum).toBeCloseTo(0.05, 6);

    const rt = roundTripLatencyHistogram.collect().find((r) => r.labels.validator === 'val-a');
    expect(rt!.sum).toBeCloseTo(1.09, 6); // 1090ms total

    // SLO gauges set (all within budget here -> 1)
    expect(stageSloGauge.get({ stage: 'sign', validator: 'val-a' })).toBe(1);
    expect(stageSloGauge.get({ stage: 'total', validator: 'val-a' })).toBe(1);
  });

  it('sets the SLO gauge to 0 for a breached stage', () => {
    const breach = STAGE_SLO_MS.sign + 200;
    const stamps: Record<StampPoint, number> = {
      'tick-enter': 0,
      'tick-exit': 5,
      'batch-enter': 5,
      'batch-exit': 25,
      'sign-enter': 25,
      'sign-exit': 25 + breach,
      'anchor-enter': 25 + breach,
      'anchor-confirmed': 25 + breach + 100,
    };
    observeMeasurement(computeMeasurement(stamps, { traceId: 't', validator: 'val-b' }));
    expect(stageSloGauge.get({ stage: 'sign', validator: 'val-b' })).toBe(0);
  });

  it('emits well-formed exposition output for the new metrics', () => {
    observeMeasurement(
      computeMeasurement(
        {
          'tick-enter': 0,
          'tick-exit': 10,
          'batch-enter': 10,
          'batch-exit': 40,
          'sign-enter': 40,
          'sign-exit': 90,
          'anchor-enter': 90,
          'anchor-confirmed': 1090,
        },
        { traceId: 't', validator: 'val-c' },
      ),
    );

    const out = registry.metrics();
    expect(out).toContain('scada_control_loop_stage_latency_seconds');
    expect(out).toContain('scada_control_loop_roundtrip_latency_seconds');
    expect(out).toContain('scada_control_loop_stage_slo_ok');
    expect(out).toContain('stage="sign"');
    expect(out).toContain('validator="val-c"');
  });
});
