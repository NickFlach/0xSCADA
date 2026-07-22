/**
 * PID Auto-Tuning tests
 * ADR-0013 [13.4] — Issue #215
 */

import { describe, it, expect, vi } from 'vitest';
import type { FOPDTModel } from '@shared/types/tuning';
import {
  DEFAULT_ENVELOPE,
  clampToEnvelope,
  isWithinEnvelope,
  limitStepTowards,
  validateEnvelope,
} from '../envelope';
import {
  FOPDTPlant,
  relayIdentify,
  runClosedLoopEpisode,
  zieglerNicholsFromUltimate,
} from '../process-sim';
import { runRLTuning } from '../rl-tuner';
import { TuningService } from '../index';
import { PIDAutoTuner } from '../../optimization/pid-autotuner';
import { PIDController } from '../../optimization/pid-controller';

const MODEL: FOPDTModel = { gain: 2, timeConstantS: 10, deadTimeS: 1 };

// ── Envelope ──────────────────────────────────────────────────────────────

describe('gain envelope (ADR-0009)', () => {
  it('validates ranges', () => {
    expect(validateEnvelope(DEFAULT_ENVELOPE)).toBeNull();
    expect(
      validateEnvelope({ ...DEFAULT_ENVELOPE, kpRange: { min: 5, max: 1 } })
    ).toMatch(/exceeds/);
    expect(
      validateEnvelope({ ...DEFAULT_ENVELOPE, kiRange: { min: -1, max: 1 } })
    ).toMatch(/negative/);
  });

  it('clamps gains to the envelope and reports it', () => {
    const envelope = {
      kpRange: { min: 0.1, max: 5 },
      kiRange: { min: 0, max: 2 },
      kdRange: { min: 0, max: 1 },
    };
    const { gains, clamped } = clampToEnvelope({ kp: 50, ki: 1, kd: 3 }, envelope);
    expect(gains).toEqual({ kp: 5, ki: 1, kd: 1 });
    expect(clamped).toBe(true);
    expect(isWithinEnvelope(gains, envelope)).toBe(true);
    expect(clampToEnvelope({ kp: 1, ki: 1, kd: 0.5 }, envelope).clamped).toBe(false);
  });

  it('limits a step to the rate-limit fraction so applyGains always accepts', () => {
    const current = { kp: 1, ki: 0.5, kd: 0.1 };
    const target = { kp: 10, ki: 0.55, kd: 0.1 };
    const { gains, complete } = limitStepTowards(current, target, 0.25);
    expect(gains.kp).toBeCloseTo(1.25); // truncated to +25%
    expect(gains.ki).toBeCloseTo(0.55); // within limit — reaches target
    expect(complete).toBe(false);

    const controller = new PIDController({
      id: 'c', name: 'c', gains: current, setpoint: 50, outputMin: 0, outputMax: 100,
    });
    expect(controller.applyGains(gains)).toBe(true);
  });
});

// ── FOPDT simulation ──────────────────────────────────────────────────────

describe('FOPDT plant and closed-loop episodes', () => {
  it('settles to gain × input in open loop', () => {
    const plant = new FOPDTPlant(MODEL, 0.5);
    for (let i = 0; i < 400; i++) plant.step(10, 0.5);
    expect(plant.output).toBeCloseTo(20, 1); // K=2 × u=10
  });

  it('reasonable gains regulate to setpoint; zero gains do not', () => {
    const good = runClosedLoopEpisode({ kp: 2, ki: 0.4, kd: 0.5 }, MODEL, {
      setpoint: 50, ticks: 1200, dtS: 0.5,
    });
    expect(good.settlingTimeS).not.toBeNull();
    expect(good.iae).toBeGreaterThan(0);

    const dead = runClosedLoopEpisode({ kp: 0, ki: 0, kd: 0 }, MODEL, {
      setpoint: 50, ticks: 1200, dtS: 0.5,
    });
    expect(dead.settlingTimeS).toBeNull();
    expect(dead.iae).toBeGreaterThan(good.iae * 5);
  });

  it('relay identification recovers a usable ultimate gain and period', () => {
    const identification = relayIdentify(MODEL, {
      setpoint: 50,
      relayAmplitude: 5,
      hysteresis: 0.2,
      minCycles: 4,
      dtS: 0.1,
    })!;
    expect(identification).not.toBeNull();
    expect(identification.ku).toBeGreaterThan(0);
    expect(identification.tu).toBeGreaterThan(0);

    // The derived Ziegler-Nichols gains must actually stabilize the loop
    const gains = zieglerNicholsFromUltimate(identification.ku, identification.tu);
    const metrics = runClosedLoopEpisode(gains, MODEL, { setpoint: 50, ticks: 2000, dtS: 0.5 });
    expect(metrics.settlingTimeS).not.toBeNull();
  });
});

// ── RL tuner ──────────────────────────────────────────────────────────────

describe('RL tuner', () => {
  it('improves reward over deliberately detuned initial gains', () => {
    const outcome = runRLTuning(
      { kp: 0.05, ki: 0.005, kd: 0 }, // sluggish start
      MODEL,
      DEFAULT_ENVELOPE,
      50,
      { episodes: 40, episodeTicks: 400, dtS: 0.5, seed: 7 }
    );
    expect(outcome.improvedOverInitial).toBe(true);
    expect(outcome.bestReward).toBeGreaterThan(outcome.initialReward);
    expect(outcome.episodes).toHaveLength(40);
    expect(isWithinEnvelope(outcome.bestGains, DEFAULT_ENVELOPE)).toBe(true);
  });

  it('is deterministic for a fixed seed', () => {
    const run = () =>
      runRLTuning({ kp: 0.5, ki: 0.05, kd: 0 }, MODEL, DEFAULT_ENVELOPE, 50, {
        episodes: 15, episodeTicks: 200, dtS: 0.5, seed: 11,
      });
    expect(run().bestGains).toEqual(run().bestGains);
  });

  it('never proposes gains outside the envelope', () => {
    const tight = {
      kpRange: { min: 0, max: 0.8 },
      kiRange: { min: 0, max: 0.1 },
      kdRange: { min: 0, max: 0.1 },
    };
    const outcome = runRLTuning({ kp: 0.5, ki: 0.05, kd: 0 }, MODEL, tight, 50, {
      episodes: 30, episodeTicks: 200, dtS: 0.5, seed: 3,
    });
    for (const episode of outcome.episodes) {
      expect(isWithinEnvelope(episode.gains, tight)).toBe(true);
    }
  });
});

// ── Approval gate ─────────────────────────────────────────────────────────

describe('TuningService approval gate (ADR-0013 human-in-the-loop)', () => {
  it('proposals stay pending until a human decides; approval applies gains', async () => {
    const service = new TuningService();
    const { controller } = service.registerLoop({
      id: 'flow-1', name: 'Flow', gains: { kp: 1, ki: 0.1, kd: 0.05 },
      setpoint: 50, outputMin: 0, outputMax: 100,
    });
    const applied = vi.fn();
    service.on('proposal-applied', applied);

    const proposal = await service.propose('flow-1', 'ziegler-nichols',
      { kp: 1.2, ki: 0.12, kd: 0.06 }, { reason: 'test', confidence: 0.8 });
    expect(proposal.status).toBe('pending');
    expect(controller.getGains()).toEqual({ kp: 1, ki: 0.1, kd: 0.05 }); // unchanged

    const decided = await service.decide(proposal.id, 'operator-1', 'approve');
    expect(decided.status).toBe('applied');
    expect(decided.fullyApplied).toBe(true);
    expect(controller.getGains()).toEqual({ kp: 1.2, ki: 0.12, kd: 0.06 });
    expect(applied).toHaveBeenCalledTimes(1);
  });

  it('rejection leaves gains untouched', async () => {
    const service = new TuningService();
    const { controller } = service.registerLoop({
      id: 'flow-2', name: 'Flow', gains: { kp: 1, ki: 0.1, kd: 0.05 },
      setpoint: 50, outputMin: 0, outputMax: 100,
    });
    const proposal = await service.propose('flow-2', 'rl',
      { kp: 2, ki: 0.2, kd: 0.1 }, { reason: 'test', confidence: 0.5 });
    const decided = await service.decide(proposal.id, 'operator-1', 'reject', 'too aggressive');
    expect(decided.status).toBe('rejected');
    expect(controller.getGains()).toEqual({ kp: 1, ki: 0.1, kd: 0.05 });
    await expect(service.decide(proposal.id, 'operator-2', 'approve')).rejects.toThrow(/already/);
  });

  it('clamps proposals to the envelope and flags it', async () => {
    const service = new TuningService();
    service.registerLoop({
      id: 'flow-3', name: 'Flow', gains: { kp: 1, ki: 0.1, kd: 0.05 },
      setpoint: 50, outputMin: 0, outputMax: 100,
      envelope: {
        kpRange: { min: 0, max: 1.2 },
        kiRange: { min: 0, max: 1 },
        kdRange: { min: 0, max: 1 },
      },
    });
    const proposal = await service.propose('flow-3', 'cohen-coon',
      { kp: 99, ki: 0.11, kd: 0.05 }, { reason: 'test', confidence: 0.7 });
    expect(proposal.clampedByEnvelope).toBe(true);
    expect(proposal.proposedGains.kp).toBe(1.2);
  });

  it('truncates large approved moves to the rate limit and reports partial application', async () => {
    const service = new TuningService();
    const { controller } = service.registerLoop({
      id: 'flow-4', name: 'Flow', gains: { kp: 1, ki: 0.1, kd: 0.05 },
      setpoint: 50, outputMin: 0, outputMax: 100,
    });
    const proposal = await service.propose('flow-4', 'rl',
      { kp: 10, ki: 0.1, kd: 0.05 }, { reason: 'big jump', confidence: 0.6 });
    const decided = await service.decide(proposal.id, 'operator-1', 'approve');
    expect(decided.status).toBe('applied');
    expect(decided.fullyApplied).toBe(false);
    expect(controller.getGains().kp).toBeCloseTo(1.25); // one 25% step, not 10
  });

  it('end-to-end: relay and RL tuning produce pending proposals, never direct changes', async () => {
    const service = new TuningService();
    const { controller } = service.registerLoop({
      id: 'e2e', name: 'E2E', gains: { kp: 0.5, ki: 0.05, kd: 0 },
      setpoint: 50, outputMin: 0, outputMax: 100,
    });
    const before = controller.getGains();

    const relayProposal = await service.tuneRelay('e2e', MODEL, { dtS: 0.1 });
    const { proposal: rlProposal } = await service.tuneRL('e2e', MODEL, {
      episodes: 10, episodeTicks: 200, dtS: 0.5, seed: 5,
    });

    expect(relayProposal.status).toBe('pending');
    expect(rlProposal.status).toBe('pending');
    expect(controller.getGains()).toEqual(before);
    expect(service.getProposals({ controllerId: 'e2e' })).toHaveLength(2);
  });
});

// ── Regression: autotuner no longer self-applies (ADR-0013) ───────────────

describe('PIDAutoTuner automatic mode', () => {
  it('emits recommendations but never applies gains itself', () => {
    const controller = new PIDController({
      id: 'auto', name: 'auto', gains: { kp: 1, ki: 0.1, kd: 0.05 },
      setpoint: 50, outputMin: 0, outputMax: 100,
    });
    const before = controller.getGains();
    const tuner = new PIDAutoTuner(controller, 'automatic');
    const applied = vi.fn();
    tuner.on('gains-applied', applied);

    // Degrade performance: large persistent error accumulates IAE
    for (let i = 0; i < 200; i++) controller.update(0, 1);
    const rec = tuner.evaluatePerformance();

    expect(rec).not.toBeNull();
    expect(controller.getGains()).toEqual(before);
    expect(applied).not.toHaveBeenCalled();
  });
});
