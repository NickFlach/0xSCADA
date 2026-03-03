/**
 * Cache Service Types
 */

import { Timestamp } from '../core/common';
import { CacheEntry, StorageProvider } from './common';

export interface RedisCacheConfig {
  host: string;
  port: number;
  password?: string;
  database?: number;
  keyPrefix?: string;
  defaultTtl: number;
}

export interface CacheMetrics {
  hitRate: number;
  missRate: number;
  totalRequests: number;
  totalHits: number;
  totalMisses: number;
  averageResponseTime: number;
  memoryUsage: number;
  keyCount: number;
  lastReset?: Timestamp;
}

export interface EventCache {
  addEvent(event: CachedEvent): Promise<void>;
  getRecentEvents(options?: { limit?: number; since?: Timestamp }): Promise<CachedEvent[]>;
  clearEvents(before?: Timestamp): Promise<number>;
}

export interface CachedEvent {
  id: string;
  type: string;
  severity: 'info' | 'warning' | 'alarm' | 'critical';
  siteId: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: Timestamp;
  acknowledged: boolean;
}