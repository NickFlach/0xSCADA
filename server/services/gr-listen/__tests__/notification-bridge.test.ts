import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AlarmSeverity,
  AlarmWireSnapshot,
} from '@shared/types/alarm-correlation';
import { AlarmCorrelationService } from '../../alarm-correlation';
import { CachedEventBridge } from '../../../websocket/cached-event-bridge';
import { GrListenFilter, getGrListenFilter, type GrListenConfig } from '../index';
import {
  applyNotificationDecision,
  isCorrelationSuppressed,
  isGrListenWiringEnabled,
  toAlertInput,
  type AlarmNotificationDecision,
} from '../notification-bridge';

/**
 * Fixture event time. Anchored to the wall clock because GrListenFilter prunes
 * its correlation history against `Date.now()` — a fixed past timestamp is
 * discarded the moment it is recorded, so grouping could never be exercised.
 */
const AT = Date.now();

type NotifiedSnapshot = AlarmWireSnapshot & {
  notification?: AlarmNotificationDecision;
};

function snapshot(overrides: Partial<AlarmWireSnapshot> = {}): AlarmWireSnapshot {
  return {
    id: 'ALM-1',
    name: 'High discharge pressure',
    tagId: 'PUMP-A.PRESSURE_HIGH',
    equipmentId: 'PUMP-A',
    siteId: 'SITE-1',
    processArea: 'AREA-3',
    severity: 'high',
    state: 'active',
    message: 'Discharge pressure above limit',
    timestamp: AT,
    value: 91,
    limit: 85,
    triggeredAt: new Date(AT).toISOString(),
    tagValue: 91,
    correlation: {
      groupId: null,
      groupState: null,
      rootCauseAlarmId: null,
      suppressed: false,
      isRootCause: false,
      coordinationMode: 'process-local',
      seq: null,
    },
    ...overrides,
  };
}

function correlated(
  overrides: Partial<AlarmWireSnapshot['correlation']>,
): AlarmWireSnapshot {
  const base = snapshot();
  return { ...base, correlation: { ...base.correlation, ...overrides } };
}

/** A filter whose critical budget is one alert, so the second is suppressed. */
function tightBudgetFilter(maxAlerts: number): GrListenFilter {
  const budgets: GrListenConfig['defaultBudgets'] = {
    critical: { maxAlerts, windowMs: 60_000 },
    high: { maxAlerts, windowMs: 60_000 },
    medium: { maxAlerts, windowMs: 60_000 },
    low: { maxAlerts, windowMs: 60_000 },
    info: { maxAlerts, windowMs: 60_000 },
  };
  return new GrListenFilter({ defaultBudgets: budgets });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('toAlertInput', () => {
  it('maps a correlation-enriched alarm onto the GR::LISTEN alert shape', () => {
    expect(toAlertInput(snapshot())).toEqual({
      alarmId: 'ALM-1',
      alarmName: 'High discharge pressure',
      sourceTagId: 'PUMP-A.PRESSURE_HIGH',
      priority: 'high',
      message: 'Discharge pressure above limit',
      processArea: 'AREA-3',
      facility: 'SITE-1',
      triggerValue: 91,
      limitValue: 85,
      timestamp: AT,
    });
  });

  it('passes every shared severity through unchanged', () => {
    const severities: AlarmSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
    for (const severity of severities) {
      expect(toAlertInput(snapshot({ severity }))?.priority).toBe(severity);
    }
  });

  it('accepts the SingularisPrime alarm shape', () => {
    const input = toAlertInput({
      alarmId: 'SP-9',
      alarmName: 'Bearing temperature',
      sourceTagId: 'FAN-2.TEMP',
      priority: 'medium',
      message: 'Bearing over temperature',
      triggerValue: '120C',
      limitValue: '110C',
      timestamp: AT,
    });
    expect(input).toMatchObject({
      alarmId: 'SP-9',
      alarmName: 'Bearing temperature',
      sourceTagId: 'FAN-2.TEMP',
      priority: 'medium',
      triggerValue: '120C',
      limitValue: '110C',
    });
  });

  it('refuses to invent a priority, id, or event time', () => {
    expect(toAlertInput({ ...snapshot(), severity: 'not-a-severity' })).toBeNull();
    expect(toAlertInput({ ...snapshot(), severity: undefined })).toBeNull();
    expect(toAlertInput({ ...snapshot(), id: '' })).toBeNull();
    expect(toAlertInput({ ...snapshot(), timestamp: 'yesterday' })).toBeNull();
  });
});

describe('isCorrelationSuppressed', () => {
  it('is true only for a non-root alarm correlation already hid', () => {
    expect(isCorrelationSuppressed(correlated({ suppressed: true }))).toBe(true);
    expect(isCorrelationSuppressed(correlated({ suppressed: false }))).toBe(false);
    // A root cause always reaches GR::LISTEN, whatever the flag says.
    expect(
      isCorrelationSuppressed(correlated({ suppressed: true, isRootCause: true })),
    ).toBe(false);
    expect(isCorrelationSuppressed({ id: 'no-correlation-field' })).toBe(false);
  });
});

describe('applyNotificationDecision', () => {
  it('attaches the decision, effective priority, and reason', () => {
    const filter = tightBudgetFilter(10);
    const result = applyNotificationDecision(snapshot(), { filter, enabled: true });

    expect(result).toMatchObject({
      id: 'ALM-1',
      severity: 'high',
      notification: {
        decision: 'pass',
        effectivePriority: 'high',
        reason: expect.any(String),
      },
    });
  });

  it('attaches the incident id when GR::LISTEN groups the alert', () => {
    const filter = tightBudgetFilter(10);
    applyNotificationDecision(snapshot({ id: 'first' }), { filter, enabled: true });
    const grouped = applyNotificationDecision(
      snapshot({ id: 'second', timestamp: AT + 1_000 }),
      { filter, enabled: true },
    ) as NotifiedSnapshot;

    expect(grouped.notification?.decision).toBe('group');
    expect(grouped.notification?.incidentId).toMatch(/^INC-/);
  });

  it('still returns a suppressed alarm — the decision de-clutters, it never drops', () => {
    const filter = tightBudgetFilter(1);
    // Distinct tags so GR::LISTEN's own correlation cannot group them and the
    // attention budget is what decides the second alert.
    const first = applyNotificationDecision(
      snapshot({ id: 'a', tagId: 'PUMP-A.TRIP' }),
      { filter, enabled: true },
    ) as NotifiedSnapshot;
    const second = applyNotificationDecision(
      snapshot({ id: 'b', tagId: 'PUMP-B.TRIP' }),
      { filter, enabled: true },
    ) as NotifiedSnapshot;

    expect(first.notification?.decision).toBe('pass');
    expect(second.notification?.decision).toBe('suppress');
    // The whole alarm survives, decision attached — nothing is dropped.
    expect(second).toMatchObject({ id: 'b', severity: 'high', state: 'active' });
  });

  it('reports the escalated priority when fatigue escalates an alert', () => {
    const filter = new GrListenFilter({ defaultFatigueThreshold: 1 });
    applyNotificationDecision(snapshot({ id: 'a', tagId: 'T-1' }), {
      filter,
      enabled: true,
    });
    const escalated = applyNotificationDecision(
      snapshot({ id: 'b', tagId: 'T-2', severity: 'medium' }),
      { filter, enabled: true },
    ) as NotifiedSnapshot;

    expect(escalated.notification).toMatchObject({
      decision: 'escalate',
      effectivePriority: 'high',
    });
    expect(escalated.severity).toBe('medium');
  });

  it('skips alarms correlation already suppressed, without touching the filter', () => {
    const filter = tightBudgetFilter(10);
    const evaluate = vi.spyOn(filter, 'evaluate');
    const alarm = correlated({ suppressed: true, groupId: 'GRP-1' });

    const result = applyNotificationDecision(alarm, { filter, enabled: true });

    expect(evaluate).not.toHaveBeenCalled();
    expect(result).toBe(alarm);
    expect(result).not.toHaveProperty('notification');
  });

  it('always evaluates the root-cause alarm of a group', () => {
    const filter = tightBudgetFilter(10);
    const evaluate = vi.spyOn(filter, 'evaluate');
    const root = correlated({
      suppressed: true,
      isRootCause: true,
      groupId: 'GRP-1',
      rootCauseAlarmId: 'ALM-1',
    });

    const result = applyNotificationDecision(root, { filter, enabled: true }) as NotifiedSnapshot;

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(result.notification?.decision).toBe('pass');
  });

  it('is a no-op when the flag is off', () => {
    const filter = tightBudgetFilter(10);
    const evaluate = vi.spyOn(filter, 'evaluate');
    const alarm = snapshot();

    const result = applyNotificationDecision(alarm, { filter, enabled: false });

    expect(evaluate).not.toHaveBeenCalled();
    expect(result).toBe(alarm);
    expect(result).not.toHaveProperty('notification');
  });

  it('defaults to off, and reads GR_LISTEN_ENABLED when no override is given', () => {
    const filter = tightBudgetFilter(10);

    vi.stubEnv('GR_LISTEN_ENABLED', '');
    expect(isGrListenWiringEnabled()).toBe(false);
    expect(applyNotificationDecision(snapshot(), { filter })).not.toHaveProperty(
      'notification',
    );

    vi.stubEnv('GR_LISTEN_ENABLED', 'true');
    expect(isGrListenWiringEnabled()).toBe(true);
    expect(applyNotificationDecision(snapshot(), { filter })).toHaveProperty(
      'notification',
    );
  });

  it('falls back to the process-wide filter when no instance is supplied', () => {
    // The production wiring in CachedEventBridge passes the singleton
    // explicitly; this covers a direct caller that does not. A unique id and
    // tag keep it independent of whatever else has used the singleton.
    const id = `fallback-${Date.now()}`;
    const result = applyNotificationDecision(
      snapshot({ id, tagId: `${id}.TRIP`, severity: 'critical' }),
      { enabled: true },
    ) as NotifiedSnapshot;

    expect(getGrListenFilter()).toBeInstanceOf(GrListenFilter);
    expect(result.notification?.effectivePriority).toBe('critical');
  });

  it('returns the alarm untouched when GR::LISTEN throws', () => {
    const filter = tightBudgetFilter(10);
    vi.spyOn(filter, 'evaluate').mockImplementation(() => {
      throw new Error('filter exploded');
    });
    const alarm = snapshot();

    const result = applyNotificationDecision(alarm, { filter, enabled: true });

    expect(result).toBe(alarm);
    expect(result).not.toHaveProperty('notification');
  });
});

// ── End-to-end through the real correlation engine and a real filter ─────────

interface CapturingSink {
  snapshots: NotifiedSnapshot[];
  broadcastAlarm(alarm: NotifiedSnapshot): void;
}

function capturingSink(): CapturingSink {
  return {
    snapshots: [],
    broadcastAlarm(alarm) {
      this.snapshots.push(alarm);
    },
  };
}

function latest(sink: CapturingSink, alarmId: string): NotifiedSnapshot {
  const found = sink.snapshots.filter((s) => s.id === alarmId).at(-1);
  if (!found) throw new Error(`No snapshot broadcast for ${alarmId}`);
  return found;
}

const bridges: CachedEventBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.destroy()));
});

describe('GR::LISTEN behind alarm correlation (end to end)', () => {
  function setup(filter: GrListenFilter) {
    const service = new AlarmCorrelationService();
    const tagSink = capturingSink();
    const unifiedSink = capturingSink();
    const bridge = new CachedEventBridge(service, tagSink, unifiedSink, (alarm) =>
      applyNotificationDecision(alarm, { filter, enabled: true }),
    );
    bridges.push(bridge);
    bridge.initializeLocalAlarmFanout();
    return { service, tagSink, unifiedSink };
  }

  it('decides notification worthiness for the root cause and skips suppressed members', () => {
    const { service, tagSink, unifiedSink } = setup(tightBudgetFilter(10));
    service.engine.setSuppressionPolicy({ enabled: true });

    service.ingest({ id: 'root', tagId: 'VALVE-1.CHATTER', severity: 'high', timestamp: 1000 });
    service.ingest({ id: 'member', tagId: 'VALVE-1.CHATTER', severity: 'medium', timestamp: 1100 });

    const root = latest(tagSink, 'root');
    expect(root.correlation.isRootCause).toBe(true);
    expect(root.notification?.effectivePriority).toBe('high');
    expect(['pass', 'group', 'escalate']).toContain(root.notification?.decision);

    const member = latest(tagSink, 'member');
    expect(member.correlation.suppressed).toBe(true);
    expect(member).not.toHaveProperty('notification');
    // The suppressed member is still delivered — correlation and GR::LISTEN
    // both annotate, neither drops.
    expect(unifiedSink.snapshots.map((s) => s.id)).toContain('member');
    expect(unifiedSink.snapshots).toEqual(tagSink.snapshots);
  });

  it('broadcasts an alarm the real filter suppressed, with the decision attached', () => {
    const { service, tagSink } = setup(tightBudgetFilter(1));

    service.ingest({ id: 'first', tagId: 'PUMP-A.TRIP', severity: 'critical', timestamp: 2000 });
    service.ingest({ id: 'second', tagId: 'PUMP-B.TRIP', severity: 'critical', timestamp: 90_000 });

    expect(latest(tagSink, 'first').notification?.decision).toBe('pass');

    const second = latest(tagSink, 'second');
    expect(second.notification?.decision).toBe('suppress');
    expect(second.notification?.reason).toMatch(/budget/i);
    // Present in the fan-out despite the suppress decision.
    expect(tagSink.snapshots.map((s) => s.id)).toContain('second');
    expect(second.severity).toBe('critical');
  });
});
