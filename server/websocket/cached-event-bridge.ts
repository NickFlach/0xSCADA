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
  'on' | 'off' | 'ingest'
>;

interface AlarmSink {
  broadcastAlarm(alarm: any): void;
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
      const outcome = this.correlationService.ingest(alarm);
      if (outcome) return;
    } catch {
      // Correlation must never block alarm fan-out
    }

    // Inputs without a normalizable timestamp still retain the bridge's
    // historical best-effort delivery behavior.
    this.broadcastRawAlarm(alarm);
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
      case CHANNEL_ALARMS:
        if (data?._bridgeOrigin === this.instanceId) break;
        if (data && typeof data === 'object') delete data._bridgeOrigin;
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

  private broadcastAlarmSnapshot(snapshot: AlarmWireSnapshot): void {
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
}

export const cachedEventBridge = new CachedEventBridge();
export default cachedEventBridge;
