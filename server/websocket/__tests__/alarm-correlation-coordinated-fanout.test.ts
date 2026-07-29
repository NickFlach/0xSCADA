/**
 * Cross-instance alarm fan-out and reconnect snapshots
 * ADR-0026 / ADR-0013 [13.2] — Issue #573
 *
 * Two `CachedEventBridge` instances stand in for two API replicas. Redis is not
 * available in this suite, so the cross-instance hop is performed by handing one
 * bridge the payload the other would have published — the same object shape,
 * through the same `handleIncoming` path a real Redis message takes. What is
 * under test is the de-duplication and snapshot logic, not ioredis.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AlarmWireSnapshot } from '@shared/types/alarm-correlation';
import {
  AlarmCorrelationCoordinator,
  AlarmCorrelationService,
  DrizzleCorrelationStore,
  type CorrelationStore,
} from '../../services/alarm-correlation';
import { CachedEventBridge } from '../cached-event-bridge';

/** The real store until `fail` is set, then a store that cannot be reached. */
function breakableStore(inner: CorrelationStore): CorrelationStore & { fail: boolean } {
  const unreachable = () => Promise.reject(new Error('journal unreachable'));
  const wrapper: CorrelationStore & { fail: boolean } = {
    fail: false,
    ready: () => inner.ready(),
    backend: () => inner.backend(),
    append: (entry) => (wrapper.fail ? unreachable() : inner.append(entry)),
    read: (afterSeq, limit) =>
      (wrapper.fail ? unreachable() : inner.read(afterSeq, limit)),
    load: () => inner.load(),
    project: (seq, changes) =>
      (wrapper.fail ? unreachable() : inner.project(seq, changes)),
    prune: (options) => inner.prune(options),
    close: () => inner.close(),
  };
  return wrapper;
}

interface CapturingSink {
  snapshots: Record<string, unknown>[];
  provided: Record<string, unknown>[][];
  broadcastAlarm(alarm: Record<string, unknown>): void;
  setAlarmSnapshotProvider(
    provider: (() => Record<string, unknown>[]) | null,
  ): void;
  requestSnapshot(): Record<string, unknown>[];
}

function capturingSink(): CapturingSink {
  let provider: (() => Record<string, unknown>[]) | null = null;
  return {
    snapshots: [],
    provided: [],
    broadcastAlarm(alarm) {
      this.snapshots.push(alarm);
    },
    setAlarmSnapshotProvider(next) {
      provider = next;
    },
    /** What a freshly connected client on this server would be sent. */
    requestSnapshot() {
      const alarms = provider ? provider() : [];
      this.provided.push(alarms);
      return alarms;
    },
  };
}

// Real transactions against a real database file with synchronous=FULL: these
// tests are disk-bound, and the default 5s budget is not enough when the suite
// runs in parallel with the rest of the repo.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined);
  }
});

async function sharedDbFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'alarm-fanout-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'correlation.sqlite');
}

interface Replica {
  service: AlarmCorrelationService;
  coordinator: AlarmCorrelationCoordinator;
  bridge: CachedEventBridge;
  tagSink: CapturingSink;
  unifiedSink: CapturingSink;
  store: CorrelationStore & { fail: boolean };
}

async function startReplica(file: string, instanceId: string): Promise<Replica> {
  const store = breakableStore(new DrizzleCorrelationStore({ sqlitePath: file }));
  const coordinator = new AlarmCorrelationCoordinator({
    store,
    instanceId,
    pollIntervalMs: 60_000,
    pruneIntervalMs: 60 * 60_000,
  });
  await coordinator.start();
  cleanups.push(() => coordinator.stop());

  const service = new AlarmCorrelationService();
  service.attachCoordinator(coordinator);

  const tagSink = capturingSink();
  const unifiedSink = capturingSink();
  const bridge = new CachedEventBridge(service, tagSink, unifiedSink);
  bridge.initializeLocalAlarmFanout();
  cleanups.push(() => bridge.destroy());

  return { service, coordinator, bridge, tagSink, unifiedSink, store };
}

/**
 * What a real bridge publishes to Redis: the snapshot plus its origin tag.
 * `handleIncoming` is private, so the test reaches it the way the subscriber
 * callback does.
 */
function deliverRemote(target: Replica, snapshot: Record<string, unknown>): void {
  const bridge = target.bridge as unknown as {
    handleIncoming(channel: string, data: unknown): void;
    instanceId: string;
  };
  bridge.handleIncoming('0xscada:ws:alarms', { ...snapshot });
}

function originTagged(
  source: Replica,
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  const bridge = source.bridge as unknown as { instanceId: string };
  return { ...snapshot, _bridgeOrigin: bridge.instanceId };
}

function latest(sink: CapturingSink, alarmId: string): AlarmWireSnapshot {
  const match = sink.snapshots.filter((snapshot) => snapshot.id === alarmId).at(-1);
  if (!match) throw new Error(`No snapshot for ${alarmId}`);
  return match as unknown as AlarmWireSnapshot;
}

describe('coordinated cross-instance alarm fan-out', () => {
  it('drops a duplicate cross-instance echo but delivers the next state', async () => {
    const file = await sharedDbFile();
    const a = await startReplica(file, 'replica-a');
    const b = await startReplica(file, 'replica-b');

    await a.bridge.publishAlarm({
      id: 'shared-alarm',
      tagId: 'PUMP-1.TRIP',
      severity: 'high',
      state: 'active',
      timestamp: 1_000,
    });
    const published = latest(a.tagSink, 'shared-alarm') as unknown as Record<string, unknown>;
    expect((published.correlation as { seq: number }).seq).toBeGreaterThan(0);

    // B consumes the same journal entry itself, then also receives A's Redis
    // copy of the identical state.
    await b.coordinator.pump();
    const deliveredBefore = b.tagSink.snapshots.length;
    deliverRemote(b, originTagged(a, published));
    expect(b.tagSink.snapshots).toHaveLength(deliveredBefore);

    // A's own echo coming back to A is dropped by the origin tag.
    const aBefore = a.tagSink.snapshots.length;
    deliverRemote(a, originTagged(a, published));
    expect(a.tagSink.snapshots).toHaveLength(aBefore);

    // A newer state for the same alarm still gets through: the guard compares
    // sequences, it does not simply remember the id.
    await a.service.acknowledge('shared-alarm', 'operator-a');
    const acknowledged = latest(a.tagSink, 'shared-alarm') as unknown as Record<string, unknown>;
    expect((acknowledged.correlation as { seq: number }).seq)
      .toBeGreaterThan((published.correlation as { seq: number }).seq);

    const beforeNewer = b.tagSink.snapshots.length;
    deliverRemote(b, originTagged(a, acknowledged));
    expect(b.tagSink.snapshots.length).toBe(beforeNewer + 1);
    expect(latest(b.tagSink, 'shared-alarm').state).toBe('acknowledged');
  });

  it('does not let an incoming message raise the de-duplication watermark', async () => {
    const file = await sharedDbFile();
    const a = await startReplica(file, 'replica-a');
    const b = await startReplica(file, 'replica-b');

    // Anything able to publish on the alarm channel claims a very high sequence
    // for an alarm id. If that raised the watermark, every later genuine state
    // for that id would be dropped as "already delivered" — a way to hide an
    // alarm, which is the one outcome this subsystem must never allow.
    deliverRemote(b, originTagged(a, {
      id: 'targeted-alarm',
      tagId: 'PUMP-1.TRIP',
      severity: 'critical',
      state: 'active',
      correlation: { seq: Number.MAX_SAFE_INTEGER, coordinationMode: 'durable' },
    }));
    expect(b.tagSink.snapshots.filter((s) => s.id === 'targeted-alarm')).toHaveLength(1);

    // A genuine, much lower-sequence state for the same alarm still gets through.
    await a.bridge.publishAlarm({
      id: 'targeted-alarm',
      tagId: 'PUMP-1.TRIP',
      severity: 'critical',
      state: 'active',
      timestamp: 1_000,
    });
    const genuine = latest(a.tagSink, 'targeted-alarm') as unknown as Record<string, unknown>;
    expect((genuine.correlation as { seq: number }).seq).toBeLessThan(Number.MAX_SAFE_INTEGER);

    const before = b.tagSink.snapshots.length;
    deliverRemote(b, originTagged(a, genuine));
    expect(b.tagSink.snapshots.length).toBe(before + 1);
  });

  it('never drops an uncorrelated alarm that carries no sequence', async () => {
    const file = await sharedDbFile();
    const a = await startReplica(file, 'replica-a');
    const b = await startReplica(file, 'replica-b');

    // A degraded or process-local producer emits no seq. Two identical copies
    // must both be delivered: a duplicate is a nuisance, a dropped alarm is a
    // safety failure, so the guard fails open.
    const raw = {
      id: 'no-seq-alarm',
      tagId: 'TANK-1.LEVEL',
      severity: 'critical',
      state: 'active',
      triggeredAt: new Date(2_000).toISOString(),
      correlation: { seq: null, coordinationMode: 'process-local' },
    };
    deliverRemote(b, originTagged(a, raw));
    deliverRemote(b, originTagged(a, raw));
    expect(b.tagSink.snapshots.filter((s) => s.id === 'no-seq-alarm')).toHaveLength(2);
  });

  it('does not let a raw producer payload raise the de-duplication watermark', async () => {
    const file = await sharedDbFile();
    const b = await startReplica(file, 'replica-b');

    // The same hide primitive as the incoming-message case, reached through the
    // other door: `publishAlarm` falls back to raw delivery for anything with
    // no usable timestamp, and that payload is the producer's, not this
    // engine's. If its `correlation.seq` were recorded as delivered, every
    // later genuine state for that alarm id would be dropped.
    await b.bridge.publishAlarm({
      id: 'targeted-alarm',
      tagId: 'TANK-1.LEVEL',
      severity: 'critical',
      state: 'active',
      timestamp: 'not-a-date',
      correlation: { seq: Number.MAX_SAFE_INTEGER, coordinationMode: 'durable' },
    });

    const before = b.tagSink.snapshots.filter((s) => s.id === 'targeted-alarm').length;
    deliverRemote(b, {
      id: 'targeted-alarm',
      tagId: 'TANK-1.LEVEL',
      severity: 'critical',
      state: 'active',
      correlation: { seq: 7, coordinationMode: 'durable' },
      _bridgeOrigin: 'replica-a',
    });
    expect(b.tagSink.snapshots.filter((s) => s.id === 'targeted-alarm'))
      .toHaveLength(before + 1);
  });

  it('serves one canonical reconnect snapshot per active alarm with no origin echo', async () => {
    const file = await sharedDbFile();
    const a = await startReplica(file, 'replica-a');
    const b = await startReplica(file, 'replica-b');

    await a.bridge.publishAlarm({
      id: 'alpha',
      tagId: 'PUMP-1.TRIP',
      severity: 'high',
      state: 'active',
      timestamp: 1_000,
    });
    await a.bridge.publishAlarm({
      id: 'beta',
      tagId: 'PUMP-1.TRIP',
      severity: 'low',
      state: 'active',
      timestamp: 1_100,
    });
    await a.bridge.publishAlarm({
      id: 'gamma',
      tagId: 'TANK-2.LEVEL',
      severity: 'medium',
      state: 'active',
      timestamp: 3_000,
    });
    await a.service.clear('gamma', 'operator-a');
    await b.coordinator.pump();

    // Both surfaces of the reconnecting replica are served from the same
    // canonical state.
    const tagSnapshot = b.tagSink.requestSnapshot();
    const unifiedSnapshot = b.unifiedSink.requestSnapshot();
    expect(unifiedSnapshot).toEqual(tagSnapshot);

    const ids = tagSnapshot.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['alpha', 'beta']);
    expect(ids).not.toContain('gamma');
    for (const entry of tagSnapshot) {
      expect((entry.correlation as { coordinationMode: string }).coordinationMode)
        .toBe('durable');
    }

    // Delivering the snapshot armed de-duplication, so A's echo of exactly the
    // state the snapshot already carried does not arrive as a duplicate right
    // after reconnect.
    const afterSnapshot = b.tagSink.snapshots.length;
    for (const entry of tagSnapshot) {
      deliverRemote(b, originTagged(a, entry));
    }
    expect(b.tagSink.snapshots).toHaveLength(afterSnapshot);
  });

  it('keeps delivering alarms and drops the seq when coordination degrades', async () => {
    const file = await sharedDbFile();
    const a = await startReplica(file, 'replica-a');

    await a.bridge.publishAlarm({
      id: 'pre-degrade',
      tagId: 'PUMP-1.TRIP',
      severity: 'high',
      state: 'active',
      timestamp: 1_000,
    });
    // Real storage loss, not a flag flip: the store rejects everything from
    // here on, so the coordinator cannot quietly recover mid-test.
    a.store.fail = true;

    await a.bridge.publishAlarm({
      id: 'post-degrade',
      tagId: 'PUMP-1.TRIP',
      severity: 'high',
      state: 'active',
      timestamp: 1_100,
    });

    // The alarm still reached the operator despite the journal being gone.
    const delivered = latest(a.tagSink, 'post-degrade');
    expect(delivered.id).toBe('post-degrade');
    expect(a.coordinator.health().healthy).toBe(false);
    expect(delivered.correlation.coordinationMode).toBe('process-local');
    // No seq while degraded, so a healthy peer can never mistake a degraded
    // replica's correction for a stale echo and drop it.
    expect(delivered.correlation.seq).toBeNull();
  });
});
