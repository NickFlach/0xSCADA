/**
 * Site Configuration Cache - Long TTL caching for configuration data
 * 
 * Configuration changes are infrequent, so longer TTL is appropriate.
 * Uses write-through pattern to ensure cache consistency.
 */

import { cacheService, CACHE_KEYS, TTL } from './cache-service.js';

export interface SiteConfig {
  id: string;
  name: string;
  description?: string;
  location?: {
    latitude: number;
    longitude: number;
    address?: string;
  };
  timezone: string;
  tags: TagConfig[];
  alerts: AlertConfig[];
  settings: Record<string, unknown>;
  updatedAt: Date;
}

export interface TagConfig {
  id: string;
  name: string;
  description?: string;
  unit?: string;
  dataType: 'number' | 'boolean' | 'string';
  minValue?: number;
  maxValue?: number;
  precision?: number;
  enabled: boolean;
}

export interface AlertConfig {
  id: string;
  name: string;
  tagId: string;
  condition: 'gt' | 'lt' | 'eq' | 'ne' | 'between';
  threshold: number | [number, number];
  severity: 'info' | 'warning' | 'critical';
  enabled: boolean;
}

/**
 * Site configuration cache with write-through support
 */
class SiteCache {
  /**
   * Get site configuration (read-through pattern)
   */
  async getSiteConfig(
    siteId: string,
    loader?: () => Promise<SiteConfig>
  ): Promise<SiteConfig | null> {
    const key = this.buildKey(siteId);

    if (loader) {
      return cacheService.getOrSet(key, loader, {
        ttl: TTL.SITE_CONFIG,
        tags: ['sites', `site:${siteId}`],
      });
    }

    return cacheService.get<SiteConfig>(key);
  }

  /**
   * Get multiple site configurations
   */
  async getSiteConfigs(siteIds: string[]): Promise<Map<string, SiteConfig | null>> {
    const keys = siteIds.map((id) => this.buildKey(id));
    return cacheService.mget<SiteConfig>(keys);
  }

  /**
   * Update site configuration (write-through pattern)
   */
  async updateSiteConfig(
    siteId: string,
    config: SiteConfig,
    persister: (config: SiteConfig) => Promise<void>
  ): Promise<boolean> {
    const key = this.buildKey(siteId);
    return cacheService.writeThrough(key, config, persister, {
      ttl: TTL.SITE_CONFIG,
      tags: ['sites', `site:${siteId}`],
    });
  }

  /**
   * Set site configuration without persistence callback
   */
  async setSiteConfig(siteId: string, config: SiteConfig): Promise<boolean> {
    const key = this.buildKey(siteId);
    return cacheService.set(key, config, {
      ttl: TTL.SITE_CONFIG,
      tags: ['sites', `site:${siteId}`],
    });
  }

  /**
   * Invalidate site configuration cache
   */
  async invalidateSite(siteId: string): Promise<boolean> {
    const key = this.buildKey(siteId);
    return cacheService.delete(key);
  }

  /**
   * Invalidate all site configurations
   */
  async invalidateAll(): Promise<number> {
    return cacheService.invalidateByTag('sites');
  }

  /**
   * Get tag configuration for a specific tag
   */
  async getTagConfig(siteId: string, tagId: string): Promise<TagConfig | null> {
    const config = await this.getSiteConfig(siteId);
    if (!config) return null;

    return config.tags.find((t) => t.id === tagId) || null;
  }

  /**
   * Get alert configuration for a site
   */
  async getAlertConfigs(siteId: string): Promise<AlertConfig[]> {
    const config = await this.getSiteConfig(siteId);
    return config?.alerts || [];
  }

  /**
   * Build cache key for site
   */
  private buildKey(siteId: string): string {
    return `${CACHE_KEYS.SITE}${siteId}:config`;
  }
}

export const siteCache = new SiteCache();
export default siteCache;
