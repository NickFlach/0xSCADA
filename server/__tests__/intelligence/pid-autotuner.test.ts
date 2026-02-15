import { describe, it, expect } from 'vitest';
import {
  zieglerNicholsTune,
  relayFeedbackAnalysis,
  PIDAutoTuner,
} from '../../intelligence/pid-autotuner';

describe('PID Auto-Tuner', () => {
  describe('zieglerNicholsTune', () => {
    it('computes ZN parameters', () => {
      const params = zieglerNicholsTune(10, 2);
      expect(params.kp).toBeCloseTo(6);
      expect(params.ki).toBeCloseTo(6);
      expect(params.kd).toBeCloseTo(1.5);
    });
  });

  describe('relayFeedbackAnalysis', () => {
    it('extracts ultimate gain and period from oscillations', () => {
      // Simulate oscillation: sine wave
      const oscillations = Array.from({ length: 100 }, (_, i) => ({
        timestamp: i * 100,
        setpoint: 50,
        processVariable: 50 + 10 * Math.sin(i * 0.3),
        controlOutput: 0,
        error: 0,
      }));

      const result = relayFeedbackAnalysis(oscillations, 5);
      expect(result).not.toBeNull();
      expect(result!.ultimateGain).toBeGreaterThan(0);
      expect(result!.ultimatePeriod).toBeGreaterThan(0);
    });

    it('returns null for insufficient data', () => {
      expect(relayFeedbackAnalysis([], 5)).toBeNull();
    });
  });

  describe('PIDAutoTuner', () => {
    const envelope = {
      kpRange: [0.1, 20] as [number, number],
      kiRange: [0, 10] as [number, number],
      kdRange: [0, 5] as [number, number],
      maxOvershootPercent: 20,
      maxSettlingTimeMs: 10000,
      maxOutputChange: 10,
    };

    it('registers and retrieves controller state', () => {
      const tuner = new PIDAutoTuner();
      tuner.registerController('pid-1', { kp: 1, ki: 0.5, kd: 0.1 }, envelope);
      const state = tuner.getState('pid-1');
      expect(state).toBeDefined();
      expect(state!.current.kp).toBe(1);
    });

    it('proposes ZN tuning requiring approval', () => {
      const tuner = new PIDAutoTuner();
      tuner.registerController('pid-1', { kp: 1, ki: 0.5, kd: 0.1 }, envelope);

      const result = tuner.tuneZieglerNichols('pid-1', 10, 2);
      expect(result).not.toBeNull();
      expect(result!.requiresApproval).toBe(true);
      expect(result!.proposed.kp).toBeCloseTo(6);

      const state = tuner.getState('pid-1');
      expect(state!.approvalStatus).toBe('pending');
    });

    it('clamps parameters to safety envelope', () => {
      const tuner = new PIDAutoTuner();
      const tightEnvelope = { ...envelope, kpRange: [0, 5] as [number, number] };
      tuner.registerController('pid-2', { kp: 1, ki: 0.5, kd: 0.1 }, tightEnvelope);

      const result = tuner.tuneZieglerNichols('pid-2', 10, 2);
      expect(result!.proposed.kp).toBeLessThanOrEqual(5);
    });

    it('approval gate works', () => {
      const tuner = new PIDAutoTuner();
      tuner.registerController('pid-1', { kp: 1, ki: 0.5, kd: 0.1 }, envelope);
      tuner.tuneZieglerNichols('pid-1', 10, 2);

      const approved = tuner.approve('pid-1');
      expect(approved).not.toBeNull();
      expect(tuner.getState('pid-1')!.approvalStatus).toBe('approved');
    });

    it('rejection clears proposed', () => {
      const tuner = new PIDAutoTuner();
      tuner.registerController('pid-1', { kp: 1, ki: 0.5, kd: 0.1 }, envelope);
      tuner.tuneZieglerNichols('pid-1', 10, 2);

      tuner.reject('pid-1');
      expect(tuner.getState('pid-1')!.approvalStatus).toBe('rejected');
      expect(tuner.getState('pid-1')!.proposed).toBeNull();
    });
  });
});
