/**
 * Resolution Genome — a weighted pipeline of resolution primitives
 *
 * Encodes a resolution strategy as a composable, evolvable sequence
 * of primitives with per-primitive weights. Genomes can be serialized,
 * cloned, and evaluated against conflict data.
 *
 * @see ADR-0023
 * @closes #380 (partial)
 */

import crypto from 'crypto';
import type { ResolutionPrimitive, ConflictContext, PrimitiveResult } from './primitives';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WeightedPrimitive {
  primitiveId: string;
  weight: number;
}

export interface GenomeEvaluation {
  /** Blended score (0–1) */
  score: number;
  /** ID of the favored event, if consensus exists */
  favoredEventId?: string;
  /** Suggested merged value, if any */
  suggestedValue?: unknown;
  /** Per-primitive results */
  primitiveResults: Array<{ primitiveId: string; result: PrimitiveResult }>;
  /** Number of primitives actually evaluated */
  primitivesEvaluated: number;
  /** Combined reasoning */
  reasoning: string;
}

export interface SerializedGenome {
  id: string;
  primitives: WeightedPrimitive[];
  generation: number;
  ancestry: string[];
  fitnessHistory: number[];
  processAreaAffinity: string | null;
}

// ─── Genome ─────────────────────────────────────────────────────────────────

export class ResolutionGenome {
  readonly id: string;
  primitives: WeightedPrimitive[];
  generation: number;
  ancestry: string[];
  fitnessHistory: number[];
  processAreaAffinity: string | null;

  /** Rolling fitness window size */
  private static readonly FITNESS_WINDOW = 50;

  constructor(opts?: Partial<{
    id: string;
    primitives: WeightedPrimitive[];
    generation: number;
    ancestry: string[];
    fitnessHistory: number[];
    processAreaAffinity: string | null;
  }>) {
    this.id = opts?.id ?? `genome_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    this.primitives = opts?.primitives ?? [];
    this.generation = opts?.generation ?? 0;
    this.ancestry = opts?.ancestry ?? [];
    this.fitnessHistory = opts?.fitnessHistory ?? [];
    this.processAreaAffinity = opts?.processAreaAffinity ?? null;
  }

  /**
   * Evaluate this genome's pipeline against conflict context.
   * Runs each primitive, blends scores by weight, and returns a combined result.
   */
  evaluate(
    ctx: ConflictContext,
    primitiveRegistry: Map<string, ResolutionPrimitive>,
  ): GenomeEvaluation {
    const results: Array<{ primitiveId: string; result: PrimitiveResult }> = [];
    let totalWeightedScore = 0;
    let totalWeight = 0;
    const eventVotes = new Map<string, number>();
    let primitivesEvaluated = 0;

    for (const wp of this.primitives) {
      const primitive = primitiveRegistry.get(wp.primitiveId);
      if (!primitive) continue;

      const result = primitive.evaluate(ctx);
      primitivesEvaluated++;

      const effectiveWeight = wp.weight * result.weight;
      totalWeightedScore += result.score * effectiveWeight;
      totalWeight += effectiveWeight;

      if (result.favoredEventId) {
        const current = eventVotes.get(result.favoredEventId) ?? 0;
        eventVotes.set(result.favoredEventId, current + effectiveWeight);
      }

      results.push({ primitiveId: wp.primitiveId, result });
    }

    const score = totalWeight > 0 ? totalWeightedScore / totalWeight : 0.5;

    // Determine favored event by highest weighted vote
    let favoredEventId: string | undefined;
    let maxVote = 0;
    for (const [eventId, voteWeight] of eventVotes) {
      if (voteWeight > maxVote) {
        maxVote = voteWeight;
        favoredEventId = eventId;
      }
    }

    const reasoning = results
      .map(r => `[${r.primitiveId}] ${r.result.reasoning}`)
      .join('; ');

    return {
      score,
      favoredEventId,
      primitiveResults: results,
      primitivesEvaluated,
      reasoning,
    };
  }

  /** Record a fitness score, maintaining rolling window */
  recordFitness(fitness: number): void {
    this.fitnessHistory.push(fitness);
    if (this.fitnessHistory.length > ResolutionGenome.FITNESS_WINDOW) {
      this.fitnessHistory = this.fitnessHistory.slice(-ResolutionGenome.FITNESS_WINDOW);
    }
  }

  /** Serialize to plain JSON */
  serialize(): SerializedGenome {
    return {
      id: this.id,
      primitives: [...this.primitives],
      generation: this.generation,
      ancestry: [...this.ancestry],
      fitnessHistory: [...this.fitnessHistory],
      processAreaAffinity: this.processAreaAffinity,
    };
  }

  /** Deserialize from JSON */
  static deserialize(data: SerializedGenome): ResolutionGenome {
    return new ResolutionGenome({
      id: data.id,
      primitives: data.primitives,
      generation: data.generation,
      ancestry: data.ancestry,
      fitnessHistory: data.fitnessHistory,
      processAreaAffinity: data.processAreaAffinity,
    });
  }

  /** Create a deep clone with a new ID */
  clone(): ResolutionGenome {
    return new ResolutionGenome({
      primitives: this.primitives.map(p => ({ ...p })),
      generation: this.generation,
      ancestry: [...this.ancestry, this.id],
      fitnessHistory: [...this.fitnessHistory],
      processAreaAffinity: this.processAreaAffinity,
    });
  }

  toString(): string {
    const prims = this.primitives.map(p => `${p.primitiveId}(w=${p.weight.toFixed(2)})`).join(' → ');
    const avgFitness = this.fitnessHistory.length > 0
      ? (this.fitnessHistory.reduce((a, b) => a + b, 0) / this.fitnessHistory.length).toFixed(3)
      : 'N/A';
    return `Genome[${this.id}] gen=${this.generation} fitness=${avgFitness} area=${this.processAreaAffinity ?? '*'} | ${prims}`;
  }
}
