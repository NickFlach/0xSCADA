/**
 * Benchmark harness — Issue #457 (Deterministic Blueprint Runtime).
 *
 * A tiny, dependency-free latency harness. We deliberately do NOT use a
 * throughput-oriented micro-bench library (tinybench / vitest bench): the SLO in
 * this issue is a *tail-latency* target (p99 tick < 1 ms), so we measure the
 * distribution of per-tick durations, not ops/sec.
 *
 * Design notes:
 *   - Each sample is one `tick()` timed with `performance.now()`.
 *   - Samples are stored in a pre-allocated Float64Array so the harness itself
 *     does not allocate inside the measurement loop (which would perturb the GC
 *     behaviour we are trying to characterise).
 *   - We expose `runLatencyBench()` for programmatic use (CI / asserting) and a
 *     `formatReport()` for human output.
 *
 * USAGE (manual, from the worktree root, once node_modules is present):
 *   npx tsx bench/blueprint-runtime/locked.bench.ts
 *   npx tsx bench/blueprint-runtime/baseline.bench.ts
 *   node --expose-gc --import tsx bench/blueprint-runtime/locked.bench.ts   # GC visibility
 */

import { PerformanceObserver } from "node:perf_hooks";

export interface LatencyStats {
  label: string;
  samples: number;
  /** Sorted percentile durations in milliseconds. */
  min: number;
  p50: number;
  p90: number;
  p99: number;
  p999: number;
  max: number;
  mean: number;
  /** Standard deviation in ms — a proxy for jitter. */
  stddev: number;
  /** GC pauses observed during the measured window, if instrumentation is active. */
  gcCount?: number;
  gcTotalMs?: number;
}

export interface LatencyBenchOptions {
  label: string;
  /** Function that performs exactly one unit of work to be timed. Must not allocate. */
  tick: () => void;
  /** Optional per-iteration setup run OUTSIDE the timed region (e.g. writeInputs). */
  beforeTick?: (i: number) => void;
  /** Warm-up iterations to reach JIT steady state before measuring. */
  warmup?: number;
  /** Measured iterations (sample count). */
  iterations?: number;
}

/** Percentile from a SORTED array using nearest-rank. */
function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

/**
 * Run a tail-latency benchmark. Returns the percentile distribution of a single
 * `tick()`. Allocation-free inside the measured loop.
 */
export function runLatencyBench(opts: LatencyBenchOptions): LatencyStats {
  const warmup = opts.warmup ?? 10_000;
  const iterations = opts.iterations ?? 100_000;

  // Optional GC instrumentation via PerformanceObserver. Best-effort; if the
  // 'gc' entry type is unavailable on this host we simply omit GC stats.
  let gcCount = 0;
  let gcTotalMs = 0;
  let observer: PerformanceObserver | undefined;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        gcCount++;
        gcTotalMs += entry.duration;
      }
    });
    observer.observe({ entryTypes: ["gc"], buffered: false });
  } catch {
    observer = undefined;
  }

  // Warm up (not measured).
  for (let i = 0; i < warmup; i++) {
    opts.beforeTick?.(i);
    opts.tick();
  }

  const samples = new Float64Array(iterations);
  for (let i = 0; i < iterations; i++) {
    opts.beforeTick?.(i);
    const start = performance.now();
    opts.tick();
    samples[i] = performance.now() - start;
  }

  observer?.disconnect();

  // Sort a copy for percentiles. This allocation happens AFTER the measured loop.
  const sorted = samples.slice().sort();

  let sum = 0;
  for (let i = 0; i < sorted.length; i++) sum += sorted[i];
  const mean = sum / sorted.length;
  let varSum = 0;
  for (let i = 0; i < sorted.length; i++) {
    const dx = sorted[i] - mean;
    varSum += dx * dx;
  }
  const stddev = Math.sqrt(varSum / sorted.length);

  return {
    label: opts.label,
    samples: iterations,
    min: sorted[0],
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
    p999: percentile(sorted, 99.9),
    max: sorted[sorted.length - 1],
    mean,
    stddev,
    gcCount: observer ? gcCount : undefined,
    gcTotalMs: observer ? gcTotalMs : undefined,
  };
}

const P99_SLO_MS = 1.0;

/** True when the measured p99 meets the issue's < 1 ms SLO. */
export function meetsSlo(stats: LatencyStats): boolean {
  return stats.p99 < P99_SLO_MS;
}

function ms(n: number): string {
  return `${n.toFixed(4)} ms`;
}

/** Human-readable, single-block report for a stats run. */
export function formatReport(stats: LatencyStats): string {
  const lines = [
    `── ${stats.label} ──`,
    `  samples : ${stats.samples.toLocaleString()}`,
    `  min     : ${ms(stats.min)}`,
    `  p50     : ${ms(stats.p50)}`,
    `  p90     : ${ms(stats.p90)}`,
    `  p99     : ${ms(stats.p99)}   (SLO < ${ms(P99_SLO_MS)})`,
    `  p99.9   : ${ms(stats.p999)}`,
    `  max     : ${ms(stats.max)}`,
    `  mean    : ${ms(stats.mean)}`,
    `  stddev  : ${ms(stats.stddev)}   (jitter proxy)`,
  ];
  if (stats.gcCount !== undefined) {
    lines.push(`  gc      : ${stats.gcCount} pause(s), ${ms(stats.gcTotalMs ?? 0)} total`);
  }
  lines.push(`  p99 SLO : ${meetsSlo(stats) ? "MET ✅" : "NOT MET ❌"}`);
  return lines.join("\n");
}

/**
 * Detect whether this module is being executed directly as a script (so the
 * .bench.ts entry points can `if (isMain(import.meta.url)) main()`), without a
 * hard dependency on a specific module system.
 */
export function isMain(metaUrl: string): boolean {
  try {
    const arg = process.argv[1];
    if (!arg) return false;
    // Compare normalised file paths (strip file:// and platform separators).
    const fromUrl = decodeURIComponent(metaUrl.replace(/^file:\/\/\/?/, "")).replace(/\\/g, "/");
    const fromArg = arg.replace(/\\/g, "/");
    return fromUrl.endsWith(fromArg) || fromArg.endsWith(fromUrl) || fromUrl.includes(fromArg);
  } catch {
    return false;
  }
}
