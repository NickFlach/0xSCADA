/**
 * Time-Series Historian Database Connector
 * 
 * Issue #51 — Interface for time-series databases (TimescaleDB, InfluxDB).
 * Tag value recording, downsampling, retention policies.
 */

import { EventEmitter } from 'events';
import type {
  HistorianConfig,
  HistorianBackend,
  TagRecord,
  QueryOptions,
  QueryResult,
  DownsamplePolicy,
  RetentionPolicy,
  HistorianStats,
} from '../../shared/types/historian';

// =============================================================================
// ABSTRACT BACKEND
// =============================================================================

export interface HistorianBackendDriver {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  write(records: TagRecord[]): Promise<void>;
  query(options: QueryOptions): Promise<QueryResult>;
  applyRetention(policy: RetentionPolicy): Promise<number>;
  downsample(policy: DownsamplePolicy): Promise<number>;
  getStats(): Promise<HistorianStats>;
}

// =============================================================================
// IN-MEMORY BACKEND (for testing / development)
// =============================================================================

export class InMemoryHistorianBackend implements HistorianBackendDriver {
  private data: TagRecord[] = [];
  private connected = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async write(records: TagRecord[]): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    this.data.push(...records);
  }

  async query(options: QueryOptions): Promise<QueryResult> {
    let filtered = this.data.filter((r) => {
      if (options.tagNames && !options.tagNames.includes(r.tagName)) return false;
      if (options.startTime && r.timestamp < options.startTime) return false;
      if (options.endTime && r.timestamp > options.endTime) return false;
      return true;
    });

    // Sort by timestamp
    filtered.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    // Apply limit
    if (options.limit) {
      filtered = filtered.slice(0, options.limit);
    }

    return {
      records: filtered,
      count: filtered.length,
      hasMore: false,
    };
  }

  async applyRetention(policy: RetentionPolicy): Promise<number> {
    const cutoff = new Date(Date.now() - policy.maxAgeDays * 24 * 60 * 60 * 1000);
    const before = this.data.length;
    this.data = this.data.filter((r) => r.timestamp > cutoff);
    return before - this.data.length;
  }

  async downsample(policy: DownsamplePolicy): Promise<number> {
    // Group by tag, then by bucket, keep aggregated value
    const cutoff = new Date(Date.now() - policy.sourceMaxAgeDays * 24 * 60 * 60 * 1000);
    const toAggregate = this.data.filter((r) => r.timestamp <= cutoff);
    const keep = this.data.filter((r) => r.timestamp > cutoff);

    const buckets = new Map<string, TagRecord[]>();
    for (const r of toAggregate) {
      const bucketTime = Math.floor(r.timestamp.getTime() / policy.bucketSizeMs) * policy.bucketSizeMs;
      const key = `${r.tagName}:${bucketTime}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(r);
    }

    const aggregated: TagRecord[] = [];
    for (const [key, records] of buckets) {
      const [tagName] = key.split(':');
      const values = records.map((r) => r.value).filter((v): v is number => typeof v === 'number');
      if (values.length === 0) continue;

      let value: number;
      switch (policy.aggregation) {
        case 'avg': value = values.reduce((a, b) => a + b, 0) / values.length; break;
        case 'min': value = Math.min(...values); break;
        case 'max': value = Math.max(...values); break;
        case 'sum': value = values.reduce((a, b) => a + b, 0); break;
        case 'last': value = values[values.length - 1]; break;
        default: value = values.reduce((a, b) => a + b, 0) / values.length;
      }

      aggregated.push({
        tagName,
        value,
        quality: 'GOOD',
        timestamp: records[0].timestamp,
      });
    }

    this.data = [...keep, ...aggregated];
    return toAggregate.length - aggregated.length;
  }

  async getStats(): Promise<HistorianStats> {
    return {
      totalRecords: this.data.length,
      oldestRecord: this.data[0]?.timestamp || null,
      newestRecord: this.data[this.data.length - 1]?.timestamp || null,
      tagCount: new Set(this.data.map((r) => r.tagName)).size,
      estimatedSizeBytes: this.data.length * 64,
    };
  }
}

// =============================================================================
// TIMESCALEDB BACKEND (stub — requires pg driver)
// =============================================================================

export class TimescaleDBBackend implements HistorianBackendDriver {
  constructor(private connectionString: string) {}

  async connect(): Promise<void> {
    console.log(`[Historian/TimescaleDB] Would connect to ${this.connectionString}`);
    // In production: const pool = new Pool({ connectionString: this.connectionString });
  }
  async disconnect(): Promise<void> { /* close pool */ }
  async write(records: TagRecord[]): Promise<void> {
    console.log(`[Historian/TimescaleDB] Would write ${records.length} records`);
    // INSERT INTO tag_values (tag_name, value, quality, timestamp) VALUES ...
  }
  async query(options: QueryOptions): Promise<QueryResult> {
    console.log(`[Historian/TimescaleDB] Would query`, options);
    return { records: [], count: 0, hasMore: false };
  }
  async applyRetention(policy: RetentionPolicy): Promise<number> {
    console.log(`[Historian/TimescaleDB] Would apply retention: ${policy.maxAgeDays} days`);
    return 0;
  }
  async downsample(policy: DownsamplePolicy): Promise<number> {
    console.log(`[Historian/TimescaleDB] Would downsample with ${policy.aggregation}`);
    return 0;
  }
  async getStats(): Promise<HistorianStats> {
    return { totalRecords: 0, oldestRecord: null, newestRecord: null, tagCount: 0, estimatedSizeBytes: 0 };
  }
}

// =============================================================================
// INFLUXDB BACKEND (stub — requires @influxdata/influxdb-client)
// =============================================================================

export class InfluxDBBackend implements HistorianBackendDriver {
  constructor(private config: { url: string; token: string; org: string; bucket: string }) {}

  async connect(): Promise<void> {
    console.log(`[Historian/InfluxDB] Would connect to ${this.config.url}`);
  }
  async disconnect(): Promise<void> { /* close client */ }
  async write(records: TagRecord[]): Promise<void> {
    console.log(`[Historian/InfluxDB] Would write ${records.length} points`);
  }
  async query(options: QueryOptions): Promise<QueryResult> {
    console.log(`[Historian/InfluxDB] Would query`, options);
    return { records: [], count: 0, hasMore: false };
  }
  async applyRetention(_policy: RetentionPolicy): Promise<number> { return 0; }
  async downsample(_policy: DownsamplePolicy): Promise<number> { return 0; }
  async getStats(): Promise<HistorianStats> {
    return { totalRecords: 0, oldestRecord: null, newestRecord: null, tagCount: 0, estimatedSizeBytes: 0 };
  }
}

// =============================================================================
// HISTORIAN CONNECTOR (main interface)
// =============================================================================

export class HistorianConnector extends EventEmitter {
  private backend: HistorianBackendDriver;
  private writeBuffer: TagRecord[] = [];
  private flushTimer?: NodeJS.Timeout;
  private retentionTimer?: NodeJS.Timeout;

  constructor(private config: HistorianConfig) {
    super();

    switch (config.backend) {
      case 'timescaledb':
        this.backend = new TimescaleDBBackend(config.connectionString || '');
        break;
      case 'influxdb':
        this.backend = new InfluxDBBackend(config.influxConfig || { url: '', token: '', org: '', bucket: '' });
        break;
      case 'memory':
      default:
        this.backend = new InMemoryHistorianBackend();
    }
  }

  async connect(): Promise<void> {
    await this.backend.connect();

    // Start flush timer
    if (this.config.flushIntervalMs) {
      this.flushTimer = setInterval(() => this.flush(), this.config.flushIntervalMs);
    }

    // Start retention timer
    if (this.config.retentionPolicy) {
      this.retentionTimer = setInterval(
        () => this.applyRetention(),
        24 * 60 * 60 * 1000 // Daily
      );
    }

    console.log(`[Historian] Connected (backend: ${this.config.backend})`);
  }

  async disconnect(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    await this.flush();
    await this.backend.disconnect();
  }

  /**
   * Record a tag value.
   */
  record(tagName: string, value: number | string | boolean, quality: string = 'GOOD'): void {
    this.writeBuffer.push({
      tagName,
      value,
      quality,
      timestamp: new Date(),
    });

    if (this.writeBuffer.length >= (this.config.batchSize || 100)) {
      this.flush();
    }
  }

  /**
   * Record multiple tag values at once.
   */
  recordBatch(records: TagRecord[]): void {
    this.writeBuffer.push(...records);
    if (this.writeBuffer.length >= (this.config.batchSize || 100)) {
      this.flush();
    }
  }

  /**
   * Flush buffered writes.
   */
  async flush(): Promise<void> {
    if (this.writeBuffer.length === 0) return;
    const batch = this.writeBuffer.splice(0);
    try {
      await this.backend.write(batch);
      this.emit('flush', { count: batch.length });
    } catch (err) {
      console.error('[Historian] Flush error:', err);
      // Re-queue failed batch
      this.writeBuffer.unshift(...batch);
      this.emit('error', err);
    }
  }

  /**
   * Query historical data.
   */
  async query(options: QueryOptions): Promise<QueryResult> {
    // Flush pending writes first
    await this.flush();
    return this.backend.query(options);
  }

  /**
   * Apply retention policy.
   */
  async applyRetention(): Promise<number> {
    if (!this.config.retentionPolicy) return 0;
    const removed = await this.backend.applyRetention(this.config.retentionPolicy);
    console.log(`[Historian] Retention applied: ${removed} records removed`);
    return removed;
  }

  /**
   * Apply downsampling.
   */
  async downsample(policy: DownsamplePolicy): Promise<number> {
    return this.backend.downsample(policy);
  }

  /**
   * Get historian statistics.
   */
  async getStats(): Promise<HistorianStats> {
    return this.backend.getStats();
  }
}
