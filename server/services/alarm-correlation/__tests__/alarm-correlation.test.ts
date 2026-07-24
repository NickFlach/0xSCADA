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

  it('rolls back an entire topology batch when a later node is invalid', () => {
    const t = new EquipmentTopology();
    t.upsert({ equipmentId: 'existing', name: 'before', causalDownstream: [] });

    expect(() =>
      t.upsertMany([
        {
          equipmentId: 'existing',
          name: 'mutated-before-failure',
          causalDownstream: ['new-a'],
        },
        { equipmentId: 'new-a', parentId: 'new-b', causalDownstream: [] },
        { equipmentId: 'new-b', parentId: 'new-a', causalDownstream: [] },
      ])
    ).toThrow(/cycle/);

    expect(t.get('existing')).toEqual({
      equipmentId: 'existing',
      name: 'before',
      causalDownstream: [],
    });
    expect(t.get('new-a')).toBeUndefined();
    expect(t.get('new-b')).toBeUndefined();
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
    expect(
      validateRule({
        id: 'r',
        name: 'r',
        type: 'causal',
        enabled: true,
        priority: 1,
        config: { windowMs: Number.POSITIVE_INFINITY, maxHops: 1 },
      })
    ).toMatch(/windowMs/);
    expect(
      validateRule({
        id: 'r',
        name: 'r',
        type: 'causal',
        enabled: true,
        priority: 1,
        config: { windowMs: 1000, maxHops: 65 },
      })
    ).toMatch(/maxHops/);
    expect(
      validateRule({
        id: 'r',
        name: 'r',
        type: 'hierarchy',
        enabled: true,
        priority: 1,
        config: { windowMs: 1000, maxDistance: 65 },
      })
    ).toMatch(/maxDistance/);
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

  it('reconciles a bounded pending component across every arrival permutation', () => {
    const permutations = [
      ['t0', 't4', 't8'],
      ['t0', 't8', 't4'],
      ['t4', 't0', 't8'],
      ['t4', 't8', 't0'],
      ['t8', 't0', 't4'],
      ['t8', 't4', 't0'],
    ];
    const timestamps: Record<string, number> = {
      t0: 0,
      t4: 4000,
      t8: 8000,
    };

    for (const order of permutations) {
      const engine = new AlarmCorrelationEngine({
        maxGroupSpanMs: 10_000,
        maxAlarmsPerGroup: 3,
        suppressionPolicy: { enabled: true },
      });
      let finalResult;
      for (const id of order) {
        finalResult = engine.ingest(alarm({
          id,
          tagId: 'VALVE-1.CHATTER',
          timestamp: timestamps[id],
        }));
      }

      const groups = engine.getGroups();
      expect(groups, order.join(',')).toHaveLength(1);
      expect([...groups[0].alarmIds].sort(), order.join(',')).toEqual(['t0', 't4', 't8']);
      expect(groups[0].rootCauseAlarmId, order.join(',')).toBe('t0');
      expect(groups[0].createdAt, order.join(',')).toBe(0);
      expect(groups[0].lastAlarmAt, order.join(',')).toBe(8000);
      expect([...groups[0].suppressedAlarmIds].sort(), order.join(',')).toEqual(['t4', 't8']);

      if (order.join(',') === 't0,t8,t4') {
        expect(finalResult).toMatchObject({
          alarmId: 't4',
          isRootCause: false,
          suppressed: true,
        });
      }
    }
  });

  it('reconciles pending bridge alarms to a bounded fixpoint', () => {
    const engine = new AlarmCorrelationEngine({
      maxGroupSpanMs: 20_000,
      maxAlarmsPerGroup: 5,
    });
    const timestamps: Record<string, number> = {
      t0: 0,
      t4: 4000,
      t8: 8000,
      t12: 12_000,
      t16: 16_000,
    };

    for (const id of ['t0', 't8', 't16', 't4', 't12']) {
      engine.ingest(alarm({
        id,
        tagId: 'VALVE-1.CHATTER',
        timestamp: timestamps[id],
      }));
    }

    expect(engine.getGroups()).toHaveLength(1);
    expect([...engine.getGroups()[0].alarmIds].sort()).toEqual([
      't0',
      't12',
      't16',
      't4',
      't8',
    ]);
  });

  it('keeps reconciliation within group span and member caps', () => {
    const permutations = [
      ['t0', 't4', 't8'],
      ['t0', 't8', 't4'],
      ['t4', 't0', 't8'],
      ['t4', 't8', 't0'],
      ['t8', 't0', 't4'],
      ['t8', 't4', 't0'],
    ];
    const timestamps: Record<string, number> = {
      t0: 0,
      t4: 4000,
      t8: 8000,
    };

    for (const order of permutations) {
      const spanEngine = new AlarmCorrelationEngine({
        maxGroupSpanMs: 7000,
        maxAlarmsPerGroup: 3,
      });
      const memberEngine = new AlarmCorrelationEngine({
        maxGroupSpanMs: 10_000,
        maxAlarmsPerGroup: 2,
      });
      for (const id of order) {
        const input = alarm({
          id,
          tagId: 'VALVE-1.CHATTER',
          timestamp: timestamps[id],
        });
        spanEngine.ingest({ ...input });
        memberEngine.ingest({ ...input });
      }

      for (const group of spanEngine.getGroups()) {
        expect(group.lastAlarmAt - group.createdAt, order.join(',')).toBeLessThanOrEqual(7000);
        expect(group.alarmIds, order.join(',')).toHaveLength(2);
      }
      for (const group of memberEngine.getGroups()) {
        expect(group.alarmIds.length, order.join(',')).toBeLessThanOrEqual(2);
      }
    }
  });

  it('keeps unrelated concurrent alarms in separate groups', () => {
    const engine = new AlarmCorrelationEngine({ topology: plantTopology() });
    engine.ingest(alarm({ id: 'a1', equipmentId: 'FDR-1', tagId: 'FDR-1.TRIP', timestamp: 1000 }));
    engine.ingest(alarm({ id: 'b1', equipmentId: 'UNRELATED', tagId: 'UNRELATED.X', timestamp: 1001 }));
    expect(engine.getGroups()).toHaveLength(0); // both standalone — never merged
  });

  it('never correlates alarms across site boundaries', () => {
    const engine = new AlarmCorrelationEngine();
    engine.ingest(alarm({
      id: 'site-a',
      tagId: 'SHARED.TAG',
      equipmentId: 'SHARED',
      siteId: 'site-a',
      timestamp: 1000,
    }));
    const second = engine.ingest(alarm({
      id: 'site-b',
      tagId: 'SHARED.TAG',
      equipmentId: 'SHARED',
      siteId: 'site-b',
      timestamp: 1001,
    }));

    expect(second.action).toBe('standalone');
    expect(engine.getGroups()).toHaveLength(0);
  });

  it('derives site boundaries from topology and fails closed on conflicts', () => {
    const crossSiteTopology = new EquipmentTopology();
    crossSiteTopology.upsertMany([
      {
        equipmentId: 'A',
        siteId: 'site-a',
        causalDownstream: ['B'],
      },
      {
        equipmentId: 'B',
        siteId: 'site-b',
        causalDownstream: [],
      },
    ]);

    for (const [description, firstSite, secondSite] of [
      ['omitted', undefined, undefined],
      ['conflicting', 'site-a', 'site-a'],
    ] as const) {
      const engine = new AlarmCorrelationEngine({
        topology: crossSiteTopology,
        suppressionPolicy: { enabled: true },
      });
      engine.ingest(alarm({
        id: `${description}-a`,
        equipmentId: 'A',
        tagId: 'A.TRIP',
        siteId: firstSite,
        timestamp: 1000,
        severity: 'high',
      }));
      const second = engine.ingest(alarm({
        id: `${description}-b`,
        equipmentId: 'B',
        tagId: 'B.TRIP',
        siteId: secondSite,
        timestamp: 1100,
        severity: 'medium',
      }));

      expect(second.action, description).toBe('standalone');
      expect(engine.getGroups(), description).toHaveLength(0);
      expect(engine.getMetrics().alarmsSuppressed, description).toBe(0);
    }

    const sameSiteTopology = new EquipmentTopology();
    sameSiteTopology.upsertMany([
      {
        equipmentId: 'A',
        siteId: 'site-a',
        causalDownstream: ['B'],
      },
      {
        equipmentId: 'B',
        siteId: 'site-a',
        causalDownstream: [],
      },
    ]);
    const sameSite = new AlarmCorrelationEngine({
      topology: sameSiteTopology,
      suppressionPolicy: { enabled: true },
    });
    sameSite.ingest(alarm({
      id: 'same-a',
      equipmentId: 'A',
      tagId: 'A.TRIP',
      timestamp: 1000,
      severity: 'high',
    }));
    expect(sameSite.ingest(alarm({
      id: 'same-b',
      equipmentId: 'B',
      tagId: 'B.TRIP',
      timestamp: 1100,
      severity: 'medium',
    }))).toMatchObject({
      action: 'formed-group',
      suppressed: true,
    });
  });

  it('restores suppression when topology later reveals a cross-site group', () => {
    const topology = new EquipmentTopology();
    topology.upsertMany([
      { equipmentId: 'A', causalDownstream: ['B'] },
      { equipmentId: 'B', causalDownstream: [] },
    ]);
    const engine = new AlarmCorrelationEngine({
      topology,
      suppressionPolicy: { enabled: true },
    });
    engine.ingest(alarm({
      id: 'root',
      equipmentId: 'A',
      tagId: 'A.TRIP',
      timestamp: 1000,
      severity: 'high',
    }));
    engine.ingest(alarm({
      id: 'member',
      equipmentId: 'B',
      tagId: 'B.TRIP',
      timestamp: 1100,
      severity: 'medium',
    }));
    const group = engine.getGroups()[0];
    expect(group.suppressedAlarmIds).toEqual(['member']);

    topology.upsertMany([
      { equipmentId: 'A', siteId: 'site-a', causalDownstream: ['B'] },
      { equipmentId: 'B', siteId: 'site-b', causalDownstream: ['C'] },
      { equipmentId: 'C', siteId: 'site-b', causalDownstream: [] },
    ]);
    engine.setSuppressionPolicy({ enabled: true });

    expect(group.suppressedAlarmIds).toEqual([]);
    expect(group.alarms.find((candidate) => candidate.id === 'member')?.state)
      .toBe('active');
    expect(engine.ingest(alarm({
      id: 'site-b-candidate',
      equipmentId: 'C',
      tagId: 'C.TRIP',
      timestamp: 1200,
      severity: 'medium',
    })).action).toBe('standalone');
    expect(group.alarmIds).toEqual(['root', 'member']);
  });

  it('suppresses downstream alarms but never critical ones', () => {
    const engine = new AlarmCorrelationEngine({
      topology: plantTopology(),
      suppressionPolicy: { enabled: true },
    });
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

  it('defaults suppression off and refuses unsafe closed-group suppression', () => {
    const engine = new AlarmCorrelationEngine();
    expect(engine.getSuppressionPolicy()).toMatchObject({
      enabled: false,
      unsuppressOnRootClear: true,
    });
    expect(() =>
      engine.setSuppressionPolicy({ unsuppressOnRootClear: false })
    ).toThrow(/fail-safe closure/);
    expect(() =>
      new AlarmCorrelationEngine({
        suppressionPolicy: { unsuppressOnRootClear: false },
      })
    ).toThrow(/fail-safe closure/);
  });

  it('closes the group and un-suppresses members when the root cause clears', () => {
    const engine = new AlarmCorrelationEngine({
      topology: plantTopology(),
      suppressionPolicy: { enabled: true },
    });
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

  it('removes stale suppression records on acknowledge and clear', () => {
    const engine = new AlarmCorrelationEngine({
      topology: plantTopology(),
      suppressionPolicy: { enabled: true },
    });
    engine.ingest(alarm({
      id: 'feeder',
      equipmentId: 'FDR-1',
      tagId: 'FDR-1.TRIP',
      timestamp: 1000,
    }));
    engine.ingest(alarm({
      id: 'breaker',
      equipmentId: 'BK-1',
      tagId: 'BK-1.TRIP',
      timestamp: 1500,
    }));
    engine.ingest(alarm({
      id: 'motor',
      equipmentId: 'MTR-1',
      tagId: 'MTR-1.STALL',
      timestamp: 2000,
    }));

    const group = engine.getGroups()[0];
    expect(group.suppressedAlarmIds).toEqual(['breaker', 'motor']);

    expect(engine.alarmAcknowledged('breaker', 'operator-alice')).toBe(true);
    const clear = engine.alarmCleared('motor', 'operator-bob');
    expect(clear.cleared).toBe(true);
    expect(group.suppressedAlarmIds).toEqual([]);
    expect(group.alarms.find((a) => a.id === 'breaker')).toMatchObject({
      state: 'acknowledged',
      acknowledgedBy: 'operator-alice',
    });
    expect(group.alarms.find((a) => a.id === 'motor')).toMatchObject({
      state: 'cleared',
      clearedBy: 'operator-bob',
    });
  });

  it('does not correlate a standalone alarm after it has cleared', () => {
    const engine = new AlarmCorrelationEngine({ topology: plantTopology() });
    engine.ingest(alarm({
      id: 'cleared-feeder',
      equipmentId: 'FDR-1',
      tagId: 'FDR-1.TRIP',
      timestamp: 1000,
    }));
    expect(engine.alarmCleared('cleared-feeder', 'operator-alice')).toMatchObject({
      cleared: true,
      clearedBy: 'operator-alice',
    });

    const next = engine.ingest(alarm({
      id: 'breaker',
      equipmentId: 'BK-1',
      tagId: 'BK-1.TRIP',
      timestamp: 1500,
    }));
    expect(next.action).toBe('standalone');
    expect(engine.getGroups()).toHaveLength(0);
  });

  it('reconciles existing suppression when policy is disabled or its floor changes', () => {
    const engine = new AlarmCorrelationEngine({
      topology: plantTopology(),
      suppressionPolicy: { enabled: true },
    });
    engine.ingest(alarm({
      id: 'feeder',
      equipmentId: 'FDR-1',
      tagId: 'FDR-1.TRIP',
      timestamp: 1000,
      severity: 'high',
    }));
    engine.ingest(alarm({
      id: 'breaker',
      equipmentId: 'BK-1',
      tagId: 'BK-1.TRIP',
      timestamp: 1500,
      severity: 'medium',
    }));
    const group = engine.getGroups()[0];
    const breaker = group.alarms.find((a) => a.id === 'breaker')!;
    expect(breaker.state).toBe('suppressed');

    engine.setSuppressionPolicy({ enabled: false });
    expect(group.suppressedAlarmIds).toEqual([]);
    expect(breaker.state).toBe('active');

    engine.setSuppressionPolicy({ enabled: true });
    expect(group.suppressedAlarmIds).toEqual(['breaker']);
    expect(breaker.state).toBe('suppressed');

    engine.setSuppressionPolicy({ neverSuppressAtOrAbove: 'medium' });
    expect(group.suppressedAlarmIds).toEqual([]);
    expect(breaker.state).toBe('active');
  });

  it('releases suppressed members when an idle group closes', () => {
    const engine = new AlarmCorrelationEngine({
      topology: plantTopology(),
      groupCloseAfterMs: 1000,
      suppressionPolicy: { enabled: true },
      clock: () => 0,
    });
    engine.ingest(alarm({
      id: 'feeder',
      equipmentId: 'FDR-1',
      tagId: 'FDR-1.TRIP',
      timestamp: 1000,
    }));
    engine.ingest(alarm({
      id: 'breaker',
      equipmentId: 'BK-1',
      tagId: 'BK-1.TRIP',
      timestamp: 1500,
    }));
    const group = engine.getGroups()[0];
    expect(group.suppressedAlarmIds).toEqual(['breaker']);

    engine.sweep(10_000);
    expect(group.state).toBe('closed');
    expect(group.closeReason).toBe('idle-timeout');
    expect(group.suppressedAlarmIds).toEqual([]);
    expect(group.alarms.find((a) => a.id === 'breaker')?.state).toBe('active');

    const clear = engine.alarmCleared('feeder', 'operator-alice');
    expect(clear.cleared).toBe(true);
    expect(group.suppressedAlarmIds).toEqual([]);
  });

  it('canonicalizes caller-suppressed raises and defensively restores closed groups', () => {
    const idle = new AlarmCorrelationEngine({
      groupCloseAfterMs: 1000,
      clock: () => 0,
    });
    idle.ingest(alarm({
      id: 'caller-root',
      tagId: 'CALLER.ALARM',
      state: 'suppressed',
      timestamp: 1000,
    }));
    idle.ingest(alarm({
      id: 'caller-member',
      tagId: 'CALLER.ALARM',
      timestamp: 1100,
    }));
    const idleGroup = idle.getGroups()[0];
    expect(idleGroup.alarms.find((candidate) => candidate.id === 'caller-root')?.state)
      .toBe('active');
    expect(idleGroup.suppressedAlarmIds).toEqual([]);

    // Simulate legacy/untrusted state that predates canonical ingestion.
    idleGroup.alarms[1].state = 'suppressed';
    idleGroup.suppressedAlarmIds = [];
    idle.sweep(10_000);
    expect(idleGroup.state).toBe('closed');
    expect(idleGroup.alarms[1].state).toBe('active');
    expect(idleGroup.suppressedAlarmIds).toEqual([]);

    const capped = new AlarmCorrelationEngine({
      maxGroups: 1,
      suppressionPolicy: { enabled: false },
    });
    capped.ingest(alarm({ id: 'old-a', tagId: 'OLD.ALARM', timestamp: 1000 }));
    capped.ingest(alarm({ id: 'old-b', tagId: 'OLD.ALARM', timestamp: 1100 }));
    const evictedGroup = capped.getGroups()[0];
    evictedGroup.alarms[1].state = 'suppressed';
    evictedGroup.suppressedAlarmIds = [];

    capped.ingest(alarm({ id: 'new-a', tagId: 'NEW.ALARM', timestamp: 100_000 }));
    capped.ingest(alarm({ id: 'new-b', tagId: 'NEW.ALARM', timestamp: 100_100 }));
    expect(evictedGroup.closeReason).toBe('evicted');
    expect(evictedGroup.alarms[1].state).toBe('active');
    expect(evictedGroup.suppressedAlarmIds).toEqual([]);
  });

  it('caps group membership to bound alarm-storm root-election work', () => {
    const engine = new AlarmCorrelationEngine({
      maxAlarmsPerGroup: 3,
    });

    for (let index = 0; index < 5; index++) {
      engine.ingest(alarm({
        id: `chatter-${index}`,
        tagId: 'VALVE-1.CHATTER',
        timestamp: index * 100,
      }));
    }

    const sizes = engine.getGroups().map((group) => group.alarmIds.length).sort();
    expect(sizes).toEqual([2, 3]);
    expect(Math.max(...sizes)).toBe(3);
  });

  it('reports duplicate alarm ids without mutating metrics', () => {
    const engine = new AlarmCorrelationEngine({ topology: plantTopology() });
    engine.ingest(alarm({ id: 'dup', equipmentId: 'FDR-1', tagId: 'FDR-1.TRIP', timestamp: 1000 }));
    const again = engine.ingest(alarm({ id: 'dup', equipmentId: 'FDR-1', tagId: 'FDR-1.TRIP', timestamp: 9999 }));
    expect(again.action).toBe('duplicate');
    expect(again.reason).toMatch(/duplicate/);
    expect(engine.getMetrics().alarmsIngested).toBe(1);
  });

  it('closes idle groups on sweep and enforces the group cap', () => {
    const engine = new AlarmCorrelationEngine({
      topology: plantTopology(),
      groupCloseAfterMs: 1000,
      maxGroups: 1,
      clock: () => 0,
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

  it('enforces the group span cap during formation and backward joins', () => {
    const formationEngine = new AlarmCorrelationEngine({
      topology: plantTopology(),
      maxGroupSpanMs: 10_000,
    });
    formationEngine.rules.upsert({
      id: 'wide',
      name: 'wide causal',
      type: 'causal',
      enabled: true,
      priority: 1,
      config: { windowMs: 1_000_000, maxHops: 5 },
    });
    formationEngine.ingest(
      alarm({ id: 'formation-f', equipmentId: 'FDR-1', tagId: 'FDR-1.T', timestamp: 0 })
    );
    const beyondFormationSpan = formationEngine.ingest(
      alarm({
        id: 'formation-b',
        equipmentId: 'BK-1',
        tagId: 'BK-1.T',
        timestamp: 50_000,
      })
    );
    expect(beyondFormationSpan.action).toBe('standalone');
    expect(formationEngine.getGroups()).toHaveLength(0);

    const joinEngine = new AlarmCorrelationEngine({
      topology: plantTopology(),
      maxGroupSpanMs: 10_000,
    });
    joinEngine.rules.upsert({
      id: 'wide',
      name: 'wide causal',
      type: 'causal',
      enabled: true,
      priority: 1,
      config: { windowMs: 1_000_000, maxHops: 5 },
    });
    joinEngine.ingest(
      alarm({ id: 'join-f', equipmentId: 'FDR-1', tagId: 'FDR-1.T', timestamp: 100_000 })
    );
    joinEngine.ingest(
      alarm({ id: 'join-b', equipmentId: 'BK-1', tagId: 'BK-1.T', timestamp: 100_100 })
    );
    const backward = joinEngine.ingest(
      alarm({ id: 'join-m', equipmentId: 'MTR-1', tagId: 'MTR-1.T', timestamp: 0 })
    );

    expect(backward.action).not.toBe('joined-group');
    expect(joinEngine.getGroups()[0].alarmIds).toEqual(['join-f', 'join-b']);
  });

  it('tracks suppression rate as the fatigue KPI', () => {
    const engine = new AlarmCorrelationEngine({
      topology: plantTopology(),
      suppressionPolicy: { enabled: true },
    });
    engine.ingest(alarm({ id: 'f', equipmentId: 'FDR-1', tagId: 'FDR-1.T', timestamp: 0 }));
    engine.ingest(alarm({ id: 'b', equipmentId: 'BK-1', tagId: 'BK-1.T', timestamp: 100 }));
    engine.ingest(alarm({ id: 'm', equipmentId: 'MTR-1', tagId: 'MTR-1.T', timestamp: 200 }));
    const metrics = engine.getMetrics();
    expect(metrics.alarmsIngested).toBe(3);
    expect(metrics.groupsCreated).toBe(1);
    expect(metrics.alarmsSuppressed).toBe(2);
    expect(metrics.suppressionRate).toBeCloseTo(2 / 3);
  });

  it('counts unique suppressed alarms so repeated policy toggles stay bounded', () => {
    const engine = new AlarmCorrelationEngine({
      suppressionPolicy: { enabled: true },
    });
    engine.ingest(alarm({
      id: 'root',
      tagId: 'BOUNDED.ALARM',
      timestamp: 0,
      severity: 'high',
    }));
    engine.ingest(alarm({
      id: 'member',
      tagId: 'BOUNDED.ALARM',
      timestamp: 100,
      severity: 'medium',
    }));

    for (let index = 0; index < 5; index++) {
      engine.setSuppressionPolicy({ enabled: false });
      engine.setSuppressionPolicy({ enabled: true });
    }

    const metrics = engine.getMetrics();
    expect(metrics.alarmsIngested).toBe(2);
    expect(metrics.alarmsSuppressed).toBe(1);
    expect(metrics.suppressionRate).toBe(0.5);
    expect(metrics.suppressionRate).toBeGreaterThanOrEqual(0);
    expect(metrics.suppressionRate).toBeLessThanOrEqual(1);
  });

  it('bounds suppression identity bookkeeping to retained groups under churn', () => {
    const engine = new AlarmCorrelationEngine({
      maxGroups: 1,
      suppressionPolicy: { enabled: true },
    });
    const churnGroups = 2000;

    for (let index = 0; index < churnGroups; index++) {
      const timestamp = index * 10_000;
      engine.ingest(alarm({
        id: `churn-root-${index}`,
        tagId: `CHURN-${index}.ALARM`,
        timestamp,
        severity: 'high',
      }));
      engine.ingest(alarm({
        id: `churn-member-${index}`,
        tagId: `CHURN-${index}.ALARM`,
        timestamp: timestamp + 100,
        severity: 'medium',
      }));
    }

    expect(engine.getGroups()).toHaveLength(1);
    expect(engine.getMetrics()).toMatchObject({
      alarmsIngested: churnGroups * 2,
      alarmsSuppressed: churnGroups,
      trackedAlarms: 2,
      suppressionRate: 0.5,
    });

    // Reusing an id from the first evicted group counts a new retained alarm
    // instance, proving its prior bookkeeping entry was released.
    engine.ingest(alarm({
      id: 'churn-root-0',
      tagId: 'CHURN-REUSED.ALARM',
      timestamp: churnGroups * 10_000,
      severity: 'high',
    }));
    engine.ingest(alarm({
      id: 'churn-member-0',
      tagId: 'CHURN-REUSED.ALARM',
      timestamp: churnGroups * 10_000 + 100,
      severity: 'medium',
    }));
    const afterReuse = engine.getMetrics();
    expect(afterReuse).toMatchObject({
      alarmsIngested: churnGroups * 2 + 2,
      alarmsSuppressed: churnGroups + 1,
      trackedAlarms: 2,
    });
    expect(Number.isFinite(afterReuse.suppressionRate)).toBe(true);
    expect(afterReuse.suppressionRate).toBeGreaterThanOrEqual(0);
    expect(afterReuse.suppressionRate).toBeLessThanOrEqual(1);
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

  it('maps missing live severity to the fail-safe floor but preserves explicit info', () => {
    for (const severity of [undefined, '', '   ']) {
      expect(normalizeAlarm({
        id: `missing-${String(severity)}`,
        tagId: 'MISSING.SEVERITY',
        timestamp: 1,
        ...(severity === undefined ? {} : { severity }),
      })?.severity).toBe('critical');
    }
    expect(normalizeAlarm({
      id: 'explicit-info',
      tagId: 'EXPLICIT.INFO',
      timestamp: 1,
      severity: 'info',
    })?.severity).toBe('info');
  });

  it('rejects alarms without a usable timestamp', () => {
    expect(normalizeAlarm({ id: 'x', tagId: 'T.1' })).toBeNull();
    expect(normalizeAlarm({ id: 'x', tagId: 'T.1', timestamp: 'garbage' })).toBeNull();
    expect(normalizeAlarm({
      id: 'x',
      tagId: 'T.1',
      timestamp: 1,
      severity: 'catastrophic',
    })).toBeNull();
    expect(normalizeAlarm({
      id: 'x',
      tagId: 'T.1',
      timestamp: 1,
      state: 'mystery',
    })).toBeNull();
    expect(normalizeAlarm({
      id: 'date-overflow',
      tagId: 'T.1',
      timestamp: -1e300,
    })).toBeNull();
  });

  it('normalizes caller-supplied suppression back to a new active raise', () => {
    expect(normalizeAlarm({
      id: 'caller-suppressed',
      tagId: 'T.1',
      timestamp: 1,
      state: 'suppressed',
    })?.state).toBe('active');
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
    expect(second.result.suppressed).toBe(false);
    expect(service.engine.getSuppressionPolicy().enabled).toBe(false);
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

  it('rejects Date-invalid timestamps before mutation and permits a valid retry', () => {
    const service = new AlarmCorrelationService();
    expect(service.ingest({
      id: 'retry-after-invalid-date',
      tagId: 'DATE.ALARM',
      timestamp: -1e300,
    })).toBeNull();
    expect(service.engine.getMetrics()).toMatchObject({
      alarmsIngested: 0,
      trackedAlarms: 0,
    });

    const retry = service.ingest({
      id: 'retry-after-invalid-date',
      tagId: 'DATE.ALARM',
      timestamp: 1000,
    });
    expect(retry?.result.action).toBe('standalone');
    expect(service.engine.getMetrics()).toMatchObject({
      alarmsIngested: 1,
      trackedAlarms: 1,
    });
  });
});
