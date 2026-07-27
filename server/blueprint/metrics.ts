/**
 * Prometheus metrics for the deterministic blueprint control loop.
 *
 * Issue #457: [wave:2b] Deterministic Blueprint Runtime
 *
 * Registered on the shared 0xSCADA registry (server/metrics/prometheus.ts) so
 * they are exported by the existing /metrics endpoint. The registry adds the
 * `scada_` prefix, so the exposed names are:
 *
 *   scada_blueprint_control_loop_enabled
 *   scada_blueprint_control_loop_running
 *   scada_blueprint_control_loop_ticks_total{blueprint}
 *   scada_blueprint_control_loop_missed_deadlines_total{blueprint}
 *   scada_blueprint_control_loop_overruns_total{blueprint}
 *   scada_blueprint_control_loop_load_failures_total
 *   scada_blueprint_control_loop_scan_period_ms{blueprint}
 *   scada_blueprint_control_loop_last_tick_duration_ms{blueprint}
 *   scada_blueprint_control_loop_tick_p50_ms{blueprint}
 *   scada_blueprint_control_loop_tick_p99_ms{blueprint}
 *   scada_blueprint_control_loop_tick_max_ms{blueprint}
 *   scada_blueprint_control_loop_window_samples{blueprint}
 *
 * WHY GAUGES AND NOT A LATENCY HISTOGRAM
 * --------------------------------------
 * A histogram would be the idiomatic shape for a latency SLO, but this
 * registry's `Histogram.observe()` builds a label key on every call
 * (`labelNames.map(...).join()`), i.e. it allocates per observation. Observing
 * once per tick would therefore put an allocation on the control-loop timer
 * callback and undermine the bounded-allocation property this issue exists to
 * guarantee. Instead the loop keeps per-tick timings in a pre-allocated ring
 * buffer (zero allocation) and publishes summary gauges — p50/p99/max over that
 * window — on a slow cadence (default once per second). The exported quantiles
 * are therefore per-window and per-instance; they are NOT aggregatable across
 * replicas the way histogram buckets would be. That trade-off is deliberate and
 * is documented in ADR-0026.
 *
 * Label cardinality: `blueprint` is the compiled blueprint id. Exactly one
 * control loop exists per process, so cardinality is 1.
 */

import { registry } from "../metrics/prometheus.js";

type MetricLabels = Record<string, string>;

interface CounterMetric {
  inc(labels?: MetricLabels, value?: number): void;
  get(labels?: MetricLabels): number;
  reset(): void;
  collect(): Array<{ labels: MetricLabels; value: number }>;
}

interface GaugeMetric {
  set(value: number, labels?: MetricLabels): void;
  get(labels?: MetricLabels): number;
  reset(): void;
  collect(): Array<{ labels: MetricLabels; value: number }>;
}

/** 1 when the control loop is enabled by configuration, 0 when it is not. */
export const blueprintControlLoopEnabled: GaugeMetric = registry.gauge(
  "blueprint_control_loop_enabled",
  "Blueprint control loop enabled by configuration (1=enabled, 0=disabled)",
);

/** 1 while the scan timer is armed, 0 otherwise (disabled, stopped or failed). */
export const blueprintControlLoopRunning: GaugeMetric = registry.gauge(
  "blueprint_control_loop_running",
  "Blueprint control loop scan timer armed (1=running, 0=not running)",
);

/** Completed scans since the loop was loaded. */
export const blueprintControlLoopTicksTotal: CounterMetric = registry.counter(
  "blueprint_control_loop_ticks_total",
  "Total blueprint control-loop scans executed",
  ["blueprint"],
);

/**
 * Scans whose inter-arrival gap exceeded the scan period plus the configured
 * jitter tolerance — i.e. the host scheduler delivered the timer late.
 */
export const blueprintControlLoopMissedDeadlinesTotal: CounterMetric = registry.counter(
  "blueprint_control_loop_missed_deadlines_total",
  "Blueprint control-loop scans delivered later than period + jitter tolerance",
  ["blueprint"],
);

/** Scans whose own execution time exceeded the scan period. */
export const blueprintControlLoopOverrunsTotal: CounterMetric = registry.counter(
  "blueprint_control_loop_overruns_total",
  "Blueprint control-loop scans whose execution exceeded the scan period",
  ["blueprint"],
);

/** Fail-closed load/configuration rejections (blueprint never started). */
export const blueprintControlLoopLoadFailuresTotal: CounterMetric = registry.counter(
  "blueprint_control_loop_load_failures_total",
  "Blueprint control-loop load/configuration failures (loop refused to start)",
);

/** Configured scan period in milliseconds. */
export const blueprintControlLoopScanPeriodMs: GaugeMetric = registry.gauge(
  "blueprint_control_loop_scan_period_ms",
  "Blueprint control-loop scan period in milliseconds",
  ["blueprint"],
);

/** Duration of the most recent scan, in milliseconds. */
export const blueprintControlLoopLastTickMs: GaugeMetric = registry.gauge(
  "blueprint_control_loop_last_tick_duration_ms",
  "Duration of the most recent blueprint control-loop scan in milliseconds",
  ["blueprint"],
);

/** Median scan duration over the sampling window. */
export const blueprintControlLoopTickP50Ms: GaugeMetric = registry.gauge(
  "blueprint_control_loop_tick_p50_ms",
  "Median blueprint control-loop scan duration over the sampling window (ms)",
  ["blueprint"],
);

/** p99 scan duration over the sampling window — the #457 SLO signal. */
export const blueprintControlLoopTickP99Ms: GaugeMetric = registry.gauge(
  "blueprint_control_loop_tick_p99_ms",
  "p99 blueprint control-loop scan duration over the sampling window (ms)",
  ["blueprint"],
);

/** Worst scan duration in the sampling window. */
export const blueprintControlLoopTickMaxMs: GaugeMetric = registry.gauge(
  "blueprint_control_loop_tick_max_ms",
  "Worst blueprint control-loop scan duration in the sampling window (ms)",
  ["blueprint"],
);

/** How many samples the published quantiles were computed from. */
export const blueprintControlLoopWindowSamples: GaugeMetric = registry.gauge(
  "blueprint_control_loop_window_samples",
  "Number of scan-duration samples backing the published quantiles",
  ["blueprint"],
);
