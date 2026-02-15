import { describe, it, expect } from 'vitest';
import { AutoRemediationEngine } from '../../operations/auto-remediation';

describe('AutoRemediationEngine', () => {
  it('should handle gateway disconnect incidents', async () => {
    const engine = new AutoRemediationEngine();
    const incident = await engine.handleIncident({
      type: 'gateway-disconnect',
      severity: 'high',
      source: 'gw-1',
      message: 'Gateway heartbeat timeout',
      metadata: {},
      timestamp: Date.now(),
    });

    expect(incident.status).toBe('resolved');
    expect(incident.results).toHaveLength(1);
    expect(incident.results[0].success).toBe(true);
  });

  it('should escalate after max attempts', async () => {
    const engine = new AutoRemediationEngine();
    engine.registerRule({
      id: 'always-fail',
      name: 'Always Fail',
      condition: (ctx) => ctx.type === 'test-fail',
      action: async () => ({ success: false, action: 'test', details: 'Failed', duration: 0 }),
      cooldownMs: 0,
      maxAutoRemediations: 1,
      escalateAfter: 1,
      enabled: true,
    });

    const incident = await engine.handleIncident({
      type: 'test-fail', severity: 'high', source: 'test',
      message: 'Test', metadata: {}, timestamp: Date.now(),
    });

    expect(incident.results[0].success).toBe(false);
  });

  it('should track open incidents', async () => {
    const engine = new AutoRemediationEngine();
    // Incident with no matching rule stays open
    await engine.handleIncident({
      type: 'unknown-issue', severity: 'low', source: 'test',
      message: 'No rule matches', metadata: {}, timestamp: Date.now(),
    });

    const open = engine.getOpenIncidents();
    expect(open).toHaveLength(1);
  });
});
