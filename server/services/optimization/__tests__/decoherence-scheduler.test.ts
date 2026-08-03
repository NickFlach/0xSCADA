/**
 * Direct DecoherenceScheduler tests (#50).
 *
 * Pins the sensor-drift model's invariants: exponential decay per tick,
 * environmental factors accelerating the effective rate, the calibration-due
 * edge trigger (fires on crossing, not on every overdue tick), calibration
 * reset, rate re-estimation from observed decay, and dashboard ordering.
 *
 * Deterministic: Date.now() runs under fake timers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DecoherenceScheduler } from '../decoherence-scheduler';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DecoherenceScheduler decay model', () => {
  it('tick applies exponential decay C·e^(-λt)', () => {
    const s = new DecoherenceScheduler();
    s.registerSensor({ sensorId: 'a', name: 'A', baseDecoherenceRate: 0.1 });
    s.tick(1);
    expect(s.getSensor('a')!.coherence).toBeCloseTo(Math.exp(-0.1), 10);
    s.tick(2);
    expect(s.getSensor('a')!.coherence).toBeCloseTo(Math.exp(-0.1) * Math.exp(-0.2), 10);
  });

  it('environmental factors accelerate the effective rate', () => {
    const s = new DecoherenceScheduler();
    s.registerSensor({ sensorId: 'calm', name: 'calm', baseDecoherenceRate: 0.1 });
    s.registerSensor({ sensorId: 'shaken', name: 'shaken', baseDecoherenceRate: 0.1 });
    s.updateEnvironment('shaken', { vibrationLevel: 1 }); // rate × (1 + 0.15)

    s.tick(1);
    const calm = s.getSensor('calm')!.coherence;
    const shaken = s.getSensor('shaken')!.coherence;
    expect(shaken).toBeLessThan(calm);
    expect(shaken).toBeCloseTo(Math.exp(-0.1 * 1.15), 10);
  });

  it('predicts the calibration date from the decay law', () => {
    const s = new DecoherenceScheduler();
    const model = s.registerSensor({
      sensorId: 'a',
      name: 'A',
      baseDecoherenceRate: 0.01,
      coherenceThreshold: 0.7,
    });
    // t = -ln(threshold / C) / λ hours from now
    const hours = -Math.log(0.7) / 0.01;
    expect(model.predictedCalibrationDate).toBeCloseTo(Date.now() + hours * 3_600_000, -4);
  });
});

describe('DecoherenceScheduler calibration lifecycle', () => {
  it('fires calibration-due exactly on the threshold crossing, not every overdue tick', () => {
    const s = new DecoherenceScheduler();
    s.registerSensor({ sensorId: 'a', name: 'A', baseDecoherenceRate: 0.2, coherenceThreshold: 0.7 });
    const events: number[] = [];
    s.on('calibration-due', (_id: string, coherence: number) => events.push(coherence));

    s.tick(1); // e^-0.2 ≈ 0.819 — above threshold
    expect(events).toHaveLength(0);
    s.tick(1); // ≈ 0.670 — crossed
    expect(events).toHaveLength(1);
    s.tick(1); // still overdue — must NOT re-fire
    expect(events).toHaveLength(1);
    expect(s.getSensor('a')!.overdue).toBe(true);
  });

  it('recordCalibration resets coherence, clears overdue, and emits completion', () => {
    const s = new DecoherenceScheduler();
    s.registerSensor({ sensorId: 'a', name: 'A', baseDecoherenceRate: 0.5, coherenceThreshold: 0.7 });
    let completed = 0;
    s.on('calibration-complete', () => completed++);

    s.tick(2); // e^-1 ≈ 0.368 → overdue
    expect(s.getSensor('a')!.overdue).toBe(true);

    s.recordCalibration('a');
    const model = s.getSensor('a')!;
    expect(model.coherence).toBe(1.0);
    expect(model.overdue).toBe(false);
    expect(completed).toBe(1);
  });

  it('re-estimates the decoherence rate from observed exponential decay', () => {
    const s = new DecoherenceScheduler();
    s.registerSensor({ sensorId: 'a', name: 'A', baseDecoherenceRate: 0.5 });

    // Feed observations of a true λ = 0.05/h decay, one hour apart.
    const lambda = 0.05;
    for (let h = 1; h <= 6; h++) {
      vi.advanceTimersByTime(3_600_000);
      s.recordObservation('a', Math.exp(-lambda * h));
    }
    expect(s.getSensor('a')!.baseDecoherenceRate).toBeCloseTo(lambda, 3);
  });

  it('recordObservation clamps coherence into [0, 1]', () => {
    const s = new DecoherenceScheduler();
    s.registerSensor({ sensorId: 'a', name: 'A' });
    s.recordObservation('a', 1.7);
    expect(s.getSensor('a')!.coherence).toBe(1);
    s.recordObservation('a', -0.3);
    expect(s.getSensor('a')!.coherence).toBe(0);
  });
});

describe('DecoherenceScheduler dashboard', () => {
  it('classifies sensors and sorts the schedule critical-first', () => {
    const s = new DecoherenceScheduler();
    s.registerSensor({ sensorId: 'healthy', name: 'H', coherenceThreshold: 0.7 });
    s.registerSensor({ sensorId: 'warn', name: 'W', coherenceThreshold: 0.7 });
    s.registerSensor({ sensorId: 'crit', name: 'C', coherenceThreshold: 0.7 });
    s.recordObservation('warn', 0.8); // between threshold and 0.85
    s.recordObservation('crit', 0.5); // below threshold → overdue/critical

    const dash = s.getDashboardStatus();
    expect(dash.totalSensors).toBe(3);
    expect(dash.healthySensors).toBe(1);
    expect(dash.warningSensors).toBe(1);
    expect(dash.criticalSensors).toBe(1);
    expect(dash.overdueSensors).toBe(1);
    expect(dash.schedule[0]?.sensorId).toBe('crit');
    expect(dash.schedule[0]?.urgency).toBe('critical');
    expect(dash.averageCoherence).toBeCloseTo((1 + 0.8 + 0.5) / 3, 10);
  });

  it('reports averageCoherence 1.0 with no sensors registered', () => {
    expect(new DecoherenceScheduler().getDashboardStatus().averageCoherence).toBe(1.0);
  });
});
