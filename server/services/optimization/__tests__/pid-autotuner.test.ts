/**
 * Direct PIDAutoTuner tests (#50).
 *
 * Pins the tuning mathematics against published values — Åström–Hägglund
 * relay-feedback analysis (Ku = 4d/πa), classic Ziegler–Nichols PID
 * coefficients (0.6·Ku, 1.2·Ku/Tu, 0.075·Ku·Tu) exercised through the real
 * relay flow, and the Cohen–Coon formulas — plus the #215 contract that the
 * tuner recommends and never applies.
 *
 * Deterministic: Date.now() runs under fake timers; the relay test's peak and
 * valley timestamps are advanced explicitly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PIDController } from '../pid-controller';
import {
  PIDAutoTuner,
  relayFeedbackAnalysis,
  type TuningRecommendation,
} from '../pid-autotuner';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

const makeController = () =>
  new PIDController({
    id: 'c1',
    name: 'loop',
    gains: { kp: 1, ki: 0.1, kd: 0.05 },
    setpoint: 50,
    outputMin: -100,
    outputMax: 100,
  });

describe('relayFeedbackAnalysis (Åström–Hägglund)', () => {
  it('computes Ku = 4d/(π·a) and Tu from peak spacing', () => {
    const result = relayFeedbackAnalysis(
      5, // relay amplitude d
      [0, 10, 20], // peaks every 10 s → Tu = 10
      [5, 15, 25],
      [55, 55, 55], // peak PV
      [45, 45, 45], // valley PV → oscillation amplitude a = (55-45)/2 = 5
    );
    expect(result).not.toBeNull();
    expect(result!.ku).toBeCloseTo((4 * 5) / (Math.PI * 5), 10);
    expect(result!.tu).toBeCloseTo(10, 10);
  });

  it('returns null with fewer than two peaks or valleys', () => {
    expect(relayFeedbackAnalysis(5, [0], [5, 15], [55], [45, 45])).toBeNull();
    expect(relayFeedbackAnalysis(5, [0, 10], [5], [55, 55], [45])).toBeNull();
  });

  it('returns null when the oscillation amplitude is not positive', () => {
    expect(
      relayFeedbackAnalysis(5, [0, 10], [5, 15], [45, 45], [55, 55]),
    ).toBeNull();
  });
});

describe('relay test → Ziegler–Nichols gains (through the real flow)', () => {
  it('completes after minCycles and recommends classic Z-N coefficients', () => {
    const controller = makeController(); // setpoint 50
    const tuner = new PIDAutoTuner(controller);
    tuner.setRelayConfig({ relayAmplitude: 5, hysteresis: 0.5, minCycles: 3 });

    let completed: TuningRecommendation | null = null;
    tuner.on('relay-complete', (rec: TuningRecommendation) => {
      completed = rec;
    });

    tuner.startRelayTest();
    // Drive a square oscillation: PV 56 (above sp+hyst, output flips negative,
    // peak recorded) then PV 44 (below sp-hyst, output flips positive, valley
    // + cycle recorded), 5 s apart → period between peaks = 10 s.
    const feed = (pv: number) => {
      tuner.relayStep(pv);
      vi.advanceTimersByTime(5000);
    };
    feed(56); // peak @ t0
    feed(44); // valley, cycle 1
    feed(56); // peak @ t10
    feed(44); // valley, cycle 2
    feed(56); // peak @ t20
    feed(44); // valley, cycle 3 → completes

    expect(completed).not.toBeNull();
    const rec = completed!;
    // a = (56-44)/2 = 6, d = 5 → Ku = 20/(6π); Tu = 10 s
    const ku = 20 / (6 * Math.PI);
    const tu = 10;
    expect(rec.method).toBe('relay-feedback');
    expect(rec.gains.kp).toBeCloseTo(0.6 * ku, 6);
    expect(rec.gains.ki).toBeCloseTo((1.2 * ku) / tu, 6);
    expect(rec.gains.kd).toBeCloseTo(0.075 * ku * tu, 6);
    expect(rec.confidence).toBe(0.85);
  });
});

describe('Cohen–Coon tuning', () => {
  it('matches the published formulas for K=2, τ=10, θ=2', () => {
    const tuner = new PIDAutoTuner(makeController());
    const rec = tuner.cohenCoonTune(2, 10, 2); // r = θ/τ = 0.2

    // kp = (1/K)(1.35 + 0.25r) = 0.5 * 1.4 = 0.7
    expect(rec.gains.kp).toBeCloseTo(0.7, 10);
    // ki = kp / (θ(2.5 - 2r)/(1 + 0.6r)) = 0.7 / (2*2.1/1.12)
    expect(rec.gains.ki).toBeCloseTo(0.7 / ((2 * (2.5 - 0.4)) / 1.12), 10);
    // kd = kp · (0.37θr)/(1 + 0.2r) = 0.7 * 0.148 / 1.04
    expect(rec.gains.kd).toBeCloseTo((0.7 * 0.37 * 2 * 0.2) / 1.04, 10);
    expect(rec.method).toBe('cohen-coon');
  });
});

describe('degradation monitoring recommends and NEVER applies (#215)', () => {
  it('returns null before 20 samples', () => {
    const controller = makeController();
    const tuner = new PIDAutoTuner(controller);
    controller.update(0, 1);
    expect(tuner.evaluatePerformance()).toBeNull();
  });

  it('emits a recommendation on sustained large error without touching gains', () => {
    const controller = makeController(); // sp 50, IAE grows 50/step
    const tuner = new PIDAutoTuner(controller, { maxIAE: 100 });
    const before = controller.getGains();

    for (let i = 0; i < 25; i++) {
      controller.update(0, 1); // |error| = 50 each step → IAE 1250 >> 100
      vi.advanceTimersByTime(1000);
    }

    const rec = tuner.evaluatePerformance();
    expect(rec).not.toBeNull();
    expect(rec!.reason.length).toBeGreaterThan(0);
    // The #215 contract: the tuner only suggests — controller gains unchanged.
    expect(controller.getGains()).toEqual(before);
  });
});
