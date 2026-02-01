/**
 * Redis Caching Layer
 * 
 * Provides hot path optimization for frequently accessed data:
 * - Tag values (live process data)
 * - Site/asset configuration
 * - User sessions and permissions
 * - Recent events
 * - Transaction receipts
 * 
 * @module server/services/cache
 */

// Core infrastructure
export {
  default as RedisClientManager,
  getRedisClient,
  isRedisHealthy,
  getRedisStatus,
  disconnectRedis,
  type RedisConfig,
} from './redis-client.js';

// Main cache service
export {
  default as cacheService,
  CacheService,
  TTL,
  CACHE_KEYS,
  type CacheOptions,
  type CacheEntry,
} from './cache-service.js';

// Metrics
export {
  default as cacheMetrics,
  type CacheMetricsSnapshot,
} from './cache-metrics.js';

// Specialized caches
export { tagCache, type TagValue, type TagBatchUpdate } from './tag-cache.js';

export {
  siteCache,
  type SiteConfig,
  type TagConfig,
  type AlertConfig,
} from './site-cache.js';

export {
  eventCache,
  type CachedEvent,
  type EventQueryOptions,
} from './event-cache.js';

export {
  sessionCache,
  type UserSession,
  type UserPermissions,
} from './session-cache.js';
