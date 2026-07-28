/**
 * Tests for the control-loop per-stage SLO instrument (#460).
 *
 * Focus: the pure timestamp/measurement logic and the Prometheus observation
 * path. The rule the whole issue turns on is asserted here — a stage that was
 * not measured is reported NOWHERE, rather than as a zero or a guess.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeMeasurement,
  stageDurationMs,
  LatencyTrace,
  observeMeasurement,
  observeCycleOutcome,
  stageLatencyHistogram,
  roundTripLatencyHistogram,
  stageSloGauge,
  controlLoopCyclesCounter,
  STAGE_SLO_MS,
  STAMP_POINTS,
  PIPELINE_STAGES,
  UNMEASURED_STAGES,
  type StampPoint,
} from '../stage-timestamps.js';
import { registry } from '../../metrics/prometheus.js';

type Stamps = Partial<Record<StampPoint, number>>;

const completeStamps: Stamps = {
  'batch-enter': 0,
  'batch-exit': 10,
  'sign-enter': 10,
  'sign-exit': 40,
  'anchor-enter': 40,
  'anchor-exit': 90,
  'confirm-enter': 90,
  'confirm-exit': 5090,
};

describe('stage-timestamps: pure measurement', () => {
  it('computes each stage duration from its enter/exit stamps', () => {
    expect(stageDurationMs(completeStamps, 'batch')).toBe(10);
    expect(stageDurationMs(completeStamps, 'sign')).toBe(30);
    expect(stageDurationMs(completeStamps, 'anchor')).toBe(50);
    expect(stageDurationMs(completeStamps, 'confirm')).toBe(5000);
  });

  it('computes the round-trip as batch-enter -> confirm-exit', () => {
    const m = computeMeasurement(completeStamps, { traceId: 't1', source: 's1' });
    expect(m.total).not.toBeNull();
    expect(m.total!.durationMs).toBe(5090);
    expect(m.complete).toBe(true);
    expect(m.unmeasured).toEqual([]);
    expect(m.anomalies).toEqual([]);
  });

  it('is pure: the same stamps always yield the same measurement', () => {
    const a = computeMeasurement(completeStamps, { traceId: 't', source: 's' });
    const b = computeMeasurement(completeStamps, { traceId: 't', source: 's' });
    expect(a).toEqual(b);
  });

  it('reports a missing stage as unmeasured instead of zero', () => {
    const neverConfirmed: Stamps = { ...completeStamps };
    delete neverConfirmed['confirm-exit'];

    const m = computeMeasurement(neverConfirmed, { traceId: 't2', source: 's1' });
    expect(m.stages.map((s) => s.stage)).toEqual(['batch', 'sign', 'anchor']);
    expect(m.unmeasured).toEqual(['confirm']);
    expect(m.complete).toBe(false);
    // No round-trip is claimed for a batch that never confirmed.
    expect(m.total).toBeNull();
    // And crucially: no zero-valued confirm entry sneaks in.
    expect(m.stages.some((s) => s.stage === 'confirm')).toBe(false);
  });

  it('drops an inverted interval as an anomaly rather than clamping it', () => {
    // confirm-exit before confirm-enter: only reachable when the confirmation
    // event races the stamp taken after submit returns.
    const raced: Stamps = { ...completeStamps, 'confirm-exit': 80 };
    const m = computeMeasurement(raced, { traceId: 't3', source: 's1' });
    expect(m.anomalies).toEqual(['confirm']);
    expect(m.stages.some((s) => s.stage === 'confirm')).toBe(false);
    expect(m.complete).toBe(false);
  });

  it('flags SLO breaches per stage and for the round-trip', () => {
    const slow: Stamps = {
      'batch-enter': 0,
      'batch-exit': STAGE_SLO_MS.batch + 1,
      'sign-enter': 1000,
      'sign-exit': 1000 + STAGE_SLO_MS.sign,
      'anchor-enter': 2000,
      'anchor-exit': 2000 + STAGE_SLO_MS.anchor,
      'confirm-enter': 3000,
      'confirm-exit': 3000 + STAGE_SLO_MS.confirm,
    };
    const m = computeMeasurement(slow, { traceId: 't4', source: 's1' });
    const byStage = new Map(m.stages.map((s) => [s.stage, s]));
    expect(byStage.get('batch')!.withinSlo).toBe(false); // 1ms over budget
    expect(byStage.get('sign')!.withinSlo).toBe(true); // exactly at budget
    expect(byStage.get('anchor')!.withinSlo).toBe(true);
    expect(byStage.get('confirm')!.withinSlo).toBe(true);
    expect(m.withinSlo).toBe(false);
  });

  it('documents — and never emits — the stages it cannot measure', () => {
    // The issue also named a `tick` stage. No control loop feeds the anchor
    // pipeline on this branch, so it is documented as unmeasurable and is not
    // part of the emitted stage set.
    expect(Object.keys(UNMEASURED_STAGES)).toContain('tick');
    expect(UNMEASURED_STAGES.tick).toMatch(/fabricated/i);
    expect(PIPELINE_STAGES as readonly string[]).not.toContain('tick');
    expect(Object.keys(STAGE_SLO_MS)).not.toContain('tick');
    expect(STAMP_POINTS.some((p) => p.startsWith('tick'))).toBe(false);
  });
});

describe('LatencyTrace', () => {
  it('stamps from an injected clock and measures the real intervals', () => {
    let now = 0;
    const trace = new LatencyTrace({ traceId: 'tr', source: 'src', clock: () => now });

    trace.mark('batch-enter');
    now = 5;
    trace.mark('batch-exit');
    trace.mark('sign-enter');
    now = 205;
    trace.mark('sign-exit');

    const m = trace.measure();
    expect(m.stages.find((s) => s.stage === 'batch')!.durationMs).toBe(5);
    expect(m.stages.find((s) => s.stage === 'sign')!.durationMs).toBe(200);
    expect(m.unmeasured).toEqual(['anchor', 'confirm']);
  });

  it('first write wins so a retry cannot rewrite history', () => {
    const trace = new LatencyTrace({ traceId: 'tr', source: 'src', clock: () => 0 });
    trace.mark('batch-enter', 100);
    trace.mark('batch-enter', 999);
    expect(trace.snapshot()['batch-enter']).toBe(100);
  });

  it('reports completeness honestly', () => {
    const trace = new LatencyTrace({ traceId: 'tr', source: 'src', clock: () => 0 });
    expect(trace.isComplete()).toBe(false);
    for (const p of STAMP_POINTS) trace.mark(p);
    expect(trace.isComplete()).toBe(true);
  });
});

describe('stage-timestamps: Prometheus publication', () => {
  beforeEach(() => {
    registry.reset();
  });

  it('publishes stage histograms, the round-trip, and the SLO gauge', () => {
    const m = computeMeasurement(completeStamps, { traceId: 't', source: 'unit' });
    observeMeasurement(m);

    const sign = stageLatencyHistogram
      .collect()
      .find((r) => r.labels.stage === 'sign' && r.labels.source === 'unit');
    expect(sign).toBeDefined();
    expect(sign!.count).toBe(1);
    expect(sign!.sum).toBeCloseTo(0.03, 6);

    const roundTrip = roundTripLatencyHistogram.collect().find((r) => r.labels.source === 'unit');
    expect(roundTrip!.count).toBe(1);
    expect(roundTrip!.sum).toBeCloseTo(5.09, 6);

    expect(stageSloGauge.get({ stage: 'sign', source: 'unit' })).toBe(1);
    expect(stageSloGauge.get({ stage: 'total', source: 'unit' })).toBe(1);
  });

  it('publishes nothing at all for an unmeasured stage', () => {
    const neverConfirmed: Stamps = { ...completeStamps };
    delete neverConfirmed['confirm-exit'];
    observeMeasurement(computeMeasurement(neverConfirmed, { traceId: 't', source: 'partial' }));

    const confirm = stageLatencyHistogram
      .collect()
      .find((r) => r.labels.stage === 'confirm' && r.labels.source === 'partial');
    expect(confirm).toBeUndefined();
    expect(
      roundTripLatencyHistogram.collect().find((r) => r.labels.source === 'partial'),
    ).toBeUndefined();

    // The exposition text must not contain a confirm series for this source.
    expect(registry.metrics()).not.toContain('stage="confirm",source="partial"');
  });

  it('sets the SLO gauge to 0 on a breach so the >5min alert can fire', () => {
    const slow: Stamps = { ...completeStamps, 'sign-exit': 10 + STAGE_SLO_MS.sign + 50 };
    observeMeasurement(computeMeasurement(slow, { traceId: 't', source: 'breach' }));
    expect(stageSloGauge.get({ stage: 'sign', source: 'breach' })).toBe(0);
    expect(registry.metrics()).toContain(
      'scada_control_loop_stage_slo_ok{stage="sign",source="breach"} 0',
    );
  });

  it('counts trace outcomes', () => {
    observeCycleOutcome('unit', 'confirmed');
    observeCycleOutcome('unit', 'confirmed');
    observeCycleOutcome('unit', 'failed');
    expect(controlLoopCyclesCounter.get({ source: 'unit', outcome: 'confirmed' })).toBe(2);
    expect(controlLoopCyclesCounter.get({ source: 'unit', outcome: 'failed' })).toBe(1);
  });
});
