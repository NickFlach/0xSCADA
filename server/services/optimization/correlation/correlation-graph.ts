/**
 * Sensor Correlation Graph — Weighted Undirected Graph
 *
 * Issue #385: Build sensor correlation graph for sublinear decoherence prediction.
 * ADR-0024: Sensors in the same physical environment decohere together.
 *
 * Tracks multi-source correlations between sensors (proximity, environmental,
 * co-drift, lineage) and blends them into composite edge weights. Supports
 * clustering via connected components and centrality scoring for sentinel selection.
 */

// ─── Types ──────────────────────────────────────────────────────────────

export type CorrelationSource = 'proximity' | 'environmental' | 'co-drift' | 'lineage';

export interface SensorMetadata {
  manufacturer?: string;
  batch?: string;
  calDate?: number;
  location?: string;
  processArea?: string;
}

export interface CorrelationEdge {
  /** Per-source correlation strengths [0,1] */
  sources: Partial<Record<CorrelationSource, number>>;
  /** Blended composite strength [0,1] */
  composite: number;
  /** Number of observations (for warm-up confidence) */
  observationCount: number;
  /** Last update timestamp */
  lastUpdated: number;
}

export interface SerializedGraph {
  sensors: Array<{ id: string; metadata: SensorMetadata }>;
  edges: Array<{
    a: string;
    b: string;
    sources: Partial<Record<CorrelationSource, number>>;
    observationCount: number;
    lastUpdated: number;
  }>;
}

/** Confidence ramps up with observations — reaches 0.9 at ~30 observations */
const WARMUP_HALF_LIFE = 10;

/** Source weights for blending (normalized internally) */
const SOURCE_WEIGHTS: Record<CorrelationSource, number> = {
  proximity: 1.0,
  environmental: 1.2,
  'co-drift': 1.5,
  lineage: 0.8,
};

// ─── Helpers ────────────────────────────────────────────────────────────

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

function blendSources(sources: Partial<Record<CorrelationSource, number>>): number {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const [src, strength] of Object.entries(sources) as Array<[CorrelationSource, number]>) {
    const w = SOURCE_WEIGHTS[src] ?? 1.0;
    weightedSum += w * strength;
    totalWeight += w;
  }
  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

// ─── Graph ──────────────────────────────────────────────────────────────

export class SensorCorrelationGraph {
  private sensors: Map<string, SensorMetadata> = new Map();
  private edges: Map<string, CorrelationEdge> = new Map();
  /** Adjacency list: sensorId → Set of neighbor sensorIds */
  private adjacency: Map<string, Set<string>> = new Map();

  // ─── Sensor management ─────────────────────────────────────────

  addSensor(id: string, metadata: SensorMetadata): void {
    this.sensors.set(id, { ...metadata });
    if (!this.adjacency.has(id)) {
      this.adjacency.set(id, new Set());
    }
  }

  removeSensor(id: string): void {
    const neighbors = this.adjacency.get(id);
    if (neighbors) {
      for (const n of neighbors) {
        this.edges.delete(edgeKey(id, n));
        this.adjacency.get(n)?.delete(id);
      }
    }
    this.adjacency.delete(id);
    this.sensors.delete(id);
  }

  hasSensor(id: string): boolean {
    return this.sensors.has(id);
  }

  getSensorMetadata(id: string): SensorMetadata | undefined {
    return this.sensors.get(id);
  }

  getSensorIds(): string[] {
    return Array.from(this.sensors.keys());
  }

  // ─── Correlation management ────────────────────────────────────

  /**
   * Update (or create) the correlation between two sensors for a given source.
   * Each source contributes independently; composite is recomputed on every update.
   */
  updateCorrelation(
    sensorA: string,
    sensorB: string,
    strength: number,
    source: CorrelationSource,
  ): void {
    if (sensorA === sensorB) return;
    const clamped = Math.max(0, Math.min(1, strength));
    const key = edgeKey(sensorA, sensorB);

    let edge = this.edges.get(key);
    if (!edge) {
      edge = { sources: {}, composite: 0, observationCount: 0, lastUpdated: Date.now() };
      this.edges.set(key, edge);
      // Ensure adjacency
      if (!this.adjacency.has(sensorA)) this.adjacency.set(sensorA, new Set());
      if (!this.adjacency.has(sensorB)) this.adjacency.set(sensorB, new Set());
      this.adjacency.get(sensorA)!.add(sensorB);
      this.adjacency.get(sensorB)!.add(sensorA);
    }

    edge.sources[source] = clamped;
    edge.composite = blendSources(edge.sources);
    edge.observationCount++;
    edge.lastUpdated = Date.now();
  }

  getEdge(sensorA: string, sensorB: string): CorrelationEdge | undefined {
    return this.edges.get(edgeKey(sensorA, sensorB));
  }

  getCompositeStrength(sensorA: string, sensorB: string): number {
    return this.edges.get(edgeKey(sensorA, sensorB))?.composite ?? 0;
  }

  getNeighbors(sensorId: string): string[] {
    return Array.from(this.adjacency.get(sensorId) ?? []);
  }

  // ─── Warm-up confidence ────────────────────────────────────────

  /**
   * Confidence in an edge's correlation based on observation count.
   * Returns 0-1, asymptotically approaching 1.
   */
  getEdgeConfidence(sensorA: string, sensorB: string): number {
    const edge = this.edges.get(edgeKey(sensorA, sensorB));
    if (!edge) return 0;
    return 1 - Math.pow(0.5, edge.observationCount / WARMUP_HALF_LIFE);
  }

  // ─── Clustering ────────────────────────────────────────────────

  /**
   * Find connected components where all edges have composite strength ≥ threshold.
   * Returns array of clusters (each cluster is an array of sensor IDs).
   */
  getCluster(threshold: number): string[][] {
    const visited = new Set<string>();
    const clusters: string[][] = [];

    for (const sensorId of this.sensors.keys()) {
      if (visited.has(sensorId)) continue;

      const cluster: string[] = [];
      const queue: string[] = [sensorId];
      visited.add(sensorId);

      while (queue.length > 0) {
        const current = queue.pop()!;
        cluster.push(current);

        for (const neighbor of this.adjacency.get(current) ?? []) {
          if (visited.has(neighbor)) continue;
          const edge = this.edges.get(edgeKey(current, neighbor));
          if (edge && edge.composite >= threshold) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }

      clusters.push(cluster);
    }

    return clusters;
  }

  // ─── Centrality ────────────────────────────────────────────────

  /**
   * Weighted degree centrality: sum of composite correlation weights for all edges
   * connected to this sensor. Used for sentinel selection (higher = more informative).
   */
  getCentrality(sensorId: string): number {
    let sum = 0;
    for (const neighbor of this.adjacency.get(sensorId) ?? []) {
      const edge = this.edges.get(edgeKey(sensorId, neighbor));
      if (edge) sum += edge.composite;
    }
    return sum;
  }

  // ─── Persistence ───────────────────────────────────────────────

  serialize(): SerializedGraph {
    const sensors: SerializedGraph['sensors'] = [];
    for (const [id, metadata] of this.sensors) {
      sensors.push({ id, metadata });
    }

    const edges: SerializedGraph['edges'] = [];
    for (const [key, edge] of this.edges) {
      const [a, b] = key.split('\0');
      edges.push({
        a,
        b,
        sources: { ...edge.sources },
        observationCount: edge.observationCount,
        lastUpdated: edge.lastUpdated,
      });
    }

    return { sensors, edges };
  }

  static deserialize(data: SerializedGraph): SensorCorrelationGraph {
    const graph = new SensorCorrelationGraph();

    for (const { id, metadata } of data.sensors) {
      graph.addSensor(id, metadata);
    }

    for (const { a, b, sources, observationCount, lastUpdated } of data.edges) {
      const key = edgeKey(a, b);
      const composite = blendSources(sources);

      graph.edges.set(key, {
        sources: { ...sources },
        composite,
        observationCount,
        lastUpdated,
      });

      if (!graph.adjacency.has(a)) graph.adjacency.set(a, new Set());
      if (!graph.adjacency.has(b)) graph.adjacency.set(b, new Set());
      graph.adjacency.get(a)!.add(b);
      graph.adjacency.get(b)!.add(a);
    }

    return graph;
  }
}
