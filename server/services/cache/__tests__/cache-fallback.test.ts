/**
 * Cache Fallback Tests
 * Tests for in-memory fallback when Redis is unavailable
 */

import { CacheService } from '../cache-service.js';
import { jest } from '@jest/globals';

// Mock Redis client to simulate unavailability
jest.mock('../redis-client.js', () => ({
  getRedisClient: jest.fn().mockResolvedValue(null),
  isRedisHealthy: jest.fn().mockReturnValue(false),
}));

describe('Cache Service - Redis Fallback', () => {
  let cache: CacheService;

  beforeEach(() => {
    cache = new CacheService();
  });

  afterEach(async () => {
    await cache.shutdown();
  });

  describe('Tag-based invalidation with fallback', () => {
    it('should handle tag invalidation in fallback cache', async () => {
      // Set values with tags
      await cache.set('key1', { data: 'test1' }, { ttl: 60, tags: ['group1', 'type-a'] });
      await cache.set('key2', { data: 'test2' }, { ttl: 60, tags: ['group1', 'type-b'] });
      await cache.set('key3', { data: 'test3' }, { ttl: 60, tags: ['group2', 'type-a'] });

      // Verify values are stored
      expect(await cache.get('key1')).toEqual({ data: 'test1' });
      expect(await cache.get('key2')).toEqual({ data: 'test2' });
      expect(await cache.get('key3')).toEqual({ data: 'test3' });

      // Invalidate by tag 'group1'
      const invalidated = await cache.invalidateByTag('group1');
      expect(invalidated).toBe(2);

      // Check that group1 keys are gone
      expect(await cache.get('key1')).toBeNull();
      expect(await cache.get('key2')).toBeNull();
      
      // Check that group2 key remains
      expect(await cache.get('key3')).toEqual({ data: 'test3' });
    });

    it('should handle multiple overlapping tags', async () => {
      await cache.set('key1', { data: 'test1' }, { tags: ['tag-a', 'tag-b'] });
      await cache.set('key2', { data: 'test2' }, { tags: ['tag-b', 'tag-c'] });
      await cache.set('key3', { data: 'test3' }, { tags: ['tag-c'] });

      // Invalidate tag-b (should remove key1 and key2)
      const invalidated = await cache.invalidateByTag('tag-b');
      expect(invalidated).toBe(2);

      expect(await cache.get('key1')).toBeNull();
      expect(await cache.get('key2')).toBeNull();
      expect(await cache.get('key3')).toEqual({ data: 'test3' });

      // Verify tag-c still works for remaining key
      const invalidated2 = await cache.invalidateByTag('tag-c');
      expect(invalidated2).toBe(1);
      expect(await cache.get('key3')).toBeNull();
    });

    it('should return 0 for non-existent tag', async () => {
      const invalidated = await cache.invalidateByTag('non-existent-tag');
      expect(invalidated).toBe(0);
    });
  });

  describe('Pattern deletion with fallback', () => {
    it('should delete keys matching pattern in fallback cache', async () => {
      // Set up test data
      await cache.set('user:1:profile', { name: 'Alice' });
      await cache.set('user:2:profile', { name: 'Bob' });
      await cache.set('user:1:settings', { theme: 'dark' });
      await cache.set('product:1:info', { name: 'Widget' });
      await cache.set('order:123', { total: 100 });

      // Delete all user: keys
      const deleted = await cache.deletePattern('user:*');
      expect(deleted).toBe(3);

      // Verify user keys are gone
      expect(await cache.get('user:1:profile')).toBeNull();
      expect(await cache.get('user:2:profile')).toBeNull();
      expect(await cache.get('user:1:settings')).toBeNull();

      // Verify other keys remain
      expect(await cache.get('product:1:info')).toEqual({ name: 'Widget' });
      expect(await cache.get('order:123')).toEqual({ total: 100 });
    });

    it('should handle complex patterns', async () => {
      await cache.set('cache:site:123:config', { data: 'test' });
      await cache.set('cache:site:456:config', { data: 'test' });
      await cache.set('cache:user:123:profile', { data: 'test' });
      await cache.set('other:site:789:config', { data: 'test' });

      // Delete cache:site:*:config pattern
      const deleted = await cache.deletePattern('cache:site:*:config');
      expect(deleted).toBe(2);

      expect(await cache.get('cache:site:123:config')).toBeNull();
      expect(await cache.get('cache:site:456:config')).toBeNull();
      expect(await cache.get('cache:user:123:profile')).toEqual({ data: 'test' });
      expect(await cache.get('other:site:789:config')).toEqual({ data: 'test' });
    });

    it('should return 0 when no keys match pattern', async () => {
      await cache.set('key1', { data: 'test' });
      
      const deleted = await cache.deletePattern('nomatch:*');
      expect(deleted).toBe(0);
      
      expect(await cache.get('key1')).toEqual({ data: 'test' });
    });
  });

  describe('Mixed Redis fallback scenarios', () => {
    it('should handle cache operations when Redis becomes unavailable', async () => {
      // Set some data with tags
      await cache.set('session:user123', { user: 'test', expires: Date.now() + 3600000 }, {
        ttl: 3600,
        tags: ['sessions', 'user:123']
      });

      await cache.set('session:user456', { user: 'test2', expires: Date.now() + 3600000 }, {
        ttl: 3600,  
        tags: ['sessions', 'user:456']
      });

      // Operations should work in fallback mode
      expect(await cache.get('session:user123')).toBeTruthy();
      
      // Tag invalidation should work
      const sessionCount = await cache.invalidateByTag('sessions');
      expect(sessionCount).toBe(2);

      expect(await cache.get('session:user123')).toBeNull();
      expect(await cache.get('session:user456')).toBeNull();
    });

    it('should handle getOrSet with fallback cache', async () => {
      const loader = jest.fn().mockResolvedValue({ computed: 'value' });
      
      // First call should invoke loader
      const result1 = await cache.getOrSet('computed:key', loader, { ttl: 60 });
      expect(result1).toEqual({ computed: 'value' });
      expect(loader).toHaveBeenCalledTimes(1);

      // Second call should use cached value
      const result2 = await cache.getOrSet('computed:key', loader);
      expect(result2).toEqual({ computed: 'value' });
      expect(loader).toHaveBeenCalledTimes(1); // Not called again
    });
  });

  describe('Expiration handling in fallback cache', () => {
    it('should respect TTL in fallback cache', async () => {
      // Set with very short TTL
      await cache.set('short-lived', { data: 'test' }, { ttl: 1 }); // 1 second

      // Should exist immediately
      expect(await cache.get('short-lived')).toEqual({ data: 'test' });

      // Wait for expiration + cleanup (up to 6 seconds for cleanup cycle)
      await new Promise(resolve => setTimeout(resolve, 6100));

      // Should be expired and cleaned up
      expect(await cache.get('short-lived')).toBeNull();
    });
  });
});