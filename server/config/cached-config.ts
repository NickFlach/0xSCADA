/**
 * Cached Configuration Manager
 *
 * Integrates the Redis caching layer with configuration management so that:
 * 1. Config values are cached in Redis for fast cross-process reads.
 * 2. Config reloads invalidate the cache.
 * 3. Individual config keys can be overridden at runtime via cache.
 *
 * Closes #254
 */

import { getConfig, reloadConfig, type AppConfig } from './config-manager.js';
import { cacheService, CACHE_KEYS, TTL } from '../services/cache/cache-service.js';

const CONFIG_CACHE_KEY = `${CACHE_KEYS.CONFIG}app`;
const CONFIG_CACHE_TTL = TTL.SITE_CONFIG; // 1 hour

/**
 * Get configuration with Redis cache-aside pattern.
 * First request loads from environment/files and caches to Redis.
 * Subsequent requests across any process hit the cache.
 */
export async function getCachedConfig(): Promise<AppConfig> {
  return cacheService.getOrSet<AppConfig>(
    CONFIG_CACHE_KEY,
    async () => getConfig(),
    { ttl: CONFIG_CACHE_TTL, tags: ['config'] },
  );
}

/**
 * Get a single config value by dot-path (e.g. 'database.host').
 * Uses per-key caching for frequently accessed individual values.
 */
export async function getCachedConfigValue<T = unknown>(
  path: string,
): Promise<T | undefined> {
  const key = `${CACHE_KEYS.CONFIG}key:${path}`;

  return cacheService.getOrSet<T | undefined>(
    key,
    async () => {
      const config = getConfig();
      return getNestedValue(config, path) as T | undefined;
    },
    { ttl: CONFIG_CACHE_TTL, tags: ['config'] },
  );
}

/**
 * Set a runtime config override in the cache.
 * Does NOT modify the underlying .env or environment variables —
 * only overrides the cached value until next invalidation.
 */
export async function setRuntimeConfigOverride<T>(
  path: string,
  value: T,
): Promise<boolean> {
  const key = `${CACHE_KEYS.CONFIG}key:${path}`;
  return cacheService.set(key, value, { ttl: CONFIG_CACHE_TTL, tags: ['config'] });
}

/**
 * Reload configuration from disk/env, invalidate all config caches,
 * and return the diff of what changed.
 */
export async function reloadCachedConfig(): Promise<{
  config: AppConfig;
  changes: Array<{ path: string; from: unknown; to: unknown }>;
}> {
  // Invalidate all config-tagged cache entries
  await cacheService.invalidateByTag('config');

  // Reload from source
  const { config, changes } = reloadConfig();

  // Re-populate cache
  await cacheService.set(CONFIG_CACHE_KEY, config, {
    ttl: CONFIG_CACHE_TTL,
    tags: ['config'],
  });

  return { config, changes };
}

/**
 * Invalidate all config caches (useful on SIGHUP or admin action).
 */
export async function invalidateConfigCache(): Promise<number> {
  return cacheService.invalidateByTag('config');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getNestedValue(obj: Record<string, any>, path: string): unknown {
  const parts = path.split('.');
  let current: any = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

export default {
  getCachedConfig,
  getCachedConfigValue,
  setRuntimeConfigOverride,
  reloadCachedConfig,
  invalidateConfigCache,
};
