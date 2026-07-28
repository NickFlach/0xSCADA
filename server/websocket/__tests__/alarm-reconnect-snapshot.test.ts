/**
 * `/ws` and `/ws/tags` reconnect snapshots
 * ADR-0026 / ADR-0013 [13.2] — Issue #573
 *
 * Real WebSocket servers on a real HTTP server, real `ws` clients, real
 * durable coordination over a real SQLite file. Nothing here inspects a
 * provider function: every assertion is about frames that actually arrived over
 * a socket, because "the client receives one canonical snapshot" is a claim
 * about the wire, not about an internal call.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

import {
  AlarmCorrelationCoordinator,
  AlarmCorrelationService,
  DrizzleCorrelationStore,
} from '../../services/alarm-correlation';
import { CachedEventBridge } from '../cached-event-bridge';
import { tagStreamServer } from '../tag-stream';
import { unifiedStreamServer } from '../unified-stream';

// Real sockets and real database commits at synchronous=FULL.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined);
  }
});

interface Harness {
  port: number;
  service: AlarmCorrelationService;
  coordinator: AlarmCorrelationCoordinator;
  bridge: CachedEventBridge;
}

async function startHarness(): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'alarm-ws-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));

  const store = new DrizzleCorrelationStore({
    sqlitePath: path.join(dir, 'correlation.sqlite'),
  });
  const coordinator = new AlarmCorrelationCoordinator({
    store,
    instanceId: 'replica-ws',
    pollIntervalMs: 60_000,
    pruneIntervalMs: 60 * 60_000,
  });
  await coordinator.start();
  cleanups.push(() => coordinator.stop());

  const service = new AlarmCorrelationService();
  service.attachCoordinator(coordinator);

  const server = createServer();
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
  tagStreamServer.initialize(server, '/ws/tags');
  unifiedStreamServer.initialize(server, '/ws');
  cleanups.push(async () => {
    tagStreamServer.destroy();
    unifiedStreamServer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const bridge = new CachedEventBridge(service, tagStreamServer, unifiedStreamServer);
  bridge.initializeLocalAlarmFanout();
  cleanups.push(() => bridge.destroy());

  return { port, service, coordinator, bridge };
}

/** A connected client that records every frame it receives, in order. */
interface Client {
  socket: WebSocket;
  frames: Record<string, unknown>[];
  waitFor(predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  countOf(kind: string): number;
  send(message: Record<string, unknown>): void;
}

async function connect(port: number, route: '/ws' | '/ws/tags'): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${route}`);
  const frames: Record<string, unknown>[] = [];
  const waiters: Array<{
    predicate: (frame: Record<string, unknown>) => boolean;
    resolve: (frame: Record<string, unknown>) => void;
  }> = [];

  socket.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(frame)) waiters.splice(i, 1)[0].resolve(frame);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  cleanups.push(async () => {
    socket.close();
  });

  return {
    socket,
    frames,
    waitFor(predicate) {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
    /** `event` on /ws/tags, `type` on /ws. */
    countOf(kind) {
      return frames.filter((frame) => frame.event === kind || frame.type === kind).length;
    },
    send(message) {
      socket.send(JSON.stringify(message));
    },
  };
}

/** Give the socket a beat to deliver anything it was going to deliver. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60));
}

function snapshotAlarms(frame: Record<string, unknown>): Record<string, unknown>[] {
  const payload = frame.payload as { alarms?: Record<string, unknown>[] };
  return payload.alarms ?? [];
}

/** The payload a real Redis subscriber would hand `handleIncoming`. */
function deliverOwnEcho(bridge: CachedEventBridge, alarm: Record<string, unknown>): void {
  const internals = bridge as unknown as {
    handleIncoming(channel: string, data: unknown): void;
    instanceId: string;
  };
  internals.handleIncoming('0xscada:ws:alarms', {
    ...alarm,
    // Deliberately NOT this instance's id: the origin tag alone would drop it,
    // and the point is to prove the sequence guard drops it too.
    _bridgeOrigin: 'some-other-replica',
  });
}

async function seedAlarms(harness: Harness): Promise<void> {
  await harness.bridge.publishAlarm({
    id: 'alpha',
    tagId: 'PUMP-1.TRIP',
    severity: 'high',
    state: 'active',
    timestamp: 1_000,
  });
  await harness.bridge.publishAlarm({
    id: 'beta',
    tagId: 'PUMP-1.TRIP',
    severity: 'low',
    state: 'active',
    timestamp: 1_100,
  });
  await harness.bridge.publishAlarm({
    id: 'gamma',
    tagId: 'TANK-2.LEVEL',
    severity: 'medium',
    state: 'active',
    timestamp: 3_000,
  });
  // Cleared alarms are not something a reconnecting operator still has to act
  // on, so they must not be replayed.
  await harness.service.clear('gamma', 'operator-a');
}

describe('/ws/tags reconnect snapshot', () => {
  it('delivers one canonical snapshot per active alarm on connect', async () => {
    const harness = await startHarness();
    await seedAlarms(harness);

    const client = await connect(harness.port, '/ws/tags');
    const frame = await client.waitFor((f) => f.event === 'alarm:snapshot');
    const alarms = snapshotAlarms(frame);

    const ids = alarms.map((alarm) => alarm.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['alpha', 'beta']);
    for (const alarm of alarms) {
      const correlation = alarm.correlation as { coordinationMode: string; seq: number };
      expect(correlation.coordinationMode).toBe('durable');
      expect(typeof correlation.seq).toBe('number');
    }
    // Exactly one snapshot frame — a reconnecting client is not sent the same
    // catch-up twice.
    await settle();
    expect(client.countOf('alarm:snapshot')).toBe(1);
  });

  it('receives no duplicate echo of the state the snapshot already carried', async () => {
    const harness = await startHarness();
    await seedAlarms(harness);

    const client = await connect(harness.port, '/ws/tags');
    const frame = await client.waitFor((f) => f.event === 'alarm:snapshot');
    const alarms = snapshotAlarms(frame);
    await settle();
    const updatesAfterSnapshot = client.countOf('alarm:update');

    // Another instance re-broadcasts exactly the states the snapshot carried.
    for (const alarm of alarms) deliverOwnEcho(harness.bridge, alarm);
    await settle();
    expect(client.countOf('alarm:update')).toBe(updatesAfterSnapshot);

    // A genuinely newer state still arrives, exactly once.
    await harness.service.acknowledge('beta', 'operator-a');
    const update = await client.waitFor(
      (f) => f.event === 'alarm:update'
        && (f.payload as { id: string }).id === 'beta'
        && (f.payload as { state: string }).state === 'acknowledged',
    );
    expect(update).toBeDefined();
    await settle();
    const acks = client.frames.filter(
      (f) => f.event === 'alarm:update'
        && (f.payload as { id: string }).id === 'beta'
        && (f.payload as { state: string }).state === 'acknowledged',
    );
    expect(acks).toHaveLength(1);
  });

  it('re-serves the snapshot on request without duplicating live delivery', async () => {
    const harness = await startHarness();
    await seedAlarms(harness);
    const client = await connect(harness.port, '/ws/tags');
    await client.waitFor((f) => f.event === 'alarm:snapshot');

    client.send({ type: 'alarm:snapshot' });
    await settle();
    expect(client.countOf('alarm:snapshot')).toBe(2);
    const latest = client.frames.filter((f) => f.event === 'alarm:snapshot').at(-1)!;
    expect(snapshotAlarms(latest).map((alarm) => alarm.id)).toEqual(['alpha', 'beta']);
  });
});

describe('/ws reconnect snapshot', () => {
  it('delivers one canonical snapshot per active alarm on subscribe:alarms', async () => {
    const harness = await startHarness();
    await seedAlarms(harness);

    const client = await connect(harness.port, '/ws');
    await client.waitFor((f) => f.type === 'connected');
    client.send({ type: 'subscribe:alarms' });

    const frame = await client.waitFor((f) => f.type === 'alarm:snapshot');
    const alarms = snapshotAlarms(frame);
    const ids = alarms.map((alarm) => alarm.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['alpha', 'beta']);

    await settle();
    expect(client.countOf('alarm:snapshot')).toBe(1);
    // The catch-up did not also arrive as a burst of live updates.
    expect(client.countOf('alarm:update')).toBe(0);
  });

  it('receives no duplicate echo, then the next genuine state exactly once', async () => {
    const harness = await startHarness();
    await seedAlarms(harness);

    const client = await connect(harness.port, '/ws');
    await client.waitFor((f) => f.type === 'connected');
    client.send({ type: 'subscribe:alarms' });
    const frame = await client.waitFor((f) => f.type === 'alarm:snapshot');
    const alarms = snapshotAlarms(frame);
    await settle();

    for (const alarm of alarms) deliverOwnEcho(harness.bridge, alarm);
    await settle();
    expect(client.countOf('alarm:update')).toBe(0);

    await harness.service.acknowledge('alpha', 'operator-a');
    await client.waitFor(
      (f) => f.type === 'alarm:update'
        && (f.payload as { id: string }).id === 'alpha'
        && (f.payload as { state: string }).state === 'acknowledged',
    );
    await settle();
    const acks = client.frames.filter(
      (f) => f.type === 'alarm:update'
        && (f.payload as { id: string }).id === 'alpha'
        && (f.payload as { state: string }).state === 'acknowledged',
    );
    expect(acks).toHaveLength(1);
  });

  it('serves both surfaces the same canonical state', async () => {
    const harness = await startHarness();
    await seedAlarms(harness);

    const tags = await connect(harness.port, '/ws/tags');
    const unified = await connect(harness.port, '/ws');
    await unified.waitFor((f) => f.type === 'connected');
    unified.send({ type: 'subscribe:alarms' });

    const fromTags = snapshotAlarms(await tags.waitFor((f) => f.event === 'alarm:snapshot'));
    const fromUnified = snapshotAlarms(
      await unified.waitFor((f) => f.type === 'alarm:snapshot'),
    );
    expect(fromUnified).toEqual(fromTags);
  });
});
