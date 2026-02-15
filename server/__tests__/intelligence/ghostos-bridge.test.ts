import { describe, it, expect } from 'vitest';
import {
  kuramotoStep,
  computeOrderParameter,
  GhostOSBridge,
  type AgentOscillator,
} from '../../intelligence/ghostos-bridge';

describe('GhostOS Bridge', () => {
  describe('Kuramoto synchronization', () => {
    it('converges oscillators toward sync', () => {
      const oscillators: AgentOscillator[] = [
        { agentId: 'a1', naturalFrequency: 1, phase: 0, amplitude: 1, couplingStrength: 1, lastUpdate: 0 },
        { agentId: 'a2', naturalFrequency: 1, phase: Math.PI, amplitude: 1, couplingStrength: 1, lastUpdate: 0 },
      ];

      let current = oscillators;
      for (let i = 0; i < 100; i++) {
        current = kuramotoStep(current, 2, 0.1);
      }

      const { r } = computeOrderParameter(current);
      expect(r).toBeGreaterThan(0.5); // should converge
    });

    it('computes order parameter', () => {
      const synced: AgentOscillator[] = [
        { agentId: 'a', naturalFrequency: 1, phase: 0, amplitude: 1, couplingStrength: 1, lastUpdate: 0 },
        { agentId: 'b', naturalFrequency: 1, phase: 0, amplitude: 1, couplingStrength: 1, lastUpdate: 0 },
      ];
      const { r } = computeOrderParameter(synced);
      expect(r).toBeCloseTo(1);
    });
  });

  describe('GhostOSBridge', () => {
    it('emits and retrieves signals', () => {
      const bridge = new GhostOSBridge();
      bridge.emitSignal({ id: 's1', source: 'tag1', type: 'sensor', value: 42, timestamp: Date.now(), metadata: {} });
      expect(bridge.getSignals().length).toBe(1);
      expect(bridge.getSignals('tag1').length).toBe(1);
    });

    it('detects resonance patterns', () => {
      const bridge = new GhostOSBridge();
      const now = Date.now();
      // Emit correlated signals
      for (let i = 0; i < 20; i++) {
        bridge.emitSignal({ id: `a${i}`, source: 'src-a', type: 'sensor', value: Math.sin(i * 0.5) * 10, timestamp: now - (20 - i) * 100, metadata: {} });
        bridge.emitSignal({ id: `b${i}`, source: 'src-b', type: 'sensor', value: Math.sin(i * 0.5) * 10 + 1, timestamp: now - (20 - i) * 100, metadata: {} });
      }

      const patterns = bridge.detectResonance(5000);
      expect(patterns.length).toBeGreaterThan(0);
      expect(patterns[0].strength).toBeGreaterThan(0.7);
    });

    it('proposes and approves decisions', () => {
      const bridge = new GhostOSBridge();
      const decision = bridge.proposeDecision('RP-1', 'agent-1', 'reduce-speed', 0.85);
      expect(decision.approved).toBeNull();
      expect(decision.requiresApproval).toBe(true);

      bridge.approveDecision(decision.id);
      expect(bridge.getDecisions()[0].approved).toBe(true);
    });

    it('manages agent oscillators', () => {
      const bridge = new GhostOSBridge();
      bridge.registerAgent('agent-1', 1.0);
      bridge.registerAgent('agent-2', 1.1);

      const { oscillators, orderParameter } = bridge.stepSync(0.1);
      expect(oscillators.length).toBe(2);
      expect(orderParameter.r).toBeGreaterThanOrEqual(0);
    });
  });
});
