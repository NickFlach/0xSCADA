/**
 * Blueprint Tick Metrics (issue #458 — Tick-Aware Scheduler)
 *
 * Real-time scheduling telemetry for the deterministic blueprint control loop.
 * These metrics expose how well the control thread is meeting its tick budget
 * so operators can trust (or distrust) the real-time guarantees of the fabric.
 *
 * The acceptance criteria pin the EXACT metric names (no `scada_` prefix on the
 * gauges, `oxscada_` prefix on the histogram), so this module ships its own
 * tiny self-contained collector rather than going through the shared
 * `scada_`-prefixed registry in `prometheus.ts`. The exposition format matches
 * `prometheus.ts` exactly so a single `/metrics` scrape can concatenate both.
 *
 * Core jitter / deadline / WCET accounting is implemented as pure logic in the
 * `TickAccountant` class so it can be unit-tested without Prometheus or a clock.
 *
 * @module server/metrics/blueprint
 */

// ============================================================================
// EXACT METRIC NAMES (acceptance criteria)
// ============================================================================

export const METRIC_TICK_JITTER_NS = 'blueprint_tick_jitter_ns';
export const METRIC_TICK_MISSED_DEADLINES = 'blueprint_tick_missed_deadlines_total';
export const METRIC_TICK_WCET_NS = 'blueprint_tick_wcet_ns';
export const METRIC_TICK_DURATION_SECONDS = 'oxscada_blueprint_tick_duration_seconds';

// Default histogram buckets for tick duration, in SECONDS.
// Tuned for a sub-millisecond control loop (target < 1 ms p99) with headroom up
// to 50 ms so we still capture pathological GC pauses / scheduling stalls.
export const DEFAULT_TICK_DURATION_BUCKETS: readonly number[] = [
  0.000_05, // 50 µs
  0.000_1, // 100 µs
  0.000_25, // 250 µs
  0.000_5, // 500 µs
  0.001, // 1 ms
  0.002_5, // 2.5 ms
  0.005, // 5 ms
  0.01, // 10 ms
  0.025, // 25 ms
  0.05, // 50 ms
];

// ============================================================================
// LABEL HANDLING (mirrors prometheus.ts so exposition is byte-compatible)
// ============================================================================

export type MetricLabels = Record<string, string>;

function labelsToKey(labelNames: string[], labels: MetricLabels): string {
  return labelNames.map((name) => labels[name] ?? '').join('|');
}

function keyToLabels(labelNames: string[], key: string): MetricLabels {
  const values = key.split('|');
  const labels: MetricLabels = {};
  labelNames.forEach((name, i) => {
    if (values[i]) labels[name] = values[i];
  });
  return labels;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatLabels(labels: MetricLabels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  const formatted = entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',');
  return `{${formatted}}`;
}

// ============================================================================
// MINIMAL METRIC PRIMITIVES (un-prefixed; names are authoritative as given)
// ============================================================================

class BareGauge {
  private values = new Map<string, number>();

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: string[] = [],
  ) {}

  set(value: number, labels: MetricLabels = {}): void {
    this.values.set(labelsToKey(this.labelNames, labels), value);
  }

  get(labels: MetricLabels = {}): number {
    return this.values.get(labelsToKey(this.labelNames, labels)) ?? 0;
  }

  reset(): void {
    this.values.clear();
  }

  expose(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
    ];
    for (const [key, value] of this.values) {
      lines.push(`${this.name}${formatLabels(keyToLabels(this.labelNames, key))} ${value}`);
    }
    return lines.join('\n');
  }
}

class BareCounter {
  private values = new Map<string, number>();

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: string[] = [],
  ) {}

  inc(labels: MetricLabels = {}, value = 1): void {
    if (value < 0) throw new Error('Counter cannot decrease');
    const key = labelsToKey(this.labelNames, labels);
    this.values.set(key, (this.values.get(key) ?? 0) + value);
  }

  get(labels: MetricLabels = {}): number {
    return this.values.get(labelsToKey(this.labelNames, labels)) ?? 0;
  }

  reset(): void {
    this.values.clear();
  }

  expose(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];
    for (const [key, value] of this.values) {
      lines.push(`${this.name}${formatLabels(keyToLabels(this.labelNames, key))} ${value}`);
    }
    return lines.join('\n');
  }
}

class BareHistogram {
  private buckets = new Map<string, Map<number, number>>();
  private sums = new Map<string, number>();
  private counts = new Map<string, number>();
  /**
   * Boundaries including `+Inf`, precomputed once. `observe()` runs once per
   * control-loop tick, so it must not allocate a fresh array per observation.
   */
  private readonly allBoundaries: readonly number[];

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: string[] = [],
    public readonly bucketBoundaries: readonly number[] = DEFAULT_TICK_DURATION_BUCKETS,
  ) {
    this.allBoundaries = [...bucketBoundaries, Infinity];
  }

  observe(value: number, labels: MetricLabels = {}): void {
    const key = labelsToKey(this.labelNames, labels);
    if (!this.buckets.has(key)) {
      const bucketMap = new Map<number, number>();
      for (const b of this.allBoundaries) bucketMap.set(b, 0);
      this.buckets.set(key, bucketMap);
      this.sums.set(key, 0);
      this.counts.set(key, 0);
    }
    const bucketMap = this.buckets.get(key)!;
    for (const boundary of this.allBoundaries) {
      if (value <= boundary) bucketMap.set(boundary, (bucketMap.get(boundary) ?? 0) + 1);
    }
    this.sums.set(key, (this.sums.get(key) ?? 0) + value);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  count(labels: MetricLabels = {}): number {
    return this.counts.get(labelsToKey(this.labelNames, labels)) ?? 0;
  }

  sum(labels: MetricLabels = {}): number {
    return this.sums.get(labelsToKey(this.labelNames, labels)) ?? 0;
  }

  reset(): void {
    this.buckets.clear();
    this.sums.clear();
    this.counts.clear();
  }

  expose(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];
    for (const [key, buckets] of this.buckets) {
      const labels = keyToLabels(this.labelNames, key);
      for (const [le, bucketCount] of buckets) {
        const leLabel = le === Infinity ? '+Inf' : le.toString();
        lines.push(`${this.name}_bucket${formatLabels({ ...labels, le: leLabel })} ${bucketCount}`);
      }
      lines.push(`${this.name}_sum${formatLabels(labels)} ${this.sums.get(key) ?? 0}`);
      lines.push(`${this.name}_count${formatLabels(labels)} ${this.counts.get(key) ?? 0}`);
    }
    return lines.join('\n');
  }
}

// ============================================================================
// METRIC INSTANCES
// ============================================================================

const LABELS = ['blueprint'] as const;

/** Most-recent observed tick jitter (deviation from the target period), ns. */
export const blueprintTickJitterNs = new BareGauge(
  METRIC_TICK_JITTER_NS,
  'Most recent blueprint control-loop tick jitter (deviation of actual period from target), in nanoseconds',
  [...LABELS],
);

/** Monotonic count of ticks whose duration exceeded the configured deadline. */
export const blueprintTickMissedDeadlinesTotal = new BareCounter(
  METRIC_TICK_MISSED_DEADLINES,
  'Total number of blueprint control-loop ticks that exceeded their deadline budget',
  [...LABELS],
);

/** Worst-case execution time observed within the rolling window, ns. */
export const blueprintTickWcetNs = new BareGauge(
  METRIC_TICK_WCET_NS,
  'Worst-case blueprint tick execution time observed within the rolling window, in nanoseconds',
  [...LABELS],
);

/** Distribution of tick execution durations, in seconds. */
export const blueprintTickDurationSeconds = new BareHistogram(
  METRIC_TICK_DURATION_SECONDS,
  'Distribution of blueprint control-loop tick execution durations, in seconds',
  [...LABELS],
  DEFAULT_TICK_DURATION_BUCKETS,
);

/**
 * Render all blueprint tick metrics in Prometheus exposition format.
 * Returned string carries no trailing newline (matches `prometheus.ts`).
 */
export function exposeBlueprintMetrics(): string {
  return [
    blueprintTickJitterNs.expose(),
    blueprintTickMissedDeadlinesTotal.expose(),
    blueprintTickWcetNs.expose(),
    blueprintTickDurationSeconds.expose(),
  ].join('\n');
}

/** Reset all blueprint metric values (primarily for tests). */
export function resetBlueprintMetrics(): void {
  blueprintTickJitterNs.reset();
  blueprintTickMissedDeadlinesTotal.reset();
  blueprintTickWcetNs.reset();
  blueprintTickDurationSeconds.reset();
}

// ============================================================================
// TICK ACCOUNTANT — pure jitter / deadline / WCET accounting (unit-testable)
// ============================================================================

export interface TickSample {
  /** Tick execution duration in nanoseconds (how long the tick body ran). */
  durationNs: number;
  /**
   * Actual elapsed wall time since the previous tick START, in nanoseconds.
   * Used to compute period jitter against the target period. Omit for the
   * first sample (no previous tick to measure a period against).
   */
  periodNs?: number;
}

export interface TickStats {
  /** Total ticks accounted for since construction. */
  totalTicks: number;
  /** Ticks that exceeded the deadline budget. */
  missedDeadlines: number;
  /** Most recent period jitter (signed) in nanoseconds. */
  lastJitterNs: number;
  /** Worst-case execution time within the current rolling window, in ns. */
  wcetNs: number;
  /** Number of duration samples currently retained in the window. */
  windowSize: number;
}

export interface TickAccountantOptions {
  /**
   * Target tick period in nanoseconds. Jitter is measured as the absolute
   * deviation of the observed period from this value.
   */
  targetPeriodNs: number;
  /**
   * Deadline budget in nanoseconds. A tick whose execution duration exceeds
   * this budget counts as a missed deadline. Defaults to `targetPeriodNs`.
   */
  deadlineNs?: number;
  /**
   * Rolling window size (number of recent ticks) over which WCET is computed.
   * WCET is "worst-case in window" per the acceptance criteria. Default 1000.
   */
  windowSize?: number;
}

/**
 * Pure accounting for control-loop tick health.
 *
 * Tracks period jitter, deadline misses, and a windowed worst-case execution
 * time. Holds no clock and no metric handles — callers feed it samples and read
 * back stats, then mirror those onto Prometheus gauges. This separation keeps
 * the math deterministically testable.
 */
export class TickAccountant {
  private readonly targetPeriodNs: number;
  private readonly deadlineNs: number;
  private readonly windowCapacity: number;

  // Ring buffer of recent durations for windowed WCET.
  private readonly window: number[] = [];
  private windowHead = 0;

  private totalTicks = 0;
  private missedDeadlines = 0;
  private lastJitterNs = 0;

  constructor(options: TickAccountantOptions) {
    if (options.targetPeriodNs <= 0) {
      throw new Error('targetPeriodNs must be > 0');
    }
    this.targetPeriodNs = options.targetPeriodNs;
    this.deadlineNs = options.deadlineNs ?? options.targetPeriodNs;
    if (this.deadlineNs <= 0) {
      throw new Error('deadlineNs must be > 0');
    }
    this.windowCapacity = Math.max(1, Math.floor(options.windowSize ?? 1000));
  }

  /**
   * Record one tick. Returns the period jitter (signed, ns) for this tick.
   * Jitter is `periodNs - targetPeriodNs`; positive means the tick ran late.
   */
  record(sample: TickSample): TickStats {
    if (sample.durationNs < 0 || !Number.isFinite(sample.durationNs)) {
      throw new Error('durationNs must be a finite, non-negative number');
    }

    this.totalTicks += 1;

    if (sample.durationNs > this.deadlineNs) {
      this.missedDeadlines += 1;
    }

    if (sample.periodNs !== undefined) {
      if (!Number.isFinite(sample.periodNs) || sample.periodNs < 0) {
        throw new Error('periodNs must be a finite, non-negative number');
      }
      this.lastJitterNs = sample.periodNs - this.targetPeriodNs;
    }

    // Push duration into the rolling window (ring buffer to bound memory).
    if (this.window.length < this.windowCapacity) {
      this.window.push(sample.durationNs);
    } else {
      this.window[this.windowHead] = sample.durationNs;
      this.windowHead = (this.windowHead + 1) % this.windowCapacity;
    }

    return this.stats();
  }

  /** Current accounting snapshot (does not mutate state). */
  stats(): TickStats {
    return {
      totalTicks: this.totalTicks,
      missedDeadlines: this.missedDeadlines,
      lastJitterNs: this.lastJitterNs,
      wcetNs: this.wcet(),
      windowSize: this.window.length,
    };
  }

  /** Worst-case execution time across the retained window, in nanoseconds. */
  wcet(): number {
    let max = 0;
    for (const d of this.window) {
      if (d > max) max = d;
    }
    return max;
  }

  /** Clear the rolling window without resetting cumulative counters. */
  resetWindow(): void {
    this.window.length = 0;
    this.windowHead = 0;
  }
}

/**
 * Convenience: record a tick on a `TickAccountant` and mirror the resulting
 * stats onto the Prometheus metric handles for the given blueprint id.
 *
 * Kept here (not inside `TickAccountant`) so the accountant stays metric-free
 * and unit-testable. The missed-deadline counter is advanced by the DELTA in
 * the accountant's cumulative `missedDeadlines`, so the counter and the
 * accountant never drift even if a tick is recorded out-of-band elsewhere.
 */
export function publishTickStats(
  accountant: TickAccountant,
  sample: TickSample,
  labels: MetricLabels = {},
): TickStats {
  const before = accountant.stats().missedDeadlines;
  const stats = accountant.record(sample);
  const missedDelta = stats.missedDeadlines - before;

  blueprintTickJitterNs.set(stats.lastJitterNs, labels);
  blueprintTickWcetNs.set(stats.wcetNs, labels);
  if (missedDelta > 0) {
    blueprintTickMissedDeadlinesTotal.inc(labels, missedDelta);
  }
  blueprintTickDurationSeconds.observe(sample.durationNs / 1e9, labels);
  return stats;
}
