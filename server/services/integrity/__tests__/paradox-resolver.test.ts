/**
 * ParadoxResolver voting/quorum/config tests (#491 B3 + minors).
 * The resolver previously had zero tests.
 */
import { describe, it, expect } from 'vitest';
import {
  ParadoxResolver,
  type ScadaEvent,
  type ConflictDetection,
  type ProcessAreaRules,
} from '../paradox-resolver';

function evt(overrides: Partial<ScadaEvent> = {}): ScadaEvent {
  return {
    id: `e_${Math.random().toString(36).slice(2)}`,
    deviceId: 'dev-1',
    tag: 'TT-101',
    value: 100,
    timestamp: new Date('2026-03-15T00:00:00Z'),
    quality: 'good',
    source: 'sensor',
    logicalClock: 1,
    vectorClock: {},
    ...overrides,
  };
}

function conflict(events: ScadaEvent[], area = 'area-1'): ConflictDetection {
  return {
    conflictId: `c_${Math.random().toString(36).slice(2)}`,
    type: 'simultaneous_reading',
    events,
    severity: 'medium',
    detectedAt: new Date(),
    description: 'test',
    processArea: area,
  };
}

function areaRules(overrides: Partial<ProcessAreaRules> = {}): ProcessAreaRules {
  return {
    processArea: 'area-1',
    preferredStrategy: 'voting',
    minVotingQuorum: 3,
    physicsConstraints: [],
    sensorPriority: [],
    autoResolveSeverity: 'low',
    deviceConfidenceOverrides: {},
    ...overrides,
  };
}

describe('ParadoxResolver voting hardening (#491 B3)', () => {
  it('does NOT crash when preferredStrategy=voting and the tag window is empty', async () => {
    const r = new ParadoxResolver();
    r.registerProcessAreaRules(areaRules({ preferredStrategy: 'voting', minVotingQuorum: 3 }));
    const c = conflict([evt({ deviceId: 'd1' }), evt({ id: 'e2', deviceId: 'd2', value: 101 })]);
    // No events were ingested → tagEventWindow is empty for this tag.
    const res = await r.resolve(c);
    expect(res).toBeDefined();
    // Falls back to confidence weighting rather than throwing / voting with 0.
    expect(res.method).toBe('confidence_weighted');
    expect(Number.isFinite(res.confidence)).toBe(true);
  });

  it('enforces quorum: below minVotingQuorum distinct devices falls back to confidence weighting', async () => {
    const r = new ParadoxResolver();
    r.registerProcessAreaRules(areaRules({ preferredStrategy: 'voting', minVotingQuorum: 3 }));
    // Ingest two devices only (quorum is 3)
    await r.ingestEvent(evt({ deviceId: 'd1', value: 100, timestamp: new Date(Date.now()) }));
    const c = conflict([
      evt({ deviceId: 'd1', value: 100 }),
      evt({ id: 'e2', deviceId: 'd2', value: 100 }),
    ]);
    const res = await r.resolve(c);
    expect(res.method).toBe('confidence_weighted');
  });

  it('genuine 3-device majority resolves by voting with a finite merged value', async () => {
    const r = new ParadoxResolver({ simultaneousWindowMs: 100000 });
    r.registerProcessAreaRules(areaRules({ preferredStrategy: 'voting', minVotingQuorum: 3 }));
    const now = Date.now();
    // 3 distinct devices, two agree ≈100, one says 200
    await r.ingestEvent(evt({ deviceId: 'd1', value: 100, timestamp: new Date(now) }));
    await r.ingestEvent(evt({ deviceId: 'd2', value: 100.4, timestamp: new Date(now + 1) }));
    await r.ingestEvent(evt({ deviceId: 'd3', value: 200, timestamp: new Date(now + 2) }));
    const c = conflict([
      evt({ deviceId: 'd1', value: 100 }),
      evt({ id: 'e2', deviceId: 'd3', value: 200 }),
    ]);
    const res = await r.resolve(c);
    expect(res.method).toBe('voting');
    expect(typeof res.mergedValue).toBe('number');
    expect(Number.isFinite(res.mergedValue as number)).toBe(true);
    // Majority (100 bucket) should win over the single 200.
    expect(res.mergedValue as number).toBeLessThan(150);
  });

  it('zero-confidence winning readings do not produce a NaN merged value', async () => {
    const r = new ParadoxResolver({ simultaneousWindowMs: 100000, qualityWeight: 1.0 });
    r.registerProcessAreaRules(areaRules({ preferredStrategy: 'voting', minVotingQuorum: 3 }));
    const now = Date.now();
    // All three devices agree on 50 but report sensorConfidence 0 and bad quality
    await r.ingestEvent(evt({ deviceId: 'd1', value: 50, sensorConfidence: 0, quality: 'bad', timestamp: new Date(now) }));
    await r.ingestEvent(evt({ deviceId: 'd2', value: 50, sensorConfidence: 0, quality: 'bad', timestamp: new Date(now + 1) }));
    await r.ingestEvent(evt({ deviceId: 'd3', value: 50, sensorConfidence: 0, quality: 'bad', timestamp: new Date(now + 2) }));
    const c = conflict([
      evt({ deviceId: 'd1', value: 50, sensorConfidence: 0, quality: 'bad' }),
      evt({ id: 'e2', deviceId: 'd2', value: 50, sensorConfidence: 0, quality: 'bad' }),
    ]);
    const res = await r.resolve(c);
    expect(res.method).toBe('voting');
    expect(Number.isFinite(res.mergedValue as number)).toBe(true);
    expect(res.mergedValue as number).toBeCloseTo(50, 5);
  });
});

describe('ParadoxResolver confidence weighting NaN guard (#491 minor)', () => {
  it('a NaN sensorConfidence does not poison the weighted merge', async () => {
    const r = new ParadoxResolver();
    const c = conflict([
      evt({ deviceId: 'd1', value: 10, sensorConfidence: NaN }),
      evt({ id: 'e2', deviceId: 'd2', value: 12, sensorConfidence: NaN }),
    ]);
    const res = await r.resolve(c);
    expect(res.method).toBe('confidence_weighted');
    expect(Number.isFinite(res.confidence)).toBe(true);
    if (res.mergedValue !== undefined) {
      expect(Number.isFinite(res.mergedValue as number)).toBe(true);
    }
  });
});

describe('ParadoxResolver auto-resolve config (#491 minor)', () => {
  it('an area with explicit autoResolveSeverity auto-resolves even when the global flag is off', async () => {
    const r = new ParadoxResolver({ autoResolveLowSeverity: false, simultaneousWindowMs: 100000 });
    r.registerProcessAreaRules(areaRules({
      processArea: 'critical-area',
      preferredStrategy: 'temporal_priority',
      autoResolveSeverity: 'critical',
    }));

    const resolvedEvents: unknown[] = [];
    r.on('resolved', res => resolvedEvents.push(res));

    // Two conflicting sensor readings in the critical area (medium severity ≤ critical)
    const now = Date.now();
    await r.ingestEvent(evt({ tag: 'PT-1', deviceId: 'd1', value: 10, timestamp: new Date(now), processArea: 'critical-area' }));
    await r.ingestEvent(evt({ tag: 'PT-1', deviceId: 'd2', value: 99, timestamp: new Date(now + 5), processArea: 'critical-area' }));

    // The area opted in explicitly → auto-resolution should have fired despite
    // autoResolveLowSeverity=false globally.
    expect(resolvedEvents.length).toBeGreaterThan(0);
  });

  it('with the global flag off and no area rule, conflicts are NOT auto-resolved', async () => {
    const r = new ParadoxResolver({ autoResolveLowSeverity: false, simultaneousWindowMs: 100000 });
    const resolved: unknown[] = [];
    r.on('resolved', res => resolved.push(res));
    const now = Date.now();
    await r.ingestEvent(evt({ tag: 'FT-9', deviceId: 'd1', value: 10, timestamp: new Date(now) }));
    await r.ingestEvent(evt({ tag: 'FT-9', deviceId: 'd2', value: 99, timestamp: new Date(now + 5) }));
    expect(resolved.length).toBe(0);
  });
});
