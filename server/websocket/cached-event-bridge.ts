/**
 * Cached Event Bridge — Redis pub/sub for WebSocket event fan-out
 *
 * Uses Redis pub/sub for cross-instance event distribution and caches
 * recent events so new subscribers can catch up on connect.
 *
 * Closes #258
 */

import { getRedisClient, isRedisHealthy } from '../services/cache/redis-client.js';
import { eventCache, type CachedEvent } from '../services/cache/event-cache.js';
import { unifiedStreamServer } from './unified-stream.js';
import { tagStreamServer, type TagUpdate } from './tag-stream.js';
import {
  alarmCorrelationService,
  type AlarmCorrelationService,
} from '../services/alarm-correlation';
import type { AlarmWireSnapshot } from '@shared/types/alarm-correlation';
import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

const CHANNEL_EVENTS = '0xscada:ws:events';
const CHANNEL_TAGS = '0xscada:ws:tags';
const CHANNEL_ALARMS = '0xscada:ws:alarms';
const RECENT_TAG_CACHE_KEY = '0xscada:ws:recent-tags';
const MAX_CACHED_TAG_VALUES = 5000;
const TAG_CACHE_TTL = 60; // seconds

type CorrelationSource = Pick<
  AlarmCorrelationService,
  'on' | 'off' | 'ingest' | 'submit' | 'getReconnectSnapshot'
>;

/**
 * How many alarm ids keep a "latest delivered seq" for cross-instance
 * de-duplication. Oldest entries are evicted first; an evicted id simply loses
 * the shortcut and is delivered again, which is the safe direction.
 */
const MAX_DEDUPE_TRACKED_ALARMS = 20_000;

interface AlarmSink {
  broadcastAlarm(alarm: any): void;
  /**
   * Optional so a test double can be a bare sink. Real WebSocket servers
   * implement it and receive the reconnect snapshot source.
   */
  setAlarmSnapshotProvider?(
    provider: (() => Record<string, unknown>[]) | null,
  ): void;
}

/**
 * Cached Event Bridge wires Redis pub/sub into the WebSocket layer:
 *
 * 1. **Publish** — when this instance produces an event/tag/alarm, it
 *    publishes to a Redis channel so all server instances receive it.
 * 2. **Subscribe** — listens on the same channels and broadcasts to
 *    local WebSocket clients.
 * 3. **Catch-up** — caches recent events in Redis sorted sets so new
 *    subscribers receive a backlog on connect.
 */
export class CachedEventBridge {
  private publisher: Redis | null = null;
  private subscriber: Redis | null = null;
  private isInitialized = false;
  private isLocalAlarmFanoutInitialized = false;
  private readonly instanceId = randomUUID();
  /**
   * alarmId → highest correlation seq this replica has itself delivered.
   *
   * With durable coordination every snapshot carries the journal seq of the
   * state it describes, and that seq is the same on every replica — so an
   * alarm that arrives again over Redis (this instance's own echo, or another
   * instance re-broadcasting the same applied entry) is recognised as
   * already-delivered and dropped.
   *
   * Only locally computed state raises this watermark; see `handleIncoming`.
   * Snapshots with no seq (process-local mode) are never dropped, because
   * without a shared order there is no way to prove the copy is redundant, and
   * delivering an alarm twice is a nuisance while dropping one is a safety
   * failure.
   */
  private readonly deliveredSeqByAlarm = new Map<string, number>();
  private readonly alarmSnapshotHandler = (snapshot: AlarmWireSnapshot): void => {
    this.broadcastAlarmSnapshot(snapshot);
  };

  constructor(
    private readonly correlationService: CorrelationSource = alarmCorrelationService,
    private readonly tagAlarmSink: AlarmSink = tagStreamServer,
    private readonly unifiedAlarmSink: AlarmSink = unifiedStreamServer,
  ) {}

  /**
   * Wire process-local correlation snapshots to both WebSocket servers.
   * This is independent of Redis health and safe to call repeatedly.
   */
  initializeLocalAlarmFanout(): void {
    if (this.isLocalAlarmFanoutInitialized) return;
    this.correlationService.on('alarm-snapshot', this.alarmSnapshotHandler);
    const provider = () =>
      this.getAlarmReconnectSnapshot() as unknown as Record<string, unknown>[];
    this.tagAlarmSink.setAlarmSnapshotProvider?.(provider);
    this.unifiedAlarmSink.setAlarmSnapshotProvider?.(provider);
    this.isLocalAlarmFanoutInitialized = true;
  }

  /**
   * Initialize pub/sub connections and start listening.
   * Safe to call multiple times — only initializes once.
   */
  async initialize(): Promise<void> {
    this.initializeLocalAlarmFanout();
    if (this.isInitialized || !isRedisHealthy()) return;

    try {
      const client = await getRedisClient() as Redis;

      // Publisher uses the shared client
      this.publisher = client;

      // Subscriber needs a dedicated connection (ioredis requirement)
      this.subscriber = client.duplicate();
      await this.subscriber.subscribe(CHANNEL_EVENTS, CHANNEL_TAGS, CHANNEL_ALARMS);

      this.subscriber.on('message', (channel: string, message: string) => {
        try {
          const data = JSON.parse(message);
          this.handleIncoming(channel, data);
        } catch {
          // Ignore malformed messages
        }
      });

      this.isInitialized = true;
      console.log('[CachedEventBridge] Redis pub/sub initialized');
    } catch (err) {
      console.warn('[CachedEventBridge] Failed to initialize Redis pub/sub:', err);
    }
  }

  /**
   * Publish a tag update — fans out to all instances via Redis.
   * Also caches the latest value in a Redis hash for catch-up.
   */
  async publishTagUpdate(update: TagUpdate): Promise<void> {
    // Always broadcast locally
    tagStreamServer.broadcastTagUpdate(update);
    unifiedStreamServer.broadcastTagUpdate(update);

    if (!this.publisher) return;

    try {
      // Publish for cross-instance fan-out
      await this.publisher.publish(CHANNEL_TAGS, JSON.stringify(update));

      // Cache latest value in a hash for catch-up
      await this.publisher.hset(RECENT_TAG_CACHE_KEY, update.tagName, JSON.stringify(update));
      await this.publisher.expire(RECENT_TAG_CACHE_KEY, TAG_CACHE_TTL);
    } catch {
      // Redis failure shouldn't break local broadcasting
    }
  }

  /**
   * Publish a domain event — fans out and caches for catch-up.
   */
  async publishEvent(event: Record<string, unknown>): Promise<void> {
    // Broadcast locally
    unifiedStreamServer.broadcastEvent(event);

    // Cache in Redis event cache for catch-up
    try {
      await eventCache.addEvent({
        id: (event.id as string) || crypto.randomUUID(),
        type: (event.eventType as string) || 'unknown',
        severity: (event.severity as CachedEvent['severity']) || 'info',
        siteId: (event.siteId as string) || '',
        message: (event.message as string) || '',
        data: event.data as Record<string, unknown> | undefined,
        timestamp: event.timestamp ? new Date(event.timestamp as string) : new Date(),
        acknowledged: false,
      });
    } catch {
      // Cache failure is non-fatal
    }

    if (!this.publisher) return;
    try {
      await this.publisher.publish(CHANNEL_EVENTS, JSON.stringify(event));
    } catch {
      // Non-fatal
    }
  }

  /**
   * Publish an alarm — fans out to all instances.
   *
   * Every alarm passes through the correlation engine first (#213); the
   * broadcast payload is enriched with a `correlation` field carrying
   * group membership, root-cause, and suppression info so consumers can
   * de-clutter without any alarm being silently dropped.
   */
  async publishAlarm(alarm: Record<string, unknown>): Promise<void> {
    this.initializeLocalAlarmFanout();
    try {
      // Goes through the shared journal when durable coordination is up, so
      // every replica groups this alarm identically. The service itself falls
      // back to process-local correlation if the journal cannot be written —
      // it never drops the alarm.
      const outcome = await this.correlationService.submit(alarm);
      if (outcome) return;
    } catch {
      // Correlation must never block alarm fan-out
    }

    // Inputs without a normalizable timestamp still retain the bridge's
    // historical best-effort delivery behavior.
    this.broadcastRawAlarm(alarm);
  }

  /**
   * One canonical snapshot per active alarm, for a client that has just
   * (re)connected to `/ws` or `/ws/tags`.
   *
   * Delivering it also arms de-duplication: each alarm's seq is recorded as
   * delivered, so a cross-instance echo of the very state the snapshot just
   * carried is dropped instead of arriving as a duplicate immediately after
   * reconnect. Newer states still get through, because the guard compares
   * seqs rather than merely remembering the id.
   */
  getAlarmReconnectSnapshot(): AlarmWireSnapshot[] {
    const snapshots = this.correlationService.getReconnectSnapshot();
    for (const snapshot of snapshots) {
      this.recordDelivered(snapshot.id, snapshot.correlation.seq);
    }
    return snapshots;
  }

  /**
   * Get cached recent events for new subscriber catch-up.
   */
  async getRecentEvents(limit = 50): Promise<CachedEvent[]> {
    return eventCache.getRecentEvents({ limit });
  }

  /**
   * Get cached latest tag values for new subscriber snapshot.
   */
  async getLatestTagValues(): Promise<Record<string, TagUpdate>> {
    if (!this.publisher) {
      // Fall back to in-memory tag stream values
      return Object.fromEntries(tagStreamServer.getLatestValues());
    }

    try {
      const all = await this.publisher.hgetall(RECENT_TAG_CACHE_KEY);
      const result: Record<string, TagUpdate> = {};
      for (const [key, val] of Object.entries(all)) {
        try { result[key] = JSON.parse(val); } catch { /* skip */ }
      }
      return result;
    } catch {
      return Object.fromEntries(tagStreamServer.getLatestValues());
    }
  }

  /**
   * Graceful shutdown.
   */
  async destroy(): Promise<void> {
    if (this.isLocalAlarmFanoutInitialized) {
      this.correlationService.off('alarm-snapshot', this.alarmSnapshotHandler);
      this.tagAlarmSink.setAlarmSnapshotProvider?.(null);
      this.unifiedAlarmSink.setAlarmSnapshotProvider?.(null);
      this.isLocalAlarmFanoutInitialized = false;
    }
    if (this.subscriber) {
      await this.subscriber.unsubscribe();
      this.subscriber.disconnect();
      this.subscriber = null;
    }
    this.publisher = null;
    this.isInitialized = false;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private handleIncoming(channel: string, data: any): void {
    switch (channel) {
      case CHANNEL_TAGS:
        // Only broadcast to unified (tag-stream already got the local copy)
        unifiedStreamServer.broadcastTagUpdate(data as TagUpdate);
        break;
      case CHANNEL_EVENTS:
        unifiedStreamServer.broadcastEvent(data);
        break;
      case CHANNEL_ALARMS: {
        // Own echo: this instance already delivered it locally before publishing.
        if (data?._bridgeOrigin === this.instanceId) break;
        if (data && typeof data === 'object') delete data._bridgeOrigin;
        // Cross-instance duplicate of a state already delivered here.
        //
        // Deliberately does NOT record the incoming seq. Recording it would let
        // anything able to publish on this channel push an alarm's watermark to
        // an arbitrary value and have later, genuine states for that alarm
        // dropped — a way to HIDE an alarm, which is the one outcome this
        // subsystem must never allow. The watermark is therefore raised only by
        // state this replica computed itself. The cost is that a replica which
        // has not yet consumed the journal entry may deliver a second copy of
        // the same state; a duplicate is a nuisance, a hidden alarm is not.
        if (this.alreadyDelivered(data)) break;
        try {
          this.tagAlarmSink.broadcastAlarm(data);
        } catch {
          // One local sink must not block the other.
        }
        try {
          this.unifiedAlarmSink.broadcastAlarm(data);
        } catch {
          // WebSocket delivery is best effort.
        }
        break;
      }
    }
  }

  private broadcastAlarmSnapshot(snapshot: AlarmWireSnapshot): void {
    // The ONLY place the de-duplication watermark is raised on the broadcast
    // path: this snapshot was computed by this replica's own engine, so its
    // seq is trustworthy. `broadcastRawAlarm` deliberately does not record,
    // because it is also the fallback for an arbitrary producer payload — and
    // a payload carrying an inflated `correlation.seq` would push the
    // watermark forward and have later genuine states for that alarm id
    // dropped, i.e. a way to HIDE an alarm.
    this.recordDelivered(snapshot.id, correlationSeq(snapshot));
    this.broadcastRawAlarm(snapshot);
  }

  private broadcastRawAlarm(
    alarm: Record<string, unknown> | AlarmWireSnapshot,
  ): void {
    try {
      this.tagAlarmSink.broadcastAlarm(alarm as any);
    } catch {
      // One local sink must not block the other.
    }
    try {
      this.unifiedAlarmSink.broadcastAlarm(alarm);
    } catch {
      // Correlation state changes must survive delivery failures.
    }

    if (!this.publisher) return;
    const remotePayload = {
      ...alarm,
      _bridgeOrigin: this.instanceId,
    };
    void this.publisher
      .publish(CHANNEL_ALARMS, JSON.stringify(remotePayload))
      .catch(() => {
        // Redis fan-out is optional and process-local delivery already ran.
      });
  }

  /**
   * True only when this exact alarm state — same id, same shared journal seq or
   * older — has already reached local clients from state this replica computed
   * itself. Anything without a seq is always delivered: an unnecessary
   * duplicate is a nuisance, a dropped alarm is not.
   */
  private alreadyDelivered(alarm: Record<string, unknown> | null | undefined): boolean {
    if (!alarm || typeof alarm.id !== 'string') return false;
    const seq = correlationSeq(alarm);
    if (seq === null) return false;
    const delivered = this.deliveredSeqByAlarm.get(alarm.id);
    return delivered !== undefined && seq <= delivered;
  }

  private recordDelivered(alarmId: string | undefined, seq: number | null): void {
    if (!alarmId || seq === null) return;
    const previous = this.deliveredSeqByAlarm.get(alarmId);
    if (previous !== undefined && previous >= seq) return;
    this.deliveredSeqByAlarm.delete(alarmId);
    this.deliveredSeqByAlarm.set(alarmId, seq);
    while (this.deliveredSeqByAlarm.size > MAX_DEDUPE_TRACKED_ALARMS) {
      const oldest = this.deliveredSeqByAlarm.keys().next();
      if (oldest.done) break;
      this.deliveredSeqByAlarm.delete(oldest.value);
    }
  }
}

/** Shared journal seq carried on a correlated snapshot, when there is one. */
function correlationSeq(alarm: unknown): number | null {
  if (!alarm || typeof alarm !== 'object') return null;
  const correlation = (alarm as { correlation?: unknown }).correlation;
  if (!correlation || typeof correlation !== 'object') return null;
  const seq = (correlation as { seq?: unknown }).seq;
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : null;
}

export const cachedEventBridge = new CachedEventBridge();
export default cachedEventBridge;
