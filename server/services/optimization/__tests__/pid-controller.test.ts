/**
 * Direct PIDController tests (#50).
 *
 * The classical control stack was covered only incidentally via the tuning
 * service. These tests pin the controller's own contract: term arithmetic,
 * output clamping, back-calculation anti-windup, derivative filtering,
 * closed-loop convergence on a first-order plant, metrics, and the gain
 * safety bounds the tuning approval gate relies on.
 *
 * Deterministic: every update passes an explicit dt, and Date.now() is under
 * fake timers so elapsed-time metrics (ITAE, settling time) are exact.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PIDController } from '../pid-controller';

const makeController = (over: Partial<ConstructorParameters<typeof PIDController>[0]> = {}) =>
  new PIDController({
    id: 'c1',
    name: 'test loop',
    gains: { kp: 1, ki: 0, kd: 0 },
    setpoint: 10,
    outputMin: -100,
    outputMax: 100,
    ...over,
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PIDController term arithmetic', () => {
  it('P-only output is kp * error', () => {
    const c = makeController({ gains: { kp: 2, ki: 0, kd: 0 } });
    const state = c.update(4, 1); // error = 10 - 4 = 6
    expect(state.error).toBe(6);
    expect(state.output).toBe(12);
  });

  it('integral term accumulates error * dt', () => {
    const c = makeController({ gains: { kp: 0, ki: 1, kd: 0 } });
    c.update(8, 1); // error 2 → integral 2
    const s = c.update(8, 1); // integral 4
    expect(s.integral).toBe(4);
    expect(s.output).toBe(4);
  });

  it('derivative term with alpha=1 is the raw slope of the error', () => {
    const c = makeController({
      gains: { kp: 0, ki: 0, kd: 1 },
      derivativeFilterAlpha: 1,
    });
    c.update(10, 1); // error 0
    const s = c.update(6, 1); // error 4, slope (4-0)/1 = 4
    expect(s.derivative).toBeCloseTo(4, 10);
    expect(s.output).toBeCloseTo(4, 10);
  });

  it('derivative filter (alpha<1) smooths a step in the error slope', () => {
    const c = makeController({
      gains: { kp: 0, ki: 0, kd: 1 },
      derivativeFilterAlpha: 0.1,
    });
    c.update(10, 1); // error 0
    const s = c.update(6, 1); // raw slope 4, filtered 0.1*4 + 0.9*0 = 0.4
    expect(s.derivative).toBeCloseTo(0.4, 10);
  });

  it('output is clamped to [outputMin, outputMax]', () => {
    const c = makeController({ gains: { kp: 100, ki: 0, kd: 0 }, outputMin: -5, outputMax: 5 });
    expect(c.update(0, 1).output).toBe(5); // unclamped would be 1000
    expect(c.update(20, 1).output).toBe(-5); // unclamped would be -1000
  });
});

describe('PIDController anti-windup (back-calculation)', () => {
  it('does not accumulate integral while the output is saturated', () => {
    const c = makeController({
      gains: { kp: 0, ki: 1, kd: 0 },
      outputMin: -1,
      outputMax: 1,
    });
    // error = 10 every step; unclamped iTerm grows past the +1 limit fast.
    let s = c.update(0, 1);
    for (let i = 0; i < 50; i++) s = c.update(0, 1);
    // With back-calculation the integral is rewound each saturated step, so it
    // stays bounded near the value that saturates the output — not 50*10.
    expect(s.output).toBe(1);
    expect(Math.abs(s.integral)).toBeLessThanOrEqual(10 + 1e-9);
  });

  it('winds up freely while unsaturated', () => {
    const c = makeController({ gains: { kp: 0, ki: 1, kd: 0 } });
    let s = c.update(9, 1); // error 1 per step, far from ±100 clamp
    for (let i = 0; i < 9; i++) s = c.update(9, 1);
    expect(s.integral).toBeCloseTo(10, 10);
  });
});

describe('PIDController closed loop on a first-order plant', () => {
  it('a PI loop converges to setpoint and reports a settling time', () => {
    const dt = 0.5;
    const c = makeController({
      gains: { kp: 2, ki: 0.5, kd: 0 },
      setpoint: 10,
      outputMin: 0,
      outputMax: 100,
      sampleTime: dt,
    });

    // Plant: first-order lag, pv' = (u - pv) / tau
    const tau = 5;
    let pv = 0;
    let lastError = Infinity;
    for (let i = 0; i < 400; i++) {
      const { output } = c.update(pv, dt);
      pv += ((output - pv) / tau) * dt;
      vi.advanceTimersByTime(dt * 1000);
      lastError = Math.abs(10 - pv);
    }

    expect(lastError).toBeLessThan(0.2); // converged to the 2% band
    const m = c.getMetrics();
    expect(m.settlingTime).not.toBeNull();
    expect(m.sampleCount).toBe(400);
    expect(m.ise).toBeGreaterThan(0);
    expect(m.iae).toBeGreaterThan(0);
    expect(m.itae).toBeGreaterThan(0);
  });

  it('overshoot metric reports peak PV above setpoint as a fraction', () => {
    const c = makeController({ setpoint: 10 });
    c.update(12, 1); // peak 12 → (12-10)/10 = 0.2
    c.update(9, 1);
    expect(c.getMetrics().overshoot).toBeCloseTo(0.2, 10);
  });

  it('oscillation is flagged after more than 6 zero-crossings', () => {
    const c = makeController({ setpoint: 0, gains: { kp: 1, ki: 0, kd: 0 } });
    for (let i = 0; i < 16; i++) {
      c.update(i % 2 === 0 ? 1 : -1, 1); // error alternates sign every sample
      vi.advanceTimersByTime(1000);
    }
    const m = c.getMetrics();
    expect(m.zeroCrossings).toBeGreaterThan(6);
    expect(m.oscillating).toBe(true);
  });
});

describe('PIDController gain safety bounds', () => {
  it('accepts gain changes within maxGainChangeFraction', () => {
    const c = makeController({ gains: { kp: 1, ki: 1, kd: 1 } }); // default 25%
    expect(c.applyGains({ kp: 1.2, ki: 0.8, kd: 1.25 })).toBe(true);
    expect(c.getGains()).toEqual({ kp: 1.2, ki: 0.8, kd: 1.25 });
  });

  it('rejects gain changes beyond the bound and keeps the old gains', () => {
    const c = makeController({ gains: { kp: 1, ki: 1, kd: 1 } });
    expect(c.applyGains({ kp: 2, ki: 1, kd: 1 })).toBe(false);
    expect(c.getGains()).toEqual({ kp: 1, ki: 1, kd: 1 });
  });

  it('forceGains bypasses the safety bound', () => {
    const c = makeController({ gains: { kp: 1, ki: 1, kd: 1 } });
    c.forceGains({ kp: 50, ki: 0, kd: 0 });
    expect(c.getGains()).toEqual({ kp: 50, ki: 0, kd: 0 });
  });

  it('setSetpoint resets the performance accumulators', () => {
    const c = makeController();
    c.update(0, 1);
    expect(c.getMetrics().sampleCount).toBe(1);
    c.setSetpoint(20);
    expect(c.getMetrics().sampleCount).toBe(0);
    expect(c.getSetpoint()).toBe(20);
  });
});
