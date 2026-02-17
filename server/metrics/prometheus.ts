/**
 * Prometheus Metrics Exporter for 0xSCADA
 * 
 * Exports system metrics in Prometheus exposition format.
 * Designed for low overhead (<2% CPU) and stable label cardinality.
 */

import type { Request, Response } from 'express';

// ============================================================================
// METRIC TYPES
// ============================================================================

type MetricType = 'counter' | 'gauge' | 'histogram' | 'summary';

interface MetricLabels {
  [key: string]: string;
}

interface MetricConfig {
  name: string;
  help: string;
  type: MetricType;
  labelNames?: string[];
}

interface HistogramConfig extends MetricConfig {
  type: 'histogram';
  buckets: number[];
}

// ============================================================================
// METRIC COLLECTORS
// ============================================================================

/**
 * Counter metric - monotonically increasing value
 */
class Counter {
  private values: Map<string, number> = new Map();
  
  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: string[] = []
  ) {}

  inc(labels: MetricLabels = {}, value: number = 1): void {
    const key = this.labelsToKey(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current + value);
  }

  get(labels: MetricLabels = {}): number {
    return this.values.get(this.labelsToKey(labels)) || 0;
  }

  reset(): void {
    this.values.clear();
  }

  collect(): { labels: MetricLabels; value: number }[] {
    const result: { labels: MetricLabels; value: number }[] = [];
    for (const [key, value] of this.values) {
      result.push({ labels: this.keyToLabels(key), value });
    }
    return result;
  }

  private labelsToKey(labels: MetricLabels): string {
    return this.labelNames.map(name => labels[name] || '').join('|');
  }

  private keyToLabels(key: string): MetricLabels {
    const values = key.split('|');
    const labels: MetricLabels = {};
    this.labelNames.forEach((name, i) => {
      if (values[i]) labels[name] = values[i];
    });
    return labels;
  }
}

/**
 * Gauge metric - value that can go up and down
 */
class Gauge {
  private values: Map<string, number> = new Map();
  
  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: string[] = []
  ) {}

  set(value: number, labels: MetricLabels = {}): void {
    this.values.set(this.labelsToKey(labels), value);
  }

  inc(labels: MetricLabels = {}, value: number = 1): void {
    const key = this.labelsToKey(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current + value);
  }

  dec(labels: MetricLabels = {}, value: number = 1): void {
    this.inc(labels, -value);
  }

  get(labels: MetricLabels = {}): number {
    return this.values.get(this.labelsToKey(labels)) || 0;
  }

  setToCurrentTime(labels: MetricLabels = {}): void {
    this.set(Date.now() / 1000, labels);
  }

  reset(): void {
    this.values.clear();
  }

  collect(): { labels: MetricLabels; value: number }[] {
    const result: { labels: MetricLabels; value: number }[] = [];
    for (const [key, value] of this.values) {
      result.push({ labels: this.keyToLabels(key), value });
    }
    return result;
  }

  private labelsToKey(labels: MetricLabels): string {
    return this.labelNames.map(name => labels[name] || '').join('|');
  }

  private keyToLabels(key: string): MetricLabels {
    const values = key.split('|');
    const labels: MetricLabels = {};
    this.labelNames.forEach((name, i) => {
      if (values[i]) labels[name] = values[i];
    });
    return labels;
  }
}

/**
 * Histogram metric - tracks distribution of values
 */
class Histogram {
  private buckets: Map<string, Map<number, number>> = new Map();
  private sums: Map<string, number> = new Map();
  private counts: Map<string, number> = new Map();

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: string[] = [],
    public readonly bucketBoundaries: number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
  ) {}

  observe(value: number, labels: MetricLabels = {}): void {
    const key = this.labelsToKey(labels);
    
    // Initialize if needed
    if (!this.buckets.has(key)) {
      const bucketMap = new Map<number, number>();
      this.bucketBoundaries.forEach(b => bucketMap.set(b, 0));
      bucketMap.set(Infinity, 0);
      this.buckets.set(key, bucketMap);
      this.sums.set(key, 0);
      this.counts.set(key, 0);
    }

    // Update buckets
    const bucketMap = this.buckets.get(key)!;
    for (const boundary of [...this.bucketBoundaries, Infinity]) {
      if (value <= boundary) {
        bucketMap.set(boundary, (bucketMap.get(boundary) || 0) + 1);
      }
    }

    // Update sum and count
    this.sums.set(key, (this.sums.get(key) || 0) + value);
    this.counts.set(key, (this.counts.get(key) || 0) + 1);
  }

  reset(): void {
    this.buckets.clear();
    this.sums.clear();
    this.counts.clear();
  }

  collect(): { 
    labels: MetricLabels; 
    buckets: Map<number, number>; 
    sum: number; 
    count: number 
  }[] {
    const result: { 
      labels: MetricLabels; 
      buckets: Map<number, number>; 
      sum: number; 
      count: number 
    }[] = [];
    
    for (const [key, buckets] of this.buckets) {
      result.push({
        labels: this.keyToLabels(key),
        buckets,
        sum: this.sums.get(key) || 0,
        count: this.counts.get(key) || 0,
      });
    }
    return result;
  }

  private labelsToKey(labels: MetricLabels): string {
    return this.labelNames.map(name => labels[name] || '').join('|');
  }

  private keyToLabels(key: string): MetricLabels {
    const values = key.split('|');
    const labels: MetricLabels = {};
    this.labelNames.forEach((name, i) => {
      if (values[i]) labels[name] = values[i];
    });
    return labels;
  }
}

// ============================================================================
// PROMETHEUS REGISTRY
// ============================================================================

/**
 * Central registry for all metrics
 */
class PrometheusRegistry {
  private counters: Map<string, Counter> = new Map();
  private gauges: Map<string, Gauge> = new Map();
  private histograms: Map<string, Histogram> = new Map();
  private prefix: string = 'scada';

  setPrefix(prefix: string): void {
    this.prefix = prefix;
  }

  /**
   * Create or get a counter
   */
  counter(name: string, help: string, labelNames: string[] = []): Counter {
    const fullName = `${this.prefix}_${name}`;
    if (!this.counters.has(fullName)) {
      this.counters.set(fullName, new Counter(fullName, help, labelNames));
    }
    return this.counters.get(fullName)!;
  }

  /**
   * Create or get a gauge
   */
  gauge(name: string, help: string, labelNames: string[] = []): Gauge {
    const fullName = `${this.prefix}_${name}`;
    if (!this.gauges.has(fullName)) {
      this.gauges.set(fullName, new Gauge(fullName, help, labelNames));
    }
    return this.gauges.get(fullName)!;
  }

  /**
   * Create or get a histogram
   */
  histogram(
    name: string, 
    help: string, 
    labelNames: string[] = [],
    buckets?: number[]
  ): Histogram {
    const fullName = `${this.prefix}_${name}`;
    if (!this.histograms.has(fullName)) {
      this.histograms.set(fullName, new Histogram(fullName, help, labelNames, buckets));
    }
    return this.histograms.get(fullName)!;
  }

  /**
   * Generate Prometheus exposition format output
   */
  metrics(): string {
    const lines: string[] = [];

    // Counters
    for (const counter of this.counters.values()) {
      lines.push(`# HELP ${counter.name} ${counter.help}`);
      lines.push(`# TYPE ${counter.name} counter`);
      for (const { labels, value } of counter.collect()) {
        lines.push(`${counter.name}${formatLabels(labels)} ${value}`);
      }
    }

    // Gauges
    for (const gauge of this.gauges.values()) {
      lines.push(`# HELP ${gauge.name} ${gauge.help}`);
      lines.push(`# TYPE ${gauge.name} gauge`);
      for (const { labels, value } of gauge.collect()) {
        lines.push(`${gauge.name}${formatLabels(labels)} ${value}`);
      }
    }

    // Histograms
    for (const histogram of this.histograms.values()) {
      lines.push(`# HELP ${histogram.name} ${histogram.help}`);
      lines.push(`# TYPE ${histogram.name} histogram`);
      for (const { labels, buckets, sum, count } of histogram.collect()) {
        for (const [le, bucketCount] of buckets) {
          const leLabel = le === Infinity ? '+Inf' : le.toString();
          lines.push(`${histogram.name}_bucket${formatLabels({ ...labels, le: leLabel })} ${bucketCount}`);
        }
        lines.push(`${histogram.name}_sum${formatLabels(labels)} ${sum}`);
        lines.push(`${histogram.name}_count${formatLabels(labels)} ${count}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Reset all metrics (clears values but keeps metrics registered)
   */
  reset(): void {
    for (const counter of this.counters.values()) {
      counter.reset();
    }
    for (const gauge of this.gauges.values()) {
      gauge.reset();
    }
    for (const histogram of this.histograms.values()) {
      histogram.reset();
    }
  }
}

/**
 * Format labels for Prometheus exposition format
 */
function formatLabels(labels: MetricLabels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  
  const formatted = entries
    .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
    .join(',');
  
  return `{${formatted}}`;
}

/**
 * Escape label values for Prometheus
 */
function escapeLabel(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

// ============================================================================
// SINGLETON REGISTRY & BUILT-IN METRICS
// ============================================================================

export const registry = new PrometheusRegistry();

// HTTP Request metrics
export const httpRequestsTotal = registry.counter(
  'http_requests_total',
  'Total number of HTTP requests',
  ['method', 'path', 'status']
);

export const httpRequestDuration = registry.histogram(
  'http_request_duration_seconds',
  'HTTP request duration in seconds',
  ['method', 'path'],
  [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
);

// Database metrics
export const dbQueryTotal = registry.counter(
  'db_queries_total',
  'Total number of database queries',
  ['operation', 'table']
);

export const dbQueryDuration = registry.histogram(
  'db_query_duration_seconds',
  'Database query duration in seconds',
  ['operation'],
  [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1]
);

export const dbConnectionsActive = registry.gauge(
  'db_connections_active',
  'Number of active database connections'
);

// Blockchain metrics
export const blockchainAnchorsTotal = registry.counter(
  'blockchain_anchors_total',
  'Total number of blockchain anchoring operations',
  ['status']
);

export const blockchainAnchorDuration = registry.histogram(
  'blockchain_anchor_duration_seconds',
  'Time to anchor events to blockchain',
  [],
  [0.5, 1, 2.5, 5, 10, 30, 60]
);

export const blockchainGasUsed = registry.counter(
  'blockchain_gas_used_total',
  'Total gas used for blockchain transactions'
);

// Event metrics
export const eventsTotal = registry.counter(
  'events_total',
  'Total number of events processed',
  ['type', 'severity', 'site_id']
);

export const eventsQueueSize = registry.gauge(
  'events_queue_size',
  'Number of events waiting to be anchored'
);

// Site metrics
export const sitesActive = registry.gauge(
  'sites_active',
  'Number of active sites'
);

export const assetsTotal = registry.gauge(
  'assets_total',
  'Total number of assets',
  ['site_id']
);

// Process metrics
export const processUptime = registry.gauge(
  'process_uptime_seconds',
  'Process uptime in seconds'
);

export const processMemoryUsage = registry.gauge(
  'process_memory_bytes',
  'Process memory usage in bytes',
  ['type']
);

export const processCpuUsage = registry.gauge(
  'process_cpu_usage_percent',
  'Process CPU usage percentage'
);

// ============================================================================
// METRICS COLLECTION
// ============================================================================

/**
 * Collect process metrics
 */
function collectProcessMetrics(): void {
  processUptime.set(process.uptime());
  
  const memUsage = process.memoryUsage();
  processMemoryUsage.set(memUsage.heapUsed, { type: 'heap_used' });
  processMemoryUsage.set(memUsage.heapTotal, { type: 'heap_total' });
  processMemoryUsage.set(memUsage.external, { type: 'external' });
  processMemoryUsage.set(memUsage.rss, { type: 'rss' });

  // CPU usage (approximate based on user/system time)
  const cpuUsage = process.cpuUsage();
  const totalCpuTime = (cpuUsage.user + cpuUsage.system) / 1000000; // Convert to seconds
  const uptime = process.uptime();
  if (uptime > 0) {
    processCpuUsage.set((totalCpuTime / uptime) * 100);
  }
}

// ============================================================================
// EXPRESS MIDDLEWARE & HANDLER
// ============================================================================

/**
 * Express middleware to record HTTP metrics
 */
export function metricsMiddleware() {
  return (req: Request, res: Response, next: () => void) => {
    const start = process.hrtime.bigint();
    
    res.on('finish', () => {
      const duration = Number(process.hrtime.bigint() - start) / 1e9;
      const path = normalizePath(req.route?.path || req.path);
      const method = req.method;
      const status = res.statusCode.toString();

      httpRequestsTotal.inc({ method, path, status });
      httpRequestDuration.observe(duration, { method, path });
    });

    next();
  };
}

/**
 * Normalize path to prevent high cardinality
 */
function normalizePath(path: string): string {
  // Replace numeric IDs with placeholder
  return path
    .replace(/\/\d+/g, '/:id')
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:uuid');
}

/**
 * Express handler for /metrics endpoint
 */
export function metricsHandler(_req: Request, res: Response): void {
  // Collect current process metrics
  collectProcessMetrics();

  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(registry.metrics());
}

export default {
  registry,
  metricsMiddleware,
  metricsHandler,
  // Metrics
  httpRequestsTotal,
  httpRequestDuration,
  dbQueryTotal,
  dbQueryDuration,
  dbConnectionsActive,
  blockchainAnchorsTotal,
  blockchainAnchorDuration,
  blockchainGasUsed,
  eventsTotal,
  eventsQueueSize,
  sitesActive,
  assetsTotal,
  processUptime,
  processMemoryUsage,
  processCpuUsage,
};
