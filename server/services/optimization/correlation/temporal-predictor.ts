/**
 * Temporal Advantage Predictor — Predict sensor drift before it manifests
 *
 * When a sentinel sensor shows early drift, immediately predict that
 * correlated sensors will follow. The prediction arrives before the
 * target sensor's own readings would show drift.
 *
 * Temporal advantage = correlation_delay × (1 - 1/√n)
 *
 * Inspired by sublinear-time-solver's Temporal Consciousness Emergence theory.
 *
 * @see ADR-0024
 * @closes #387
 */

import { SensorCorrelationGraph } from './correlation-graph';
import { SentinelSampler, SentinelReading, CoherencePrediction } from './sentinel-sampler';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DriftEvent {
  sensorId: string;
  previousCoherence: number;
  currentCoherence: number;
  timestamp: number;
  /** How much coherence dropped */
  delta: number;
}

export interface DriftPrediction {
  targetSensorId: string;
  predictedCoherence: number;
  /** Predicted time when target will show drift (ms timestamp) */
  predictedDriftTime: number;
  /** How far ahead of direct measurement this prediction is (ms) */
  temporalAdvantageMs: number;
  /** Confidence in the prediction [0,1] */
  confidence: number;
  /** Which sentinel triggered this prediction */
  triggeredBy: string;
  /** Correlation strength between trigger and target */
  correlationStrength: number;
  timestamp: number;
}

export interface SchedulingRecommendation {
  sensorId: string;
  action: 'schedule_calibration' | 'increase_monitoring' | 'flag_attention';
  reason: string;
  urgency: 'immediate' | 'soon' | 'watch';
  predictedCoherence: number;
  confidence: number;
}

export interface TemporalPredictorConfig {
  /** Early drift threshold: coherence drop that triggers prediction (default 0.05) */
  earlyDriftThreshold: number;
  /** High correlation threshold for immediate scheduling (default 0.85) */
  highCorrelationThreshold: number;
  /** Medium correlation threshold for increased monitoring (default 0.5) */
  mediumCorrelationThreshold: number;
  /** Default correlation delay in ms (typical lag between correlated drifts) (default 2h) */
  defaultCorrelationDelayMs: number;
  /** Max predictions to retain (default 500) */
  maxPredictionHistory: number;
}

const DEFAULT_CONFIG: TemporalPredictorConfig = {
  earlyDriftThreshold: 0.05,
  highCorrelationThreshold: 0.85,
  mediumCorrelationThreshold: 0.5,
  defaultCorrelationDelayMs: 2 * 60 * 60 * 1000, // 2 hours
  maxPredictionHistory: 500,
};

// ─── Temporal Predictor ─────────────────────────────────────────────────────

export class TemporalPredictor {
  private graph: SensorCorrelationGraph;
  private sampler: SentinelSampler;
  private config: TemporalPredictorConfig;

  /** Previous coherence readings for delta detection */
  private lastCoherence: Map<string, number> = new Map();
  /** Historical correlation delays (sensorPair → observed delays in ms) */
  private correlationDelays: Map<string, number[]> = new Map();
  /** Drift prediction history */
  private predictions: DriftPrediction[] = [];
  /** Drift events for correlation delay learning */
  private recentDrifts: Map<string, DriftEvent> = new Map();

  constructor(
    graph: SensorCorrelationGraph,
    sampler: SentinelSampler,
    config: Partial<TemporalPredictorConfig> = {},
  ) {
    this.graph = graph;
    this.sampler = sampler;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── Drift Detection ────────────────────────────────────────────

  /**
   * Process a sentinel reading and detect early drift.
   * Returns drift predictions for correlated sensors if drift is detected.
   */
  processSentinelReading(reading: SentinelReading): DriftPrediction[] {
    const prevCoherence = this.lastCoherence.get(reading.sensorId) ?? 1.0;
    this.lastCoherence.set(reading.sensorId, reading.coherence);

    const delta = prevCoherence - reading.coherence;

    // Not enough drift to trigger prediction
    if (delta < this.config.earlyDriftThreshold) return [];

    // Record drift event for correlation delay learning
    const driftEvent: DriftEvent = {
      sensorId: reading.sensorId,
      previousCoherence: prevCoherence,
      currentCoherence: reading.coherence,
      timestamp: reading.timestamp,
      delta,
    };
    this.recentDrifts.set(reading.sensorId, driftEvent);

    // Learn correlation delays from observed drift pairs
    this.learnCorrelationDelays(driftEvent);

    // Generate predictions for all correlated sensors
    return this.predictCorrelatedDrift(driftEvent);
  }

  /**
   * Generate drift predictions for sensors correlated with the drifting sentinel.
   */
  private predictCorrelatedDrift(drift: DriftEvent): DriftPrediction[] {
    const predictions: DriftPrediction[] = [];
    const neighbors = this.graph.getNeighbors(drift.sensorId);

    for (const neighborId of neighbors) {
      const correlation = this.graph.getCompositeStrength(drift.sensorId, neighborId);
      if (correlation < this.config.mediumCorrelationThreshold) continue;

      // Estimate correlation delay for this pair
      const delayMs = this.getCorrelationDelay(drift.sensorId, neighborId);

      // Temporal advantage: delay × (1 - 1/√n) where n = cluster size
      const cluster = this.findClusterFor(drift.sensorId);
      const n = Math.max(1, cluster.length);
      const temporalAdvantageMs = delayMs * (1 - 1 / Math.sqrt(n));

      // Predict coherence: scale the sentinel's drift by correlation strength
      const currentNeighborCoherence = this.lastCoherence.get(neighborId) ?? 1.0;
      const predictedDrop = drift.delta * correlation;
      const predictedCoherence = Math.max(0, currentNeighborCoherence - predictedDrop);

      // Confidence: blend correlation strength with edge confidence and prediction history accuracy
      const edgeConfidence = this.graph.getEdgeConfidence(drift.sensorId, neighborId);
      const confidence = correlation * 0.5 + edgeConfidence * 0.3 + (delayMs > 0 ? 0.2 : 0.1);

      const prediction: DriftPrediction = {
        targetSensorId: neighborId,
        predictedCoherence,
        predictedDriftTime: drift.timestamp + delayMs,
        temporalAdvantageMs,
        confidence: Math.min(1, confidence),
        triggeredBy: drift.sensorId,
        correlationStrength: correlation,
        timestamp: Date.now(),
      };

      predictions.push(prediction);
      this.predictions.push(prediction);
    }

    // Bound prediction history
    if (this.predictions.length > this.config.maxPredictionHistory) {
      this.predictions = this.predictions.slice(-this.config.maxPredictionHistory);
    }

    return predictions;
  }

  // ─── Scheduling Recommendations ─────────────────────────────────

  /**
   * Convert drift predictions into scheduling recommendations.
   * High correlation → immediate schedule
   * Medium correlation → increase monitoring
   * Low correlation → flag for attention
   */
  getRecommendations(predictions: DriftPrediction[]): SchedulingRecommendation[] {
    return predictions.map(pred => {
      if (pred.correlationStrength >= this.config.highCorrelationThreshold) {
        return {
          sensorId: pred.targetSensorId,
          action: 'schedule_calibration' as const,
          reason: `High correlation (${pred.correlationStrength.toFixed(2)}) with drifting sensor ${pred.triggeredBy}. Temporal advantage: ${(pred.temporalAdvantageMs / 60000).toFixed(1)} min`,
          urgency: 'immediate' as const,
          predictedCoherence: pred.predictedCoherence,
          confidence: pred.confidence,
        };
      } else if (pred.correlationStrength >= this.config.mediumCorrelationThreshold) {
        return {
          sensorId: pred.targetSensorId,
          action: 'increase_monitoring' as const,
          reason: `Medium correlation (${pred.correlationStrength.toFixed(2)}) with drifting sensor ${pred.triggeredBy}. Watch for drift.`,
          urgency: 'soon' as const,
          predictedCoherence: pred.predictedCoherence,
          confidence: pred.confidence,
        };
      } else {
        return {
          sensorId: pred.targetSensorId,
          action: 'flag_attention' as const,
          reason: `Low correlation (${pred.correlationStrength.toFixed(2)}) with drifting sensor ${pred.triggeredBy}`,
          urgency: 'watch' as const,
          predictedCoherence: pred.predictedCoherence,
          confidence: pred.confidence,
        };
      }
    });
  }

  // ─── Correlation Delay Learning ─────────────────────────────────

  /**
   * When we observe drift in a sensor, check if any recently-drifted
   * correlated sensors can teach us the typical delay between their drifts.
   */
  private learnCorrelationDelays(drift: DriftEvent): void {
    for (const [otherId, otherDrift] of this.recentDrifts) {
      if (otherId === drift.sensorId) continue;

      const correlation = this.graph.getCompositeStrength(drift.sensorId, otherId);
      if (correlation < this.config.mediumCorrelationThreshold) continue;

      const delay = Math.abs(drift.timestamp - otherDrift.timestamp);
      // Only learn from reasonable delays (< 24 hours)
      if (delay > 24 * 60 * 60 * 1000) continue;

      const pairKey = [drift.sensorId, otherId].sort().join('|');
      const delays = this.correlationDelays.get(pairKey) ?? [];
      delays.push(delay);
      // Keep last 20 observations
      if (delays.length > 20) delays.shift();
      this.correlationDelays.set(pairKey, delays);
    }
  }

  /**
   * Get the estimated correlation delay between two sensors.
   * Uses learned delays if available, otherwise the default.
   */
  private getCorrelationDelay(sensorA: string, sensorB: string): number {
    const pairKey = [sensorA, sensorB].sort().join('|');
    const delays = this.correlationDelays.get(pairKey);
    if (!delays || delays.length === 0) return this.config.defaultCorrelationDelayMs;

    // Use median delay (more robust than mean to outliers)
    const sorted = [...delays].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  private findClusterFor(sensorId: string): string[] {
    const clusters = this.graph.getCluster(this.config.mediumCorrelationThreshold);
    return clusters.find(c => c.includes(sensorId)) ?? [sensorId];
  }

  // ─── Validation ─────────────────────────────────────────────────

  /**
   * Validate a past prediction against an actual observation.
   * Call when a sensor's coherence is actually measured.
   * Returns accuracy score for the prediction.
   */
  validatePrediction(
    sensorId: string,
    actualCoherence: number,
    timestamp: number,
  ): { predictionId: number; accuracy: number } | null {
    // Find the most recent unvalidated prediction for this sensor
    for (let i = this.predictions.length - 1; i >= 0; i--) {
      const pred = this.predictions[i];
      if (pred.targetSensorId !== sensorId) continue;

      // Accuracy: 1 - |predicted - actual| / max(predicted, actual, 0.01)
      const error = Math.abs(pred.predictedCoherence - actualCoherence);
      const scale = Math.max(pred.predictedCoherence, actualCoherence, 0.01);
      const accuracy = 1 - error / scale;

      return { predictionId: i, accuracy: Math.max(0, accuracy) };
    }
    return null;
  }

  // ─── Accessors ──────────────────────────────────────────────────

  getPredictions(options?: {
    sensorId?: string;
    limit?: number;
    sinceMs?: number;
  }): DriftPrediction[] {
    let preds = this.predictions;

    if (options?.sensorId) {
      preds = preds.filter(p => p.targetSensorId === options.sensorId);
    }
    if (options?.sinceMs) {
      preds = preds.filter(p => p.timestamp >= options.sinceMs!);
    }
    if (options?.limit) {
      preds = preds.slice(-options.limit);
    }

    return preds;
  }

  /** Get average temporal advantage across all predictions */
  getAverageTemporalAdvantage(): number {
    if (this.predictions.length === 0) return 0;
    const sum = this.predictions.reduce((s, p) => s + p.temporalAdvantageMs, 0);
    return sum / this.predictions.length;
  }

  /** Get learned correlation delays */
  getLearnedDelays(): Map<string, number[]> {
    return new Map(this.correlationDelays);
  }
}
