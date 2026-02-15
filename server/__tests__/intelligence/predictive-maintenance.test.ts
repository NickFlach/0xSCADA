import { describe, it, expect } from 'vitest';
import {
  computeZScore,
  zScoreDetector,
  ewmaDetector,
  iqrDetector,
  ensembleScore,
  classifySeverity,
  PredictiveMaintenanceEngine,
} from '../../intelligence/predictive-maintenance';

describe('Predictive Maintenance Engine', () => {
  describe('computeZScore', () => {
    it('returns 0 for constant values', () => {
      const result = computeZScore([5, 5, 5, 5, 5]);
      expect(result.zScore).toBe(0);
      expect(result.mean).toBe(5);
    });

    it('detects outliers', () => {
      const values = [10, 10, 10, 10, 10, 10, 10, 10, 10, 50];
      const result = computeZScore(values);
      expect(result.zScore).toBeGreaterThan(2);
    });
  });

  describe('zScoreDetector', () => {
    it('flags anomalous points', () => {
      const series = Array.from({ length: 50 }, (_, i) => ({
        timestamp: i * 1000,
        value: i === 49 ? 100 : 10 + Math.random() * 2,
      }));
      const result = zScoreDetector(series, 3);
      expect(result.anomalous).toBe(true);
      expect(result.detector).toBe('z-score');
    });

    it('passes normal data', () => {
      const series = Array.from({ length: 50 }, (_, i) => ({
        timestamp: i * 1000,
        value: 10,
      }));
      const result = zScoreDetector(series, 3);
      expect(result.anomalous).toBe(false);
    });
  });

  describe('ewmaDetector', () => {
    it('detects sudden jumps', () => {
      const series = [
        ...Array.from({ length: 20 }, (_, i) => ({ timestamp: i * 1000, value: 50 })),
        { timestamp: 20000, value: 200 },
      ];
      const result = ewmaDetector(series, 0.3, 20);
      expect(result.anomalous).toBe(true);
    });
  });

  describe('iqrDetector', () => {
    it('detects outliers outside IQR bounds', () => {
      const series = [
        ...Array.from({ length: 30 }, (_, i) => ({ timestamp: i * 1000, value: 10 + (i % 5) })),
        { timestamp: 30000, value: 100 },
      ];
      const result = iqrDetector(series, 1.5);
      expect(result.anomalous).toBe(true);
    });
  });

  describe('ensembleScore', () => {
    it('computes weighted average', () => {
      const results = [
        { detector: 'z-score', score: 0.8, anomalous: true, details: {} },
        { detector: 'ewma', score: 0.6, anomalous: true, details: {} },
        { detector: 'iqr', score: 0.2, anomalous: false, details: {} },
      ];
      const score = ensembleScore(results, { 'z-score': 0.4, ewma: 0.35, iqr: 0.25 });
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });

  describe('classifySeverity', () => {
    it('classifies correctly', () => {
      expect(classifySeverity(0.1, { warning: 0.4, critical: 0.7, emergency: 0.9 })).toBe('info');
      expect(classifySeverity(0.5, { warning: 0.4, critical: 0.7, emergency: 0.9 })).toBe('warning');
      expect(classifySeverity(0.8, { warning: 0.4, critical: 0.7, emergency: 0.9 })).toBe('critical');
      expect(classifySeverity(0.95, { warning: 0.4, critical: 0.7, emergency: 0.9 })).toBe('emergency');
    });
  });

  describe('PredictiveMaintenanceEngine', () => {
    it('ingests data and analyzes', () => {
      const engine = new PredictiveMaintenanceEngine();
      // Normal data then spike
      for (let i = 0; i < 50; i++) {
        engine.ingestPoint('temp-1', i * 1000, 25 + Math.random());
      }
      engine.ingestPoint('temp-1', 50000, 200); // spike

      const result = engine.analyze('temp-1');
      expect(result).not.toBeNull();
      expect(result!.severity).not.toBe('info');
    });

    it('returns null for insufficient data', () => {
      const engine = new PredictiveMaintenanceEngine();
      engine.ingestPoint('x', 0, 10);
      expect(engine.analyze('x')).toBeNull();
    });

    it('generates and acknowledges alerts', () => {
      const engine = new PredictiveMaintenanceEngine();
      for (let i = 0; i < 50; i++) engine.ingestPoint('t', i * 1000, 10);
      engine.ingestPoint('t', 50000, 500);
      engine.analyze('t');

      const alerts = engine.getAlerts();
      expect(alerts.length).toBeGreaterThan(0);

      const ack = engine.acknowledgeAlert(alerts[0].id);
      expect(ack).toBe(true);
      expect(engine.getAlerts()[0].acknowledged).toBe(true);
    });
  });
});
