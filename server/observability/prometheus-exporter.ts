/**
 * Prometheus Metrics Exporter
 *
 * Exposes /metrics endpoint with SCADA-relevant metrics in Prometheus text format.
 * Issues: #25
 */

/** Metric types */
export enum MetricType {
  COUNTER = 'counter',
  GAUGE = 'gauge',
  HISTOGRAM = 'histogram',
  SUMMARY = 'summary',
}

/** Metric definition */
interface MetricDef {
  name: string;
  help: string;
  type: MetricType;
}

/** Histogram bucket */
interface HistogramBucket {
  le: number;
  count: number;
}

/**
 * Simple Prometheus metrics registry.
 */
export class PrometheusRegistry {
  private counters = new Map<string, { value: number; labels: Record<string, string> }[]>();
  private gauges = new Map<string, { value: number; labels: Record<string, string> }[]>();
  private histograms = new Map<
    string,
    { sum: number; count: number; buckets: HistogramBucket[]; labels: Record<string, string> }[]
  >();
  private definitions = new Map<string, MetricDef>();

  private define(name: string, help: string, type: MetricType) {
    this.definitions.set(name, { name, help, type });
  }

  /** Increment a counter */
  incCounter(name: string, labels: Record<string, string> = {}, value = 1) {
    this.define(name, name, MetricType.COUNTER);
    const entries = this.counters.get(name) || [];
    const key = JSON.stringify(labels);
    const existing = entries.find((e) => JSON.stringify(e.labels) === key);
    if (existing) {
      existing.value += value;
    } else {
      entries.push({ value, labels });
      this.counters.set(name, entries);
    }
  }

  /** Set a gauge value */
  setGauge(name: string, value: number, labels: Record<string, string> = {}) {
    this.define(name, name, MetricType.GAUGE);
    const entries = this.gauges.get(name) || [];
    const key = JSON.stringify(labels);
    const existing = entries.find((e) => JSON.stringify(e.labels) === key);
    if (existing) {
      existing.value = value;
    } else {
      entries.push({ value, labels });
      this.gauges.set(name, entries);
    }
  }

  /** Observe a histogram value */
  observeHistogram(
    name: string,
    value: number,
    labels: Record<string, string> = {},
    bucketBounds = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
  ) {
    this.define(name, name, MetricType.HISTOGRAM);
    const entries = this.histograms.get(name) || [];
    const key = JSON.stringify(labels);
    let existing = entries.find((e) => JSON.stringify(e.labels) === key);
    if (!existing) {
      existing = {
        sum: 0,
        count: 0,
        buckets: bucketBounds.map((le) => ({ le, count: 0 })),
        labels,
      };
      entries.push(existing);
      this.histograms.set(name, entries);
    }
    existing.sum += value;
    existing.count++;
    for (const bucket of existing.buckets) {
      if (value <= bucket.le) bucket.count++;
    }
  }

  /**
   * Serialize all metrics to Prometheus text exposition format.
   */
  serialize(): string {
    const lines: string[] = [];

    const formatLabels = (labels: Record<string, string>) => {
      const pairs = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
      return pairs.length > 0 ? `{${pairs.join(',')}}` : '';
    };

    // Counters
    for (const [name, entries] of this.counters) {
      const def = this.definitions.get(name)!;
      lines.push(`# HELP ${name} ${def.help}`);
      lines.push(`# TYPE ${name} counter`);
      for (const e of entries) {
        lines.push(`${name}${formatLabels(e.labels)} ${e.value}`);
      }
    }

    // Gauges
    for (const [name, entries] of this.gauges) {
      const def = this.definitions.get(name)!;
      lines.push(`# HELP ${name} ${def.help}`);
      lines.push(`# TYPE ${name} gauge`);
      for (const e of entries) {
        lines.push(`${name}${formatLabels(e.labels)} ${e.value}`);
      }
    }

    // Histograms
    for (const [name, entries] of this.histograms) {
      const def = this.definitions.get(name)!;
      lines.push(`# HELP ${name} ${def.help}`);
      lines.push(`# TYPE ${name} histogram`);
      for (const e of entries) {
        const lbl = formatLabels(e.labels);
        for (const b of e.buckets) {
          const bucketLabels = { ...e.labels, le: b.le.toString() };
          lines.push(`${name}_bucket${formatLabels(bucketLabels)} ${b.count}`);
        }
        lines.push(`${name}_bucket${formatLabels({ ...e.labels, le: '+Inf' })} ${e.count}`);
        lines.push(`${name}_sum${lbl} ${e.sum}`);
        lines.push(`${name}_count${lbl} ${e.count}`);
      }
    }

    return lines.join('\n') + '\n';
  }

  /** Reset all metrics */
  reset() {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.definitions.clear();
  }
}

/**
 * Pre-configured SCADA metrics registry.
 */
export function createSCADAMetrics(): {
  registry: PrometheusRegistry;
  metrics: SCADAMetrics;
} {
  const registry = new PrometheusRegistry();

  const metrics: SCADAMetrics = {
    recordRequestLatency(method: string, path: string, statusCode: number, durationSeconds: number) {
      registry.observeHistogram('scada_http_request_duration_seconds', durationSeconds, {
        method,
        path,
        status: statusCode.toString(),
      });
    },

    setActiveConnections(count: number) {
      registry.setGauge('scada_active_connections', count);
    },

    incTagReads(gateway: string, count = 1) {
      registry.incCounter('scada_tag_reads_total', { gateway }, count);
    },

    incTagWrites(gateway: string, count = 1) {
      registry.incCounter('scada_tag_writes_total', { gateway }, count);
    },

    incAlarmCount(severity: string) {
      registry.incCounter('scada_alarms_total', { severity });
    },

    setGatewayConnectionStatus(gateway: string, connected: boolean) {
      registry.setGauge('scada_gateway_connected', connected ? 1 : 0, { gateway });
    },
  };

  return { registry, metrics };
}

/** Typed SCADA metrics interface */
export interface SCADAMetrics {
  recordRequestLatency(method: string, path: string, statusCode: number, durationSeconds: number): void;
  setActiveConnections(count: number): void;
  incTagReads(gateway: string, count?: number): void;
  incTagWrites(gateway: string, count?: number): void;
  incAlarmCount(severity: string): void;
  setGatewayConnectionStatus(gateway: string, connected: boolean): void;
}

/**
 * Express middleware for request latency tracking.
 */
export function metricsMiddleware(metrics: SCADAMetrics) {
  return (req: any, res: any, next: any) => {
    const start = process.hrtime.bigint();
    const originalEnd = res.end;

    res.end = function (...args: any[]) {
      const duration = Number(process.hrtime.bigint() - start) / 1e9;
      metrics.recordRequestLatency(req.method, req.route?.path || req.path, res.statusCode, duration);
      return originalEnd.apply(this, args);
    };

    next();
  };
}

/**
 * Express handler for /metrics endpoint.
 */
export function metricsHandler(registry: PrometheusRegistry) {
  return (_req: any, res: any) => {
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(registry.serialize());
  };
}
