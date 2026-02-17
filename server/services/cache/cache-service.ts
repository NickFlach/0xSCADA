/**
 * Cache Service - Core caching functionality
 * 
 * Implements various caching patterns:
 * - Cache-aside (lazy loading)
 * - Write-through (synchronous write to cache and DB)
 * - Write-behind (async batch writes)
 * - Read-through (automatic loading on miss)
 */

import { getRedisClient, isRedisHealthy } from './redis-client.js';
import { cacheMetrics } from './cache-metrics.js';
import type Redis from 'ioredis';

export interface CacheOptions {
  /** Time-to-live in seconds */
  ttl?: number;
  /** Skip cache read and force refresh */
  forceRefresh?: boolean;
  /** Tags for bulk invalidation */
  tags?: string[];
}

export interface CacheEntry<T> {
  value: T;
  cachedAt: number;
  expiresAt: number;
  tags?: string[];
}

// Default TTLs for different data types (in seconds)
export const TTL = {
  TAG_VALUES: 5,           // Live process data - very short TTL
  SITE_CONFIG: 3600,       // Site configuration - 1 hour
  USER_SESSION: 1800,      // User sessions - 30 minutes
  RECENT_EVENTS: 30,       // Recent events sliding window
  TX_RECEIPTS: 86400,      // Blockchain tx receipts - 24 hours
  DEFAULT: 300,            // Default TTL - 5 minutes
} as const;

// Cache key prefixes for namespacing
export const CACHE_KEYS = {
  TAG: 'tag:',
  SITE: 'site:',
  USER: 'user:',
  SESSION: 'session:',
  EVENT: 'event:',
  TX: 'tx:',
  CONFIG: 'config:',
} as const;

/**
 * Generic cache service with multiple caching strategies
 */
export class CacheService {
  private client: Redis | null = null;
  private fallbackCache: Map<string, CacheEntry<unknown>> = new Map();
  private writeBuffer: Map<string, { value: unknown; ttl: number }> = new Map();
  private flushInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start write-behind flush interval
    this.startWriteBehindFlush();
  }

  /**
   * Get Redis client with fallback handling
   */
  private async getClient(): Promise<Redis | null> {
    if (!isRedisHealthy()) {
      console.warn('[Cache] Redis unhealthy, using in-memory fallback');
      return null;
    }

    try {
      this.client = await getRedisClient() as Redis;
      return this.client;
    } catch (error) {
      console.warn('[Cache] Failed to get Redis client:', error);
      return null;
    }
  }

  /**
   * Cache-aside pattern: Get from cache or load from source
   */
  async getOrSet<T>(
    key: string,
    loader: () => Promise<T>,
    options: CacheOptions = {}
  ): Promise<T> {
    const startTime = Date.now();
    const ttl = options.ttl ?? TTL.DEFAULT;

    // Check cache first (unless force refresh)
    if (!options.forceRefresh) {
      const cached = await this.get<T>(key);
      if (cached !== null) {
        cacheMetrics.recordHit(key, Date.now() - startTime);
        return cached;
      }
    }

    // Load from source
    cacheMetrics.recordMiss(key);
    const value = await loader();

    // Store in cache
    await this.set(key, value, { ...options, ttl });
    cacheMetrics.recordLatency(key, Date.now() - startTime);

    return value;
  }

  /**
   * Get value from cache
   */
  async get<T>(key: string): Promise<T | null> {
    const startTime = Date.now();
    
    try {
      const client = await this.getClient();

      if (client) {
        const data = await client.get(key);
        if (data) {
          const entry = JSON.parse(data) as CacheEntry<T>;
          cacheMetrics.recordHit(key, Date.now() - startTime);
          return entry.value;
        }
      } else {
        // Fallback to in-memory cache
        const entry = this.fallbackCache.get(key) as CacheEntry<T> | undefined;
        if (entry && entry.expiresAt > Date.now()) {
          cacheMetrics.recordHit(key, Date.now() - startTime);
          return entry.value;
        }
        this.fallbackCache.delete(key);
      }

      cacheMetrics.recordMiss(key);
      return null;
    } catch (error) {
      console.error('[Cache] Get error:', error);
      cacheMetrics.recordError(key);
      return null;
    }
  }

  /**
   * Set value in cache
   */
  async set<T>(
    key: string,
    value: T,
    options: CacheOptions = {}
  ): Promise<boolean> {
    const ttl = options.ttl ?? TTL.DEFAULT;
    const now = Date.now();

    const entry: CacheEntry<T> = {
      value,
      cachedAt: now,
      expiresAt: now + ttl * 1000,
      tags: options.tags,
    };

    try {
      const client = await this.getClient();

      if (client) {
        await client.setex(key, ttl, JSON.stringify(entry));

        // Store tags for bulk invalidation
        if (options.tags?.length) {
          await this.addToTags(client, key, options.tags, ttl);
        }
      } else {
        // Fallback to in-memory cache
        this.fallbackCache.set(key, entry);
      }

      return true;
    } catch (error) {
      console.error('[Cache] Set error:', error);
      cacheMetrics.recordError(key);
      return false;
    }
  }

  /**
   * Write-through: Synchronously write to cache and execute callback
   */
  async writeThrough<T>(
    key: string,
    value: T,
    persister: (value: T) => Promise<void>,
    options: CacheOptions = {}
  ): Promise<boolean> {
    try {
      // Write to persistent storage first
      await persister(value);

      // Then update cache
      await this.set(key, value, options);

      return true;
    } catch (error) {
      console.error('[Cache] Write-through error:', error);
      // Invalidate cache on failure
      await this.delete(key);
      throw error;
    }
  }

  /**
   * Write-behind: Buffer writes for batch processing
   */
  async writeBehind<T>(
    key: string,
    value: T,
    options: CacheOptions = {}
  ): Promise<void> {
    const ttl = options.ttl ?? TTL.DEFAULT;

    // Update cache immediately
    await this.set(key, value, options);

    // Add to write buffer for batch persistence
    this.writeBuffer.set(key, { value, ttl });
  }

  /**
   * Delete from cache
   */
  async delete(key: string): Promise<boolean> {
    try {
      const client = await this.getClient();

      if (client) {
        await client.del(key);
      }

      this.fallbackCache.delete(key);
      return true;
    } catch (error) {
      console.error('[Cache] Delete error:', error);
      return false;
    }
  }

  /**
   * Delete multiple keys matching a pattern
   */
  async deletePattern(pattern: string): Promise<number> {
    try {
      const client = await this.getClient();
      if (!client) return 0;

      const keys = await client.keys(pattern);
      if (keys.length === 0) return 0;

      const deleted = await client.del(...keys);
      return deleted;
    } catch (error) {
      console.error('[Cache] Delete pattern error:', error);
      return 0;
    }
  }

  /**
   * Invalidate all keys with a specific tag
   */
  async invalidateByTag(tag: string): Promise<number> {
    try {
      const client = await this.getClient();
      if (!client) return 0;

      const tagKey = `tag:${tag}`;
      const keys = await client.smembers(tagKey);

      if (keys.length === 0) return 0;

      const pipeline = client.pipeline();
      keys.forEach((key) => pipeline.del(key));
      pipeline.del(tagKey);
      await pipeline.exec();

      return keys.length;
    } catch (error) {
      console.error('[Cache] Tag invalidation error:', error);
      return 0;
    }
  }

  /**
   * Get multiple values at once
   */
  async mget<T>(keys: string[]): Promise<Map<string, T | null>> {
    const result = new Map<string, T | null>();

    try {
      const client = await this.getClient();

      if (client) {
        const values = await client.mget(...keys);
        keys.forEach((key, index) => {
          const data = values[index];
          if (data) {
            const entry = JSON.parse(data) as CacheEntry<T>;
            result.set(key, entry.value);
            cacheMetrics.recordHit(key, 0);
          } else {
            result.set(key, null);
            cacheMetrics.recordMiss(key);
          }
        });
      } else {
        keys.forEach((key) => {
          const entry = this.fallbackCache.get(key) as CacheEntry<T> | undefined;
          result.set(key, entry?.value ?? null);
        });
      }
    } catch (error) {
      console.error('[Cache] Multi-get error:', error);
      keys.forEach((key) => result.set(key, null));
    }

    return result;
  }

  /**
   * Add key to tag sets for bulk invalidation
   */
  private async addToTags(
    client: Redis,
    key: string,
    tags: string[],
    ttl: number
  ): Promise<void> {
    const pipeline = client.pipeline();

    tags.forEach((tag) => {
      const tagKey = `tag:${tag}`;
      pipeline.sadd(tagKey, key);
      pipeline.expire(tagKey, ttl + 3600); // Tag set expires 1 hour after entries
    });

    await pipeline.exec();
  }

  /**
   * Start periodic flush of write-behind buffer
   */
  private startWriteBehindFlush(): void {
    this.flushInterval = setInterval(() => {
      this.flushWriteBuffer();
    }, 5000); // Flush every 5 seconds
  }

  /**
   * Flush write-behind buffer
   */
  private async flushWriteBuffer(): Promise<void> {
    if (this.writeBuffer.size === 0) return;

    const entries = new Map(this.writeBuffer);
    this.writeBuffer.clear();

    // Emit event for external handlers to process
    console.log(`[Cache] Flushing ${entries.size} buffered writes`);
    // In production, this would be handled by an event emitter
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    hitRate: number;
    missRate: number;
    errorRate: number;
    avgLatency: number;
  } {
    return cacheMetrics.getStats();
  }

  /**
   * Cleanup resources
   */
  async shutdown(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    await this.flushWriteBuffer();
    this.fallbackCache.clear();
  }
}

// Export singleton instance
export const cacheService = new CacheService();

export default cacheService;
