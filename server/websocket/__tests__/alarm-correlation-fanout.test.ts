import { afterEach, describe, expect, it } from 'vitest';

import { AlarmCorrelationService } from '../../services/alarm-correlation';
import type { AlarmWireSnapshot } from '@shared/types/alarm-correlation';
import { CachedEventBridge } from '../cached-event-bridge';

interface CapturingSink {
  snapshots: AlarmWireSnapshot[];
  broadcastAlarm(alarm: AlarmWireSnapshot): void;
}

function capturingSink(): CapturingSink {
  return {
    snapshots: [],
    broadcastAlarm(alarm) {
      this.snapshots.push(alarm);
    },
  };
}

function latest(sink: CapturingSink, alarmId: string): AlarmWireSnapshot {
  const matches = sink.snapshots.filter((snapshot) => snapshot.id === alarmId);
  const snapshot = matches.at(-1);
  if (!snapshot) throw new Error(`No snapshot for ${alarmId}`);
  return snapshot;
}

const bridges: CachedEventBridge[] = [];

function setup() {
  const service = new AlarmCorrelationService();
  const tagSink = capturingSink();
  const unifiedSink = capturingSink();
  const bridge = new CachedEventBridge(service, tagSink, unifiedSink);
  bridges.push(bridge);
  return { service, tagSink, unifiedSink, bridge };
}

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.destroy()));
});

describe('alarm correlation local fanout', () => {
  it('emits corrected snapshots for every member when a group forms', () => {
    const { service, tagSink, unifiedSink, bridge } = setup();
    service.engine.setSuppressionPolicy({ enabled: true });
    bridge.initializeLocalAlarmFanout();

    service.ingest({
      id: 'root',
      tagId: 'VALVE-1.CHATTER',
      severity: 'high',
      state: 'active',
      timestamp: 1000,
    });
    service.ingest({
      id: 'member',
      tagId: 'VALVE-1.CHATTER',
      severity: 'medium',
      state: 'active',
      timestamp: 1100,
    });

    expect(latest(tagSink, 'root')).toMatchObject({
      state: 'active',
      correlation: {
        groupState: 'open',
        rootCauseAlarmId: 'root',
        suppressed: false,
        isRootCause: true,
        coordinationMode: 'process-local',
      },
    });
    expect(latest(tagSink, 'member')).toMatchObject({
      state: 'suppressed',
      correlation: {
        groupState: 'open',
        rootCauseAlarmId: 'root',
        suppressed: true,
        isRootCause: false,
      },
    });
    expect(unifiedSink.snapshots).toEqual(tagSink.snapshots);
  });

  it('rebroadcasts every member after an out-of-order root change', () => {
    const { service, tagSink, bridge } = setup();
    bridge.initializeLocalAlarmFanout();

    service.ingest({
      id: 'late-event',
      tagId: 'PUMP-1.TRIP',
      timestamp: 5000,
    });
    service.ingest({
      id: 'later-event',
      tagId: 'PUMP-1.TRIP',
      timestamp: 5200,
    });
    service.ingest({
      id: 'earliest-event',
      tagId: 'PUMP-1.TRIP',
      timestamp: 4800,
    });

    for (const id of ['late-event', 'later-event', 'earliest-event']) {
      expect(latest(tagSink, id).correlation.rootCauseAlarmId).toBe('earliest-event');
    }
    expect(latest(tagSink, 'earliest-event').correlation.isRootCause).toBe(true);
  });

  it('fans out acknowledgement, clear, policy, and idle-close lifecycle changes', () => {
    const { service, tagSink, bridge } = setup();
    service.engine.setSuppressionPolicy({ enabled: true });
    bridge.initializeLocalAlarmFanout();

    service.ingest({ id: 'root', tagId: 'LOOP-1.ALARM', timestamp: 1000 });
    service.ingest({ id: 'member', tagId: 'LOOP-1.ALARM', timestamp: 1100 });

    expect(service.engine.alarmAcknowledged('member', 'operator-a')).toBe(true);
    expect(latest(tagSink, 'member')).toMatchObject({
      state: 'acknowledged',
      acknowledgedBy: 'operator-a',
      correlation: { suppressed: false },
    });

    service.engine.setSuppressionPolicy({ enabled: false });
    expect(latest(tagSink, 'root').correlation.groupState).toBe('open');
    service.engine.setSuppressionPolicy({ enabled: true });

    expect(service.engine.alarmCleared('root', 'operator-b')).toMatchObject({
      cleared: true,
      clearedBy: 'operator-b',
    });
    expect(latest(tagSink, 'root')).toMatchObject({
      state: 'cleared',
      clearedBy: 'operator-b',
      correlation: { groupState: 'closed' },
    });

    const idle = setup();
    idle.service.engine.setSuppressionPolicy({ enabled: true });
    idle.bridge.initializeLocalAlarmFanout();
    idle.service.ingest({ id: 'idle-root', tagId: 'IDLE.ALARM', timestamp: 1000 });
    idle.service.ingest({ id: 'idle-member', tagId: 'IDLE.ALARM', timestamp: 1100 });
    idle.service.engine.sweep(Date.now() + 11 * 60 * 1000);
    expect(latest(idle.tagSink, 'idle-member')).toMatchObject({
      state: 'active',
      correlation: {
        groupState: 'closed',
        suppressed: false,
      },
    });
  });

  it('keeps missing live severity unsuppressed while preserving explicit info', async () => {
    for (const [label, severity, expectedSeverity, suppressed] of [
      ['missing', undefined, 'critical', false],
      ['blank', '', 'critical', false],
      ['explicit-info', 'info', 'info', true],
    ] as const) {
      const { service, tagSink, bridge } = setup();
      service.engine.setSuppressionPolicy({ enabled: true });

      await bridge.publishAlarm({
        id: `${label}-root`,
        tagId: `${label}.ALARM`,
        state: 'active',
        severity: 'high',
        timestamp: 1000,
      });
      await bridge.publishAlarm({
        id: `${label}-member`,
        tagId: `${label}.ALARM`,
        state: 'active',
        timestamp: 1100,
        ...(severity === undefined ? {} : { severity }),
      });

      expect(latest(tagSink, `${label}-member`)).toMatchObject({
        severity: expectedSeverity,
        state: suppressed ? 'suppressed' : 'active',
        correlation: { suppressed },
      });
    }
  });

  it('processes and broadcasts a same-id cleared lifecycle update once', async () => {
    const { service, tagSink, unifiedSink, bridge } = setup();

    await bridge.publishAlarm({
      id: 'same-id',
      tagId: 'SAME.ALARM',
      state: 'active',
      severity: 'high',
      timestamp: 1000,
    });
    expect(latest(tagSink, 'same-id').state).toBe('active');

    await bridge.publishAlarm({
      id: 'same-id',
      tagId: 'SAME.ALARM',
      state: 'cleared',
      severity: 'high',
      timestamp: 1100,
    });
    expect(latest(tagSink, 'same-id')).toMatchObject({
      state: 'cleared',
      correlation: {
        groupId: null,
        suppressed: false,
      },
    });
    expect(unifiedSink.snapshots).toEqual(tagSink.snapshots);

    const snapshotCount = tagSink.snapshots.length;
    await bridge.publishAlarm({
      id: 'same-id',
      tagId: 'SAME.ALARM',
      state: 'cleared',
      severity: 'high',
      timestamp: 1200,
    });
    expect(tagSink.snapshots).toHaveLength(snapshotCount);
    expect(latest(tagSink, 'same-id').clearedBy).toBeUndefined();
    expect(service.engine.getMetrics()).toMatchObject({
      alarmsIngested: 1,
      trackedAlarms: 1,
    });
  });

  it('initializes idempotently and isolates sink failures', async () => {
    const service = new AlarmCorrelationService();
    const delivered = capturingSink();
    const failingSink = {
      broadcastAlarm() {
        throw new Error('socket unavailable');
      },
    };
    const bridge = new CachedEventBridge(service, failingSink, delivered);
    bridges.push(bridge);

    bridge.initializeLocalAlarmFanout();
    bridge.initializeLocalAlarmFanout();
    await expect(bridge.publishAlarm({
      id: 'one',
      tagId: 'ONE.ALARM',
      timestamp: 1000,
    })).resolves.toBeUndefined();

    expect(delivered.snapshots).toHaveLength(1);
    expect(delivered.snapshots[0]).toMatchObject({
      id: 'one',
      triggeredAt: new Date(1000).toISOString(),
      correlation: {
        groupId: null,
        coordinationMode: 'process-local',
      },
    });
  });
});
