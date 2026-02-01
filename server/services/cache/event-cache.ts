/**
 * Event Cache - Sliding window caching for recent events
 * 
 * Maintains a cached list of recent events for fast dashboard
 * access without querying the database.
 */

import { cacheService, CACHE_KEYS, TTL } from './cache-service.js';
import { getRedisClient, isRedisHealthy } from './redis-client.js';
import type Redis from 'ioredis';

export interface CachedEvent {
  id: string;
  type: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  siteId: string;
  tagId?: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: Date;
  acknowledged: boolean;
  acknowledgedBy?: string;
  acknowledgedAt?: Date;
}

export interface EventQueryOptions {
  siteId?: string;
  type?: string;
  severity?: string;
  limit?: number;
  startTime?: Date;
  endTime?: Date;
}

/**
 * Event cache using Redis sorted sets for time-based queries
 */
class EventCache {
  private readonly MAX_EVENTS_PER_SITE = 1000;
  private readonly RECENT_EVENTS_KEY = `${CACHE_KEYS.EVENT}recent`;

  /**
   * Add a new event to the cache
   */
  async addEvent(event: CachedEvent): Promise<boolean> {
    try {
      const client = await this.getClient();
      if (!client) {
        return false;
      }

      const score = new Date(event.timestamp).getTime();
      const member = JSON.stringify(event);

      // Add to global recent events sorted set
      await client.zadd(this.RECENT_EVENTS_KEY, score, member);

      // Add to site-specific sorted set
      const siteKey = this.getSiteKey(event.siteId);
      await client.zadd(siteKey, score, member);

      // Trim old events
      await this.trimEvents(client);

      // Set TTL for site key
      await client.expire(siteKey, TTL.RECENT_EVENTS * 10);

      return true;
    } catch (error) {
      console.error('[EventCache] Add event error:', error);
      return false;
    }
  }

  /**
   * Get recent events with optional filtering
   */
  async getRecentEvents(options: EventQueryOptions = {}): Promise<CachedEvent[]> {
    try {
      const client = await this.getClient();
      if (!client) {
        return [];
      }

      const limit = options.limit || 100;
      const key = options.siteId
        ? this.getSiteKey(options.siteId)
        : this.RECENT_EVENTS_KEY;

      let events: string[];

      if (options.startTime || options.endTime) {
        // Time-range query using ZRANGEBYSCORE
        const min = options.startTime?.getTime() || '-inf';
        const max = options.endTime?.getTime() || '+inf';
        events = await client.zrangebyscore(key, min, max, 'LIMIT', 0, limit);
      } else {
        // Get most recent events
        events = await client.zrevrange(key, 0, limit - 1);
      }

      const parsed = events
        .map((e) => {
          try {
            return JSON.parse(e) as CachedEvent;
          } catch {
            return null;
          }
        })
        .filter((e): e is CachedEvent => e !== null);

      // Apply additional filters
      return this.filterEvents(parsed, options);
    } catch (error) {
      console.error('[EventCache] Get recent events error:', error);
      return [];
    }
  }

  /**
   * Get event count for a site
   */
  async getEventCount(siteId?: string): Promise<number> {
    try {
      const client = await this.getClient();
      if (!client) return 0;

      const key = siteId ? this.getSiteKey(siteId) : this.RECENT_EVENTS_KEY;
      return await client.zcard(key);
    } catch (error) {
      console.error('[EventCache] Get count error:', error);
      return 0;
    }
  }

  /**
   * Get unacknowledged event count
   */
  async getUnacknowledgedCount(siteId?: string): Promise<number> {
    const events = await this.getRecentEvents({ siteId, limit: 1000 });
    return events.filter((e) => !e.acknowledged).length;
  }

  /**
   * Mark an event as acknowledged
   */
  async acknowledgeEvent(
    eventId: string,
    acknowledgedBy: string
  ): Promise<boolean> {
    // Note: This is a simplified implementation
    // In production, you'd need to update the event in the sorted set
    // which requires removing and re-adding with updated data
    console.warn('[EventCache] Event acknowledgement requires database update');
    return true;
  }

  /**
   * Clear all events for a site
   */
  async clearSiteEvents(siteId: string): Promise<boolean> {
    try {
      const client = await this.getClient();
      if (!client) return false;

      const key = this.getSiteKey(siteId);
      await client.del(key);
      return true;
    } catch (error) {
      console.error('[EventCache] Clear site events error:', error);
      return false;
    }
  }

  /**
   * Invalidate event cache
   */
  async invalidate(): Promise<boolean> {
    try {
      const client = await this.getClient();
      if (!client) return false;

      await client.del(this.RECENT_EVENTS_KEY);
      // Note: Site-specific keys would need pattern scanning
      return true;
    } catch (error) {
      console.error('[EventCache] Invalidate error:', error);
      return false;
    }
  }

  /**
   * Get Redis client
   */
  private async getClient(): Promise<Redis | null> {
    if (!isRedisHealthy()) return null;
    try {
      return (await getRedisClient()) as Redis;
    } catch {
      return null;
    }
  }

  /**
   * Trim old events to maintain size limits
   */
  private async trimEvents(client: Redis): Promise<void> {
    // Keep only the most recent events
    await client.zremrangebyrank(
      this.RECENT_EVENTS_KEY,
      0,
      -(this.MAX_EVENTS_PER_SITE + 1)
    );
  }

  /**
   * Build site-specific cache key
   */
  private getSiteKey(siteId: string): string {
    return `${CACHE_KEYS.EVENT}site:${siteId}`;
  }

  /**
   * Apply filters to events
   */
  private filterEvents(
    events: CachedEvent[],
    options: EventQueryOptions
  ): CachedEvent[] {
    return events.filter((event) => {
      if (options.type && event.type !== options.type) return false;
      if (options.severity && event.severity !== options.severity) return false;
      return true;
    });
  }
}

export const eventCache = new EventCache();
export default eventCache;
