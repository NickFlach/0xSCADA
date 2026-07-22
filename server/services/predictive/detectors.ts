/**
 * Statistical Anomaly Detectors
 * ADR-0013 [13.1] — Issue #212
 *
 * Pure statistical detectors (z-score, EWMA, IQR) over tag time-series.
 * Each detector tests the latest point against a baseline built from the
 * preceding window, and implements the shared AnomalyDetector contract so
 * ML models can be registered alongside them.
 */

import type {
  AnomalyDetector,
  DetectorResult,
  SeverityLevel,
  SeverityThresholds,
  TagThresholds,
  TimeSeriesPoint,
} from '@shared/types/predictive';

// ── Statistics primitives ─────────────────────────────────────────────────

/**
 * Relative tolerance treating floating-point rounding residue as zero.
 * Means/EWMAs of constant decimal series (e.g. 0.4 repeated) land a few ulp
 * away from the constant; without this guard that residue registers as an
 * anomaly with score 1 on a perfectly flat signal.
 */
const REL_EPS = 1e-9;

function epsFor(...magnitudes: number[]): number {
  return REL_EPS * Math.max(...magnitudes.map(Math.abs), Number.MIN_VALUE);
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Sample standard deviation (n-1 denominator) */
export function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Quantile with linear interpolation (q in 0..1) over an unsorted sample */
export function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (base + 1 < sorted.length) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

/**
 * Z-score of the latest value against the baseline of all preceding values.
 * A zero-variance baseline with a deviating latest value is treated as an
 * infinite z-score (score 1).
 */
export function computeZScore(values: number[]): {
  mean: number;
  stdDev: number;
  zScore: number;
} {
  if (values.length < 3) {
    return { mean: values[0] ?? 0, stdDev: 0, zScore: 0 };
  }
  const baseline = values.slice(0, -1);
  const latest = values[values.length - 1];
  const m = mean(baseline);
  const sd = stdDev(baseline);
  const eps = epsFor(m, latest);
  if (sd <= eps) {
    return { mean: m, stdDev: 0, zScore: Math.abs(latest - m) <= eps ? 0 : Infinity };
  }
  return { mean: m, stdDev: sd, zScore: Math.abs(latest - m) / sd };
}

// ── Detector functions ────────────────────────────────────────────────────

export function zScoreDetector(series: TimeSeriesPoint[], threshold: number): DetectorResult {
  const values = series.map((p) => p.value);
  const { zScore, mean: m, stdDev: sd } = computeZScore(values);
  return {
    detector: 'z-score',
    score: Math.min(zScore / threshold, 1),
    anomalous: zScore > threshold,
    // Infinity is not JSON-representable — report it as an explicit flag
    details: {
      zScore: Number.isFinite(zScore) ? zScore : null,
      zScoreInfinite: !Number.isFinite(zScore),
      mean: m,
      stdDev: sd,
      threshold,
    },
  };
}

/**
 * EWMA control-chart detector. The EWMA statistic z_i = α·x_i + (1−α)·z_{i−1}
 * is run over the whole series and its final value is compared against the
 * process mean of the preceding baseline, with asymptotic control limits of
 * width L·σ·√(α/(2−α)). Thresholds are in sigma units, so the detector works
 * for tags of any engineering scale and catches sustained drift that
 * point-wise detectors miss.
 */
export function ewmaDetector(series: TimeSeriesPoint[], alpha: number, L: number): DetectorResult {
  if (series.length < 3) {
    return { detector: 'ewma', score: 0, anomalous: false, details: { insufficient: true } };
  }

  const values = series.map((p) => p.value);
  const baseline = values.slice(0, -1);
  const processMean = mean(baseline);
  const sd = stdDev(baseline);

  let ewma = values[0];
  for (let i = 1; i < values.length; i++) {
    ewma = alpha * values[i] + (1 - alpha) * ewma;
  }

  const deviation = Math.abs(ewma - processMean);
  const eps = epsFor(ewma, processMean);

  if (sd <= eps) {
    const anomalous = deviation > eps;
    return {
      detector: 'ewma',
      score: anomalous ? 1 : 0,
      anomalous,
      details: { ewma, processMean, deviation, alpha, L, controlLimit: 0 },
    };
  }

  const controlLimit = Math.max(L * sd * Math.sqrt(alpha / (2 - alpha)), eps);
  return {
    detector: 'ewma',
    score: Math.min(deviation / controlLimit, 1),
    anomalous: deviation > controlLimit,
    details: { ewma, processMean, deviation, alpha, L, controlLimit },
  };
}

export function iqrDetector(series: TimeSeriesPoint[], multiplier: number): DetectorResult {
  if (series.length < 5) {
    return { detector: 'iqr', score: 0, anomalous: false, details: { insufficient: true } };
  }

  const baseline = series.slice(0, -1).map((p) => p.value);
  const latest = series[series.length - 1].value;

  const q1 = quantile(baseline, 0.25);
  const q3 = quantile(baseline, 0.75);
  const iqr = q3 - q1;
  const lowerBound = q1 - multiplier * iqr;
  const upperBound = q3 + multiplier * iqr;
  const outsideRange = latest < lowerBound || latest > upperBound;

  // Score contract: 0 inside the quartiles, exactly 1 at the Tukey fence,
  // saturating beyond it — same "1.0 == at threshold" semantics as the
  // other detectors so ensemble weighting stays comparable.
  let score = 0;
  if (iqr === 0) {
    score = outsideRange ? 1 : 0;
  } else {
    const displacement = Math.max(0, q1 - latest, latest - q3);
    score = Math.min(displacement / (multiplier * iqr), 1);
  }

  return {
    detector: 'iqr',
    score,
    anomalous: outsideRange,
    details: { q1, q3, iqr, lowerBound, upperBound, latest, multiplier },
  };
}

// ── AnomalyDetector implementations ──────────────────────────────────────

export const builtinDetectors: AnomalyDetector[] = [
  {
    name: 'z-score',
    kind: 'statistical',
    detect: (series, cfg) => zScoreDetector(series, cfg.zScoreThreshold),
  },
  {
    name: 'ewma',
    kind: 'statistical',
    detect: (series, cfg) => ewmaDetector(series, cfg.ewmaAlpha, cfg.ewmaL),
  },
  {
    name: 'iqr',
    kind: 'statistical',
    detect: (series, cfg) => iqrDetector(series, cfg.iqrMultiplier),
  },
];

// ── Ensemble scoring ─────────────────────────────────────────────────────

export function ensembleScore(
  results: DetectorResult[],
  weights: Record<string, number>
): number {
  let totalWeight = 0;
  let weightedSum = 0;

  for (const r of results) {
    // An insufficient-data result is an abstention, not a "normal" vote —
    // renormalize over the detectors that actually ran, otherwise a small
    // window mathematically caps the ensemble below the top severities.
    if (r.details.insufficient === true) continue;
    const w = weights[r.detector] ?? 1;
    weightedSum += r.score * w;
    totalWeight += w;
  }

  return totalWeight === 0 ? 0 : weightedSum / totalWeight;
}

export function classifySeverity(score: number, thresholds: SeverityThresholds): SeverityLevel {
  if (score >= thresholds.emergency) return 'emergency';
  if (score >= thresholds.critical) return 'critical';
  if (score >= thresholds.warning) return 'warning';
  return 'info';
}

// ── Trend estimation (alert before failure) ──────────────────────────────

export interface TrendEstimate {
  /** Least-squares slope in value units per hour */
  slopePerHour: number;
  /** Fitted value at the latest timestamp */
  latestFitted: number;
  /** R² of the fit — 0 when the data has no linear structure */
  rSquared: number;
}

const MS_PER_HOUR = 3_600_000;

export function estimateTrend(series: TimeSeriesPoint[]): TrendEstimate | null {
  if (series.length < 3) return null;

  const t0 = series[0].timestamp;
  const xs = series.map((p) => (p.timestamp - t0) / MS_PER_HOUR);
  const ys = series.map((p) => p.value);

  const mx = mean(xs);
  const my = mean(ys);
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0) return null;

  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const rSquared = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);

  return {
    slopePerHour: slope,
    latestFitted: intercept + slope * xs[xs.length - 1],
    rSquared,
  };
}

/**
 * Hours until the fitted trend crosses a failure limit, or null when the
 * series is not trending toward either limit.
 */
export function estimateHoursToLimit(
  trend: TrendEstimate,
  limits: { low?: number; high?: number }
): { hours: number; limit: number } | null {
  const { slopePerHour, latestFitted } = trend;
  if (slopePerHour === 0) return null;

  if (limits.high !== undefined && slopePerHour > 0 && latestFitted < limits.high) {
    return { hours: (limits.high - latestFitted) / slopePerHour, limit: limits.high };
  }
  if (limits.low !== undefined && slopePerHour < 0 && latestFitted > limits.low) {
    return { hours: (limits.low - latestFitted) / slopePerHour, limit: limits.low };
  }
  // Already at/past a limit and still heading away from safe range
  if (limits.high !== undefined && slopePerHour > 0 && latestFitted >= limits.high) {
    return { hours: 0, limit: limits.high };
  }
  if (limits.low !== undefined && slopePerHour < 0 && latestFitted <= limits.low) {
    return { hours: 0, limit: limits.low };
  }
  return null;
}
