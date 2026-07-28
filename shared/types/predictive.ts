/**
 * Predictive Maintenance Types
 * ADR-0013 [13.1] — Issue #212
 *
 * Anomaly detection on tag time-series with ensemble scoring,
 * configurable per-tag thresholds, and severity-rated alerts.
 */

export type SeverityLevel = 'info' | 'warning' | 'critical' | 'emergency';

export interface TimeSeriesPoint {
  timestamp: number;
  value: number;
}

export interface DetectorResult {
  detector: string;
  /** Normalized 0..1 — saturates at 1 when the detector threshold is reached */
  score: number;
  anomalous: boolean;
  details: Record<string, unknown>;
}

/**
 * ML-ready detector contract.
 *
 * Built-in statistical detectors (z-score, EWMA, IQR) and future ML models
 * implement the same interface; `detect` may be async so remote/model
 * inference can be plugged in without changing the engine.
 */
export interface AnomalyDetector {
  readonly name: string;
  readonly kind: 'statistical' | 'ml';
  detect(
    series: TimeSeriesPoint[],
    config: TagThresholds
  ): DetectorResult | Promise<DetectorResult>;
}

export interface SeverityThresholds {
  warning: number;
  critical: number;
  emergency: number;
}

/** Engineering limits used for time-to-failure trend estimation */
export interface FailureLimits {
  low?: number;
  high?: number;
}

export interface TagThresholds {
  tagId: string;
  /** Minimum samples in the window before analysis runs */
  minSamples: number;
  zScoreThreshold: number;
  /** EWMA smoothing factor (0..1) */
  ewmaAlpha: number;
  /** EWMA control limit width in sigma units */
  ewmaL: number;
  iqrMultiplier: number;
  /** Weight per detector name — unlisted detectors default to weight 1 */
  ensembleWeights: Record<string, number>;
  severityThresholds: SeverityThresholds;
  failureLimits?: FailureLimits;
}

export interface AnomalyAssessment {
  tagId: string;
  timestamp: number;
  value: number;
  detectorResults: DetectorResult[];
  ensembleScore: number;
  severity: SeverityLevel;
  description: string;
}

export interface MaintenancePrediction {
  tagId: string;
  /** 0..1 — current ensemble anomaly score blended with trend confidence */
  failureProbability: number;
  /** Hours until the trend crosses a failure limit; null if not trending toward one */
  estimatedHoursToLimit: number | null;
  /** Least-squares slope of the window, in value units per hour */
  trendSlopePerHour: number;
  /** The failure limit the trend is heading toward, if any */
  limit: number | null;
  recommendedAction: string;
  /** R² of the linear fit — how well the trend explains the data */
  confidence: number;
}

export interface PredictiveAlert {
  /**
   * Content-derived, restart-stable identity (#546). Derived from
   * tag + severity + the cooldown window the alert was raised in, so the same
   * anomaly seen by a restarted process — or by a second replica — resolves to
   * the same durable row instead of a new one.
   */
  id: string;
  tagId: string;
  severity: SeverityLevel;
  score: number;
  message: string;
  /** Timestamp of the observation that triggered the alert (data clock) */
  timestamp: number;
  detectors: string[];
  acknowledged: boolean;
  recommendation: string;
  prediction?: MaintenancePrediction | null;
  /** Wall-clock time the alert was durably recorded. Retention/order key. */
  createdAt: number;
  /**
   * Authenticated control-plane principal that acknowledged the alert.
   * Never taken from a request body — see `server/routes/predictive.ts`.
   */
  acknowledgedBy: string | null;
  acknowledgedAt: number | null;
}

/** What `hydrate()` actually loaded from the durable store at startup (#546). */
export interface PredictiveHydrationSummary {
  backend: 'postgres' | 'sqlite' | 'unopened';
  configuredTags: number;
  totalAlerts: number;
  unacknowledgedAlerts: number;
}

/** Outcome of a durable acknowledgement attempt (#546). */
export type AcknowledgeStatus = 'acknowledged' | 'already-acknowledged' | 'not-found';

export interface AcknowledgeOutcome {
  status: AcknowledgeStatus;
  alert: PredictiveAlert | null;
}
