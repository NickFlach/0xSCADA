/**
 * Cache Metrics - Prometheus-compatible metrics collection
 * 
 * Tracks cache performance for monitoring and alerting:
 * - Hit/miss ratios
 * - Latency histograms
 * - Error rates
 * - Memory utilization
 */

export interface CacheMetricsSnapshot {
  hits: number;
  misses: number;
  errors: number;
  hitRate: number;
  missRate: number;
  errorRate: number;
  avgLatency: number;
  p50Latency: number;
  p95Latency: number;
  p99Latency: number;
}

interface LatencyBucket {
  le: number;
  count: number;
}

/**
 * Cache metrics collector with sliding window statistics
 */
class CacheMetrics {
  private hits: number = 0;
  private misses: number = 0;
  private errors: number = 0;
  private latencies: number[] = [];
  private readonly maxLatencySamples = 1000;

  // Histogram buckets for Prometheus compatibility
  private latencyBuckets: LatencyBucket[] = [
    { le: 1, count: 0 },    // 1ms
    { le: 5, count: 0 },    // 5ms
    { le: 10, count: 0 },   // 10ms
    { le: 25, count: 0 },   // 25ms
    { le: 50, count: 0 },   // 50ms
    { le: 100, count: 0 },  // 100ms
    { le: 250, count: 0 },  // 250ms
    { le: 500, count: 0 },  // 500ms
    { le: 1000, count: 0 }, // 1s
    { le: Infinity, count: 0 }, // +Inf
  ];

  // Per-key metrics for detailed analysis
  private keyMetrics: Map<string, { hits: number; misses: number; errors: number }> = new Map();

  /**
   * Record a cache hit
   */
  recordHit(key: string, latencyMs: number): void {
    this.hits++;
    this.recordLatency(key, latencyMs);
    this.updateKeyMetrics(key, 'hits');
  }

  /**
   * Record a cache miss
   */
  recordMiss(key: string): void {
    this.misses++;
    this.updateKeyMetrics(key, 'misses');
  }

  /**
   * Record a cache error
   */
  recordError(key: string): void {
    this.errors++;
    this.updateKeyMetrics(key, 'errors');
  }

  /**
   * Record operation latency
   */
  recordLatency(key: string, latencyMs: number): void {
    // Store sample
    this.latencies.push(latencyMs);
    if (this.latencies.length > this.maxLatencySamples) {
      this.latencies.shift();
    }

    // Update histogram buckets
    for (const bucket of this.latencyBuckets) {
      if (latencyMs <= bucket.le) {
        bucket.count++;
        break;
      }
    }
  }

  /**
   * Update per-key metrics
   */
  private updateKeyMetrics(
    key: string,
    metric: 'hits' | 'misses' | 'errors'
  ): void {
    // Extract key prefix for grouping
    const prefix = key.split(':')[0] || 'unknown';

    if (!this.keyMetrics.has(prefix)) {
      this.keyMetrics.set(prefix, { hits: 0, misses: 0, errors: 0 });
    }

    const metrics = this.keyMetrics.get(prefix)!;
    metrics[metric]++;
  }

  /**
   * Get overall cache statistics
   */
  getStats(): {
    hitRate: number;
    missRate: number;
    errorRate: number;
    avgLatency: number;
  } {
    const total = this.hits + this.misses;

    return {
      hitRate: total > 0 ? this.hits / total : 0,
      missRate: total > 0 ? this.misses / total : 0,
      errorRate: total > 0 ? this.errors / total : 0,
      avgLatency: this.calculateAvgLatency(),
    };
  }

  /**
   * Get detailed metrics snapshot
   */
  getSnapshot(): CacheMetricsSnapshot {
    const total = this.hits + this.misses;

    return {
      hits: this.hits,
      misses: this.misses,
      errors: this.errors,
      hitRate: total > 0 ? this.hits / total : 0,
      missRate: total > 0 ? this.misses / total : 0,
      errorRate: total > 0 ? this.errors / total : 0,
      avgLatency: this.calculateAvgLatency(),
      p50Latency: this.calculatePercentile(50),
      p95Latency: this.calculatePercentile(95),
      p99Latency: this.calculatePercentile(99),
    };
  }

  /**
   * Get Prometheus-compatible metrics string
   */
  toPrometheusMetrics(): string {
    const lines: string[] = [];
    const labels = 'service="0xscada"';

    // Counter metrics
    lines.push(`# HELP cache_hits_total Total number of cache hits`);
    lines.push(`# TYPE cache_hits_total counter`);
    lines.push(`cache_hits_total{${labels}} ${this.hits}`);

    lines.push(`# HELP cache_misses_total Total number of cache misses`);
    lines.push(`# TYPE cache_misses_total counter`);
    lines.push(`cache_misses_total{${labels}} ${this.misses}`);

    lines.push(`# HELP cache_errors_total Total number of cache errors`);
    lines.push(`# TYPE cache_errors_total counter`);
    lines.push(`cache_errors_total{${labels}} ${this.errors}`);

    // Gauge metrics
    const stats = this.getStats();
    lines.push(`# HELP cache_hit_ratio Current cache hit ratio`);
    lines.push(`# TYPE cache_hit_ratio gauge`);
    lines.push(`cache_hit_ratio{${labels}} ${stats.hitRate.toFixed(4)}`);

    // Histogram metrics
    lines.push(`# HELP cache_operation_duration_ms Cache operation duration in milliseconds`);
    lines.push(`# TYPE cache_operation_duration_ms histogram`);

    for (const bucket of this.latencyBuckets) {
      const le = bucket.le === Infinity ? '+Inf' : bucket.le.toString();
      lines.push(`cache_operation_duration_ms_bucket{${labels},le="${le}"} ${bucket.count}`);
    }
    lines.push(`cache_operation_duration_ms_sum{${labels}} ${this.latencies.reduce((a, b) => a + b, 0)}`);
    lines.push(`cache_operation_duration_ms_count{${labels}} ${this.latencies.length}`);

    // Per-key-prefix metrics
    lines.push(`# HELP cache_hits_by_prefix Cache hits by key prefix`);
    lines.push(`# TYPE cache_hits_by_prefix counter`);
    for (const [prefix, metrics] of this.keyMetrics) {
      lines.push(`cache_hits_by_prefix{${labels},prefix="${prefix}"} ${metrics.hits}`);
    }

    lines.push(`# HELP cache_misses_by_prefix Cache misses by key prefix`);
    lines.push(`# TYPE cache_misses_by_prefix counter`);
    for (const [prefix, metrics] of this.keyMetrics) {
      lines.push(`cache_misses_by_prefix{${labels},prefix="${prefix}"} ${metrics.misses}`);
    }

    return lines.join('\n');
  }

  /**
   * Calculate average latency
   */
  private calculateAvgLatency(): number {
    if (this.latencies.length === 0) return 0;
    return this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length;
  }

  /**
   * Calculate percentile latency
   */
  private calculatePercentile(percentile: number): number {
    if (this.latencies.length === 0) return 0;

    const sorted = [...this.latencies].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  /**
   * Reset all metrics (for testing or periodic reset)
   */
  reset(): void {
    this.hits = 0;
    this.misses = 0;
    this.errors = 0;
    this.latencies = [];
    this.keyMetrics.clear();
    this.latencyBuckets.forEach((b) => (b.count = 0));
  }
}

// Export singleton instance
export const cacheMetrics = new CacheMetrics();

export default cacheMetrics;
