/**
 * Predictive Decoherence Scheduler — Integrates sublinear prediction with
 * the existing DecoherenceScheduler for hybrid coherence monitoring.
 *
 * Blends predicted coherence (from sentinel network) with observed coherence
 * (from direct measurements). Connects to:
 * - Correlation graph (sensor relationships)
 * - Sentinel sampler (O(√n) monitoring)
 * - Temporal predictor (drift-ahead-of-time)
 * - DecoherenceScheduler (existing scheduler for tick/observation)
 * - Flux Publisher (cross-facility sharing, optional)
 *
 * @see ADR-0024
 * @closes #388
 */

import { EventEmitter } from 'events';
import { SensorCorrelationGraph, CorrelationSource, SensorMetadata } from './correlation-graph';
import { SentinelSampler, SentinelReading, CoherencePrediction } from './sentinel-sampler';
import { TemporalPredictor, DriftPrediction, SchedulingRecommendation } from './temporal-predictor';
import { DecoherenceScheduler, SensorCoherenceModel } from '../decoherence-scheduler';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PredictiveSchedulerConfig {
  /** Weight of predicted coherence in hybrid blend (default 0.3) */
  predictionWeight: number;
  /** Weight of observed coherence in hybrid blend (default 0.7) */
  observedWeight: number;
  /** Cluster correlation threshold (default 0.7) */
  clusterThreshold: number;
  /** Whether to auto-populate lineage correlations from sensor metadata */
  autoLineageCorrelation: boolean;
  /** Full scan interval override for sentinel sampler (ms) */
  fullScanIntervalMs?: number;
}

export interface HybridCoherence {
  sensorId: string;
  observed: number;
  predicted: number;
  blended: number;
  source: 'observed' | 'predicted' | 'hybrid';
}

export interface PredictiveStatus {
  totalSensors: number;
  sentinelCount: number;
  monitoringReduction: string;
  avgTemporalAdvantageMin: number;
  pendingPredictions: number;
  recentRecommendations: SchedulingRecommendation[];
  correlationCoverage: number;
}

const DEFAULT_CONFIG: PredictiveSchedulerConfig = {
  predictionWeight: 0.3,
  observedWeight: 0.7,
  clusterThreshold: 0.7,
  autoLineageCorrelation: true,
};

// ─── Predictive Scheduler ───────────────────────────────────────────────────

export class PredictiveScheduler extends EventEmitter {
  private scheduler: DecoherenceScheduler;
  private graph: SensorCorrelationGraph;
  private sampler: SentinelSampler;
  private predictor: TemporalPredictor;
  private config: PredictiveSchedulerConfig;

  /** Latest hybrid coherence per sensor */
  private hybridCoherence: Map<string, HybridCoherence> = new Map();
  /** Recent recommendations (bounded) */
  private recentRecommendations: SchedulingRecommendation[] = [];
  private static readonly MAX_RECOMMENDATIONS = 100;

  constructor(
    scheduler: DecoherenceScheduler,
    config: Partial<PredictiveSchedulerConfig> = {},
  ) {
    super();
    this.scheduler = scheduler;
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.graph = new SensorCorrelationGraph();
    this.sampler = new SentinelSampler(this.graph, {
      clusterThreshold: this.config.clusterThreshold,
      fullScanIntervalMs: this.config.fullScanIntervalMs,
    });
    this.predictor = new TemporalPredictor(this.graph, this.sampler);
  }

  // ─── Sensor Registration ────────────────────────────────────────

  /**
   * Register a sensor with both the decoherence scheduler and correlation graph.
   * If metadata includes manufacturer/batch/calDate, auto-creates lineage correlations.
   */
  registerSensor(config: {
    sensorId: string;
    name: string;
    baseDecoherenceRate?: number;
    coherenceThreshold?: number;
    ageDays?: number;
    metadata?: SensorMetadata;
  }): void {
    // Register in scheduler
    this.scheduler.registerSensor(config);

    // Register in correlation graph
    this.graph.addSensor(config.sensorId, config.metadata ?? {});

    // Auto-populate lineage correlations
    if (this.config.autoLineageCorrelation && config.metadata) {
      this.autoCorrelateByLineage(config.sensorId, config.metadata);
    }
  }

  /**
   * Automatically create lineage correlations based on shared metadata.
   * Sensors from the same manufacturer+batch get high lineage correlation.
   */
  private autoCorrelateByLineage(sensorId: string, metadata: SensorMetadata): void {
    if (!metadata.manufacturer && !metadata.batch) return;

    for (const otherId of this.graph.getSensorIds()) {
      if (otherId === sensorId) continue;
      const otherMeta = this.graph.getSensorMetadata(otherId);
      if (!otherMeta) continue;

      let lineageStrength = 0;

      // Same manufacturer: base correlation
      if (metadata.manufacturer && metadata.manufacturer === otherMeta.manufacturer) {
        lineageStrength += 0.3;
      }
      // Same batch: strong correlation (same production run)
      if (metadata.batch && metadata.batch === otherMeta.batch) {
        lineageStrength += 0.4;
      }
      // Same process area: environmental coupling
      if (metadata.processArea && metadata.processArea === otherMeta.processArea) {
        this.graph.updateCorrelation(sensorId, otherId, 0.5, 'proximity');
      }

      if (lineageStrength > 0) {
        this.graph.updateCorrelation(sensorId, otherId, Math.min(1, lineageStrength), 'lineage');
      }
    }
  }

  // ─── Monitoring Cycle ───────────────────────────────────────────

  /**
   * Run a monitoring cycle. Uses sentinel sampling for efficiency.
   * 1. Determine which sensors to measure (sentinels or full scan)
   * 2. Process sentinel readings through temporal predictor
   * 3. Blend predictions with observations for all sensors
   * 4. Generate scheduling recommendations
   */
  async runCycle(readCoherence: (sensorId: string) => Promise<number>): Promise<{
    measured: number;
    predicted: number;
    recommendations: SchedulingRecommendation[];
  }> {
    // Rotate sentinels if due
    if (this.sampler.isRotationDue()) {
      this.sampler.rotateSentinels();
    } else if (this.sampler.getSelections().length === 0) {
      this.sampler.selectAllSentinels();
    }

    // Get sensors to measure
    const { sensorIds, isFullScan } = this.sampler.getSensorsToMeasure();

    if (isFullScan) {
      this.sampler.recordFullScan();
    }

    // Measure sentinels (or all if full scan)
    const readings: SentinelReading[] = [];
    for (const sensorId of sensorIds) {
      const coherence = await readCoherence(sensorId);
      readings.push({ sensorId, coherence, timestamp: Date.now() });

      // Update the base scheduler with the observation
      this.scheduler.recordObservation(sensorId, coherence);
    }

    // Process through temporal predictor
    const allPredictions: DriftPrediction[] = [];
    for (const reading of readings) {
      const preds = this.predictor.processSentinelReading(reading);
      allPredictions.push(...preds);
    }

    // Predict coherence for non-measured sensors
    const allSensorIds = this.graph.getSensorIds();
    const measuredSet = new Set(sensorIds);
    let predictedCount = 0;

    for (const sensorId of allSensorIds) {
      const measured = measuredSet.has(sensorId);
      const observation = readings.find(r => r.sensorId === sensorId);

      if (measured && observation) {
        // Direct measurement
        this.hybridCoherence.set(sensorId, {
          sensorId,
          observed: observation.coherence,
          predicted: observation.coherence,
          blended: observation.coherence,
          source: 'observed',
        });
      } else {
        // Predict from sentinel readings
        const prediction = this.sampler.predictCoherence(sensorId, readings);
        predictedCount++;

        // Blend with last known observed value
        const sensor = this.scheduler.getSensor(sensorId);
        const lastObserved = sensor?.coherence ?? 1.0;

        const blended = prediction.confidence > 0.3
          ? lastObserved * this.config.observedWeight + prediction.predictedCoherence * this.config.predictionWeight
          : lastObserved; // Low confidence → rely on last observation

        this.hybridCoherence.set(sensorId, {
          sensorId,
          observed: lastObserved,
          predicted: prediction.predictedCoherence,
          blended,
          source: prediction.confidence > 0.3 ? 'hybrid' : 'predicted',
        });
      }
    }

    // Generate recommendations from drift predictions
    const recommendations = this.predictor.getRecommendations(allPredictions);
    this.recentRecommendations.push(...recommendations);
    if (this.recentRecommendations.length > PredictiveScheduler.MAX_RECOMMENDATIONS) {
      this.recentRecommendations = this.recentRecommendations.slice(-PredictiveScheduler.MAX_RECOMMENDATIONS);
    }

    // Emit events for immediate-action recommendations
    for (const rec of recommendations) {
      if (rec.urgency === 'immediate') {
        this.emit('predictive-calibration-due', rec);
      }
    }

    return {
      measured: sensorIds.length,
      predicted: predictedCount,
      recommendations,
    };
  }

  // ─── Co-drift Learning ──────────────────────────────────────────

  /**
   * Feed co-drift observations to strengthen the correlation graph.
   * Call when two sensors drift within a time window of each other.
   */
  recordCoDrift(sensorA: string, sensorB: string, strength: number): void {
    this.graph.updateCorrelation(sensorA, sensorB, strength, 'co-drift');
  }

  // ─── Status ─────────────────────────────────────────────────────

  getStatus(): PredictiveStatus {
    const totalSensors = this.graph.getSensorIds().length;
    const sentinels = this.sampler.getSensorsToMeasure();
    const sentinelCount = sentinels.isFullScan ? totalSensors : sentinels.sensorIds.length;
    const reduction = totalSensors > 0
      ? `${((1 - sentinelCount / totalSensors) * 100).toFixed(1)}%`
      : '0%';

    // Correlation coverage: fraction of sensors with at least one correlation
    const sensorIds = this.graph.getSensorIds();
    const withCorrelation = sensorIds.filter(id => this.graph.getNeighbors(id).length > 0).length;
    const coverage = sensorIds.length > 0 ? withCorrelation / sensorIds.length : 0;

    return {
      totalSensors,
      sentinelCount,
      monitoringReduction: reduction,
      avgTemporalAdvantageMin: this.predictor.getAverageTemporalAdvantage() / 60000,
      pendingPredictions: this.predictor.getPredictions({ limit: 50 }).length,
      recentRecommendations: this.recentRecommendations.slice(-10),
      correlationCoverage: coverage,
    };
  }

  /** Get hybrid coherence for a sensor */
  getHybridCoherence(sensorId: string): HybridCoherence | undefined {
    return this.hybridCoherence.get(sensorId);
  }

  /** Get all hybrid coherence values */
  getAllHybridCoherence(): HybridCoherence[] {
    return Array.from(this.hybridCoherence.values());
  }

  /** Direct access to sub-components for advanced usage */
  getGraph(): SensorCorrelationGraph { return this.graph; }
  getSampler(): SentinelSampler { return this.sampler; }
  getPredictor(): TemporalPredictor { return this.predictor; }
}
