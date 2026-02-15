/**
 * Performance Benchmarking Suite — ADR-0014 [14.1]
 *
 * Measures event throughput, query latency, WebSocket fan-out,
 * and blockchain anchoring rate at scale.
 */

import { EventEmitter } from 'events';

export interface BenchmarkConfig {
  tagCount: number;
  durationMs: number;
  warmupMs: number;
  concurrency: number;
  reportIntervalMs: number;
}

export interface LatencyHistogram {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
  stddev: number;
  samples: number;
}

export interface BenchmarkResult {
  scenario: string;
  tagCount: number;
  durationMs: number;
  throughput: {
    eventsPerSecond: number;
    bytesPerSecond: number;
    totalEvents: number;
  };
  latency: LatencyHistogram;
  memory: {
    heapUsedMB: number;
    heapTotalMB: number;
    rssMB: number;
    externalMB: number;
  };
  websocket: {
    fanOutLatencyMs: LatencyHistogram;
    concurrentConnections: number;
    messagesDelivered: number;
  };
  blockchain: {
    anchoringRatePerSecond: number;
    avgAnchorLatencyMs: number;
    totalAnchored: number;
  };
  timestamp: number;
  regressionDetected: boolean;
  regressionDetails?: string;
}

export class BenchmarkSuite extends EventEmitter {
  private config: BenchmarkConfig;
  private latencySamples: number[] = [];
  private fanOutSamples: number[] = [];
  private baselineResults: BenchmarkResult | null = null;
  private running = false;

  constructor(config: BenchmarkConfig) {
    super();
    this.config = config;
  }

  async run(scenario: string): Promise<BenchmarkResult> {
    this.running = true;
    this.latencySamples = [];
    this.fanOutSamples = [];

    this.emit('start', { scenario, tagCount: this.config.tagCount });

    // Warmup phase
    await this.warmup();

    // Generate tags
    const tags = this.generateTags(this.config.tagCount);
    const startTime = Date.now();
    let totalEvents = 0;
    let totalBytes = 0;
    let anchoredCount = 0;
    const anchorLatencies: number[] = [];

    // Main benchmark loop
    while (Date.now() - startTime < this.config.durationMs && this.running) {
      const batchStart = performance.now();

      for (let i = 0; i < this.config.concurrency; i++) {
        const tag = tags[Math.floor(Math.random() * tags.length)];
        const event = this.generateEvent(tag);
        const eventBytes = JSON.stringify(event).length;

        const eventStart = performance.now();
        await this.processEvent(event);
        const eventLatency = performance.now() - eventStart;

        this.latencySamples.push(eventLatency);
        totalEvents++;
        totalBytes += eventBytes;

        // Simulate WebSocket fan-out
        const fanOutStart = performance.now();
        await this.simulateFanOut(event);
        this.fanOutSamples.push(performance.now() - fanOutStart);

        // Periodic blockchain anchoring (every 100 events)
        if (totalEvents % 100 === 0) {
          const anchorStart = performance.now();
          await this.simulateBlockchainAnchor(event);
          anchorLatencies.push(performance.now() - anchorStart);
          anchoredCount++;
        }
      }

      // Emit progress
      if (totalEvents % 1000 === 0) {
        this.emit('progress', {
          events: totalEvents,
          elapsedMs: Date.now() - startTime,
        });
      }
    }

    const elapsedMs = Date.now() - startTime;
    const memUsage = process.memoryUsage();

    const result: BenchmarkResult = {
      scenario,
      tagCount: this.config.tagCount,
      durationMs: elapsedMs,
      throughput: {
        eventsPerSecond: (totalEvents / elapsedMs) * 1000,
        bytesPerSecond: (totalBytes / elapsedMs) * 1000,
        totalEvents,
      },
      latency: this.computeHistogram(this.latencySamples),
      memory: {
        heapUsedMB: memUsage.heapUsed / 1024 / 1024,
        heapTotalMB: memUsage.heapTotal / 1024 / 1024,
        rssMB: memUsage.rss / 1024 / 1024,
        externalMB: memUsage.external / 1024 / 1024,
      },
      websocket: {
        fanOutLatencyMs: this.computeHistogram(this.fanOutSamples),
        concurrentConnections: this.config.concurrency,
        messagesDelivered: totalEvents,
      },
      blockchain: {
        anchoringRatePerSecond: (anchoredCount / elapsedMs) * 1000,
        avgAnchorLatencyMs:
          anchorLatencies.length > 0
            ? anchorLatencies.reduce((a, b) => a + b, 0) / anchorLatencies.length
            : 0,
        totalAnchored: anchoredCount,
      },
      timestamp: Date.now(),
      regressionDetected: false,
    };

    // Check for regression against baseline
    if (this.baselineResults) {
      const regression = this.detectRegression(result, this.baselineResults);
      result.regressionDetected = regression.detected;
      result.regressionDetails = regression.details;
    }

    this.emit('complete', result);
    this.running = false;
    return result;
  }

  setBaseline(baseline: BenchmarkResult): void {
    this.baselineResults = baseline;
  }

  stop(): void {
    this.running = false;
  }

  private async warmup(): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < this.config.warmupMs) {
      await this.processEvent(this.generateEvent({ id: 'warmup', name: 'warmup', type: 'analog' }));
    }
  }

  private generateTags(count: number): Array<{ id: string; name: string; type: string }> {
    const types = ['analog', 'digital', 'string', 'counter'];
    return Array.from({ length: count }, (_, i) => ({
      id: `tag-${i}`,
      name: `area${Math.floor(i / 100)}/sensor${i}`,
      type: types[i % types.length],
    }));
  }

  private generateEvent(tag: { id: string; name: string; type: string }): Record<string, unknown> {
    return {
      tagId: tag.id,
      tagName: tag.name,
      value: Math.random() * 1000,
      quality: 'good',
      timestamp: Date.now(),
      source: 'benchmark',
    };
  }

  private async processEvent(_event: Record<string, unknown>): Promise<void> {
    // Simulate event processing pipeline
    await new Promise((resolve) => setImmediate(resolve));
  }

  private async simulateFanOut(_event: Record<string, unknown>): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  private async simulateBlockchainAnchor(_event: Record<string, unknown>): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  computeHistogram(samples: number[]): LatencyHistogram {
    if (samples.length === 0) {
      return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0, stddev: 0, samples: 0 };
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    const variance = sorted.reduce((sum, v) => sum + (v - mean) ** 2, 0) / sorted.length;

    return {
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
      min: sorted[0],
      max: sorted[sorted.length - 1],
      mean,
      stddev: Math.sqrt(variance),
      samples: sorted.length,
    };
  }

  private detectRegression(
    current: BenchmarkResult,
    baseline: BenchmarkResult
  ): { detected: boolean; details?: string } {
    const issues: string[] = [];
    const threshold = 0.15; // 15% degradation threshold

    if (current.throughput.eventsPerSecond < baseline.throughput.eventsPerSecond * (1 - threshold)) {
      issues.push(
        `Throughput regression: ${current.throughput.eventsPerSecond.toFixed(0)} vs baseline ${baseline.throughput.eventsPerSecond.toFixed(0)} events/s`
      );
    }

    if (current.latency.p99 > baseline.latency.p99 * (1 + threshold)) {
      issues.push(
        `P99 latency regression: ${current.latency.p99.toFixed(2)}ms vs baseline ${baseline.latency.p99.toFixed(2)}ms`
      );
    }

    if (current.memory.heapUsedMB > baseline.memory.heapUsedMB * (1 + threshold)) {
      issues.push(
        `Memory regression: ${current.memory.heapUsedMB.toFixed(1)}MB vs baseline ${baseline.memory.heapUsedMB.toFixed(1)}MB`
      );
    }

    return {
      detected: issues.length > 0,
      details: issues.length > 0 ? issues.join('; ') : undefined,
    };
  }
}

export function createBenchmarkSuite(tagCount: number): BenchmarkSuite {
  return new BenchmarkSuite({
    tagCount,
    durationMs: 30000,
    warmupMs: 5000,
    concurrency: 10,
    reportIntervalMs: 5000,
  });
}
