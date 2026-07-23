/**
 * Prometheus metrics for the IEC 61850 GOOSE subscriber.
 *
 * Registered on the shared 0xSCADA registry (server/metrics) so they are
 * exposed automatically on the existing /metrics endpoint. The registry adds
 * the `scada_` prefix, yielding the metric names required by issue #465:
 *
 *   scada_goose_frames_received_total
 *   scada_goose_frames_rejected_total{reason}
 *   scada_goose_round_trip_us  (histogram)
 *
 * Issue: #465
 */

import { registry } from "../../metrics/prometheus.js";

type MetricLabels = Record<string, string>;

interface CounterMetric {
  inc(labels?: MetricLabels, value?: number): void;
  get(labels?: MetricLabels): number;
  reset(): void;
  collect(): Array<{ labels: MetricLabels; value: number }>;
}

interface GaugeMetric {
  set(value: number, labels?: MetricLabels): void;
  inc(labels?: MetricLabels, value?: number): void;
  dec(labels?: MetricLabels, value?: number): void;
  get(labels?: MetricLabels): number;
  setToCurrentTime(labels?: MetricLabels): void;
  reset(): void;
  collect(): Array<{ labels: MetricLabels; value: number }>;
}

interface HistogramMetric {
  observe(value: number, labels?: MetricLabels): void;
  reset(): void;
  collect(): Array<{
    labels: MetricLabels;
    buckets: Map<number, number>;
    sum: number;
    count: number;
  }>;
}

/** Total GOOSE frames received on the wire (before validation). */
export const gooseFramesReceivedTotal: CounterMetric = registry.counter(
  "goose_frames_received_total",
  "Total IEC 61850 GOOSE frames received on the configured interface",
  ["app_id"],
);

/**
 * GOOSE frames rejected, labelled by reason. Reasons are a fixed, low-cardinality
 * enum — see {@link GooseRejectReason}.
 */
export const gooseFramesRejectedTotal: CounterMetric = registry.counter(
  "goose_frames_rejected_total",
  "IEC 61850 GOOSE frames rejected during decode/validation",
  ["reason"],
);

/**
 * End-to-end round-trip latency in microseconds (publisher event timestamp `t`
 * to local receive time). Buckets centred on the sub-4ms control-loop budget
 * (issue 2b pairs this with control-loop latency telemetry).
 */
export const gooseRoundTripUs: HistogramMetric = registry.histogram(
  "goose_round_trip_us",
  "GOOSE publish-to-receive round-trip latency in microseconds",
  ["gocb_ref"],
  [100, 250, 500, 1000, 2000, 4000, 8000, 16000, 50000, 100000],
);

/** Per-subscription state-number gauge (last accepted stNum). */
export const gooseLastStNum: GaugeMetric = registry.gauge(
  "goose_last_st_num",
  "Last accepted GOOSE state number per subscription",
  ["gocb_ref"],
);

/** Number of active GOOSE subscriptions configured on the subscriber. */
export const gooseSubscriptionsActive: GaugeMetric = registry.gauge(
  "goose_subscriptions_active",
  "Number of active GOOSE subscriptions",
);

/**
 * Canonical, fixed set of rejection reasons. Keeping this an enum bounds the
 * label cardinality of `goose_frames_rejected_total`.
 */
export type GooseRejectReason =
  | "parse_error" // BER/frame decode failed
  | "no_subscription" // no subscription matches gocbRef/appId
  | "mac_mismatch" // source/dest MAC did not match expected
  | "app_id_mismatch" // APPID did not match expected
  | "dataset_shape" // dataset entry count/types did not match expected
  | "stnum_regression" // stNum went backwards
  | "sqnum_regression" // sqNum went backwards within same stNum
  | "ttl_expired" // previous message TTL elapsed (stale link)
  | "conf_rev_mismatch" // configuration revision changed unexpectedly
  | "simulation" // simulation/test bit set and simulationPolicy="reject"
  | "nds_com"; // publisher signalled needsCommissioning
