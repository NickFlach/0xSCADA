/**
 * Control-Loop Stage Timestamps & Per-Stage SLO Instrument (#460)
 *
 * Pure, dependency-light core for measuring the latency of a control-loop
 * round-trip through the integrity pipeline:
 *
 *   tick -> batch -> sign -> anchor -> confirm
 *
 * Each stage emits two stamped timestamps (enter/exit), except the terminal
 * anchor stage which is bounded by `anchor-enter` and `anchor-confirmed`.
 * From those stamps we derive per-stage durations and a total round-trip,
 * then feed them into Prometheus histograms registered on the shared
 * registry (server/metrics/prometheus.ts).
 *
 * Design goals:
 *  - The trace + measurement logic is a PURE function of the recorded stamps,
 *    so it is unit-testable without Prometheus, the blockchain, or the HSM
 *    present (see __tests__/stage-timestamps.test.ts).
 *  - Wiring into the live anchor pipeline is additive: callers create a
 *    LatencyTrace, call mark(...) at the existing seams, and finally call
 *    observe(...) to publish histograms. No control-relevant code path is
 *    altered.
 *
 * Part of the Dual-Time Control Plane (ADR-0021).
 */

import { registry } from '../metrics/prometheus.js';

// ============================================================================
// STAGE MODEL
// ============================================================================

/**
 * The ordered set of stamp points emitted along a control-loop round-trip.
 * These names are stable and are also used as Prometheus label values and in
 * the Grafana dashboard / Alertmanager rules — do NOT rename without updating
 * ops/grafana/control-loop-latency.json and ops/alertmanager/control-loop-rules.yml.
 */
export type StampPoint =
  | 'tick-enter'
  | 'tick-exit'
  | 'batch-enter'
  | 'batch-exit'
  | 'sign-enter'
  | 'sign-exit'
  | 'anchor-enter'
  | 'anchor-confirmed';

export const STAMP_POINTS: readonly StampPoint[] = [
  'tick-enter',
  'tick-exit',
  'batch-enter',
  'batch-exit',
  'sign-enter',
  'sign-exit',
  'anchor-enter',
  'anchor-confirmed',
] as const;

/**
 * Logical pipeline stages. Each stage is the interval between its
 * enter-stamp and its exit/terminal-stamp.
 */
export type Stage = 'tick' | 'batch' | 'sign' | 'anchor' | 'total';

/**
 * (enter, exit) stamp pair backing each stage's duration.
 * `anchor` is bounded by anchor-enter -> anchor-confirmed.
 */
const STAGE_BOUNDS: Record<Exclude<Stage, 'total'>, [StampPoint, StampPoint]> = {
  tick: ['tick-enter', 'tick-exit'],
  batch: ['batch-enter', 'batch-exit'],
  sign: ['sign-enter', 'sign-exit'],
  anchor: ['anchor-enter', 'anchor-confirmed'],
};

export const PIPELINE_STAGES: readonly Exclude<Stage, 'total'>[] = [
  'tick',
  'batch',
  'sign',
  'anchor',
] as const;

/**
 * Per-stage latency Service Level Objectives, in milliseconds.
 * These are the budgets surfaced in the dashboard and enforced by the
 * Alertmanager "stage-budget breached" rule (>5min sustained breach).
 *
 * The sentinel round-trip is synthetic and isolated, so these are tight
 * targets reflecting an unloaded happy-path; tune via ops review.
 */
export const STAGE_SLO_MS: Record<Stage, number> = {
  tick: 50,
  batch: 100,
  sign: 150,
  anchor: 5000,
  total: 5500,
};

// ============================================================================
// MEASUREMENT TYPES
// ============================================================================

export interface StageMeasurement {
  stage: Stage;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Whether the duration is within the configured SLO budget. */
  withinSlo: boolean;
  /** Configured SLO budget for the stage, in milliseconds. */
  sloMs: number;
}

export interface LatencyMeasurement {
  traceId: string;
  validator: string;
  /** Per-stage durations (tick, batch, sign, anchor). */
  stages: StageMeasurement[];
  /** End-to-end round-trip: tick-enter -> anchor-confirmed. */
  total: StageMeasurement;
  /** True when every stage and the total are within budget. */
  withinSlo: boolean;
}

// ============================================================================
// CORE MEASUREMENT (pure — no Prometheus / IO)
// ============================================================================

/**
 * Compute a single stage's duration in milliseconds from a stamp map.
 * Throws when a required stamp is missing so partial traces never silently
 * report a misleading zero.
 */
export function stageDurationMs(
  stamps: Readonly<Partial<Record<StampPoint, number>>>,
  stage: Exclude<Stage, 'total'>,
): number {
  const [enter, exit] = STAGE_BOUNDS[stage];
  const enterTs = stamps[enter];
  const exitTs = stamps[exit];

  if (enterTs === undefined || exitTs === undefined) {
    throw new Error(
      `Cannot measure stage "${stage}": missing stamp ${enterTs === undefined ? enter : exit}`,
    );
  }

  const duration = exitTs - enterTs;
  if (duration < 0) {
    throw new Error(
      `Negative duration for stage "${stage}" (${enter}=${enterTs}, ${exit}=${exitTs})`,
    );
  }
  return duration;
}

/**
 * Compute the full per-stage measurement from a complete stamp map.
 * Pure: identical input always yields identical output, independent of
 * wall-clock time or external systems. This is the heart of the SLO
 * instrument and the primary unit-test surface.
 */
export function computeMeasurement(
  stamps: Readonly<Partial<Record<StampPoint, number>>>,
  meta: { traceId: string; validator: string },
): LatencyMeasurement {
  const stages: StageMeasurement[] = PIPELINE_STAGES.map((stage) => {
    const durationMs = stageDurationMs(stamps, stage);
    const sloMs = STAGE_SLO_MS[stage];
    return { stage, durationMs, withinSlo: durationMs <= sloMs, sloMs };
  });

  const tickEnter = stamps['tick-enter'];
  const anchorConfirmed = stamps['anchor-confirmed'];
  if (tickEnter === undefined || anchorConfirmed === undefined) {
    throw new Error(
      'Cannot measure total round-trip: missing tick-enter or anchor-confirmed stamp',
    );
  }
  const totalDuration = anchorConfirmed - tickEnter;
  if (totalDuration < 0) {
    throw new Error('Negative total round-trip duration');
  }
  const total: StageMeasurement = {
    stage: 'total',
    durationMs: totalDuration,
    withinSlo: totalDuration <= STAGE_SLO_MS.total,
    sloMs: STAGE_SLO_MS.total,
  };

  const withinSlo = total.withinSlo && stages.every((s) => s.withinSlo);

  return { traceId: meta.traceId, validator: meta.validator, stages, total, withinSlo };
}

// ============================================================================
// PROMETHEUS HISTOGRAMS
// ============================================================================

/**
 * Histogram bucket boundaries in SECONDS (Prometheus convention).
 * Covers sub-millisecond ticks through multi-second anchor confirmations.
 */
const LATENCY_BUCKETS_SECONDS = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
] as const;

/** Public structural metric types keep generated declarations self-contained. */
export interface MetricLabels {
  [key: string]: string;
}

export interface GaugeMetric {
  set(value: number, labels?: MetricLabels): void;
  get(labels?: MetricLabels): number;
}

export interface HistogramMetric {
  observe(value: number, labels?: MetricLabels): void;
  collect(): Array<{
    labels: MetricLabels;
    buckets: Map<number, number>;
    sum: number;
    count: number;
  }>;
}

/**
 * Per-stage latency histogram. Labelled by `stage` and `validator` so each
 * sentinel's pipeline stages can be sliced independently in Grafana.
 *
 * Metric name (with the registry's `scada` prefix):
 *   scada_control_loop_stage_latency_seconds
 */
export const stageLatencyHistogram: HistogramMetric = registry.histogram(
  'control_loop_stage_latency_seconds',
  'Per-stage control-loop latency (tick/batch/sign/anchor) in seconds',
  ['stage', 'validator'],
  [...LATENCY_BUCKETS_SECONDS],
);

/**
 * End-to-end round-trip latency histogram (tick-enter -> anchor-confirmed).
 *
 * Metric name: scada_control_loop_roundtrip_latency_seconds
 */
export const roundTripLatencyHistogram: HistogramMetric = registry.histogram(
  'control_loop_roundtrip_latency_seconds',
  'End-to-end control-loop round-trip latency (tick -> anchor-confirmed) in seconds',
  ['validator'],
  [...LATENCY_BUCKETS_SECONDS],
);

/**
 * Counter-style gauge tracking the most recent SLO compliance per stage
 * (1 = within budget, 0 = breached). Drives the Alertmanager rule, which
 * fires when a stage stays breached for >5min.
 *
 * Metric name: scada_control_loop_stage_slo_ok
 */
export const stageSloGauge: GaugeMetric = registry.gauge(
  'control_loop_stage_slo_ok',
  'Whether the last sampled stage latency was within its SLO budget (1=ok, 0=breach)',
  ['stage', 'validator'],
);

/**
 * Publish a computed measurement to Prometheus. Separated from
 * `computeMeasurement` so the pure measurement logic stays testable without a
 * registry. Durations are converted from milliseconds to seconds for
 * Prometheus convention.
 */
export function observeMeasurement(measurement: LatencyMeasurement): void {
  const { validator } = measurement;

  for (const s of measurement.stages) {
    stageLatencyHistogram.observe(s.durationMs / 1000, { stage: s.stage, validator });
    stageSloGauge.set(s.withinSlo ? 1 : 0, { stage: s.stage, validator });
  }

  roundTripLatencyHistogram.observe(measurement.total.durationMs / 1000, { validator });
  stageSloGauge.set(measurement.total.withinSlo ? 1 : 0, { stage: 'total', validator });
}

// ============================================================================
// LATENCY TRACE (stateful collector wired into the live pipeline)
// ============================================================================

/**
 * Pluggable clock so tests can inject deterministic time. Defaults to a
 * monotonic high-resolution clock (performance.now) to avoid wall-clock
 * jumps skewing sub-millisecond stage measurements.
 */
export type Clock = () => number;

const defaultClock: Clock =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

export interface LatencyTraceOptions {
  traceId: string;
  validator: string;
  clock?: Clock;
}

/**
 * Collects stamp points across the control-loop round-trip for a single
 * synthetic sentinel event. Created by the latency probe (or any caller
 * threading a trace through the pipeline) and finalized once the anchor is
 * confirmed.
 *
 * INTEGRATION (anchor pipeline): the existing pipeline/relayer code can hold a
 * LatencyTrace and call `mark()` at each seam with zero behavioural change.
 * Marking an unknown or duplicate stamp is a no-op-with-warning rather than a
 * throw, so instrumentation can never crash the control path.
 */
export class LatencyTrace {
  readonly traceId: string;
  readonly validator: string;
  private readonly clock: Clock;
  private readonly stamps: Partial<Record<StampPoint, number>> = {};

  constructor(opts: LatencyTraceOptions) {
    this.traceId = opts.traceId;
    this.validator = opts.validator;
    this.clock = opts.clock ?? defaultClock;
  }

  /**
   * Record a stamp point. If `at` is omitted the trace's clock is sampled.
   * Re-stamping the same point is ignored (first write wins) to keep
   * measurements stable under retries.
   */
  mark(point: StampPoint, at?: number): this {
    if (this.stamps[point] !== undefined) {
      return this; // first write wins; retries must not rewrite history
    }
    this.stamps[point] = at ?? this.clock();
    return this;
  }

  /** Whether a given stamp point has been recorded. */
  has(point: StampPoint): boolean {
    return this.stamps[point] !== undefined;
  }

  /** Read-only snapshot of recorded stamps (for inspection / tests). */
  snapshot(): Readonly<Partial<Record<StampPoint, number>>> {
    return { ...this.stamps };
  }

  /** True once every stamp point required for a full measurement exists. */
  isComplete(): boolean {
    return STAMP_POINTS.every((p) => this.stamps[p] !== undefined);
  }

  /**
   * Compute the per-stage measurement for this trace. Throws (via
   * computeMeasurement) if the trace is incomplete.
   */
  measure(): LatencyMeasurement {
    return computeMeasurement(this.stamps, {
      traceId: this.traceId,
      validator: this.validator,
    });
  }

  /**
   * Compute and publish the measurement to Prometheus, returning the
   * measurement for further inspection/logging by the caller.
   */
  finalize(): LatencyMeasurement {
    const measurement = this.measure();
    observeMeasurement(measurement);
    return measurement;
  }
}
