/**
 * Predictive Maintenance Engine
 * ADR-0013 [13.1] — Time-series anomaly detection with ensemble scoring
 */

import type {
  AnomalyScore,
  TagThresholds,
  PredictiveAlert,
  TimeSeriesPoint,
  DetectorResult,
  SeverityLevel,
} from '../../shared/types/predictive';

// ── Z-Score Detector ──────────────────────────────────────────────

export function computeZScore(values: number[]): { mean: number; stdDev: number; zScore: number } {
  if (values.length < 2) return { mean: values[0] ?? 0, stdDev: 0, zScore: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  const stdDev = Math.sqrt(variance);
  const latest = values[values.length - 1];
  const zScore = stdDev === 0 ? 0 : Math.abs(latest - mean) / stdDev;
  return { mean, stdDev, zScore };
}

export function zScoreDetector(series: TimeSeriesPoint[], threshold: number): DetectorResult {
  const values = series.map((p) => p.value);
  const { zScore, mean, stdDev } = computeZScore(values);
  return {
    detector: 'z-score',
    score: Math.min(zScore / threshold, 1),
    anomalous: zScore > threshold,
    details: { zScore, mean, stdDev, threshold },
  };
}

// ── EWMA Detector ─────────────────────────────────────────────────

export function ewmaDetector(
  series: TimeSeriesPoint[],
  alpha: number,
  threshold: number
): DetectorResult {
  if (series.length === 0) {
    return { detector: 'ewma', score: 0, anomalous: false, details: { ewma: 0 } };
  }

  let ewma = series[0].value;
  for (let i = 1; i < series.length; i++) {
    ewma = alpha * series[i].value + (1 - alpha) * ewma;
  }

  const latest = series[series.length - 1].value;
  const deviation = Math.abs(latest - ewma);
  const score = Math.min(deviation / threshold, 1);

  return {
    detector: 'ewma',
    score,
    anomalous: deviation > threshold,
    details: { ewma, latest, deviation, alpha, threshold },
  };
}

// ── IQR Detector ──────────────────────────────────────────────────

export function iqrDetector(series: TimeSeriesPoint[], multiplier: number): DetectorResult {
  const values = series.map((p) => p.value).sort((a, b) => a - b);
  if (values.length < 4) {
    return { detector: 'iqr', score: 0, anomalous: false, details: { insufficient: true } };
  }

  const q1 = values[Math.floor(values.length * 0.25)];
  const q3 = values[Math.floor(values.length * 0.75)];
  const iqr = q3 - q1;
  const lowerBound = q1 - multiplier * iqr;
  const upperBound = q3 + multiplier * iqr;
  const latest = series[series.length - 1].value;
  const outsideRange = latest < lowerBound || latest > upperBound;

  let score = 0;
  if (outsideRange && iqr > 0) {
    const distance = latest < lowerBound ? lowerBound - latest : latest - upperBound;
    score = Math.min(distance / iqr, 1);
  }

  return {
    detector: 'iqr',
    score,
    anomalous: outsideRange,
    details: { q1, q3, iqr, lowerBound, upperBound, latest, multiplier },
  };
}

// ── Ensemble Scoring ──────────────────────────────────────────────

export function ensembleScore(
  results: DetectorResult[],
  weights: Record<string, number>
): number {
  let totalWeight = 0;
  let weightedSum = 0;

  for (const r of results) {
    const w = weights[r.detector] ?? 1;
    weightedSum += r.score * w;
    totalWeight += w;
  }

  return totalWeight === 0 ? 0 : weightedSum / totalWeight;
}

export function classifySeverity(
  score: number,
  thresholds: { warning: number; critical: number; emergency: number }
): SeverityLevel {
  if (score >= thresholds.emergency) return 'emergency';
  if (score >= thresholds.critical) return 'critical';
  if (score >= thresholds.warning) return 'warning';
  return 'info';
}

// ── Predictive Maintenance Engine ─────────────────────────────────

const DEFAULT_THRESHOLDS: TagThresholds = {
  tagId: '*',
  zScoreThreshold: 3,
  ewmaAlpha: 0.3,
  ewmaThreshold: 10,
  iqrMultiplier: 1.5,
  ensembleWeights: { zScore: 0.4, ewma: 0.35, iqr: 0.25 },
  severityThresholds: { warning: 0.4, critical: 0.7, emergency: 0.9 },
};

export class PredictiveMaintenanceEngine {
  private thresholds: Map<string, TagThresholds> = new Map();
  private history: Map<string, TimeSeriesPoint[]> = new Map();
  private alerts: PredictiveAlert[] = [];
  private maxHistorySize: number;
  private alertCounter = 0;

  constructor(maxHistorySize = 1000) {
    this.maxHistorySize = maxHistorySize;
  }

  setThresholds(tagId: string, thresholds: Partial<TagThresholds>): void {
    const base = this.thresholds.get(tagId) ?? { ...DEFAULT_THRESHOLDS, tagId };
    this.thresholds.set(tagId, { ...base, ...thresholds, tagId });
  }

  getThresholds(tagId: string): TagThresholds {
    return this.thresholds.get(tagId) ?? { ...DEFAULT_THRESHOLDS, tagId };
  }

  ingestPoint(tagId: string, timestamp: number, value: number): void {
    let series = this.history.get(tagId);
    if (!series) {
      series = [];
      this.history.set(tagId, series);
    }
    series.push({ timestamp, value });
    if (series.length > this.maxHistorySize) {
      series.splice(0, series.length - this.maxHistorySize);
    }
  }

  analyze(tagId: string): AnomalyScore | null {
    const series = this.history.get(tagId);
    if (!series || series.length < 10) return null;

    const cfg = this.getThresholds(tagId);

    const zResult = zScoreDetector(series, cfg.zScoreThreshold);
    const ewmaResult = ewmaDetector(series, cfg.ewmaAlpha, cfg.ewmaThreshold);
    const iqrResult = iqrDetector(series, cfg.iqrMultiplier);

    const ensemble = ensembleScore(
      [zResult, ewmaResult, iqrResult],
      cfg.ensembleWeights as unknown as Record<string, number>
    );

    const severity = classifySeverity(ensemble, cfg.severityThresholds);
    const latest = series[series.length - 1];

    const anomaly: AnomalyScore = {
      tagId,
      timestamp: latest.timestamp,
      zScore: zResult.anomalous ? (zResult.details.zScore as number) : null,
      ewmaScore: ewmaResult.anomalous ? ewmaResult.score : null,
      iqrScore: iqrResult.anomalous ? iqrResult.score : null,
      ensembleScore: ensemble,
      severity,
      description: this.describeAnomaly(tagId, severity, [zResult, ewmaResult, iqrResult]),
    };

    if (severity !== 'info') {
      this.generateAlert(anomaly, [zResult, ewmaResult, iqrResult]);
    }

    return anomaly;
  }

  analyzeAll(): AnomalyScore[] {
    const results: AnomalyScore[] = [];
    for (const tagId of this.history.keys()) {
      const result = this.analyze(tagId);
      if (result) results.push(result);
    }
    return results;
  }

  getAlerts(severity?: SeverityLevel): PredictiveAlert[] {
    if (!severity) return [...this.alerts];
    return this.alerts.filter((a) => a.severity === severity);
  }

  acknowledgeAlert(alertId: string): boolean {
    const alert = this.alerts.find((a) => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
      return true;
    }
    return false;
  }

  getHistory(tagId: string): TimeSeriesPoint[] {
    return this.history.get(tagId) ?? [];
  }

  clearHistory(tagId: string): void {
    this.history.delete(tagId);
  }

  private generateAlert(anomaly: AnomalyScore, detectors: DetectorResult[]): void {
    const alert: PredictiveAlert = {
      id: `PMA-${++this.alertCounter}`,
      tagId: anomaly.tagId,
      severity: anomaly.severity,
      score: anomaly.ensembleScore,
      message: anomaly.description,
      timestamp: anomaly.timestamp,
      detectors: detectors.filter((d) => d.anomalous).map((d) => d.detector),
      acknowledged: false,
      recommendation: this.getRecommendation(anomaly.severity),
    };
    this.alerts.push(alert);
  }

  private describeAnomaly(
    tagId: string,
    severity: SeverityLevel,
    detectors: DetectorResult[]
  ): string {
    const triggered = detectors.filter((d) => d.anomalous).map((d) => d.detector);
    if (triggered.length === 0) return `Tag ${tagId}: nominal`;
    return `Tag ${tagId}: ${severity} anomaly detected by ${triggered.join(', ')}`;
  }

  private getRecommendation(severity: SeverityLevel): string {
    switch (severity) {
      case 'emergency':
        return 'Immediate inspection required. Consider shutting down affected equipment.';
      case 'critical':
        return 'Schedule urgent maintenance within 24 hours.';
      case 'warning':
        return 'Monitor closely. Schedule inspection within 1 week.';
      default:
        return 'No action required.';
    }
  }
}
