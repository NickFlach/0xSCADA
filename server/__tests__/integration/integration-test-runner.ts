/**
 * Integration Test Runner
 * 
 * Issue #44 — End-to-end API testing harness for 0xSCADA.
 * Provides helpers to spin up the server, make authenticated requests,
 * and assert on responses.
 */

import http from 'http';

// =============================================================================
// TYPES
// =============================================================================

export interface TestContext {
  baseUrl: string;
  headers: Record<string, string>;
}

export interface TestResult {
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
  statusCode?: number;
}

export interface TestSuiteResult {
  suiteName: string;
  results: TestResult[];
  totalDurationMs: number;
  passed: number;
  failed: number;
}

export interface RequestOptions {
  method?: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface ResponseData {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  json: <T = unknown>() => T;
  durationMs: number;
}

// =============================================================================
// HTTP CLIENT
// =============================================================================

export async function makeRequest(
  ctx: TestContext,
  options: RequestOptions
): Promise<ResponseData> {
  const start = performance.now();
  const url = new URL(options.path, ctx.baseUrl);

  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...ctx.headers,
          ...options.headers,
        },
        timeout: options.timeoutMs || 10000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          const durationMs = performance.now() - start;
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers as Record<string, string>,
            body,
            json: <T = unknown>() => JSON.parse(body) as T,
            durationMs,
          });
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

// =============================================================================
// TEST RUNNER
// =============================================================================

type TestFn = (ctx: TestContext) => Promise<void>;

interface TestCase {
  name: string;
  fn: TestFn;
}

export class IntegrationTestRunner {
  private tests: TestCase[] = [];
  private beforeAllFn?: (ctx: TestContext) => Promise<void>;
  private afterAllFn?: (ctx: TestContext) => Promise<void>;

  constructor(private suiteName: string) {}

  beforeAll(fn: (ctx: TestContext) => Promise<void>): void {
    this.beforeAllFn = fn;
  }

  afterAll(fn: (ctx: TestContext) => Promise<void>): void {
    this.afterAllFn = fn;
  }

  test(name: string, fn: TestFn): void {
    this.tests.push({ name, fn });
  }

  async run(ctx: TestContext): Promise<TestSuiteResult> {
    const suiteStart = performance.now();
    const results: TestResult[] = [];

    if (this.beforeAllFn) {
      await this.beforeAllFn(ctx);
    }

    for (const tc of this.tests) {
      const start = performance.now();
      try {
        await tc.fn(ctx);
        results.push({
          name: tc.name,
          passed: true,
          durationMs: performance.now() - start,
        });
      } catch (err: any) {
        results.push({
          name: tc.name,
          passed: false,
          durationMs: performance.now() - start,
          error: err.message || String(err),
        });
      }
    }

    if (this.afterAllFn) {
      await this.afterAllFn(ctx);
    }

    return {
      suiteName: this.suiteName,
      results,
      totalDurationMs: performance.now() - suiteStart,
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
    };
  }
}

// =============================================================================
// ASSERTION HELPERS
// =============================================================================

export function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

export function assertStatus(response: ResponseData, expected: number): void {
  assertEqual(response.statusCode, expected, `Expected status ${expected}, got ${response.statusCode}`);
}

export function assertOk(response: ResponseData): void {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Expected 2xx status, got ${response.statusCode}: ${response.body}`);
  }
}

export function assertContains(body: string, substring: string): void {
  if (!body.includes(substring)) {
    throw new Error(`Expected body to contain "${substring}"`);
  }
}

// =============================================================================
// SUITE PRINTER
// =============================================================================

export function printResults(result: TestSuiteResult): void {
  console.log(`\n━━━ ${result.suiteName} ━━━`);
  for (const r of result.results) {
    const icon = r.passed ? '✅' : '❌';
    console.log(`  ${icon} ${r.name} (${r.durationMs.toFixed(1)}ms)`);
    if (r.error) console.log(`     └─ ${r.error}`);
  }
  console.log(`\n  ${result.passed} passed, ${result.failed} failed (${result.totalDurationMs.toFixed(0)}ms)\n`);
}
