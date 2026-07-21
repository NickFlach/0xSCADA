/**
 * Predictive Maintenance Engine
 * ADR-0013 [13.1] — Issue #212
 *
 * Ingests tag time-series, runs an ensemble of anomaly detectors
 * (z-score, EWMA, IQR by default — ML models pluggable via the
 * AnomalyDetector contract), classifies severity against per-tag
 * thresholds, and generates alerts before failures using trend-based
 * time-to-limit estimation.
 */

import { EventEmitter } from 'events';
import type {
  AnomalyAssessment,
  AnomalyDetector,
  DetectorResult,
  MaintenancePrediction,
  PredictiveAlert,
  SeverityLevel,
  TagThresholds,
  TimeSeriesPoint,
} from '@shared/types/predictive';
import {
  builtinDetectors,
  classifySeverity,
  ensembleScore,
  estimateHoursToLimit,
  estimateTrend,
} from './detectors';

export const DEFAULT_THRESHOLDS: Omit<TagThresholds, 'tagId'> = {
  minSamples: 10,
  zScoreThreshold: 3,
  ewmaAlpha: 0.3,
  ewmaL: 3,
  iqrMultiplier: 1.5,
  ensembleWeights: { 'z-score': 0.4, ewma: 0.35, iqr: 0.25 },
  severityThresholds: { warning: 0.4, critical: 0.7, emergency: 0.9 },
};

export interface EngineOptions {
  /** Points retained per tag (sliding window) */
  maxHistorySize?: number;
  /** Alerts retained before the oldest are dropped */
  maxAlerts?: number;
  /** Suppress repeat alerts for the same tag+severity within this window */
  alertCooldownMs?: number;
}

export class PredictiveMaintenanceEngine extends EventEmitter {
  private readonly maxHistorySize: number;
  private readonly maxAlerts: number;
  private readonly alertCooldownMs: number;

  private detectors: Map<string, AnomalyDetector> = new Map();
  private thresholds: Map<string, TagThresholds> = new Map();
  private history: Map<string, TimeSeriesPoint[]> = new Map();
  private alerts: PredictiveAlert[] = [];
  private lastAlertAt: Map<string, number> = new Map(); // key: tagId:severity
  private alertCounter = 0;

  constructor(options: EngineOptions = {}) {
    super();
    this.maxHistorySize = options.maxHistorySize ?? 1000;
    this.maxAlerts = options.maxAlerts ?? 500;
    this.alertCooldownMs = options.alertCooldownMs ?? 5 * 60 * 1000;
    for (const d of builtinDetectors) {
      this.detectors.set(d.name, d);
    }
  }

  // ── Detector registry (ML integration point) ─────────────────────────

  registerDetector(detector: AnomalyDetector): void {
    this.detectors.set(detector.name, detector);
  }

  unregisterDetector(name: string): boolean {
    return this.detectors.delete(name);
  }

  getDetectors(): Array<Pick<AnomalyDetector, 'name' | 'kind'>> {
    return Array.from(this.detectors.values()).map(({ name, kind }) => ({ name, kind }));
  }

  // ── Per-tag threshold configuration ──────────────────────────────────

  setThresholds(tagId: string, overrides: Partial<Omit<TagThresholds, 'tagId'>>): TagThresholds {
    const base = this.thresholds.get(tagId) ?? { ...DEFAULT_THRESHOLDS, tagId };
    const merged: TagThresholds = {
      ...base,
      ...overrides,
      ensembleWeights: { ...base.ensembleWeights, ...overrides.ensembleWeights },
      severityThresholds: { ...base.severityThresholds, ...overrides.severityThresholds },
      tagId,
    };
    this.thresholds.set(tagId, merged);
    return merged;
  }

  getThresholds(tagId: string): TagThresholds {
    return this.thresholds.get(tagId) ?? { ...DEFAULT_THRESHOLDS, tagId };
  }

  // ── Ingestion ────────────────────────────────────────────────────────

  ingestPoint(tagId: string, timestamp: number, value: number): void {
    if (!Number.isFinite(timestamp) || !Number.isFinite(value)) return;
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

  ingestSeries(tagId: string, points: TimeSeriesPoint[]): void {
    for (const p of points) this.ingestPoint(tagId, p.timestamp, p.value);
  }

  // ── Analysis ─────────────────────────────────────────────────────────

  async analyze(
    tagId: string,
    options: { generateAlerts?: boolean } = {}
  ): Promise<AnomalyAssessment | null> {
    const series = this.history.get(tagId);
    const cfg = this.getThresholds(tagId);
    if (!series || series.length < cfg.minSamples) return null;

    const detectorResults: DetectorResult[] = [];
    for (const detector of this.detectors.values()) {
      try {
        detectorResults.push(await detector.detect(series, cfg));
      } catch (error) {
        this.emit('detector-error', {
          detector: detector.name,
          tagId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (detectorResults.length === 0) return null;

    const ensemble = ensembleScore(detectorResults, cfg.ensembleWeights);
    const severity = classifySeverity(ensemble, cfg.severityThresholds);
    const latest = series[series.length - 1];

    const assessment: AnomalyAssessment = {
      tagId,
      timestamp: latest.timestamp,
      value: latest.value,
      detectorResults,
      ensembleScore: ensemble,
      severity,
      description: this.describeAnomaly(tagId, severity, detectorResults),
    };

    if (severity !== 'info' && options.generateAlerts !== false) {
      this.generateAlert(assessment);
    }

    return assessment;
  }

  async analyzeAll(): Promise<AnomalyAssessment[]> {
    const results: AnomalyAssessment[] = [];
    for (const tagId of this.history.keys()) {
      const result = await this.analyze(tagId);
      if (result) results.push(result);
    }
    return results;
  }

  // ── Failure prediction (alert before failure) ────────────────────────

  async predictFailure(tagId: string): Promise<MaintenancePrediction | null> {
    const series = this.history.get(tagId);
    const cfg = this.getThresholds(tagId);
    if (!series || series.length < cfg.minSamples) return null;

    const trend = estimateTrend(series);
    if (!trend) return null;

    const toLimit = cfg.failureLimits
      ? estimateHoursToLimit(trend, cfg.failureLimits)
      : null;

    const assessment = await this.analyze(tagId, { generateAlerts: false });
    const anomalyScore = assessment?.ensembleScore ?? 0;

    // Blend current anomaly level with trend certainty; an imminent limit
    // crossing dominates the probability.
    let failureProbability = anomalyScore;
    if (toLimit) {
      const urgency = toLimit.hours <= 0 ? 1 : Math.min(24 / (toLimit.hours + 24), 1);
      failureProbability = Math.min(1, Math.max(anomalyScore, urgency * trend.rSquared));
    }

    return {
      tagId,
      failureProbability,
      estimatedHoursToLimit: toLimit ? Math.max(0, toLimit.hours) : null,
      trendSlopePerHour: trend.slopePerHour,
      limit: toLimit?.limit ?? null,
      recommendedAction: this.getRecommendation(
        classifySeverity(failureProbability, cfg.severityThresholds)
      ),
      confidence: trend.rSquared,
    };
  }

  // ── Alerts ───────────────────────────────────────────────────────────

  getAlerts(filter?: { severity?: SeverityLevel; acknowledged?: boolean }): PredictiveAlert[] {
    let alerts = [...this.alerts];
    if (filter?.severity) alerts = alerts.filter((a) => a.severity === filter.severity);
    if (filter?.acknowledged !== undefined) {
      alerts = alerts.filter((a) => a.acknowledged === filter.acknowledged);
    }
    return alerts;
  }

  acknowledgeAlert(alertId: string): boolean {
    const alert = this.alerts.find((a) => a.id === alertId);
    if (!alert) return false;
    alert.acknowledged = true;
    return true;
  }

  // ── History access ───────────────────────────────────────────────────

  getHistory(tagId: string): TimeSeriesPoint[] {
    return this.history.get(tagId) ?? [];
  }

  getTrackedTags(): Array<{ tagId: string; samples: number; latest: TimeSeriesPoint | null }> {
    return Array.from(this.history.entries()).map(([tagId, series]) => ({
      tagId,
      samples: series.length,
      latest: series[series.length - 1] ?? null,
    }));
  }

  clearHistory(tagId: string): void {
    this.history.delete(tagId);
  }

  getStatus(): {
    trackedTags: number;
    totalSamples: number;
    detectors: Array<Pick<AnomalyDetector, 'name' | 'kind'>>;
    activeAlerts: number;
    totalAlerts: number;
  } {
    let totalSamples = 0;
    for (const series of this.history.values()) totalSamples += series.length;
    return {
      trackedTags: this.history.size,
      totalSamples,
      detectors: this.getDetectors(),
      activeAlerts: this.alerts.filter((a) => !a.acknowledged).length,
      totalAlerts: this.alerts.length,
    };
  }

  // ── Private ──────────────────────────────────────────────────────────

  private generateAlert(assessment: AnomalyAssessment): void {
    const cooldownKey = `${assessment.tagId}:${assessment.severity}`;
    const last = this.lastAlertAt.get(cooldownKey);
    if (last !== undefined && assessment.timestamp - last < this.alertCooldownMs) {
      return;
    }
    this.lastAlertAt.set(cooldownKey, assessment.timestamp);

    const alert: PredictiveAlert = {
      id: `PMA-${++this.alertCounter}`,
      tagId: assessment.tagId,
      severity: assessment.severity,
      score: assessment.ensembleScore,
      message: assessment.description,
      timestamp: assessment.timestamp,
      detectors: assessment.detectorResults.filter((d) => d.anomalous).map((d) => d.detector),
      acknowledged: false,
      recommendation: this.getRecommendation(assessment.severity),
    };

    this.alerts.push(alert);
    if (this.alerts.length > this.maxAlerts) {
      this.alerts.splice(0, this.alerts.length - this.maxAlerts);
    }
    this.emit('alert', alert);
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
