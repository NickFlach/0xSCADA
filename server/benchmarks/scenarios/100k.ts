/**
 * 100,000 Tag Benchmark Scenario — ADR-0014 [14.1]
 */
import { createBenchmarkSuite } from '../benchmark-suite';

export async function run100kBenchmark() {
  const suite = createBenchmarkSuite(100_000);
  suite.on('progress', ({ events, elapsedMs }) => {
    console.log(`[100k] ${events} events in ${elapsedMs}ms`);
  });
  const result = await suite.run('100k-tags');
  console.log(`[100k] Complete: ${result.throughput.eventsPerSecond.toFixed(0)} events/s, p99=${result.latency.p99.toFixed(2)}ms`);
  return result;
}

if (require.main === module) {
  run100kBenchmark().catch(console.error);
}
