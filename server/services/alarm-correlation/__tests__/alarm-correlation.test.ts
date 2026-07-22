/**
 * Alarm Correlation Engine tests
 * ADR-0013 [13.2] — Issue #213
 */

import { describe, it, expect, vi } from 'vitest';
import type { CorrelatedAlarm } from '@shared/types/alarm-correlation';
import { EquipmentTopology } from '../topology';
import { CorrelationRulesEngine, validateRule, DEFAULT_RULES } from '../rules';
import { AlarmCorrelationEngine } from '../engine';
import {
  AlarmCorrelationService,
  normalizeAlarm,
  normalizeSeverity,
  resolveEquipmentFromTag,
} from '../index';

let alarmCounter = 0;
function alarm(overrides: Partial<CorrelatedAlarm>): CorrelatedAlarm {
  return {
    id: overrides.id ?? `A-${++alarmCounter}`,
    name: 'test alarm',
    tagId: 'TAG.EVENT',
    severity: 'medium',
    state: 'active',
    message: 'test',
    timestamp: 0,
    ...overrides,
  };
}

/** Feeder → breaker → motor causal chain under one substation */
function plantTopology(): EquipmentTopology {
  const topology = new EquipmentTopology();
  topology.upsertMany([
    { equipmentId: 'SUB-1', causalDownstream: [] },
    { equipmentId: 'FDR-1', parentId: 'SUB-1', causalDownstream: ['BK-1'] },
    { equipmentId: 'BK-1', parentId: 'SUB-1', causalDownstream: ['MTR-1'] },
    { equipmentId: 'MTR-1', parentId: 'SUB-1', causalDownstream: [] },
    { equipmentId: 'UNRELATED', causalDownstream: [] },
  ]);
  return topology;
}

// ── Topology ──────────────────────────────────────────────────────────────

describe('EquipmentTopology', () => {
  it('rejects hierarchy cycles at registration', () => {
    const t = new EquipmentTopology();
    t.upsert({ equipmentId: 'a', parentId: 'b', causalDownstream: [] });
    expect(() =>
      t.upsert({ equipmentId: 'b', parentId: 'a', causalDownstream: [] })
    ).toThrow(/cycle/);
    // failed upsert must not leave the cyclic node behind
    expect(t.get('b')).toBeUndefined();
  });

  it('computes hierarchy distance: parent-child 1, siblings 1, unrelated null', () => {
    const t = plantTopology();
    expect(t.hierarchyDistance('FDR-1', 'SUB-1')).toBe(1);
    expect(t.hierarchyDistance('FDR-1', 'BK-1')).toBe(1);
    expect(t.hierarchyDistance('FDR-1', 'FDR-1')).toBe(0);
    expect(t.hierarchyDistance('FDR-1', 'UNRELATED')).toBeNull();
  });

  it('finds transitive causal reachability with hop bound', () => {
    const t = plantTopology();
    expect(t.isCausallyReachable('FDR-1', 'MTR-1', 5)).toBe(true); // 2 hops
    expect(t.isCausallyReachable('FDR-1', 'MTR-1', 1)).toBe(false); // capped
    expect(t.isCausallyReachable('MTR-1', 'FDR-1', 5)).toBe(false); // directed
    expect(t.isCausallyRelated('MTR-1', 'FDR-1', 5)).toBe(true); // either direction
  });

  it('survives causal cycles (recirculation loops)', () => {
    const t = new EquipmentTopology();
    t.upsert({ equipmentId: 'p1', causalDownstream: ['p2'] });
    t.upsert({ equipmentId: 'p2', causalDownstream: ['p1', 'p3'] });
    t.upsert({ equipmentId: 'p3', causalDownstream: [] });
    expect(t.isCausallyReachable('p1', 'p3', 10)).toBe(true);
    expect(t.isCausallyReachable('p3', 'p1', 10)).toBe(false);
  });

  it('measures causal dominance', () => {
    const t = plantTopology();
    expect(t.causalDominance('FDR-1', ['BK-1', 'MTR-1', 'UNRELATED'], 5)).toBe(2);
    expect(t.causalDominance('MTR-1', ['FDR-1', 'BK-1'], 5)).toBe(0);
  });
});

// ── Rules ─────────────────────────────────────────────────────────────────

describe('CorrelationRulesEngine', () => {
  it('validates rule configs', () => {
    expect(
      validateRule({
        id: 'r',
        name: 'r',
        type: 'causal',
        enabled: true,
        priority: 1,
        config: { windowMs: 1000 } as never,
      })
    ).toMatch(/maxHops/);
    expect(
      validateRule({
        id: 'r',
        name: 'r',
        type: 'temporal',
        enabled: true,
        priority: 1,
        config: { windowMs: 1000, scope: 'everything' } as never,
      })
    ).toMatch(/scope/);
  });

  it('evaluates rules in priority order and skips disabled ones', () => {
    const rules = new CorrelationRulesEngine();
    expect(rules.list().map((r) => r.id)).toEqual(DEFAULT_RULES.map((r) => r.id));
    rules.setEnabled('default-causal', false);
    const t = plantTopology();
    const a = alarm({ equipmentId: 'FDR-1', tagId: 'FDR-1.TRIP', timestamp: 1000 });
    const b = alarm({ equipmentId: 'BK-1', tagId: 'BK-1.TRIP', timestamp: 2000 });
    // causal disabled → falls through to hierarchy (siblings under SUB-1)
    const matched = rules.evaluatePair(a, b, t);
    expect(matched?.id).toBe('default-hierarchy');
  });

  it('never pairs unrelated equipment on bare temporal proximity', () => {
    const rules = new CorrelationRulesEngine();
    const t = plantTopology();
    const a = alarm({ equipmentId: 'FDR-1', tagId: 'FDR-1.TRIP', timestamp: 1000 });
    const b = alarm({ equipmentId: 'UNRELATED', tagId: 'UNRELATED.TRIP', timestamp: 1001 });
    expect(rules.evaluatePair(a, b, t)).toBeNull();
  });

  it('pairs same-process-area alarms under a scoped temporal rule', () => {
    const rules = new CorrelationRulesEngine();
    rules.upsert({
      id: 'area',
      name: 'area burst',
      type: 'temporal',
      enabled: true,
      priority: 50,
      config: { windowMs: 5000, scope: 'process-area' },
    });
    const t = new EquipmentTopology();
    const a = alarm({ processArea: 'unit-100', tagId: 'X.1', timestamp: 0 });
    const b = alarm({ processArea: 'unit-100', tagId: 'Y.1', timestamp: 100 });
    expect(rules.evaluatePair(a, b, t)?.id).toBe('area');
  });
});

// ── Engine ────────────────────────────────────────────────────────────────

describe('AlarmCorrelationEngine', () => {
  it('groups a causal chain and elects the upstream cause as root', () => {
    const engine = new AlarmCorrelationEngine({ topology: plantTopology() });
    const events: string[] = [];
    engine.on('group-created', () => events.push('created'));

    const r1 = engine.ingest(
      alarm({ id: 'feeder', equipmentId: 'FDR-1', tagId: 'FDR-1.TRIP', timestamp: 1000 })
    );
    expect(r1.action).toBe('standalone');

    const r2 = engine.ingest(
      alarm({ id: 'breaker', equipmentId: 'BK-1', tagId: 'BK-1.TRIP', timestamp: 2000 })
    );
    expect(r2.action).toBe('formed-group');

    const r3 = engine.ingest(
      alarm({ id: 'motor', equipmentId: 'MTR-1', tagId: 'MTR-1.STALL', timestamp: 3000 })
    );
    expect(r3.action).toBe('joined-group');
    expect(r3.groupId).toBe(r2.groupId);

    const group = engine.getGroup(r2.groupId!)!;
    expect(group.rootCauseAlarmId).toBe('feeder');
    expect(group.alarmIds).toEqual(['feeder', 'breaker', 'motor']);
    expect(events).toEqual(['created']);

    const rootCause = engine.getRootCause(group.id)!;
    expect(rootCause.alarm.id).toBe('feeder');
    expect(rootCause.causalDominance).toBe(2);
  });

  it('re-elects the root when an earlier upstream cause arrives late (out-of-order)', () => {
    const engine = new AlarmCorrelationEngine({ topology: plantTopology() });
    const rootChanges: unknown[] = [];
    engine.on('root-cause-changed', (e) => rootChanges.push(e));

    engine.ingest(alarm({ id: 'motor', equipmentId: 'MTR-1', tagId: 'MTR-1.STALL', timestamp: 5000 }));
    engine.ingest(alarm({ id: 'breaker', equipmentId: 'BK-1', tagId: 'BK-1.TRIP', timestamp: 5200 }));
    // Upstream cause with the earliest event time arrives last
    const r = engine.ingest(
      alarm({ id: 'feeder', equipmentId: 'FDR-1', tagId: 'FDR-1.TRIP', timestamp: 4800 })
    );
    expect(r.action).toBe('joined-group');
    expect(r.isRootCause).toBe(true);

    const group = engine.getGroup(r.groupId!)!;
    expect(group.rootCauseAlarmId).toBe('feeder');
    expect(rootChanges.length).toBeGreaterThan(0);
  });

  it('keeps unrelated concurrent alarms in separate groups', () => {
    const engine = new AlarmCorrelationEngine({ topology: plantTopology() });
    engine.ingest(alarm({ id: 'a1', equipmentId: 'FDR-1', tagId: 'FDR-1.TRIP', timestamp: 1000 }));
    engine.ingest(alarm({ id: 'b1', equipmentId: 'UNRELATED', tagId: 'UNRELATED.X', timestamp: 1001 }));
    expect(engine.getGroups()).toHaveLength(0); // both standalone — never merged
  });

  it('suppresses downstream alarms but never critical ones', () => {
    const engine = new AlarmCorrelationEngine({ topology: plantTopology() });
    const suppressed: unknown[] = [];
    engine.on('alarm-suppressed', (e) => suppressed.push(e));

    engine.ingest(alarm({ id: 'feeder', equipmentId: 'FDR-1', tagId: 'FDR-1.TRIP', timestamp: 1000, severity: 'high' }));
    engine.ingest(alarm({ id: 'breaker', equipmentId: 'BK-1', tagId: 'BK-1.TRIP', timestamp: 1500, severity: 'medium' }));
    engine.ingest(alarm({ id: 'motor', equipmentId: 'MTR-1', tagId: 'MTR-1.STALL', timestamp: 2000, severity: 'critical' }));

    const group = engine.getGroups()[0];
    expect(group.rootCauseAlarmId).toBe('feeder');
    expect(group.suppressedAlarmIds).toEqual(['breaker']); // critical motor spared
    expect(group.alarms.find((a) => a.id === 'breaker')!.state).toBe('suppressed');
    expect(group.alarms.find((a) => a.id === 'motor')!.state).toBe('active');
    expect(suppressed).toHaveLength(1);
  });

  it('closes the group and un-suppresses members when the root cause clears', () => {
    const engine = new AlarmCorrelationEngine({ topology: plantTopology() });
    const unsuppressed: unknown[] = [];
    engine.on('alarms-unsuppressed', (e) => unsuppressed.push(e));

    engine.ingest(alarm({ id: 'feeder', equipmentId: 'FDR-1', tagId: 'FDR-1.TRIP', timestamp: 1000 }));
    engine.ingest(alarm({ id: 'breaker', equipmentId: 'BK-1', tagId: 'BK-1.TRIP', timestamp: 1500 }));

    const outcome = engine.alarmCleared('feeder');
    expect(outcome.groupClosed).toBeDefined();
    expect(outcome.unsuppressed).toEqual(['breaker']);

    const group = engine.getGroups({ state: 'closed' })[0];
    expect(group.closeReason).toBe('root-cause-cleared');
    expect(group.alarms.find((a) => a.id === 'breaker')!.state).toBe('active');
    expect(unsuppressed).toHaveLength(1);
  });

  it('ignores duplicate alarm ids', () => {
    const engine = new AlarmCorrelationEngine({ topology: plantTopology() });
    engine.ingest(alarm({ id: 'dup', equipmentId: 'FDR-1', tagId: 'FDR-1.TRIP', timestamp: 1000 }));
    const again = engine.ingest(alarm({ id: 'dup', equipmentId: 'FDR-1', tagId: 'FDR-1.TRIP', timestamp: 9999 }));
    expect(again.reason).toMatch(/duplicate/);
    expect(engine.getMetrics().alarmsIngested).toBe(1);
  });

  it('closes idle groups on sweep and enforces the group cap', () => {
    const engine = new AlarmCorrelationEngine({
      topology: plantTopology(),
      groupCloseAfterMs: 1000,
      maxGroups: 1,
    });
    engine.ingest(alarm({ id: 'f1', equipmentId: 'FDR-1', tagId: 'FDR-1.TRIP', timestamp: 1000 }));
    engine.ingest(alarm({ id: 'b1', equipmentId: 'BK-1', tagId: 'BK-1.TRIP', timestamp: 1500 }));
    expect(engine.getGroups({ state: 'open' })).toHaveLength(1);

    const { closedGroups } = engine.sweep(10_000);
    expect(closedGroups).toHaveLength(1);

    // A later, unrelated-to-window group forms; cap 1 evicts the closed one
    engine.ingest(alarm({ id: 'f2', equipmentId: 'FDR-1', tagId: 'FDR-1.TRIP2', timestamp: 100_000 }));
    engine.ingest(alarm({ id: 'b2', equipmentId: 'BK-1', tagId: 'BK-1.TRIP2', timestamp: 100_500 }));
    expect(engine.getGroups()).toHaveLength(1);
    expect(engine.getGroups()[0].alarmIds).toEqual(['f2', 'b2']);
  });

  it('does not admit alarms beyond the group span cap', () => {
    const engine = new AlarmCorrelationEngine({
      topology: plantTopology(),
      maxGroupSpanMs: 10_000,
    });
    engine.rules.upsert({
      id: 'wide',
      name: 'wide causal',
      type: 'causal',
      enabled: true,
      priority: 1,
      config: { windowMs: 1_000_000, maxHops: 5 },
    });
    engine.ingest(alarm({ id: 'f', equipmentId: 'FDR-1', tagId: 'FDR-1.T', timestamp: 0 }));
    engine.ingest(alarm({ id: 'b', equipmentId: 'BK-1', tagId: 'BK-1.T', timestamp: 100 }));
    const late = engine.ingest(
      alarm({ id: 'm', equipmentId: 'MTR-1', tagId: 'MTR-1.T', timestamp: 50_000 })
    );
    expect(late.action).not.toBe('joined-group');
  });

  it('tracks suppression rate as the fatigue KPI', () => {
    const engine = new AlarmCorrelationEngine({ topology: plantTopology() });
    engine.ingest(alarm({ id: 'f', equipmentId: 'FDR-1', tagId: 'FDR-1.T', timestamp: 0 }));
    engine.ingest(alarm({ id: 'b', equipmentId: 'BK-1', tagId: 'BK-1.T', timestamp: 100 }));
    engine.ingest(alarm({ id: 'm', equipmentId: 'MTR-1', tagId: 'MTR-1.T', timestamp: 200 }));
    const metrics = engine.getMetrics();
    expect(metrics.alarmsIngested).toBe(3);
    expect(metrics.groupsCreated).toBe(1);
    expect(metrics.alarmsSuppressed).toBe(2);
    expect(metrics.suppressionRate).toBeCloseTo(2 / 3);
  });
});

// ── Normalization & service ───────────────────────────────────────────────

describe('normalizeAlarm', () => {
  it('normalizes the tag-stream broadcastAlarm shape', () => {
    const a = normalizeAlarm({
      id: 'alm-1',
      name: 'BK-FEEDER-01 BREAKER_TRIP',
      severity: 'critical',
      state: 'active',
      tagValue: 1450,
      triggeredAt: '2026-07-22T10:00:00.000Z',
      tagId: 'BK-FEEDER-01.BREAKER_TRIP',
    })!;
    expect(a.id).toBe('alm-1');
    expect(a.equipmentId).toBe('BK-FEEDER-01');
    expect(a.severity).toBe('critical');
    expect(a.timestamp).toBe(Date.parse('2026-07-22T10:00:00.000Z'));
    expect(a.value).toBe(1450);
  });

  it('normalizes the SingularisPrime/GR::LISTEN AlarmPayload shape', () => {
    const a = normalizeAlarm({
      alarmId: 'AL-9',
      alarmName: 'High pressure',
      sourceTagId: 'PT-101.PV',
      priority: 'high',
      message: 'above limit',
      triggerValue: 9.2,
      limitValue: 8.5,
      timestamp: 1700000000000,
    })!;
    expect(a.id).toBe('AL-9');
    expect(a.tagId).toBe('PT-101.PV');
    expect(a.equipmentId).toBe('PT-101');
    expect(a.severity).toBe('high');
    expect(a.limit).toBe(8.5);
  });

  it('maps DB-enum severities onto the runtime vocabulary', () => {
    expect(normalizeSeverity('EMERGENCY')).toBe('critical');
    expect(normalizeSeverity('CRITICAL')).toBe('critical');
    expect(normalizeSeverity('WARNING')).toBe('medium');
    expect(normalizeSeverity('alarm')).toBe('high');
    expect(normalizeSeverity(undefined)).toBe('info');
  });

  it('rejects alarms without a usable timestamp', () => {
    expect(normalizeAlarm({ id: 'x', tagId: 'T.1' })).toBeNull();
    expect(normalizeAlarm({ id: 'x', tagId: 'T.1', timestamp: 'garbage' })).toBeNull();
  });

  it('resolves equipment from the ASSET.EVENT tag convention', () => {
    expect(resolveEquipmentFromTag('BK-FEEDER-01.BREAKER_TRIP')).toBe('BK-FEEDER-01');
    expect(resolveEquipmentFromTag('PLAINTAG')).toBe('PLAINTAG');
    expect(resolveEquipmentFromTag('')).toBeUndefined();
  });
});

describe('AlarmCorrelationService', () => {
  it('ingests end-to-end and re-emits engine events', () => {
    const service = new AlarmCorrelationService();
    const created = vi.fn();
    service.on('group-created', created);

    service.engine.topology.upsertMany([
      { equipmentId: 'BK-1', causalDownstream: ['MTR-1'] },
      { equipmentId: 'MTR-1', causalDownstream: [] },
    ]);

    const first = service.ingest({
      id: 'w1', tagId: 'BK-1.TRIP', severity: 'high', state: 'active',
      timestamp: 1000, message: 'trip',
    })!;
    expect(first.result.action).toBe('standalone');

    const second = service.ingest({
      id: 'w2', tagId: 'MTR-1.STALL', severity: 'medium', state: 'active',
      timestamp: 1800, message: 'stall',
    })!;
    expect(second.result.action).toBe('formed-group');
    expect(second.result.suppressed).toBe(true);
    expect(created).toHaveBeenCalledTimes(1);
  });

  it('reports health based on initialization', async () => {
    const service = new AlarmCorrelationService();
    expect((await service.healthCheck()).healthy).toBe(false);
    await service.initialize();
    expect((await service.healthCheck()).healthy).toBe(true);
    await service.shutdown();
    expect((await service.healthCheck()).healthy).toBe(false);
  });
});
