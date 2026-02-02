/**
 * Cache Service Tests
 * 
 * Tests caching functionality with mocked Redis client
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CacheService, TTL } from '../cache-service.js';
import { cacheMetrics } from '../cache-metrics.js';

// Mock Redis client
vi.mock('../redis-client.js', () => ({
  getRedisClient: vi.fn(),
  isRedisHealthy: vi.fn(() => false), // Default to unhealthy to use fallback
}));

describe('CacheService', () => {
  let cache: CacheService;

  beforeEach(() => {
    cache = new CacheService();
    cacheMetrics.reset();
  });

  afterEach(async () => {
    await cache.shutdown();
  });

  describe('get/set operations', () => {
    it('should store and retrieve values from fallback cache', async () => {
      const key = 'test:key';
      const value = { foo: 'bar', num: 123 };

      await cache.set(key, value, { ttl: 60 });
      const result = await cache.get(key);

      expect(result).toEqual(value);
    });

    it('should return null for missing keys', async () => {
      const result = await cache.get('nonexistent:key');
      expect(result).toBeNull();
    });

    it('should expire values after TTL', async () => {
      vi.useFakeTimers();

      const key = 'test:expiring';
      const value = { data: 'test' };

      await cache.set(key, value, { ttl: 1 }); // 1 second TTL

      // Value should exist immediately
      let result = await cache.get(key);
      expect(result).toEqual(value);

      // Advance time past TTL
      vi.advanceTimersByTime(2000);

      // Value should be expired
      result = await cache.get(key);
      expect(result).toBeNull();

      vi.useRealTimers();
    });
  });

  describe('getOrSet (cache-aside pattern)', () => {
    it('should return cached value without calling loader', async () => {
      const key = 'test:cached';
      const cachedValue = { cached: true };
      const loaderValue = { loaded: true };

      // Pre-populate cache
      await cache.set(key, cachedValue);

      const loader = vi.fn().mockResolvedValue(loaderValue);
      const result = await cache.getOrSet(key, loader);

      expect(result).toEqual(cachedValue);
      expect(loader).not.toHaveBeenCalled();
    });

    it('should call loader on cache miss', async () => {
      const key = 'test:miss';
      const loaderValue = { loaded: true };

      const loader = vi.fn().mockResolvedValue(loaderValue);
      const result = await cache.getOrSet(key, loader);

      expect(result).toEqual(loaderValue);
      expect(loader).toHaveBeenCalledOnce();
    });

    it('should cache loader result', async () => {
      const key = 'test:load-and-cache';
      const loaderValue = { data: 'from-loader' };

      const loader = vi.fn().mockResolvedValue(loaderValue);

      // First call - should hit loader
      await cache.getOrSet(key, loader);
      expect(loader).toHaveBeenCalledOnce();

      // Second call - should use cache
      const result = await cache.getOrSet(key, loader);
      expect(result).toEqual(loaderValue);
      expect(loader).toHaveBeenCalledOnce(); // Still only one call
    });

    it('should force refresh when specified', async () => {
      const key = 'test:force-refresh';
      const cachedValue = { old: true };
      const newValue = { new: true };

      await cache.set(key, cachedValue);

      const loader = vi.fn().mockResolvedValue(newValue);
      const result = await cache.getOrSet(key, loader, { forceRefresh: true });

      expect(result).toEqual(newValue);
      expect(loader).toHaveBeenCalledOnce();
    });
  });

  describe('writeThrough pattern', () => {
    it('should persist and cache value', async () => {
      const key = 'test:write-through';
      const value = { important: 'data' };

      const persister = vi.fn().mockResolvedValue(undefined);

      await cache.writeThrough(key, value, persister);

      expect(persister).toHaveBeenCalledWith(value);

      const cached = await cache.get(key);
      expect(cached).toEqual(value);
    });

    it('should invalidate cache on persistence failure', async () => {
      const key = 'test:write-through-fail';
      const value = { will: 'fail' };

      // Pre-populate cache with old value
      await cache.set(key, { old: 'value' });

      const persister = vi.fn().mockRejectedValue(new Error('DB error'));

      await expect(
        cache.writeThrough(key, value, persister)
      ).rejects.toThrow('DB error');

      // Cache should be invalidated
      const cached = await cache.get(key);
      expect(cached).toBeNull();
    });
  });

  describe('delete operations', () => {
    it('should delete existing key', async () => {
      const key = 'test:delete';
      await cache.set(key, { data: 'test' });

      const deleted = await cache.delete(key);
      expect(deleted).toBe(true);

      const result = await cache.get(key);
      expect(result).toBeNull();
    });

    it('should handle deleting non-existent key', async () => {
      const deleted = await cache.delete('nonexistent');
      expect(deleted).toBe(true);
    });
  });

  describe('multi-get operations', () => {
    it('should retrieve multiple values', async () => {
      await cache.set('key1', { id: 1 });
      await cache.set('key2', { id: 2 });
      await cache.set('key3', { id: 3 });

      const results = await cache.mget(['key1', 'key2', 'key3', 'key4']);

      expect(results.get('key1')).toEqual({ id: 1 });
      expect(results.get('key2')).toEqual({ id: 2 });
      expect(results.get('key3')).toEqual({ id: 3 });
      expect(results.get('key4')).toBeNull();
    });
  });

  describe('metrics tracking', () => {
    it('should track cache hits', async () => {
      const key = 'test:hit-tracking';
      await cache.set(key, { data: 'test' });

      await cache.get(key);
      await cache.get(key);

      const stats = cache.getStats();
      expect(stats.hitRate).toBeGreaterThan(0);
    });

    it('should track cache misses', async () => {
      await cache.get('nonexistent1');
      await cache.get('nonexistent2');

      const stats = cache.getStats();
      expect(stats.missRate).toBeGreaterThan(0);
    });
  });

  describe('TTL constants', () => {
    it('should have appropriate TTL values', () => {
      expect(TTL.TAG_VALUES).toBeLessThan(60); // Very short for real-time data
      expect(TTL.SITE_CONFIG).toBeGreaterThan(300); // Longer for config
      expect(TTL.USER_SESSION).toBeLessThanOrEqual(3600); // Reasonable session length
      expect(TTL.TX_RECEIPTS).toBe(86400); // 24 hours for blockchain data
    });
  });
});

describe('CacheMetrics', () => {
  beforeEach(() => {
    cacheMetrics.reset();
  });

  it('should calculate hit rate correctly', () => {
    cacheMetrics.recordHit('key1', 10);
    cacheMetrics.recordHit('key2', 15);
    cacheMetrics.recordMiss('key3');

    const snapshot = cacheMetrics.getSnapshot();
    expect(snapshot.hits).toBe(2);
    expect(snapshot.misses).toBe(1);
    expect(snapshot.hitRate).toBeCloseTo(0.667, 2);
  });

  it('should track latency percentiles', () => {
    // Add various latencies
    for (let i = 0; i < 100; i++) {
      cacheMetrics.recordLatency(`key${i}`, i);
    }

    const snapshot = cacheMetrics.getSnapshot();
    expect(snapshot.p50Latency).toBeLessThanOrEqual(50);
    expect(snapshot.p95Latency).toBeLessThanOrEqual(95);
    expect(snapshot.p99Latency).toBeLessThanOrEqual(99);
  });

  it('should generate Prometheus metrics', () => {
    cacheMetrics.recordHit('key1', 5);
    cacheMetrics.recordMiss('key2');
    cacheMetrics.recordError('key3');

    const metrics = cacheMetrics.toPrometheusMetrics();

    expect(metrics).toContain('cache_hits_total');
    expect(metrics).toContain('cache_misses_total');
    expect(metrics).toContain('cache_errors_total');
    expect(metrics).toContain('cache_hit_ratio');
    expect(metrics).toContain('cache_operation_duration_ms_bucket');
  });
});
