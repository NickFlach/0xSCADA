/**
 * Predictive Maintenance Engine tests
 * ADR-0013 [13.1] — Issue #212
 *
 * Since #546 the engine's thresholds and alerts are durable, so these run
 * against a real private in-memory SQLite database per engine through the real
 * Drizzle store — no stub, no fake. Restart behaviour needs a file rather than
 * a private connection and is covered in `predictive-persistence.test.ts`.
 */

import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
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
import { PredictiveMaintenanceEngine, type EngineOptions } from '../engine';
import { PredictiveMaintenanceService } from '../index';
import { DrizzlePredictiveStore } from '../store';

function series(values: number[], intervalMs = 1000): TimeSeriesPoint[] {
  return values.map((value, i) => ({ timestamp: i * intervalMs, value }));
}

/** Principal name every write in this file is attributed to. */
const OPERATOR = 'unit-test-operator';

const openStores: DrizzlePredictiveStore[] = [];

/**
 * A real SQLite database, private to this connection. `:memory:` is a genuine
 * database engine executing the same SQL as production — it just cannot be
 * reopened, which is why the restart suite uses a file instead.
 */
function newStore(): DrizzlePredictiveStore {
  const store = new DrizzlePredictiveStore({ sqlitePath: ':memory:' });
  openStores.push(store);
  return store;
}

function newEngine(options: Omit<EngineOptions, 'store'> = {}): PredictiveMaintenanceEngine {
  return new PredictiveMaintenanceEngine({ ...options, store: newStore() });
}

function newService(sweepIntervalMs = 30_000): PredictiveMaintenanceService {
  return new PredictiveMaintenanceService(sweepIntervalMs, { store: newStore() });
}

afterAll(async () => {
  await Promise.all(openStores.map((store) => store.close()));
});

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
    const engine = newEngine();
    engine.ingestPoint('x', 0, 10);
    expect(await engine.analyze('x')).toBeNull();
  });

  it('detects a spike, classifies severity, and emits an alert', async () => {
    const engine = newEngine();
    const onAlert = vi.fn();
    engine.on('alert', onAlert);

    for (let i = 0; i < 50; i++) engine.ingestPoint('temp-1', i * 1000, 25 + Math.sin(i));
    engine.ingestPoint('temp-1', 50_000, 200);

    const result = await engine.analyze('temp-1');
    expect(result).not.toBeNull();
    expect(result!.severity).not.toBe('info');
    expect(result!.detectorResults.length).toBe(3);
    expect(onAlert).toHaveBeenCalledTimes(1);

    const alerts = await engine.listAlerts();
    expect(alerts.length).toBe(1);
    expect(alerts[0].detectors.length).toBeGreaterThan(0);
    expect(alerts[0].recommendation).toBeTruthy();
    // A freshly generated alert carries no attribution until someone
    // acknowledges it.
    expect(alerts[0].acknowledged).toBe(false);
    expect(alerts[0].acknowledgedBy).toBeNull();
    expect(alerts[0].acknowledgedAt).toBeNull();
  });

  it('suppresses duplicate alerts within the cooldown window', async () => {
    const engine = newEngine({ alertCooldownMs: 60_000 });
    for (let i = 0; i < 50; i++) engine.ingestPoint('t', i * 1000, 10);
    engine.ingestPoint('t', 50_000, 500);

    await engine.analyze('t');
    await engine.analyze('t');
    expect(await engine.listAlerts()).toHaveLength(1);
  });

  it('acknowledges alerts, attributes them, and filters by acknowledged state', async () => {
    const engine = newEngine();
    for (let i = 0; i < 50; i++) engine.ingestPoint('t', i * 1000, 10);
    engine.ingestPoint('t', 50_000, 500);
    await engine.analyze('t');

    const [alert] = await engine.listAlerts();
    const outcome = await engine.acknowledgeAlert(alert.id, OPERATOR);
    expect(outcome.status).toBe('acknowledged');
    expect(outcome.alert?.acknowledgedBy).toBe(OPERATOR);
    expect(outcome.alert?.acknowledgedAt).toEqual(expect.any(Number));

    expect(await engine.listAlerts({ acknowledged: false })).toHaveLength(0);
    expect(await engine.listAlerts({ acknowledged: true })).toHaveLength(1);
    expect((await engine.acknowledgeAlert('nope', OPERATOR)).status).toBe('not-found');
  });

  it('refuses an acknowledgement with no principal', async () => {
    const engine = newEngine();
    await expect(engine.acknowledgeAlert('any-id', '  ')).rejects.toThrow(
      /authenticated principal/,
    );
  });

  it('merges per-tag threshold overrides onto defaults', async () => {
    const engine = newEngine();
    const updated = await engine.setThresholds('tag-a', {
      zScoreThreshold: 4,
      severityThresholds: { warning: 0.5, critical: 0.8, emergency: 0.95 },
    }, OPERATOR);
    expect(updated.zScoreThreshold).toBe(4);
    expect(updated.iqrMultiplier).toBe(1.5); // default preserved
    expect((await engine.getThresholds('tag-a')).severityThresholds.warning).toBe(0.5);
    // unconfigured tags fall back to defaults
    expect((await engine.getThresholds('tag-b')).zScoreThreshold).toBe(3);
    // and the write is attributed to the principal that made it
    const configured = await engine.listConfiguredTags();
    expect(configured).toEqual([
      expect.objectContaining({ tagId: 'tag-a', updatedBy: OPERATOR }),
    ]);
  });

  it('runs registered ML detectors alongside statistical ones', async () => {
    const engine = newEngine();
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
    const engine = newEngine();
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
    const engine = newEngine({ maxHistorySize: 100 });
    for (let i = 0; i < 250; i++) engine.ingestPoint('t', i * 1000, i);
    const history = engine.getHistory('t');
    expect(history.length).toBe(100);
    expect(history[0].value).toBe(150);
  });

  it('ignores non-finite inputs', () => {
    const engine = newEngine();
    engine.ingestPoint('t', 0, NaN);
    engine.ingestPoint('t', NaN, 5);
    engine.ingestPoint('t', 0, Infinity);
    expect(engine.getHistory('t')).toHaveLength(0);
  });

  it('predicts hours until a failure limit on a rising trend', async () => {
    const engine = newEngine();
    await engine.setThresholds('bearing-temp', { failureLimits: { high: 189 } }, OPERATOR);
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
    expect(await engine.listAlerts()).toHaveLength(0);
  });

  it('reports tracked tags and status', () => {
    const engine = newEngine();
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
    const service = newService();
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
    const service = newService();
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
    const service = newService();
    expect((await service.healthCheck()).healthy).toBe(false);
    await service.initialize();
    expect((await service.healthCheck()).healthy).toBe(true);
    await service.shutdown();
    expect((await service.healthCheck()).healthy).toBe(false);
  });
});

// ── Review regressions (PR #493 adversarial review) ───────────────────────

describe('constant decimal series (float rounding residue)', () => {
  it('never flags flat non-integer signals at any window size', async () => {
    for (const value of [0.1, 0.4, 1.3, 1.5]) {
      for (const n of [10, 15, 20, 50]) {
        const flat = series(Array(n).fill(value));
        expect(ewmaDetector(flat, 0.3, 3).anomalous, `ewma v=${value} n=${n}`).toBe(false);
        expect(ewmaDetector(flat, 0.3, 3).score, `ewma score v=${value} n=${n}`).toBe(0);
        expect(zScoreDetector(flat, 3).score, `z score v=${value} n=${n}`).toBe(0);
      }
    }
    const engine = newEngine();
    for (let i = 0; i < 40; i++) engine.ingestPoint('flat', i * 1000, 0.4);
    const result = await engine.analyze('flat');
    expect(result!.severity).toBe('info');
    expect(await engine.listAlerts()).toHaveLength(0);
  });
});

describe('ensemble abstention', () => {
  it('renormalizes over detectors that actually ran', async () => {
    // 4 samples: IQR abstains (insufficient); z-score + EWMA both saturate.
    const engine = newEngine();
    await engine.setThresholds('fast', { minSamples: 4 }, OPERATOR);
    engine.ingestSeries('fast', series([100, 100, 100, 180]));
    const result = await engine.analyze('fast');
    expect(result!.ensembleScore).toBeCloseTo(1);
    expect(result!.severity).toBe('emergency');
  });
});

describe('IQR score contract', () => {
  it('scores exactly 1 at the Tukey fence and grades inside it', () => {
    const base = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    // q1=12.5, q3=17.5, iqr=5, fence=17.5+7.5=25
    const atFence = iqrDetector(series([...base, 25]), 1.5);
    expect(atFence.score).toBeCloseTo(1, 5);
    const inside = iqrDetector(series([...base, 21]), 1.5);
    expect(inside.anomalous).toBe(false);
    expect(inside.score).toBeGreaterThan(0);
    expect(inside.score).toBeLessThan(1);
  });
});

describe('EWMA statistic formulation (drift detection)', () => {
  it('flags a sustained small shift that no single point would trigger', () => {
    // Sustained +2 shift: the EWMA statistic accumulates and crosses its
    // control limit even though the latest point stays well inside 3 sigma
    // of the (shift-contaminated) process mean — a per-point test misses it.
    const baseline = Array.from({ length: 40 }, (_, i) => 50 + Math.sin(i));
    const shifted = Array.from({ length: 8 }, (_, i) => 52 + Math.sin(40 + i));
    const all = [...baseline, ...shifted];
    const result = ewmaDetector(series(all), 0.3, 3);
    expect(result.anomalous).toBe(true);

    const base = all.slice(0, -1);
    const m = base.reduce((a, b) => a + b, 0) / base.length;
    const sd = Math.sqrt(
      base.reduce((s, x) => s + (x - m) ** 2, 0) / (base.length - 1)
    );
    expect(Math.abs(all[all.length - 1] - m)).toBeLessThan(3 * sd);
  });
});

describe('per-tag threshold overrides drive analysis outcomes', () => {
  it('a desensitized tag stays info while a default tag alarms on the same data', async () => {
    const engine = newEngine();
    await engine.setThresholds('desensitized', {
      zScoreThreshold: 100_000,
      ewmaL: 100_000,
      iqrMultiplier: 100_000,
    }, OPERATOR);
    const data = [...Array.from({ length: 30 }, (_, i) => 10 + Math.sin(i)), 500];
    engine.ingestSeries('desensitized', series(data));
    engine.ingestSeries('default', series(data));

    const desensitized = await engine.analyze('desensitized');
    const standard = await engine.analyze('default');
    expect(standard!.severity).not.toBe('info');
    expect(desensitized!.severity).toBe('info');
    expect((await engine.listAlerts()).every((a) => a.tagId === 'default')).toBe(true);
  });
});

describe('alert cooldown (wall clock)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-alerts after the window and is immune to future-dated data', async () => {
    // Fake timers move Date.now(), which is what the cooldown window (and
    // therefore the alert id) is derived from. sqlite3 dispatches its
    // callbacks off the libuv work queue rather than off a timer, so the real
    // database still answers under fake time.
    vi.useFakeTimers();
    const engine = newEngine({ alertCooldownMs: 60_000 });
    // Future-dated spike data must not permanently mute the tag
    const farFuture = Date.now() + 365 * 24 * 3600 * 1000;
    for (let i = 0; i < 30; i++) engine.ingestPoint('t', farFuture + i * 1000, 10);
    engine.ingestPoint('t', farFuture + 31_000, 500);

    await engine.analyze('t');
    await engine.analyze('t');
    expect(await engine.listAlerts()).toHaveLength(1); // within cooldown

    vi.advanceTimersByTime(61_000);
    await engine.analyze('t');
    expect(await engine.listAlerts()).toHaveLength(2); // wall-clock window elapsed
  });
});

describe('bounded state', () => {
  it('holds the durable alert table to maxAlerts, and says what it evicted', async () => {
    // Cooldown off, so every analysis raises a distinct alert.
    const engine = newEngine({ maxAlerts: 3, alertCooldownMs: 0 });
    const pruned: Array<{ overflow: number; unacknowledgedEvicted: string[] }> = [];
    engine.on('alerts-pruned', (result) => pruned.push(result));

    for (let i = 0; i < 30; i++) engine.ingestPoint('t', i * 1000, 10);
    for (let k = 0; k < 6; k++) {
      engine.ingestPoint('t', 31_000 + k, 500 + k);
      await engine.analyze('t');
    }
    expect(await engine.listAlerts()).toHaveLength(6);

    await engine.pruneAlerts();
    expect(await engine.listAlerts()).toHaveLength(3);
    // Bounding the table is allowed to drop rows; doing it silently is not.
    expect(pruned).toHaveLength(1);
    expect(pruned[0].overflow).toBe(3);
    expect(pruned[0].unacknowledgedEvicted).toHaveLength(3);
  });

  it('evicts acknowledged alerts before unacknowledged ones', async () => {
    const engine = newEngine({ maxAlerts: 1, alertCooldownMs: 0 });
    for (let i = 0; i < 30; i++) engine.ingestPoint('t', i * 1000, 10);
    for (let k = 0; k < 2; k++) {
      engine.ingestPoint('t', 31_000 + k, 500 + k);
      await engine.analyze('t');
    }
    const [first, second] = await engine.listAlerts();
    await engine.acknowledgeAlert(first.id, OPERATOR);

    const result = await engine.pruneAlerts();
    expect(result.unacknowledgedEvicted).toEqual([]);
    const remaining = await engine.listAlerts();
    expect(remaining.map((a) => a.id)).toEqual([second.id]);
  });

  it('retires acknowledged alerts on the retention window but keeps open ones', async () => {
    const engine = newEngine({
      alertCooldownMs: 0,
      alertRetentionMs: 60_000,
      alertMaxAgeMs: 10 * 60_000,
    });
    for (let i = 0; i < 30; i++) engine.ingestPoint('t', i * 1000, 10);
    for (let k = 0; k < 2; k++) {
      engine.ingestPoint('t', 31_000 + k, 500 + k);
      await engine.analyze('t');
    }
    const [acked, open] = await engine.listAlerts();
    await engine.acknowledgeAlert(acked.id, OPERATOR);

    // Two minutes on: past the acknowledged-alert window, inside the absolute one.
    const result = await engine.pruneAlerts(new Date(Date.now() + 2 * 60_000));
    expect(result.retired).toBe(1);
    expect(result.expired).toBe(0);
    expect((await engine.listAlerts()).map((a) => a.id)).toEqual([open.id]);

    // Eleven minutes on: past the absolute cut-off, so the open one goes too.
    const later = await engine.pruneAlerts(new Date(Date.now() + 11 * 60_000));
    expect(later.expired).toBe(1);
    expect(await engine.listAlerts()).toHaveLength(0);
  });

  it('evicts the least-recently-updated tag beyond maxTrackedTags', () => {
    const engine = newEngine({ maxTrackedTags: 3 });
    for (const tag of ['a', 'b', 'c']) engine.ingestPoint(tag, 0, 1);
    engine.ingestPoint('a', 1000, 2); // refresh a — b is now oldest
    engine.ingestPoint('d', 2000, 1);
    const tags = engine.getTrackedTags().map((t) => t.tagId);
    expect(tags).toHaveLength(3);
    expect(tags).not.toContain('b');
    expect(tags).toEqual(expect.arrayContaining(['a', 'c', 'd']));
  });
});

describe('resilient sweeps', () => {
  it('keeps analyzing other tags when an alert listener throws', async () => {
    const engine = newEngine();
    engine.on('alert', () => {
      throw new Error('listener boom');
    });
    const errors: unknown[] = [];
    engine.on('analyze-error', (e) => errors.push(e));

    // 'a' alarms (listener throws); 'z' must still be analyzed after it
    engine.ingestSeries('a', series([...Array(30).fill(10), 500]));
    engine.ingestSeries('z', series(Array(30).fill(10)));
    const results = await engine.analyzeAll();

    expect(results.map((r) => r.tagId)).toEqual(expect.arrayContaining(['a', 'z']));
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('ingestion quality guards', () => {
  it('skips non-good quality readings and empty-string values', () => {
    const service = newService();
    service.ingestTagUpdate({ tagName: 'q', value: 10, timestamp: 1000, quality: 'bad' });
    service.ingestTagUpdate({ tagName: 'q', value: 11, timestamp: 2000, quality: 'uncertain' });
    service.ingestTagUpdate({ tagName: 'q', value: '', timestamp: 3000 });
    service.ingestTagUpdate({ tagName: 'q', value: '   ', timestamp: 4000 });
    service.ingestTagUpdate({ tagName: 'q', value: 12, timestamp: 5000, quality: 'good' });
    service.ingestTagUpdate({ tagName: 'q', value: 13, timestamp: 6000 });

    const history = service.engine.getHistory('q');
    expect(history.map((p) => p.value)).toEqual([12, 13]);
  });
});
