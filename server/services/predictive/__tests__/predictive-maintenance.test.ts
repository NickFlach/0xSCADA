/**
 * Predictive Maintenance Engine tests
 * ADR-0013 [13.1] — Issue #212
 */

import { describe, it, expect, vi } from 'vitest';
import type { AnomalyDetector, TimeSeriesPoint } from '@shared/types/predictive';
import {
  quantile,
  computeZScore,
  zScoreDetector,
  ewmaDetector,
  iqrDetector,
  ensembleScore,
  classifySeverity,
  estimateTrend,
  estimateHoursToLimit,
} from '../detectors';
import { PredictiveMaintenanceEngine } from '../engine';
import { PredictiveMaintenanceService } from '../index';

function series(values: number[], intervalMs = 1000): TimeSeriesPoint[] {
  return values.map((value, i) => ({ timestamp: i * intervalMs, value }));
}

// ── Statistics primitives ─────────────────────────────────────────────────

describe('quantile', () => {
  it('interpolates linearly between sample points', () => {
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75);
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5);
    expect(quantile([1, 2, 3, 4], 1)).toBe(4);
  });

  it('handles unsorted input', () => {
    expect(quantile([4, 1, 3, 2], 0.5)).toBeCloseTo(2.5);
  });
});

describe('computeZScore', () => {
  it('returns 0 for constant values', () => {
    const result = computeZScore([5, 5, 5, 5, 5]);
    expect(result.zScore).toBe(0);
    expect(result.mean).toBe(5);
  });

  it('treats a deviation from a zero-variance baseline as infinite', () => {
    const result = computeZScore([10, 10, 10, 10, 50]);
    expect(result.zScore).toBe(Infinity);
  });

  it('measures the latest value against the preceding baseline', () => {
    const result = computeZScore([10, 12, 11, 9, 10, 11, 10, 12, 9, 30]);
    expect(result.mean).toBeCloseTo(10.44, 1);
    expect(result.zScore).toBeGreaterThan(3);
  });
});

// ── Detectors ─────────────────────────────────────────────────────────────

describe('zScoreDetector', () => {
  it('flags a spike at the end of the series', () => {
    const values = Array.from({ length: 49 }, (_, i) => 10 + Math.sin(i) * 2);
    const result = zScoreDetector(series([...values, 100]), 3);
    expect(result.anomalous).toBe(true);
    expect(result.score).toBe(1);
    expect(result.detector).toBe('z-score');
  });

  it('passes normal data', () => {
    const values = Array.from({ length: 50 }, (_, i) => 10 + Math.sin(i) * 2);
    const result = zScoreDetector(series(values), 3);
    expect(result.anomalous).toBe(false);
  });
});

describe('ewmaDetector', () => {
  it('detects a sudden jump', () => {
    const values = Array.from({ length: 30 }, (_, i) => 50 + Math.sin(i));
    const result = ewmaDetector(series([...values, 200]), 0.3, 3);
    expect(result.anomalous).toBe(true);
  });

  it('passes a steady signal', () => {
    const values = Array.from({ length: 30 }, (_, i) => 50 + Math.sin(i));
    const result = ewmaDetector(series(values), 0.3, 3);
    expect(result.anomalous).toBe(false);
  });

  it('uses sigma-scaled limits so units do not matter', () => {
    const small = Array.from({ length: 30 }, (_, i) => 0.5 + Math.sin(i) * 0.01);
    const result = ewmaDetector(series([...small, 2]), 0.3, 3);
    expect(result.anomalous).toBe(true);
  });

  it('reports insufficient data for tiny series', () => {
    const result = ewmaDetector(series([1, 2]), 0.3, 3);
    expect(result.anomalous).toBe(false);
    expect(result.details.insufficient).toBe(true);
  });
});

describe('iqrDetector', () => {
  it('detects outliers beyond the fences', () => {
    const values = Array.from({ length: 30 }, (_, i) => 10 + (i % 5));
    const result = iqrDetector(series([...values, 100]), 1.5);
    expect(result.anomalous).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });

  it('passes values inside the fences', () => {
    const values = Array.from({ length: 30 }, (_, i) => 10 + (i % 5));
    const result = iqrDetector(series([...values, 12]), 1.5);
    expect(result.anomalous).toBe(false);
  });
});

// ── Ensemble & severity ───────────────────────────────────────────────────

describe('ensembleScore', () => {
  it('computes a weighted average', () => {
    const results = [
      { detector: 'z-score', score: 1, anomalous: true, details: {} },
      { detector: 'ewma', score: 0, anomalous: false, details: {} },
    ];
    expect(ensembleScore(results, { 'z-score': 3, ewma: 1 })).toBeCloseTo(0.75);
  });

  it('defaults unlisted detectors to weight 1', () => {
    const results = [
      { detector: 'custom-ml', score: 0.5, anomalous: true, details: {} },
    ];
    expect(ensembleScore(results, {})).toBeCloseTo(0.5);
  });

  it('returns 0 for no results', () => {
    expect(ensembleScore([], {})).toBe(0);
  });
});

describe('classifySeverity', () => {
  const t = { warning: 0.4, critical: 0.7, emergency: 0.9 };
  it('classifies at each boundary', () => {
    expect(classifySeverity(0.1, t)).toBe('info');
    expect(classifySeverity(0.4, t)).toBe('warning');
    expect(classifySeverity(0.7, t)).toBe('critical');
    expect(classifySeverity(0.95, t)).toBe('emergency');
  });
});

// ── Trend estimation ──────────────────────────────────────────────────────

describe('estimateTrend', () => {
  it('recovers the slope of a linear ramp', () => {
    // 1 unit per minute = 60 units/hour
    const points = Array.from({ length: 30 }, (_, i) => ({
      timestamp: i * 60_000,
      value: 100 + i,
    }));
    const trend = estimateTrend(points)!;
    expect(trend.slopePerHour).toBeCloseTo(60);
    expect(trend.rSquared).toBeCloseTo(1);
  });

  it('returns zero slope for flat data', () => {
    const trend = estimateTrend(series([5, 5, 5, 5, 5]))!;
    expect(trend.slopePerHour).toBeCloseTo(0);
  });
});

describe('estimateHoursToLimit', () => {
  it('projects time to a high limit', () => {
    const trend = { slopePerHour: 60, latestFitted: 129, rSquared: 1 };
    const result = estimateHoursToLimit(trend, { high: 189 })!;
    expect(result.hours).toBeCloseTo(1);
    expect(result.limit).toBe(189);
  });

  it('projects time to a low limit on a falling trend', () => {
    const trend = { slopePerHour: -10, latestFitted: 50, rSquared: 1 };
    const result = estimateHoursToLimit(trend, { low: 20 })!;
    expect(result.hours).toBeCloseTo(3);
  });

  it('returns null when not trending toward a limit', () => {
    const trend = { slopePerHour: -10, latestFitted: 50, rSquared: 1 };
    expect(estimateHoursToLimit(trend, { high: 100 })).toBeNull();
  });

  it('returns 0 hours when already past the limit', () => {
    const trend = { slopePerHour: 5, latestFitted: 120, rSquared: 1 };
    expect(estimateHoursToLimit(trend, { high: 100 })!.hours).toBe(0);
  });
});

// ── Engine ────────────────────────────────────────────────────────────────

describe('PredictiveMaintenanceEngine', () => {
  it('returns null for insufficient data', async () => {
    const engine = new PredictiveMaintenanceEngine();
    engine.ingestPoint('x', 0, 10);
    expect(await engine.analyze('x')).toBeNull();
  });

  it('detects a spike, classifies severity, and emits an alert', async () => {
    const engine = new PredictiveMaintenanceEngine();
    const onAlert = vi.fn();
    engine.on('alert', onAlert);

    for (let i = 0; i < 50; i++) engine.ingestPoint('temp-1', i * 1000, 25 + Math.sin(i));
    engine.ingestPoint('temp-1', 50_000, 200);

    const result = await engine.analyze('temp-1');
    expect(result).not.toBeNull();
    expect(result!.severity).not.toBe('info');
    expect(result!.detectorResults.length).toBe(3);
    expect(onAlert).toHaveBeenCalledTimes(1);

    const alerts = engine.getAlerts();
    expect(alerts.length).toBe(1);
    expect(alerts[0].detectors.length).toBeGreaterThan(0);
    expect(alerts[0].recommendation).toBeTruthy();
  });

  it('suppresses duplicate alerts within the cooldown window', async () => {
    const engine = new PredictiveMaintenanceEngine({ alertCooldownMs: 60_000 });
    for (let i = 0; i < 50; i++) engine.ingestPoint('t', i * 1000, 10);
    engine.ingestPoint('t', 50_000, 500);

    await engine.analyze('t');
    await engine.analyze('t');
    expect(engine.getAlerts().length).toBe(1);
  });

  it('acknowledges alerts and filters by acknowledged state', async () => {
    const engine = new PredictiveMaintenanceEngine();
    for (let i = 0; i < 50; i++) engine.ingestPoint('t', i * 1000, 10);
    engine.ingestPoint('t', 50_000, 500);
    await engine.analyze('t');

    const [alert] = engine.getAlerts();
    expect(engine.acknowledgeAlert(alert.id)).toBe(true);
    expect(engine.getAlerts({ acknowledged: false })).toHaveLength(0);
    expect(engine.getAlerts({ acknowledged: true })).toHaveLength(1);
    expect(engine.acknowledgeAlert('nope')).toBe(false);
  });

  it('merges per-tag threshold overrides onto defaults', () => {
    const engine = new PredictiveMaintenanceEngine();
    const updated = engine.setThresholds('tag-a', {
      zScoreThreshold: 4,
      severityThresholds: { warning: 0.5, critical: 0.8, emergency: 0.95 },
    });
    expect(updated.zScoreThreshold).toBe(4);
    expect(updated.iqrMultiplier).toBe(1.5); // default preserved
    expect(engine.getThresholds('tag-a').severityThresholds.warning).toBe(0.5);
    // unconfigured tags fall back to defaults
    expect(engine.getThresholds('tag-b').zScoreThreshold).toBe(3);
  });

  it('runs registered ML detectors alongside statistical ones', async () => {
    const engine = new PredictiveMaintenanceEngine();
    const mlDetector: AnomalyDetector = {
      name: 'custom-ml',
      kind: 'ml',
      detect: async () => ({
        detector: 'custom-ml',
        score: 1,
        anomalous: true,
        details: { model: 'v1' },
      }),
    };
    engine.registerDetector(mlDetector);
    expect(engine.getDetectors().map((d) => d.name)).toContain('custom-ml');

    for (let i = 0; i < 20; i++) engine.ingestPoint('t', i * 1000, 10 + Math.sin(i));
    const result = await engine.analyze('t');
    expect(result!.detectorResults.map((d) => d.detector)).toContain('custom-ml');

    expect(engine.unregisterDetector('custom-ml')).toBe(true);
  });

  it('surfaces detector failures without breaking analysis', async () => {
    const engine = new PredictiveMaintenanceEngine();
    const onError = vi.fn();
    engine.on('detector-error', onError);
    engine.registerDetector({
      name: 'broken',
      kind: 'ml',
      detect: () => {
        throw new Error('model unavailable');
      },
    });

    for (let i = 0; i < 20; i++) engine.ingestPoint('t', i * 1000, 10 + Math.sin(i));
    const result = await engine.analyze('t');
    expect(result).not.toBeNull();
    expect(result!.detectorResults.length).toBe(3); // built-ins still ran
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ detector: 'broken', tagId: 't' })
    );
  });

  it('bounds history to the sliding window', () => {
    const engine = new PredictiveMaintenanceEngine({ maxHistorySize: 100 });
    for (let i = 0; i < 250; i++) engine.ingestPoint('t', i * 1000, i);
    const history = engine.getHistory('t');
    expect(history.length).toBe(100);
    expect(history[0].value).toBe(150);
  });

  it('ignores non-finite inputs', () => {
    const engine = new PredictiveMaintenanceEngine();
    engine.ingestPoint('t', 0, NaN);
    engine.ingestPoint('t', NaN, 5);
    engine.ingestPoint('t', 0, Infinity);
    expect(engine.getHistory('t')).toHaveLength(0);
  });

  it('predicts hours until a failure limit on a rising trend', async () => {
    const engine = new PredictiveMaintenanceEngine();
    engine.setThresholds('bearing-temp', { failureLimits: { high: 189 } });
    // 1 unit/minute ramp: 100 → 129 over 30 minutes, limit 60 units away
    for (let i = 0; i < 30; i++) engine.ingestPoint('bearing-temp', i * 60_000, 100 + i);

    const prediction = await engine.predictFailure('bearing-temp');
    expect(prediction).not.toBeNull();
    expect(prediction!.estimatedHoursToLimit).toBeCloseTo(1, 1);
    expect(prediction!.limit).toBe(189);
    expect(prediction!.trendSlopePerHour).toBeCloseTo(60);
    expect(prediction!.confidence).toBeCloseTo(1);
    expect(prediction!.failureProbability).toBeGreaterThan(0.9);
    // prediction must not generate alerts as a side effect
    expect(engine.getAlerts()).toHaveLength(0);
  });

  it('reports tracked tags and status', () => {
    const engine = new PredictiveMaintenanceEngine();
    for (let i = 0; i < 5; i++) engine.ingestPoint('a', i, i);
    engine.ingestPoint('b', 0, 1);

    const tags = engine.getTrackedTags();
    expect(tags).toHaveLength(2);
    expect(tags.find((t) => t.tagId === 'a')!.samples).toBe(5);

    const status = engine.getStatus();
    expect(status.trackedTags).toBe(2);
    expect(status.totalSamples).toBe(6);
    expect(status.detectors.map((d) => d.name)).toEqual(['z-score', 'ewma', 'iqr']);

    engine.clearHistory('a');
    expect(engine.getTrackedTags()).toHaveLength(1);
  });
});

// ── Service wrapper ───────────────────────────────────────────────────────

describe('PredictiveMaintenanceService', () => {
  it('ingests numeric tag updates and skips non-numeric values', () => {
    const service = new PredictiveMaintenanceService();
    service.ingestTagUpdate({ tagName: 'pump.flow', value: 42.5, timestamp: 1000 });
    service.ingestTagUpdate({ tagName: 'pump.flow', value: '43.1', timestamp: '1970-01-01T00:00:02.000Z' });
    service.ingestTagUpdate({ tagName: 'pump.flow', value: 'running', timestamp: 3000 });
    service.ingestTagUpdate({ tagName: 'pump.flow', value: true, timestamp: 4000 });
    service.ingestTagUpdate({ tagName: 'pump.flow', value: 44, timestamp: 'not-a-date' });

    const history = service.engine.getHistory('pump.flow');
    expect(history).toHaveLength(2);
    expect(history[1].value).toBeCloseTo(43.1);
    expect(history[1].timestamp).toBe(2000);
  });

  it('re-emits engine alerts', async () => {
    const service = new PredictiveMaintenanceService();
    const onAlert = vi.fn();
    service.on('alert', onAlert);

    for (let i = 0; i < 50; i++) {
      service.ingestTagUpdate({ tagName: 't', value: 10, timestamp: i * 1000 });
    }
    service.ingestTagUpdate({ tagName: 't', value: 500, timestamp: 50_000 });
    await service.engine.analyze('t');
    expect(onAlert).toHaveBeenCalledTimes(1);
  });

  it('reports health based on initialization', async () => {
    const service = new PredictiveMaintenanceService();
    expect((await service.healthCheck()).healthy).toBe(false);
    await service.initialize();
    expect((await service.healthCheck()).healthy).toBe(true);
    await service.shutdown();
    expect((await service.healthCheck()).healthy).toBe(false);
  });
});
