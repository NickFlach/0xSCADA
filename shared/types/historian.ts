/**
 * Historian Types
 * Issue #51 — Types for time-series historian database connector.
 */

export type HistorianBackend = 'timescaledb' | 'influxdb' | 'memory';

export interface HistorianConfig {
  backend: HistorianBackend;
  connectionString?: string;
  influxConfig?: {
    url: string;
    token: string;
    org: string;
    bucket: string;
  };
  /** Flush buffered writes every N ms */
  flushIntervalMs?: number;
  /** Max records before auto-flush */
  batchSize?: number;
  /** Retention policy */
  retentionPolicy?: RetentionPolicy;
}

export interface TagRecord {
  tagName: string;
  value: number | string | boolean;
  quality: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface QueryOptions {
  tagNames?: string[];
  startTime?: Date;
  endTime?: Date;
  limit?: number;
  aggregation?: 'avg' | 'min' | 'max' | 'sum' | 'count' | 'last';
  bucketSizeMs?: number;
}

export interface QueryResult {
  records: TagRecord[];
  count: number;
  hasMore: boolean;
}

export interface RetentionPolicy {
  /** Maximum age in days */
  maxAgeDays: number;
  /** Apply to specific tags (or all if empty) */
  tagPatterns?: string[];
}

export interface DownsamplePolicy {
  /** Aggregate data older than this many days */
  sourceMaxAgeDays: number;
  /** Bucket size in ms */
  bucketSizeMs: number;
  /** Aggregation function */
  aggregation: 'avg' | 'min' | 'max' | 'sum' | 'last';
}

export interface HistorianStats {
  totalRecords: number;
  oldestRecord: Date | null;
  newestRecord: Date | null;
  tagCount: number;
  estimatedSizeBytes: number;
}
