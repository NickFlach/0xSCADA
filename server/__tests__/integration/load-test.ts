/**
 * Load Test Runner
 * 
 * Issue #44 — Simple load testing with concurrent requests.
 * Measures p50, p95, p99 latencies and throughput.
 */

import { makeRequest, TestContext, ResponseData } from './integration-test-runner';

// =============================================================================
// TYPES
// =============================================================================

export interface LoadTestConfig {
  /** Total number of requests to send */
  totalRequests: number;
  /** Max concurrent requests in flight */
  concurrency: number;
  /** Request definition */
  request: {
    method?: string;
    path: string;
    body?: unknown;
  };
  /** Ramp-up time in ms (0 = all at once) */
  rampUpMs?: number;
  /** Timeout per request in ms */
  timeoutMs?: number;
}

export interface LoadTestResult {
  totalRequests: number;
  successCount: number;
  errorCount: number;
  totalDurationMs: number;
  requestsPerSecond: number;
  latencies: {
    min: number;
    max: number;
    mean: number;
    p50: number;
    p95: number;
    p99: number;
  };
  statusCodes: Record<number, number>;
  errors: string[];
}

// =============================================================================
// PERCENTILE CALCULATION
// =============================================================================

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// =============================================================================
// LOAD TEST RUNNER
// =============================================================================

export async function runLoadTest(
  ctx: TestContext,
  config: LoadTestConfig
): Promise<LoadTestResult> {
  const latencies: number[] = [];
  const statusCodes: Record<number, number> = {};
  const errors: string[] = [];
  let successCount = 0;
  let errorCount = 0;

  const start = performance.now();

  // Create a semaphore for concurrency control
  let inFlight = 0;
  const queue: Array<() => void> = [];

  function release() {
    inFlight--;
    if (queue.length > 0) {
      const next = queue.shift()!;
      next();
    }
  }

  function acquire(): Promise<void> {
    if (inFlight < config.concurrency) {
      inFlight++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      queue.push(() => {
        inFlight++;
        resolve();
      });
    });
  }

  const rampDelay = config.rampUpMs
    ? config.rampUpMs / config.totalRequests
    : 0;

  const promises: Promise<void>[] = [];

  for (let i = 0; i < config.totalRequests; i++) {
    if (rampDelay > 0) {
      await new Promise((r) => setTimeout(r, rampDelay));
    }

    await acquire();

    const p = (async () => {
      try {
        const res: ResponseData = await makeRequest(ctx, {
          method: config.request.method || 'GET',
          path: config.request.path,
          body: config.request.body,
          timeoutMs: config.timeoutMs || 10000,
        });

        latencies.push(res.durationMs);
        statusCodes[res.statusCode] = (statusCodes[res.statusCode] || 0) + 1;

        if (res.statusCode >= 200 && res.statusCode < 400) {
          successCount++;
        } else {
          errorCount++;
          if (errors.length < 10) {
            errors.push(`HTTP ${res.statusCode}: ${res.body.slice(0, 200)}`);
          }
        }
      } catch (err: any) {
        errorCount++;
        if (errors.length < 10) {
          errors.push(err.message || String(err));
        }
      } finally {
        release();
      }
    })();

    promises.push(p);
  }

  await Promise.all(promises);

  const totalDurationMs = performance.now() - start;
  const sorted = latencies.slice().sort((a, b) => a - b);

  return {
    totalRequests: config.totalRequests,
    successCount,
    errorCount,
    totalDurationMs,
    requestsPerSecond: (config.totalRequests / totalDurationMs) * 1000,
    latencies: {
      min: sorted[0] || 0,
      max: sorted[sorted.length - 1] || 0,
      mean: sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
    },
    statusCodes,
    errors,
  };
}

// =============================================================================
// PRINTER
// =============================================================================

export function printLoadTestResult(result: LoadTestResult): void {
  console.log('\n━━━ Load Test Results ━━━');
  console.log(`  Total Requests:    ${result.totalRequests}`);
  console.log(`  Successes:         ${result.successCount}`);
  console.log(`  Errors:            ${result.errorCount}`);
  console.log(`  Duration:          ${result.totalDurationMs.toFixed(0)}ms`);
  console.log(`  Throughput:        ${result.requestsPerSecond.toFixed(1)} req/s`);
  console.log(`  Latency (min):     ${result.latencies.min.toFixed(1)}ms`);
  console.log(`  Latency (p50):     ${result.latencies.p50.toFixed(1)}ms`);
  console.log(`  Latency (p95):     ${result.latencies.p95.toFixed(1)}ms`);
  console.log(`  Latency (p99):     ${result.latencies.p99.toFixed(1)}ms`);
  console.log(`  Latency (max):     ${result.latencies.max.toFixed(1)}ms`);
  console.log(`  Status Codes:      ${JSON.stringify(result.statusCodes)}`);
  if (result.errors.length > 0) {
    console.log(`  Sample Errors:`);
    result.errors.slice(0, 5).forEach((e) => console.log(`    - ${e}`));
  }
  console.log('');
}
