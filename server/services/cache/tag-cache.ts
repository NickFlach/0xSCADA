/**
 * Tag Value Cache - Hot path caching for live process data
 * 
 * Optimized for high-frequency reads with very short TTL
 * to ensure data freshness while reducing database load.
 */

import { cacheService, CACHE_KEYS, TTL } from './cache-service.js';

export interface TagValue {
  tagId: string;
  value: number | string | boolean;
  quality: 'GOOD' | 'BAD' | 'UNCERTAIN';
  timestamp: Date;
  unit?: string;
}

export interface TagBatchUpdate {
  siteId: string;
  tags: TagValue[];
  timestamp: Date;
}

/**
 * Tag value cache with optimizations for real-time data
 */
class TagCache {
  /**
   * Get current value for a single tag
   */
  async getTagValue(siteId: string, tagId: string): Promise<TagValue | null> {
    const key = this.buildKey(siteId, tagId);
    return cacheService.get<TagValue>(key);
  }

  /**
   * Get current values for multiple tags
   */
  async getTagValues(
    siteId: string,
    tagIds: string[]
  ): Promise<Map<string, TagValue | null>> {
    const keys = tagIds.map((tagId) => this.buildKey(siteId, tagId));
    return cacheService.mget<TagValue>(keys);
  }

  /**
   * Set a single tag value with short TTL
   */
  async setTagValue(siteId: string, tag: TagValue): Promise<boolean> {
    const key = this.buildKey(siteId, tag.tagId);
    return cacheService.set(key, tag, {
      ttl: TTL.TAG_VALUES,
      tags: [`site:${siteId}`, 'tags'],
    });
  }

  /**
   * Batch update tag values (optimized for high-frequency updates)
   */
  async batchUpdate(update: TagBatchUpdate): Promise<void> {
    const promises = update.tags.map((tag) =>
      this.setTagValue(update.siteId, tag)
    );
    await Promise.all(promises);
  }

  /**
   * Get all cached tag values for a site
   */
  async getSiteTagValues(siteId: string): Promise<TagValue[]> {
    // This would need Redis SCAN in production for efficiency
    // For now, this is a placeholder
    console.warn('[TagCache] getSiteTagValues requires pattern scanning');
    return [];
  }

  /**
   * Invalidate all tags for a site
   */
  async invalidateSite(siteId: string): Promise<number> {
    return cacheService.invalidateByTag(`site:${siteId}`);
  }

  /**
   * Invalidate specific tag
   */
  async invalidateTag(siteId: string, tagId: string): Promise<boolean> {
    const key = this.buildKey(siteId, tagId);
    return cacheService.delete(key);
  }

  /**
   * Build cache key for tag
   */
  private buildKey(siteId: string, tagId: string): string {
    return `${CACHE_KEYS.TAG}${siteId}:${tagId}`;
  }
}

export const tagCache = new TagCache();
export default tagCache;
