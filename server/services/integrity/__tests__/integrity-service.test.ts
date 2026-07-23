/**
 * Integration tests for the #492 wiring: EvolutionaryResolver composed into
 * the IntegrityService with governance gates + explainability audit, feeding
 * evolved resolutions back through the base resolver's event stream.
 */
import { describe, it, expect } from 'vitest';
import { IntegrityService } from '../integrity-service';
import { EvolutionaryResolver } from '../evolutionary/evolutionary-resolver';
import { ParadoxResolver, type ScadaEvent, type ConflictDetection } from '../paradox-resolver';
import { ExplainabilityMonitor, type GovernanceGate } from '../explainability-monitor';
import { ResolutionGenome } from '../evolutionary/genome';

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
    processArea: 'area-1',
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

/** Pin the sole population genome to a controllable primitive. */
function forceGenome(resolver: EvolutionaryResolver, primitiveId: string, score: number, area = 'area-1') {
  resolver.getRegistry().add({
    id: primitiveId,
    name: primitiveId,
    description: 'test',
    evaluate: () => ({ score, weight: 1, reasoning: `fixed ${score}` }),
  });
  const g = new ResolutionGenome({
    id: `genome_${primitiveId}`,
    primitives: [{ primitiveId, weight: 1 }],
    generation: 10, // mature → not novelty-gated
    processAreaAffinity: area,
  });
  const engine = resolver.getEngine();
  (engine as any).populations.set(area, [g]);
  (engine as any).generations.set(area, 0);
  (engine as any).resolutionCounters.set(area, 0);
  return g;
}

describe('IntegrityService wiring (#492)', () => {
  it('an evolved resolution commits to the base resolver AND lands in the explainability audit', async () => {
    const svc = new IntegrityService({
      evolutionary: { evolution: { seed: 1, populationSize: 1 }, safety: { confidenceFloor: 0.3, maturityGeneration: 5 } },
    });
    // High-scoring genome → passes safety floor + the 0.6 governance gate.
    forceGenome(svc.evolutionary, 'strong', 0.95);

    const resolvedEvents: unknown[] = [];
    svc.on('resolved_event', e => resolvedEvents.push(e));

    const conf = conflict([
      evt({ deviceId: 'd1', value: 100 }),
      evt({ id: 'e2', deviceId: 'd2', value: 101 }),
    ]);
    const outcome = await svc.evolutionary.resolveConflict(conf);

    // Evolved path taken…
    expect(outcome.usedEvolved).toBe(true);
    expect(outcome.resolution.confidence).toBeCloseTo(0.95, 2);

    // …committed to the base resolver (downstream resolved_event fired, and the
    // resolution is queryable) — this is the M1 fix.
    expect(resolvedEvents.length).toBe(1);
    expect(svc.resolver.getResolution(conf.conflictId)).toBeDefined();

    // …and recorded in the tamper-evident explainability audit (M7).
    const decisions = svc.monitor.getRecentDecisions(10);
    const evolved = decisions.find(d => d.source === 'EvolutionaryResolver' && d.action === 'evolved_resolution');
    expect(evolved).toBeDefined();
    expect(evolved!.output).toMatchObject({ applied: true });
    const audit = svc.monitor.getAuditTrail({ resource: 'evolved_resolution' });
    expect(audit.some(a => a.action === 'approve')).toBe(true);
    expect(svc.monitor.verifyDecisionChain().valid).toBe(true);
    expect(svc.monitor.verifyAuditChain().valid).toBe(true);
  });

  it('the governance gate demotes a low-confidence evolved strategy to static + records a reject audit (#492 M7)', async () => {
    const svc = new IntegrityService({
      evolutionary: { evolution: { seed: 2, populationSize: 1 }, safety: { confidenceFloor: 0.1, maturityGeneration: 5 } },
      // gate blocks below 0.6; the genome scores 0.4 — above the safety floor,
      // below the governance gate.
    });
    forceGenome(svc.evolutionary, 'midling', 0.4);

    let govBlocked = 0;
    svc.on('governance_blocked', () => govBlocked++);

    const conf = conflict([
      evt({ deviceId: 'd1', value: 100 }),
      evt({ id: 'e2', deviceId: 'd2', value: 200 }),
    ]);
    const outcome = await svc.evolutionary.resolveConflict(conf);

    expect(outcome.usedEvolved).toBe(false);
    expect(outcome.safetyDecision.reason).toMatch(/Governance gate/);
    expect(govBlocked).toBe(1);

    const audit = svc.monitor.getAuditTrail({ resource: 'evolved_resolution' });
    expect(audit.some(a => a.action === 'reject')).toBe(true);
    // Static fallback still produced a real resolution.
    expect(outcome.resolution).toBeDefined();
    expect(svc.evolutionary.getStatus().totalGovernanceBlocked).toBe(1);
  });

  it('ingestEvent detects a conflict and routes it through the evolutionary resolver end-to-end', async () => {
    const svc = new IntegrityService({
      resolver: { simultaneousWindowMs: 100000 },
      evolutionary: { evolution: { seed: 3, populationSize: 1 }, safety: { confidenceFloor: 0.3, maturityGeneration: 5 } },
    });
    forceGenome(svc.evolutionary, 'strong2', 0.9);

    const now = Date.now();
    // First reading establishes state; the second (different device, different
    // value, within the window) triggers a simultaneous-reading conflict.
    const r1 = await svc.ingestEvent(evt({ deviceId: 'd1', value: 100, timestamp: new Date(now) }));
    expect(r1.conflict).toBeNull();

    const r2 = await svc.ingestEvent(evt({ id: 'e2', deviceId: 'd2', value: 150, timestamp: new Date(now + 5) }));
    expect(r2.conflict).not.toBeNull();
    expect(r2.resolution).not.toBeNull();
    // The base resolver did NOT auto-resolve (auto-resolve is off); resolution
    // came from the evolutionary path and was committed.
    expect(svc.resolver.getResolution(r2.conflict!.conflictId)).toBeDefined();
  });

  it('ConflictContext is populated so history/rate primitives run on real data (#492 M5)', async () => {
    // A resolver seeded with recent readings; a genome using the history_bias
    // primitive should now receive non-empty recentReadings and favor the
    // reading closest to the historical mean, instead of returning neutral 0.5.
    const base = new ParadoxResolver({ simultaneousWindowMs: 100000 });
    const monitor = new ExplainabilityMonitor();
    const resolver = new EvolutionaryResolver(base, {
      evolution: { seed: 4, populationSize: 1 },
      safety: { confidenceFloor: 0.05, maturityGeneration: 5 },
    }, monitor);

    // Historical trend centered on 100 with real spread (σ≈7), so a reading at
    // 101 sits well within a stddev (score clears the safety floor) while 500 is
    // far out — history_bias should favor 101.
    const now = Date.now();
    for (const [i, v] of [90, 95, 100, 105, 110].entries()) {
      await base.ingestEvent(evt({ deviceId: 'hist', value: v, timestamp: new Date(now + i), tag: 'FT-9' }));
    }

    const g = new ResolutionGenome({
      id: 'hist-genome',
      primitives: [{ primitiveId: 'history_bias', weight: 1 }],
      generation: 10,
      processAreaAffinity: 'area-1',
    });
    (resolver.getEngine() as any).populations.set('area-1', [g]);
    (resolver.getEngine() as any).generations.set('area-1', 0);
    (resolver.getEngine() as any).resolutionCounters.set('area-1', 0);

    // Conflict: 500 (wild) FIRST, then 101 (near history). history_bias must
    // favor 101. The wild reading is events[0], so if recentReadings were NOT
    // populated (history_bias returns no favoredEventId) the winner would
    // default to the wild reading — the test discriminates on that.
    const conf = conflict([
      evt({ id: 'wild', deviceId: 'd2', value: 500, tag: 'FT-9' }),
      evt({ id: 'near', deviceId: 'd1', value: 101, tag: 'FT-9' }),
    ]);
    const outcome = await resolver.resolveConflict(conf);

    expect(outcome.usedEvolved).toBe(true);
    // Winner is the near-history reading → history_bias actually ran on real
    // recentReadings (M5). With empty context it would default to events[0]=wild.
    expect(outcome.resolution.winner?.id).toBe('near');
  });

  it('does NOT double-commit when a process area has an explicit autoResolveSeverity', async () => {
    // Regression: base ingestEvent must not auto-resolve (which would commit
    // once) and then have the evolutionary resolver commit again. The
    // externalResolution master switch suppresses base auto-resolution even
    // for an area that opted in via autoResolveSeverity.
    const svc = new IntegrityService({
      resolver: { simultaneousWindowMs: 100000 },
      evolutionary: { evolution: { seed: 6, populationSize: 1 }, safety: { confidenceFloor: 0.3, maturityGeneration: 5 } },
    });
    svc.registerProcessAreaRules({
      processArea: 'area-1',
      preferredStrategy: 'confidence_weighted',
      minVotingQuorum: 3,
      physicsConstraints: [],
      sensorPriority: [],
      autoResolveSeverity: 'critical', // would auto-resolve everything if honored
      deviceConfidenceOverrides: {},
    });
    forceGenome(svc.evolutionary, 'strong4', 0.9);

    const resolvedEvents: unknown[] = [];
    svc.on('resolved_event', e => resolvedEvents.push(e));

    const now = Date.now();
    await svc.ingestEvent(evt({ deviceId: 'd1', value: 100, timestamp: new Date(now) }));
    await svc.ingestEvent(evt({ id: 'e2', deviceId: 'd2', value: 150, timestamp: new Date(now + 5) }));

    // Exactly ONE resolved_event for the one conflict — no double commit.
    expect(resolvedEvents.length).toBe(1);
  });

  it('without a monitor, resolveConflict still works (governance/audit are no-ops)', async () => {
    const base = new ParadoxResolver();
    const resolver = new EvolutionaryResolver(base, {
      evolution: { seed: 5, populationSize: 1 },
      safety: { confidenceFloor: 0.3, maturityGeneration: 5 },
    }); // no monitor
    forceGenome(resolver, 'strong3', 0.9);
    const outcome = await resolver.resolveConflict(conflict([
      evt({ deviceId: 'd1', value: 100 }),
      evt({ id: 'e2', deviceId: 'd2', value: 101 }),
    ]));
    expect(outcome.usedEvolved).toBe(true);
    expect(resolver.getStatus().complianceMonitorActive).toBe(false);
  });
});
