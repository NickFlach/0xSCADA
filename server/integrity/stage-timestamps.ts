/**
 * Control-Loop Stage Timestamps & Per-Stage SLO Instrument (#460)
 *
 * Measures the latency of each stage of the REAL integrity/anchor pipeline that
 * exists on this branch (server/integrity/anchor-pipeline.ts):
 *
 *   batch -> sign -> anchor -> confirm
 *
 *   batch    Merkle root construction over the flushed batch's event hashes
 *            (MerkleTreeBuilder.rootBytes32).
 *   sign     MerkleRootSigner.signMerkleRoot — HSM / software RSA signature.
 *   anchor   AnchorRelayerService.submitAnchor — the hand-off of the signed
 *            root into the relayer's submission queue. NOTE this is the
 *            enqueue only: submitAnchor coalesces the request and kicks
 *            processQueue() WITHOUT awaiting it, so signature verification,
 *            gas estimation and the transaction itself run asynchronously and
 *            land in `confirm`, not here. Measured at ~1ms in practice; the
 *            budget below is sized for a hand-off, so a breach means the event
 *            loop is stalled, not that the chain is slow.
 *   confirm  submit -> the relayer's per-batch `anchorSuccess` event. Covers
 *            signature verification, gas estimation, transaction submission
 *            and the confirmation-block wait.
 *
 * WHAT IS DELIBERATELY *NOT* MEASURED
 * -----------------------------------
 * The original issue described a `tick` stage (field I/O -> control loop) ahead
 * of `batch`. There is no control loop feeding the anchor pipeline on this
 * branch — BlueprintRuntime (#457) is not wired to it — so there is nothing to
 * time. A `tick` number here could only be invented, so the stage is reported
 * nowhere: not as a metric, not on the dashboard, not in the alert rules. See
 * UNMEASURED_STAGES below; add the stage here (and to the dashboard/rules) once
 * a real control loop exists to measure.
 *
 * Everything in this module is measurement only: every duration is the
 * difference between two timestamps taken around real work. Nothing is
 * synthesised, defaulted, or back-filled.
 *
 * Part of the Dual-Time Control Plane (ADR-0021).
 */

import { registry } from '../metrics/prometheus.js';

// ============================================================================
// STAGE MODEL
// ============================================================================

/**
 * Timestamps taken along one batch's trip through the anchor pipeline.
 * These names are stable and are also used as Prometheus label values and in
 * the Grafana dashboard / Alertmanager rules — do NOT rename without updating
 * ops/grafana/control-loop-latency.json and ops/alertmanager/control-loop-rules.yml.
 */
export type StampPoint =
  | 'batch-enter'
  | 'batch-exit'
  | 'sign-enter'
  | 'sign-exit'
  | 'anchor-enter'
  | 'anchor-exit'
  | 'confirm-enter'
  | 'confirm-exit';

export const STAMP_POINTS: readonly StampPoint[] = [
  'batch-enter',
  'batch-exit',
  'sign-enter',
  'sign-exit',
  'anchor-enter',
  'anchor-exit',
  'confirm-enter',
  'confirm-exit',
] as const;

/** Pipeline stages that are actually instrumented and emitted. */
export type PipelineStage = 'batch' | 'sign' | 'anchor' | 'confirm';

/** Everything that can appear as a `stage` label value. */
export type Stage = PipelineStage | 'total';

export const PIPELINE_STAGES: readonly PipelineStage[] = [
  'batch',
  'sign',
  'anchor',
  'confirm',
] as const;

/**
 * Stages named by the issue that CANNOT be measured on this branch, with the
 * reason. Nothing is emitted for them — no metric, no panel, no alert rule.
 * This list is asserted by the tests so a stage can never be quietly faked.
 */
export const UNMEASURED_STAGES: Readonly<Record<string, string>> = Object.freeze({
  tick:
    'No control loop feeds the anchor pipeline on this branch (BlueprintRuntime, #457, '
    + 'is not wired to it), so there is no field-I/O-to-loop interval to time. Emitting a '
    + 'number here would be fabricated.',
});

/** (enter, exit) stamp pair backing each stage's duration. */
const STAGE_BOUNDS: Record<PipelineStage, readonly [StampPoint, StampPoint]> = {
  batch: ['batch-enter', 'batch-exit'],
  sign: ['sign-enter', 'sign-exit'],
  anchor: ['anchor-enter', 'anchor-exit'],
  confirm: ['confirm-enter', 'confirm-exit'],
};

/** End-to-end: the start of batching through on-chain confirmation. */
const TOTAL_BOUNDS: readonly [StampPoint, StampPoint] = ['batch-enter', 'confirm-exit'];

/**
 * Per-stage latency budgets, in milliseconds. These are the budgets surfaced on
 * the dashboard and enforced by the Alertmanager "stage budget breached" rule.
 *
 * `confirm` and `total` are sized for the 5s-block Clique chain this repo
 * targets with the relayer's default 2 confirmation blocks (~10s) plus slack;
 * `batch`/`sign` are local CPU/HSM work. Tune via ops review — and mirror any
 * change into ops/alertmanager/control-loop-rules.yml.
 */
export const STAGE_SLO_MS: Record<Stage, number> = {
  batch: 100,
  sign: 150,
  // `anchor` is the enqueue hand-off only (see the header): the real
  // submission is asynchronous and is accounted to `confirm`. Sized for a
  // hand-off — 500ms here would have been ~500x the observed value and could
  // never have breached, i.e. a rule that cannot fire.
  anchor: 100,
  confirm: 30_000,
  total: 30_500,
};

// ============================================================================
// MEASUREMENT TYPES
// ============================================================================

export interface StageMeasurement {
  stage: Stage;
  /** Duration in milliseconds, measured between two real timestamps. */
  durationMs: number;
  /** Whether the duration is within the configured SLO budget. */
  withinSlo: boolean;
  /** Configured SLO budget for the stage, in milliseconds. */
  sloMs: number;
}

export interface LatencyMeasurement {
  traceId: string;
  /** Producer identity, used as the `source` Prometheus label. */
  source: string;
  /** Stages that were genuinely measured. Never contains invented entries. */
  stages: StageMeasurement[];
  /** End-to-end batch-enter -> confirm-exit, or null when never confirmed. */
  total: StageMeasurement | null;
  /** Stages whose stamps are missing — reported nowhere rather than as zero. */
  unmeasured: PipelineStage[];
  /**
   * Stages whose exit stamp preceded their enter stamp. Only reachable when a
   * downstream event races the call that stamps the stage exit; such a stage is
   * dropped rather than clamped, so no misleading value is ever published.
   */
  anomalies: PipelineStage[];
  /** True when all four stages and the round-trip were measured. */
  complete: boolean;
  /** True when every measured stage (and the total, if any) met its budget. */
  withinSlo: boolean;
}

export type StampMap = Readonly<Partial<Record<StampPoint, number>>>;

// ============================================================================
// CORE MEASUREMENT (pure — no Prometheus / IO)
// ============================================================================

/**
 * Duration of one stage in milliseconds, or null when either bound is missing
 * (unmeasured) or the interval is inverted (anomalous). Returning null rather
 * than a default keeps unmeasured work out of the histograms entirely.
 */
export function stageDurationMs(stamps: StampMap, stage: PipelineStage): number | null {
  const [enter, exit] = STAGE_BOUNDS[stage];
  return boundedDuration(stamps, enter, exit);
}

function boundedDuration(stamps: StampMap, enter: StampPoint, exit: StampPoint): number | null {
  const enterTs = stamps[enter];
  const exitTs = stamps[exit];
  if (enterTs === undefined || exitTs === undefined) return null;
  const duration = exitTs - enterTs;
  return duration < 0 ? null : duration;
}

function measured(stage: Stage, durationMs: number): StageMeasurement {
  const sloMs = STAGE_SLO_MS[stage];
  return { stage, durationMs, withinSlo: durationMs <= sloMs, sloMs };
}

/**
 * Compute the per-stage measurement from a stamp map. Pure: identical input
 * always yields identical output, independent of wall-clock time or any
 * external system. This is the primary unit-test surface for the instrument.
 */
export function computeMeasurement(
  stamps: StampMap,
  meta: { traceId: string; source: string },
): LatencyMeasurement {
  const stages: StageMeasurement[] = [];
  const unmeasured: PipelineStage[] = [];
  const anomalies: PipelineStage[] = [];

  for (const stage of PIPELINE_STAGES) {
    const durationMs = stageDurationMs(stamps, stage);
    if (durationMs !== null) {
      stages.push(measured(stage, durationMs));
      continue;
    }
    const [enter, exit] = STAGE_BOUNDS[stage];
    if (stamps[enter] !== undefined && stamps[exit] !== undefined) {
      anomalies.push(stage); // inverted interval — dropped, never clamped
    } else {
      unmeasured.push(stage);
    }
  }

  const totalDuration = boundedDuration(stamps, TOTAL_BOUNDS[0], TOTAL_BOUNDS[1]);
  const total = totalDuration === null ? null : measured('total', totalDuration);

  const complete = stages.length === PIPELINE_STAGES.length && total !== null;
  const withinSlo = stages.every((s) => s.withinSlo) && (total === null || total.withinSlo);

  return {
    traceId: meta.traceId,
    source: meta.source,
    stages,
    total,
    unmeasured,
    anomalies,
    complete,
    withinSlo,
  };
}

// ============================================================================
// PROMETHEUS METRICS (registered on the shared registry — server/metrics)
// ============================================================================

/**
 * Histogram bucket boundaries in SECONDS (Prometheus convention). Covers
 * sub-millisecond local work through multi-block on-chain confirmations.
 */
const LATENCY_BUCKETS_SECONDS = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
] as const;

/**
 * Structural metric types. The concrete Counter/Gauge/Histogram classes are not
 * exported from server/metrics/prometheus.ts, so these interfaces give the
 * exported bindings a nameable type without resorting to `any`.
 */
export interface MetricLabels {
  [key: string]: string;
}

export interface CounterMetric {
  inc(labels?: MetricLabels, value?: number): void;
  get(labels?: MetricLabels): number;
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
 * Per-stage latency. Labelled by `stage` and by `source` (the producing
 * pipeline) so several pipelines can be sliced independently.
 *
 * Metric name (with the registry's `scada` prefix):
 *   scada_control_loop_stage_latency_seconds
 */
export const stageLatencyHistogram: HistogramMetric = registry.histogram(
  'control_loop_stage_latency_seconds',
  'Per-stage anchor-pipeline latency (batch/sign/anchor/confirm) in seconds',
  ['stage', 'source'],
  [...LATENCY_BUCKETS_SECONDS],
);

/**
 * End-to-end round-trip (batch-enter -> confirm-exit).
 *
 * Metric name: scada_control_loop_roundtrip_latency_seconds
 */
export const roundTripLatencyHistogram: HistogramMetric = registry.histogram(
  'control_loop_roundtrip_latency_seconds',
  'End-to-end anchor round-trip latency (batch -> on-chain confirmation) in seconds',
  ['source'],
  [...LATENCY_BUCKETS_SECONDS],
);

/**
 * Most recent SLO compliance per stage (1 = within budget, 0 = breached).
 * Drives the Alertmanager rule that fires on a >5min sustained breach.
 *
 * Metric name: scada_control_loop_stage_slo_ok
 */
export const stageSloGauge: GaugeMetric = registry.gauge(
  'control_loop_stage_slo_ok',
  'Whether the last measured stage latency was within its SLO budget (1=ok, 0=breach)',
  ['stage', 'source'],
);

/**
 * Completed pipeline traces by outcome:
 *   confirmed   — the anchor was confirmed on-chain and the round-trip measured
 *   failed      — the relayer reported the anchor failed
 *   unconfirmed — no confirmation arrived within the pipeline's wait budget
 *
 * Metric name: scada_control_loop_cycles_total
 */
export const controlLoopCyclesCounter: CounterMetric = registry.counter(
  'control_loop_cycles_total',
  'Anchor-pipeline traces completed, by outcome',
  ['source', 'outcome'],
);

export type CycleOutcome = 'confirmed' | 'failed' | 'unconfirmed';

/**
 * Publish a measurement. Only genuinely measured stages are observed; missing
 * and anomalous stages are simply absent from the series, which is why the
 * dashboard/alerts treat absence as "no data" rather than as a zero.
 */
export function observeMeasurement(measurement: LatencyMeasurement): void {
  const { source } = measurement;

  for (const s of measurement.stages) {
    stageLatencyHistogram.observe(s.durationMs / 1000, { stage: s.stage, source });
    stageSloGauge.set(s.withinSlo ? 1 : 0, { stage: s.stage, source });
  }

  if (measurement.total) {
    roundTripLatencyHistogram.observe(measurement.total.durationMs / 1000, { source });
    stageSloGauge.set(measurement.total.withinSlo ? 1 : 0, { stage: 'total', source });
  }
}

/** Record the outcome of a completed trace. */
export function observeCycleOutcome(source: string, outcome: CycleOutcome): void {
  controlLoopCyclesCounter.inc({ source, outcome });
}

// ============================================================================
// LATENCY TRACE (stateful collector used by the live pipeline)
// ============================================================================

/**
 * Pluggable clock. Defaults to a monotonic high-resolution clock so wall-clock
 * jumps cannot skew sub-millisecond stage measurements.
 */
export type Clock = () => number;

export const monotonicClock: Clock =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

export interface LatencyTraceOptions {
  traceId: string;
  source: string;
  clock?: Clock;
}

/**
 * Collects stamps across one batch's trip through the anchor pipeline.
 *
 * Marking is deliberately total: an unknown or duplicate stamp is ignored
 * rather than thrown, so instrumentation can never break the integrity path.
 */
export class LatencyTrace {
  readonly traceId: string;
  readonly source: string;
  private readonly clock: Clock;
  private readonly stamps: Partial<Record<StampPoint, number>> = {};

  constructor(opts: LatencyTraceOptions) {
    this.traceId = opts.traceId;
    this.source = opts.source;
    this.clock = opts.clock ?? monotonicClock;
  }

  /** Sample the trace's clock without stamping (for deferred marks). */
  now(): number {
    return this.clock();
  }

  /**
   * Record a stamp point. If `at` is omitted the trace's clock is sampled.
   * Re-stamping the same point is ignored (first write wins) so retries cannot
   * rewrite history.
   */
  mark(point: StampPoint, at?: number): this {
    if (this.stamps[point] !== undefined) return this;
    this.stamps[point] = at ?? this.clock();
    return this;
  }

  has(point: StampPoint): boolean {
    return this.stamps[point] !== undefined;
  }

  /** Read-only snapshot of recorded stamps (for inspection / tests). */
  snapshot(): StampMap {
    return { ...this.stamps };
  }

  /** True once every stamp needed for a complete measurement exists. */
  isComplete(): boolean {
    return STAMP_POINTS.every((p) => this.stamps[p] !== undefined);
  }

  /** Compute this trace's measurement without publishing it. */
  measure(): LatencyMeasurement {
    return computeMeasurement(this.stamps, { traceId: this.traceId, source: this.source });
  }

  /** Compute, publish, and return this trace's measurement. */
  finalize(): LatencyMeasurement {
    const measurement = this.measure();
    observeMeasurement(measurement);
    return measurement;
  }
}
