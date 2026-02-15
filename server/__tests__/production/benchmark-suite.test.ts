import { describe, it, expect } from 'vitest';
import { BenchmarkSuite, createBenchmarkSuite } from '../../benchmarks/benchmark-suite';

describe('BenchmarkSuite', () => {
  it('should create a suite with specified tag count', () => {
    const suite = createBenchmarkSuite(1000);
    expect(suite).toBeInstanceOf(BenchmarkSuite);
  });

  it('should compute latency histogram correctly', () => {
    const suite = createBenchmarkSuite(100);
    const histogram = suite.computeHistogram([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    expect(histogram.min).toBe(1);
    expect(histogram.max).toBe(10);
    expect(histogram.mean).toBe(5.5);
    expect(histogram.samples).toBe(10);
    expect(histogram.p50).toBe(6);
    expect(histogram.p95).toBe(10);
  });

  it('should handle empty histogram', () => {
    const suite = createBenchmarkSuite(100);
    const histogram = suite.computeHistogram([]);

    expect(histogram.samples).toBe(0);
    expect(histogram.mean).toBe(0);
  });

  it('should run a short benchmark', async () => {
    const suite = new BenchmarkSuite({
      tagCount: 100,
      durationMs: 500,
      warmupMs: 100,
      concurrency: 2,
      reportIntervalMs: 1000,
    });

    const result = await suite.run('test-scenario');

    expect(result.scenario).toBe('test-scenario');
    expect(result.tagCount).toBe(100);
    expect(result.throughput.totalEvents).toBeGreaterThan(0);
    expect(result.throughput.eventsPerSecond).toBeGreaterThan(0);
    expect(result.latency.samples).toBeGreaterThan(0);
    expect(result.memory.heapUsedMB).toBeGreaterThan(0);
    expect(result.regressionDetected).toBe(false);
  });

  it('should detect regression against baseline', async () => {
    const suite = new BenchmarkSuite({
      tagCount: 100,
      durationMs: 300,
      warmupMs: 50,
      concurrency: 2,
      reportIntervalMs: 1000,
    });

    const result = await suite.run('baseline');

    // Set impossibly high baseline to trigger regression
    suite.setBaseline({
      ...result,
      throughput: { ...result.throughput, eventsPerSecond: result.throughput.eventsPerSecond * 100 },
    });

    const result2 = await suite.run('regression-test');
    expect(result2.regressionDetected).toBe(true);
    expect(result2.regressionDetails).toBeDefined();
  });
});
