/**
 * 1,000,000 Tag Benchmark Scenario — ADR-0014 [14.1]
 */
import { createBenchmarkSuite, BenchmarkSuite } from '../benchmark-suite';

export async function run1mBenchmark() {
  const suite: BenchmarkSuite = new BenchmarkSuite({
    tagCount: 1_000_000,
    durationMs: 60000,
    warmupMs: 10000,
    concurrency: 50,
    reportIntervalMs: 10000,
  });
  suite.on('progress', ({ events, elapsedMs }) => {
    console.log(`[1M] ${events} events in ${elapsedMs}ms`);
  });
  const result = await suite.run('1m-tags');
  console.log(`[1M] Complete: ${result.throughput.eventsPerSecond.toFixed(0)} events/s, p99=${result.latency.p99.toFixed(2)}ms, heap=${result.memory.heapUsedMB.toFixed(0)}MB`);
  return result;
}

if (require.main === module) {
  run1mBenchmark().catch(console.error);
}
