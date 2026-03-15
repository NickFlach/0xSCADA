/**
 * Sublinear Sentinel Sampling Strategy
 *
 * Issue #386: Implement sentinel sampling for O(√n) decoherence prediction.
 * ADR-0024: Measure √n sensors, predict the rest via correlation-weighted inference.
 *
 * Selects sentinel sensors per cluster by centrality, predicts coherence for
 * non-sentinel sensors, and manages rotation + full-scan verification cycles.
 */

import { SensorCorrelationGraph, CorrelationEdge } from './correlation-graph';

// ─── Types ──────────────────────────────────────────────────────────────

export interface SentinelReading {
  sensorId: string;
  coherence: number;
  timestamp: number;
}

export interface CoherencePrediction {
  targetSensorId: string;
  predictedCoherence: number;
  confidence: number;
  basedOnSentinels: string[];
  timestamp: number;
}

export interface SentinelSelection {
  cluster: string[];
  sentinels: string[];
  selectedAt: number;
}

export interface SentinelSamplerConfig {
  /** Minimum sentinels per cluster (default 2) */
  minSentinelsPerCluster?: number;
  /** Rotation interval in ms (default 4 hours) */
  rotationIntervalMs?: number;
  /** Full-scan interval in ms (default 24 hours / daily) */
  fullScanIntervalMs?: number;
  /** Correlation threshold for clustering (default 0.7) */
  clusterThreshold?: number;
}

// ─── Constants ──────────────────────────────────────────────────────────

const DEFAULT_MIN_SENTINELS = 2;
const DEFAULT_ROTATION_INTERVAL_MS = 4 * 60 * 60 * 1000;       // 4 hours
const DEFAULT_FULL_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;     // 24 hours
const DEFAULT_CLUSTER_THRESHOLD = 0.7;

// ─── Sampler ────────────────────────────────────────────────────────────

export class SentinelSampler {
  private graph: SensorCorrelationGraph;
  private selections: SentinelSelection[] = [];
  private lastRotation: number = 0;
  private lastFullScan: number = 0;
  private rotationGeneration: number = 0;

  readonly minSentinelsPerCluster: number;
  readonly rotationIntervalMs: number;
  readonly fullScanIntervalMs: number;
  readonly clusterThreshold: number;

  constructor(graph: SensorCorrelationGraph, config: SentinelSamplerConfig = {}) {
    this.graph = graph;
    this.minSentinelsPerCluster = config.minSentinelsPerCluster ?? DEFAULT_MIN_SENTINELS;
    this.rotationIntervalMs = config.rotationIntervalMs ?? DEFAULT_ROTATION_INTERVAL_MS;
    this.fullScanIntervalMs = config.fullScanIntervalMs ?? DEFAULT_FULL_SCAN_INTERVAL_MS;
    this.clusterThreshold = config.clusterThreshold ?? DEFAULT_CLUSTER_THRESHOLD;
  }

  // ─── Sentinel selection ────────────────────────────────────────

  /**
   * Select √n sentinel sensors from a cluster, ranked by centrality.
   * Minimum of `minSentinelsPerCluster` per cluster.
   */
  selectSentinels(cluster: string[], count?: number): string[] {
    if (cluster.length === 0) return [];

    const n = count ?? Math.max(this.minSentinelsPerCluster, Math.ceil(Math.sqrt(cluster.length)));
    const actual = Math.min(n, cluster.length);

    // Rank by centrality (descending)
    const ranked = cluster
      .map(id => ({ id, centrality: this.graph.getCentrality(id) }))
      .sort((a, b) => b.centrality - a.centrality);

    return ranked.slice(0, actual).map(r => r.id);
  }

  /**
   * Select sentinels for all clusters and store the selection.
   * Returns all selections.
   */
  selectAllSentinels(): SentinelSelection[] {
    const clusters = this.graph.getCluster(this.clusterThreshold);
    const now = Date.now();

    this.selections = clusters.map(cluster => ({
      cluster,
      sentinels: this.selectSentinels(cluster),
      selectedAt: now,
    }));

    this.lastRotation = now;
    return this.selections;
  }

  /**
   * Rotate sentinels to prevent blind spots. On each rotation, the previous
   * sentinels are deprioritized so different sensors get a turn.
   */
  rotateSentinels(): SentinelSelection[] {
    this.rotationGeneration++;
    const clusters = this.graph.getCluster(this.clusterThreshold);
    const now = Date.now();

    // Build a map from sorted cluster key → previous sentinel set for O(1) lookup (#400)
    const prevSentinelsByKey = new Map<string, Set<string>>();
    for (const sel of this.selections) {
      const key = [...sel.cluster].sort().join(',');
      prevSentinelsByKey.set(key, new Set(sel.sentinels));
    }

    this.selections = clusters.map((cluster) => {
      const n = Math.max(this.minSentinelsPerCluster, Math.ceil(Math.sqrt(cluster.length)));
      const actual = Math.min(n, cluster.length);

      // Look up previous sentinels by sorted cluster identity (#400)
      const clusterKey = [...cluster].sort().join(',');
      const prevSet = prevSentinelsByKey.get(clusterKey) ?? new Set<string>();

      const ranked = cluster
        .map(id => {
          let centrality = this.graph.getCentrality(id);
          // Soft penalty for recent sentinels (they still qualify if highly central)
          if (prevSet.has(id)) centrality *= 0.7;
          return { id, centrality };
        })
        .sort((a, b) => b.centrality - a.centrality);

      return {
        cluster,
        sentinels: ranked.slice(0, actual).map(r => r.id),
        selectedAt: now,
      };
    });

    this.lastRotation = now;
    return this.selections;
  }

  /**
   * Check if rotation is due based on configured interval.
   */
  isRotationDue(): boolean {
    return Date.now() - this.lastRotation >= this.rotationIntervalMs;
  }

  // ─── Coherence prediction ─────────────────────────────────────

  /**
   * Predict coherence for a target sensor based on sentinel readings.
   * Formula: Σ(correlation × observed_coherence) / Σ(correlations)
   */
  predictCoherence(
    targetSensor: string,
    sentinelReadings: SentinelReading[],
  ): CoherencePrediction {
    let weightedSum = 0;
    let totalWeight = 0;
    const usedSentinels: string[] = [];

    for (const reading of sentinelReadings) {
      if (reading.sensorId === targetSensor) {
        // Direct reading — return as-is with full confidence
        return {
          targetSensorId: targetSensor,
          predictedCoherence: reading.coherence,
          confidence: 1.0,
          basedOnSentinels: [reading.sensorId],
          timestamp: Date.now(),
        };
      }

      const correlation = this.graph.getCompositeStrength(targetSensor, reading.sensorId);
      if (correlation > 0) {
        weightedSum += correlation * reading.coherence;
        totalWeight += correlation;
        usedSentinels.push(reading.sensorId);
      }
    }

    const predictedCoherence = totalWeight > 0 ? weightedSum / totalWeight : 0;

    return {
      targetSensorId: targetSensor,
      predictedCoherence,
      confidence: this.getConfidence(targetSensor, usedSentinels),
      basedOnSentinels: usedSentinels,
      timestamp: Date.now(),
    };
  }

  // ─── Confidence ────────────────────────────────────────────────

  /**
   * Confidence in a prediction based on:
   * 1. Average correlation strength between target and sentinels
   * 2. Sentinel coverage (fraction of cluster acting as sentinels)
   * 3. Edge confidence (warm-up / observation count)
   */
  getConfidence(targetSensor: string, sentinelIds: string[]): number {
    if (sentinelIds.length === 0) return 0;

    // Average correlation strength
    let totalCorrelation = 0;
    let totalEdgeConfidence = 0;

    for (const sentinelId of sentinelIds) {
      totalCorrelation += this.graph.getCompositeStrength(targetSensor, sentinelId);
      totalEdgeConfidence += this.graph.getEdgeConfidence(targetSensor, sentinelId);
    }

    const avgCorrelation = totalCorrelation / sentinelIds.length;
    const avgEdgeConfidence = totalEdgeConfidence / sentinelIds.length;

    // Coverage: how many of the target's neighbors are sentinels?
    const neighbors = this.graph.getNeighbors(targetSensor);
    const coverage = neighbors.length > 0
      ? sentinelIds.filter(s => neighbors.includes(s)).length / neighbors.length
      : 0;

    // Blend: correlation strength (40%), edge confidence (30%), coverage (30%)
    return avgCorrelation * 0.4 + avgEdgeConfidence * 0.3 + coverage * 0.3;
  }

  // ─── Full-scan schedule ────────────────────────────────────────

  /**
   * Check if a full-scan verification cycle is due.
   * Full scans override predictions and measure all sensors directly.
   */
  isFullScanDue(): boolean {
    return Date.now() - this.lastFullScan >= this.fullScanIntervalMs;
  }

  /**
   * Record that a full scan was completed.
   */
  recordFullScan(): void {
    this.lastFullScan = Date.now();
  }

  /**
   * Get all sensor IDs that need measurement in the current cycle.
   * Returns only sentinels unless a full scan is due.
   */
  getSensorsToMeasure(): { sensorIds: string[]; isFullScan: boolean } {
    if (this.isFullScanDue()) {
      return {
        sensorIds: this.graph.getSensorIds(),
        isFullScan: true,
      };
    }

    const sentinelSet = new Set<string>();
    for (const selection of this.selections) {
      for (const s of selection.sentinels) {
        sentinelSet.add(s);
      }
    }

    return {
      sensorIds: Array.from(sentinelSet),
      isFullScan: false,
    };
  }

  // ─── Accessors ─────────────────────────────────────────────────

  getSelections(): SentinelSelection[] {
    return this.selections;
  }

  getLastRotation(): number {
    return this.lastRotation;
  }

  getLastFullScan(): number {
    return this.lastFullScan;
  }
}
