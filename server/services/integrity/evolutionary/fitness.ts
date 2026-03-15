/**
 * Fitness Evaluator — scores resolution genomes based on resolution quality
 *
 * Computes fitness from:
 * - Resolution confidence score
 * - Validation feedback (confirmed/rejected by subsequent readings)
 * - Efficiency bonus (fewer primitives = better)
 * - Physics violation penalty
 * - Rolling fitness window with exponential decay
 *
 * @see ADR-0023
 * @closes #381
 */

import type { Resolution } from '../paradox-resolver';
import type { ResolutionGenome, GenomeEvaluation } from './genome';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FitnessRecord {
  timestamp: number;
  rawFitness: number;
  confidenceScore: number;
  efficiencyBonus: number;
  physicsPenalty: number;
  validationBonus: number;
}

export interface FitnessConfig {
  /** Max records per genome in rolling window */
  windowSize: number;
  /** Exponential decay factor for older records (0–1, lower = more decay) */
  decayFactor: number;
  /** Weight of efficiency bonus */
  efficiencyWeight: number;
  /** Max number of primitives considered "full cost" (no bonus beyond this) */
  maxPrimitivesBaseline: number;
  /** Penalty multiplier for physics violations */
  physicsPenaltyWeight: number;
  /** Bonus for validated (confirmed) resolutions */
  validationConfirmBonus: number;
  /** Penalty for rejected resolutions */
  validationRejectPenalty: number;
}

const DEFAULT_FITNESS_CONFIG: FitnessConfig = {
  windowSize: 50,
  decayFactor: 0.95,
  efficiencyWeight: 0.1,
  maxPrimitivesBaseline: 7,
  physicsPenaltyWeight: 0.3,
  validationConfirmBonus: 0.15,
  validationRejectPenalty: 0.25,
};

// ─── Fitness Evaluator ──────────────────────────────────────────────────────

export class FitnessEvaluator {
  private config: FitnessConfig;
  /** genomeId → rolling fitness records */
  private records: Map<string, FitnessRecord[]> = new Map();

  constructor(config: Partial<FitnessConfig> = {}) {
    this.config = { ...DEFAULT_FITNESS_CONFIG, ...config };
  }

  /**
   * Evaluate fitness for a genome based on a resolution outcome.
   * Returns the raw fitness score and records it in the rolling window.
   */
  evaluate(
    genome: ResolutionGenome,
    resolution: Resolution,
    evaluation: GenomeEvaluation,
  ): number {
    const confidenceScore = resolution.confidence;

    // Efficiency bonus: fewer primitives evaluated → higher bonus
    const primRatio = evaluation.primitivesEvaluated / this.config.maxPrimitivesBaseline;
    const efficiencyBonus = Math.max(0, (1 - primRatio)) * this.config.efficiencyWeight;

    // Physics penalty: if method was physics_arbitration with low confidence, penalize
    const physicsPenalty =
      resolution.method === 'physics_arbitration' && resolution.confidence < 0.5
        ? this.config.physicsPenaltyWeight
        : 0;

    const rawFitness = Math.max(0, Math.min(1, confidenceScore + efficiencyBonus - physicsPenalty));

    const record: FitnessRecord = {
      timestamp: Date.now(),
      rawFitness,
      confidenceScore,
      efficiencyBonus,
      physicsPenalty,
      validationBonus: 0,
    };

    this.pushRecord(genome.id, record);
    genome.recordFitness(rawFitness);

    return rawFitness;
  }

  /**
   * Record validation feedback: a subsequent reading confirmed or rejected
   * the resolution. Adjusts the most recent fitness record for this genome.
   */
  recordValidation(genomeId: string, confirmed: boolean): void {
    const records = this.records.get(genomeId);
    if (!records || records.length === 0) return;

    const latest = records[records.length - 1];
    latest.validationBonus = confirmed
      ? this.config.validationConfirmBonus
      : -this.config.validationRejectPenalty;
    latest.rawFitness = Math.max(0, Math.min(1, latest.rawFitness + latest.validationBonus));
  }

  /**
   * Get aggregate fitness for a genome using exponential-decay weighted average
   * over the rolling window.
   */
  getFitness(genomeId: string): number {
    const records = this.records.get(genomeId);
    if (!records || records.length === 0) return 0;

    let totalWeight = 0;
    let weightedSum = 0;
    const n = records.length;

    for (let i = 0; i < n; i++) {
      // Most recent record has highest weight
      const age = n - 1 - i;
      const w = Math.pow(this.config.decayFactor, age);
      weightedSum += records[i].rawFitness * w;
      totalWeight += w;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  /** Get raw fitness records for a genome */
  getRecords(genomeId: string): FitnessRecord[] {
    return this.records.get(genomeId) ?? [];
  }

  /** Remove records for a retired genome to prevent unbounded memory growth (#399) */
  removeGenome(genomeId: string): boolean {
    return this.records.delete(genomeId);
  }

  /**
   * Prune records for genomes not in the provided set of active IDs.
   * Call after each generation to clean up dead genomes.
   */
  pruneInactive(activeGenomeIds: Set<string>): number {
    let pruned = 0;
    for (const id of this.records.keys()) {
      if (!activeGenomeIds.has(id)) {
        this.records.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  /** Current number of tracked genomes */
  get trackedGenomeCount(): number {
    return this.records.size;
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private pushRecord(genomeId: string, record: FitnessRecord): void {
    let arr = this.records.get(genomeId);
    if (!arr) {
      arr = [];
      this.records.set(genomeId, arr);
    }
    arr.push(record);
    if (arr.length > this.config.windowSize) {
      this.records.set(genomeId, arr.slice(-this.config.windowSize));
    }
  }
}
