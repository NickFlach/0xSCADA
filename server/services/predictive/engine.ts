/**
 * Predictive Maintenance Engine
 * ADR-0013 [13.1] — Issue #212, made durable by #546
 *
 * Ingests tag time-series, runs an ensemble of anomaly detectors
 * (z-score, EWMA, IQR by default — ML models pluggable via the
 * AnomalyDetector contract), classifies severity against per-tag
 * thresholds, and generates alerts before failures using trend-based
 * time-to-limit estimation.
 *
 * ─── WHAT LIVES WHERE (#546) ────────────────────────────────────────────────
 *
 * Durable, in the shared store (`./store.ts`):
 *   - per-tag operator thresholds
 *   - generated alerts, their identity, and acknowledgement attribution
 *
 * In process, deliberately:
 *   - the detector registry (that is code, not state)
 *   - the raw prediction history: a bounded per-tag sliding window
 *     (`maxHistorySize` points over at most `maxTrackedTags` tags) fed by the
 *     live tag stream. It is recomputable, the historian is the system of
 *     record for sampled process data, and persisting it would put a write on
 *     every ingested sample. Its retention is therefore defined here and
 *     independently of the durable retention applied to alerts.
 *
 * There is no process-local ownership of durable state: alert suppression is
 * an idempotent insert against a content-derived primary key rather than a
 * local `lastAlertAt` map, so a restarted process — or a second replica —
 * neither loses nor duplicates an alert.
 */

import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'events';
import type {
  AcknowledgeOutcome,
  AnomalyAssessment,
  AnomalyDetector,
  DetectorResult,
  MaintenancePrediction,
  PredictiveAlert,
  PredictiveHydrationSummary,
  SeverityLevel,
  SeverityThresholds,
  TagThresholds,
  TimeSeriesPoint,
} from '@shared/types/predictive';
import {
  predictiveStore,
  PredictiveStoreUnavailableError,
  type AlertFilter,
  type PredictiveStore,
  type PruneResult,
} from './store';

/** Threshold overrides — nested objects may be partial; they merge over the base */
export type ThresholdOverrides = Partial<
  Omit<TagThresholds, 'tagId' | 'severityThresholds'>
> & {
  severityThresholds?: Partial<SeverityThresholds>;
};
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

/** Acknowledged alerts are pruned after this long. */
export const DEFAULT_ALERT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** Any alert is pruned after this long, acknowledged or not. */
export const DEFAULT_ALERT_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
/** Durable row cap for `predictive_alerts`. */
export const DEFAULT_MAX_ALERTS = 5_000;

export interface EngineOptions {
  /** Points retained per tag, in process (sliding window) */
  maxHistorySize?: number;
  /** Durable alert rows retained before the oldest are evicted */
  maxAlerts?: number;
  /** Suppress repeat alerts for the same tag+severity within this window */
  alertCooldownMs?: number;
  /** Tags tracked in process before the least-recently-updated is evicted */
  maxTrackedTags?: number;
  /** Acknowledged alerts older than this are pruned */
  alertRetentionMs?: number;
  /** Any alert older than this is pruned, acknowledged or not */
  alertMaxAgeMs?: number;
  /** Durable state boundary. Defaults to the process-wide store. */
  store?: PredictiveStore;
}

export class PredictiveMaintenanceEngine extends EventEmitter {
  private readonly maxHistorySize: number;
  private readonly maxAlerts: number;
  private readonly alertCooldownMs: number;
  private readonly maxTrackedTags: number;
  private readonly alertRetentionMs: number;
  private readonly alertMaxAgeMs: number;
  private readonly store: PredictiveStore;
  /** Only used to keep ids unique when alert suppression is switched off */
  private readonly bootId: string;

  private detectors: Map<string, AnomalyDetector> = new Map();
  /** Insertion order doubles as recency order — refreshed on every ingest */
  private history: Map<string, TimeSeriesPoint[]> = new Map();
  private alertNonce = 0;
  private lastStoreError: string | null = null;

  constructor(options: EngineOptions = {}) {
    super();
    this.maxHistorySize = options.maxHistorySize ?? 1000;
    this.maxAlerts = options.maxAlerts ?? DEFAULT_MAX_ALERTS;
    this.alertCooldownMs = options.alertCooldownMs ?? 5 * 60 * 1000;
    this.maxTrackedTags = options.maxTrackedTags ?? 500;
    this.alertRetentionMs = options.alertRetentionMs ?? DEFAULT_ALERT_RETENTION_MS;
    this.alertMaxAgeMs = options.alertMaxAgeMs ?? DEFAULT_ALERT_MAX_AGE_MS;
    this.store = options.store ?? predictiveStore;
    this.bootId = randomUUID();
    for (const d of builtinDetectors) {
      this.detectors.set(d.name, d);
    }
  }

  // ── Startup hydration ────────────────────────────────────────────────

  /**
   * Open the durable store and report what is already there.
   *
   * There is nothing to copy into memory: thresholds and alerts are read from
   * the store on demand, which is what lets a second replica see the first
   * one's configuration and acknowledgements. Hydration is therefore
   * deterministic and idempotent by construction — running it twice, or after
   * a restart, can neither drop a row nor create one. The returned summary is
   * the observable proof that state was found rather than silently reset.
   */
  async hydrate(): Promise<PredictiveHydrationSummary> {
    await this.runDurable(() => this.store.ready());
    const [configuredTags, counts] = await Promise.all([
      this.runDurable(() => this.store.countThresholds()),
      this.runDurable(() => this.store.countAlerts()),
    ]);
    return {
      backend: this.store.backend(),
      configuredTags,
      totalAlerts: counts.total,
      unacknowledgedAlerts: counts.unacknowledged,
    };
  }

  /** Last durable-store failure seen, for `/status`. Null once one succeeds. */
  getLastStoreError(): string | null {
    return this.lastStoreError;
  }

  storeBackend(): 'postgres' | 'sqlite' | 'unopened' {
    return this.store.backend();
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

  // ── Per-tag threshold configuration (durable) ────────────────────────

  /**
   * Merge `overrides` over the stored configuration and persist the result.
   *
   * Store-first: the merged value is only returned once the row is written, so
   * a caller can never be told a threshold was configured when it was not.
   * `updatedBy` is the authenticated control-plane principal supplied by the
   * route — it is never read from a request body.
   */
  async setThresholds(
    tagId: string,
    overrides: ThresholdOverrides,
    updatedBy: string,
  ): Promise<TagThresholds> {
    if (updatedBy.trim() === '') {
      throw new Error('setThresholds requires an authenticated principal name');
    }
    const base = await this.getThresholds(tagId);
    const merged: TagThresholds = {
      ...base,
      ...overrides,
      ensembleWeights: { ...base.ensembleWeights, ...overrides.ensembleWeights },
      severityThresholds: { ...base.severityThresholds, ...overrides.severityThresholds },
      tagId,
    };
    const stored = await this.runDurable(() =>
      this.store.upsertThresholds({ thresholds: merged, updatedBy, at: new Date() }));
    return stored.thresholds;
  }

  /** Stored thresholds for a tag, or the built-in defaults if none are set. */
  async getThresholds(tagId: string): Promise<TagThresholds> {
    const stored = await this.runDurable(() => this.store.getThresholds(tagId));
    return stored?.thresholds ?? { ...DEFAULT_THRESHOLDS, tagId };
  }

  /** Every tag an operator has explicitly configured, with attribution. */
  async listConfiguredTags(): Promise<
    Array<{ tagId: string; thresholds: TagThresholds; updatedBy: string; updatedAt: Date }>
  > {
    const rows = await this.runDurable(() => this.store.listThresholds());
    return rows.map(({ tagId, thresholds, updatedBy, updatedAt }) => ({
      tagId,
      thresholds,
      updatedBy,
      updatedAt,
    }));
  }

  // ── Ingestion ────────────────────────────────────────────────────────

  ingestPoint(tagId: string, timestamp: number, value: number): void {
    if (!Number.isFinite(timestamp) || !Number.isFinite(value)) return;
    let series = this.history.get(tagId);
    if (series) {
      // Refresh recency: Map insertion order is the eviction order
      this.history.delete(tagId);
    } else {
      series = [];
    }
    this.history.set(tagId, series);
    series.push({ timestamp, value });
    if (series.length > this.maxHistorySize) {
      series.splice(0, series.length - this.maxHistorySize);
    }
    this.evictStaleTags();
  }

  ingestSeries(tagId: string, points: TimeSeriesPoint[]): void {
    for (const p of points) this.ingestPoint(tagId, p.timestamp, p.value);
  }

  // ── Analysis ─────────────────────────────────────────────────────────

  async analyze(
    tagId: string,
    options: { generateAlerts?: boolean } = {}
  ): Promise<AnomalyAssessment | null> {
    const live = this.history.get(tagId);
    // Thresholds come from the shared store, so a configuration change made on
    // another replica takes effect here without a restart.
    const cfg = await this.getThresholds(tagId);
    if (!live || live.length < cfg.minSamples) return null;
    // Snapshot before any await — the live series mutates while async
    // detectors run, and every detector (and the alert) must describe the
    // same window.
    const series = live.slice();

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
      await this.generateAlert(assessment);
    }

    return assessment;
  }

  async analyzeAll(): Promise<AnomalyAssessment[]> {
    const results: AnomalyAssessment[] = [];
    for (const tagId of Array.from(this.history.keys())) {
      try {
        const result = await this.analyze(tagId);
        if (result) results.push(result);
      } catch (error) {
        // One tag's failure (including a throwing 'alert' listener or an
        // unreachable store) must not starve the remaining tags of analysis.
        this.emit('analyze-error', {
          tagId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  // ── Failure prediction (alert before failure) ────────────────────────

  async predictFailure(tagId: string): Promise<MaintenancePrediction | null> {
    const series = this.history.get(tagId);
    const cfg = await this.getThresholds(tagId);
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

  // ── Alerts (durable) ─────────────────────────────────────────────────

  /** Read alerts from the shared store, oldest first. */
  listAlerts(filter?: AlertFilter): Promise<PredictiveAlert[]> {
    return this.runDurable(() => this.store.listAlerts(filter));
  }

  getAlert(alertId: string): Promise<PredictiveAlert | null> {
    return this.runDurable(() => this.store.getAlert(alertId));
  }

  /**
   * Record an acknowledgement against the durable alert row.
   *
   * `acknowledgedBy` must be an authenticated control-plane principal name.
   * The update is conditional on the alert still being unacknowledged, so a
   * second acknowledgement — from this process or another replica — reports
   * `already-acknowledged` and leaves the original attribution intact.
   */
  acknowledgeAlert(alertId: string, acknowledgedBy: string): Promise<AcknowledgeOutcome> {
    if (acknowledgedBy.trim() === '') {
      // An unattributed acknowledgement is not an audit record. Refusing here
      // means no code path can write one even if a caller passes an empty
      // principal name.
      return Promise.reject(
        new Error('acknowledgeAlert requires an authenticated principal name'),
      );
    }
    return this.runDurable(() =>
      this.store.acknowledgeAlert(alertId, acknowledgedBy, new Date()));
  }

  /**
   * Apply the alert retention policy. Deliberately separate from the raw
   * history window above: operator/audit state ages out on a calendar
   * schedule, sampled data ages out by sample count.
   */
  async pruneAlerts(now: Date = new Date()): Promise<PruneResult> {
    const result = await this.runDurable(() =>
      this.store.prune({
        acknowledgedBefore: new Date(now.getTime() - this.alertRetentionMs),
        anyBefore: new Date(now.getTime() - this.alertMaxAgeMs),
        maxRows: this.maxAlerts,
      }));
    if (result.retired + result.expired + result.overflow > 0) {
      // Retention is allowed to remove state; it is not allowed to remove it
      // quietly. Unacknowledged evictions are called out separately because
      // those are the ones no operator ever closed out.
      this.emit('alerts-pruned', result);
    }
    return result;
  }

  // ── History access (in process, ephemeral) ───────────────────────────

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

  /**
   * Drop a tag's in-process sample window. This is a history operation only —
   * it deliberately does not touch the tag's durable thresholds or its alert
   * history, which belong to the operator, not to the sampling window.
   */
  clearHistory(tagId: string): void {
    this.history.delete(tagId);
  }

  /** Evict least-recently-updated tags beyond the tracked-tag cap */
  private evictStaleTags(): void {
    while (this.history.size > this.maxTrackedTags) {
      const oldest = this.history.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.clearHistory(oldest);
      this.emit('tag-evicted', { tagId: oldest });
    }
  }

  /** In-process status. Durable counts come from `getDurableStatus()`. */
  getStatus(): {
    trackedTags: number;
    totalSamples: number;
    detectors: Array<Pick<AnomalyDetector, 'name' | 'kind'>>;
  } {
    let totalSamples = 0;
    for (const series of this.history.values()) totalSamples += series.length;
    return {
      trackedTags: this.history.size,
      totalSamples,
      detectors: this.getDetectors(),
    };
  }

  /** Durable state summary, read from the shared store. */
  async getDurableStatus(): Promise<{
    backend: 'postgres' | 'sqlite' | 'unopened';
    configuredTags: number;
    activeAlerts: number;
    totalAlerts: number;
  }> {
    const [configuredTags, counts] = await Promise.all([
      this.runDurable(() => this.store.countThresholds()),
      this.runDurable(() => this.store.countAlerts()),
    ]);
    return {
      backend: this.store.backend(),
      configuredTags,
      activeAlerts: counts.unacknowledged,
      totalAlerts: counts.total,
    };
  }

  // ── Private ──────────────────────────────────────────────────────────

  /**
   * Content-derived alert identity.
   *
   * The tuple is (tag, severity, cooldown window). Two consequences, both
   * intentional:
   *   - a restarted process that re-detects the same anomaly inside the same
   *     window writes the same primary key, so the alert is not duplicated and
   *     an acknowledgement made before the restart still applies to it;
   *   - two replicas that both see the anomaly converge on one row, which is
   *     what replaces the old process-local `lastAlertAt` suppression map.
   *
   * The window is aligned on absolute time (`floor(now / cooldown)`) rather
   * than measured from the previous alert, because a sliding window needs a
   * shared "previous alert" value and that is precisely the process-local
   * state this issue removes. When suppression is disabled (`cooldown <= 0`)
   * every alert must stay distinct, so the tuple gets a per-process nonce.
   */
  private alertId(tagId: string, severity: SeverityLevel, now: number): string {
    const window = this.alertCooldownMs > 0
      ? String(Math.floor(now / this.alertCooldownMs))
      : `${this.bootId}:${now}:${++this.alertNonce}`;
    const digest = createHash('sha256')
      .update(`${tagId} ${severity} ${window}`)
      .digest('hex');
    return `PMA-${digest.slice(0, 32)}`;
  }

  /**
   * Persist first, emit second.
   *
   * The `alert` event drives the operator-facing alarm fan-out, so it is only
   * raised once the row exists: an alarm the operator cannot then acknowledge
   * — because the alert was never recorded — would be worse than no alarm.
   * If the store is unreachable this throws, which fails the ingest request
   * closed and surfaces on `/api/predictive/status`; the next analysis of a
   * still-anomalous tag retries the same id.
   */
  private async generateAlert(assessment: AnomalyAssessment): Promise<void> {
    // Suppression runs on wall clock, not on data timestamps: keying it on
    // data time would let one future-dated point mute a tag+severity
    // permanently.
    const now = Date.now();
    const alert: PredictiveAlert = {
      id: this.alertId(assessment.tagId, assessment.severity, now),
      tagId: assessment.tagId,
      severity: assessment.severity,
      score: assessment.ensembleScore,
      message: assessment.description,
      timestamp: assessment.timestamp,
      detectors: assessment.detectorResults.filter((d) => d.anomalous).map((d) => d.detector),
      acknowledged: false,
      recommendation: this.getRecommendation(assessment.severity),
      createdAt: now,
      acknowledgedBy: null,
      acknowledgedAt: null,
    };

    const inserted = await this.runDurable(() => this.store.insertAlert(alert));
    // Already present: this tag+severity already alerted in this window, on
    // this process or another one. Suppressed, exactly as before — only now
    // the suppression survives a restart.
    if (!inserted) return;

    try {
      this.emit('alert', alert);
    } catch (error) {
      // A throwing listener must not abort the caller's analysis loop
      this.emit('analyze-error', {
        tagId: alert.tagId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Run a durable-store operation, recording the outcome so failures are
   * observable rather than silent. The error is re-thrown: every caller either
   * fails a mutation closed or is caught by `analyzeAll`'s per-tag handler.
   */
  private async runDurable<T>(operation: () => Promise<T>): Promise<T> {
    try {
      const value = await operation();
      this.lastStoreError = null;
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastStoreError = message;
      this.emit('store-error', { error: message });
      if (error instanceof PredictiveStoreUnavailableError) throw error;
      throw new PredictiveStoreUnavailableError(message, error);
    }
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
