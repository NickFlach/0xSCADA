# Integration & Load Testing Guide

## Overview

0xSCADA provides an integration test runner and load test framework for end-to-end API validation and performance benchmarking.

## Files

- `server/__tests__/integration/integration-test-runner.ts` — Test harness with HTTP client, assertions, suite runner
- `server/__tests__/integration/load-test.ts` — Concurrent load testing with latency percentiles

## Running Integration Tests

```typescript
import { IntegrationTestRunner, makeRequest, assertOk, assertStatus, printResults } from './integration-test-runner';

const suite = new IntegrationTestRunner('API Health');
const ctx = { baseUrl: 'http://localhost:3000', headers: {} };

suite.test('GET /api/health returns 200', async (ctx) => {
  const res = await makeRequest(ctx, { path: '/api/health' });
  assertStatus(res, 200);
});

suite.test('POST /api/tags requires auth', async (ctx) => {
  const res = await makeRequest(ctx, { method: 'POST', path: '/api/tags', body: {} });
  assertStatus(res, 401);
});

const results = await suite.run(ctx);
printResults(results);
```

## Running Load Tests

```typescript
import { runLoadTest, printLoadTestResult } from './load-test';

const result = await runLoadTest(
  { baseUrl: 'http://localhost:3000', headers: {} },
  {
    totalRequests: 1000,
    concurrency: 50,
    request: { method: 'GET', path: '/api/health' },
    rampUpMs: 2000,
  }
);

printLoadTestResult(result);
// Output: p50, p95, p99 latencies, throughput, error rate
```

## Interpreting Results

| Metric | Good | Acceptable | Investigate |
|--------|------|------------|-------------|
| p50 | <50ms | <200ms | >200ms |
| p95 | <200ms | <500ms | >500ms |
| p99 | <500ms | <1s | >1s |
| Error Rate | 0% | <1% | >1% |

## CI Integration

Add to your CI pipeline:
```bash
npx tsx server/__tests__/integration/integration-test-runner.ts
```
