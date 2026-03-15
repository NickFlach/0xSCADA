/**
 * Evolutionary Resolver — Wires the evolution engine into ParadoxResolver
 *
 * Sits alongside the ParadoxResolver, providing evolved resolution strategies
 * as an alternative to static ones. The SafetyGuard ensures we fall back to
 * static strategies when evolved ones underperform.
 *
 * Integration flow:
 * 1. Conflict detected by ParadoxResolver
 * 2. EvolutionaryResolver selects best genome for the process area
 * 3. Genome evaluates the conflict using its primitive pipeline
 * 4. SafetyGuard checks confidence, novelty budget, kill switch
 * 5. If allowed → return evolved resolution
 * 6. If blocked → ParadoxResolver handles it with static strategy
 * 7. Fitness evaluator scores the result
 * 8. After N resolutions, evolution cycle runs
 *
 * @see ADR-0023
 * @closes #384
 */

import { EventEmitter } from 'events';
import {
  ParadoxResolver,
  ConflictDetection,
  Resolution,
  ScadaEvent,
} from '../paradox-resolver';
import { EvolutionEngine } from './evolution-engine';
import { SafetyGuard } from './safety-guard';
import { FitnessEvaluator } from './fitness';
import { PrimitiveRegistry } from './registry';
import { ResolutionGenome } from './genome';
import { ConflictContext } from './primitives';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EvolutionaryResolverConfig {
  /** Whether evolved strategies are enabled (default true) */
  enabled: boolean;
  /** Process areas where evolution is allowed (empty = all) */
  allowedProcessAreas: string[];
}

export interface EvolutionaryResolution {
  /** The resolution produced */
  resolution: Resolution;
  /** Whether an evolved genome was used */
  usedEvolved: boolean;
  /** Genome ID if evolved, null if static */
  genomeId: string | null;
  /** Generation of the genome used */
  generation: number;
  /** Safety guard decision details */
  safetyDecision: {
    allowed: boolean;
    reason: string;
  };
}

export interface EvolutionaryResolverStatus {
  enabled: boolean;
  killSwitchActive: boolean;
  processAreas: Array<{
    area: string;
    generation: number;
    populationSize: number;
    bestFitness: number;
    avgFitness: number;
    diversity: number;
  }>;
  safetyStats: ReturnType<SafetyGuard['getStats']>;
  totalEvolutionaryResolutions: number;
  totalStaticFallbacks: number;
}

const DEFAULT_CONFIG: EvolutionaryResolverConfig = {
  enabled: true,
  allowedProcessAreas: [],
};

// ─── Evolutionary Resolver ──────────────────────────────────────────────────

export class EvolutionaryResolver extends EventEmitter {
  private config: EvolutionaryResolverConfig;
  private resolver: ParadoxResolver;
  private engine: EvolutionEngine;
  private guard: SafetyGuard;
  private fitness: FitnessEvaluator;
  private registry: PrimitiveRegistry;

  /** Counters for status tracking */
  private evolutionaryCount = 0;
  private staticFallbackCount = 0;

  constructor(
    resolver: ParadoxResolver,
    config: Partial<EvolutionaryResolverConfig> = {},
  ) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.resolver = resolver;

    // Initialize sub-components
    this.registry = new PrimitiveRegistry();
    this.fitness = new FitnessEvaluator();
    this.engine = new EvolutionEngine(this.registry, this.fitness);
    this.guard = new SafetyGuard(this.fitness);
  }

  // ─── Resolution ─────────────────────────────────────────────────

  /**
   * Attempt to resolve a conflict using an evolved strategy.
   * Falls back to the base ParadoxResolver if:
   * - Evolutionary resolution is disabled
   * - Process area not in allowed list
   * - Safety guard blocks the evolved strategy
   * - No population exists for the process area
   */
  async resolveConflict(conflict: ConflictDetection): Promise<EvolutionaryResolution> {
    const processArea = conflict.processArea ?? 'default';

    // Check if we should try evolutionary resolution
    if (!this.shouldUseEvolved(processArea)) {
      const resolution = await this.resolver.resolve(conflict);
      this.staticFallbackCount++;
      return {
        resolution,
        usedEvolved: false,
        genomeId: null,
        generation: 0,
        safetyDecision: { allowed: false, reason: 'Evolutionary resolution disabled or not applicable' },
      };
    }

    // Get best genome for this process area
    const genome = this.engine.getBestGenome(processArea);
    if (!genome) {
      // No population yet — initialize and fall back
      this.engine.initializePopulation(processArea);
      const resolution = await this.resolver.resolve(conflict);
      this.staticFallbackCount++;
      return {
        resolution,
        usedEvolved: false,
        genomeId: null,
        generation: 0,
        safetyDecision: { allowed: false, reason: 'Population initializing' },
      };
    }

    // Build conflict context for genome evaluation
    const ctx = this.buildConflictContext(conflict);

    // Evaluate the genome
    const evaluation = genome.evaluate(ctx, this.registry.getMap());

    // Safety check
    const safetyDecision = this.guard.checkResolution(genome, evaluation, processArea);

    if (!safetyDecision.allowed) {
      // Safety guard blocked — fall back to static resolver
      const resolution = await this.resolver.resolve(conflict);
      this.staticFallbackCount++;

      // Still record fitness (low score for blocked genome)
      this.fitness.evaluate(genome, resolution, evaluation);

      this.emit('safety_blocked', {
        processArea,
        genomeId: genome.id,
        reason: safetyDecision.reason,
      });

      return {
        resolution,
        usedEvolved: false,
        genomeId: genome.id,
        generation: genome.generation,
        safetyDecision: { allowed: false, reason: safetyDecision.reason },
      };
    }

    // Evolved strategy approved — build resolution from genome evaluation
    const resolution: Resolution = {
      conflictId: conflict.conflictId,
      method: 'confidence_weighted', // closest static equivalent
      winner: evaluation.favoredEventId
        ? conflict.events.find(e => e.id === evaluation.favoredEventId)
        : conflict.events[0],
      confidence: evaluation.score,
      reasoning: `[Evolved gen=${genome.generation}] ${evaluation.reasoning}`,
      resolvedAt: new Date(),
    };

    this.evolutionaryCount++;

    // Record fitness
    this.fitness.evaluate(genome, resolution, evaluation);

    // Check if evolution cycle should trigger
    if (this.engine.recordResolution(processArea)) {
      this.evolveAndEmit(processArea);
    }

    this.emit('evolutionary_resolution', {
      processArea,
      genomeId: genome.id,
      generation: genome.generation,
      confidence: evaluation.score,
    });

    return {
      resolution,
      usedEvolved: true,
      genomeId: genome.id,
      generation: genome.generation,
      safetyDecision: { allowed: true, reason: 'All safety checks passed' },
    };
  }

  /**
   * Provide validation feedback: a subsequent reading confirmed or rejected
   * the resolution. This feeds back into the fitness evaluator.
   */
  recordValidation(genomeId: string, confirmed: boolean): void {
    this.fitness.recordValidation(genomeId, confirmed);
  }

  // ─── Evolution Control ──────────────────────────────────────────

  /** Manually trigger evolution for a process area */
  triggerEvolution(processArea: string): void {
    this.evolveAndEmit(processArea);
  }

  /** Enable/disable evolutionary resolution */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  /** Activate kill switch (disables all evolved strategies immediately) */
  activateKillSwitch(): void {
    this.guard.activateKillSwitch();
    this.emit('kill_switch_activated');
  }

  /** Deactivate kill switch */
  deactivateKillSwitch(): void {
    this.guard.deactivateKillSwitch();
    this.emit('kill_switch_deactivated');
  }

  // ─── Internal ───────────────────────────────────────────────────

  private shouldUseEvolved(processArea: string): boolean {
    if (!this.config.enabled) return false;
    if (this.guard.isKillSwitchActive()) return false;
    if (this.config.allowedProcessAreas.length > 0 &&
        !this.config.allowedProcessAreas.includes(processArea)) return false;
    return true;
  }

  private buildConflictContext(conflict: ConflictDetection): ConflictContext {
    return {
      conflict,
      recentReadings: undefined, // Could be populated from resolver's event history
      neighborValues: undefined, // Could be populated from tag correlations
      physicsValid: conflict.type !== 'physics_violation' ? undefined : false,
    };
  }

  private evolveAndEmit(processArea: string): void {
    const newPop = this.engine.evolve(processArea);
    const stats = this.engine.getStats(processArea);

    this.emit('evolution_complete', {
      processArea,
      generation: stats?.generation,
      bestFitness: stats?.bestFitness,
      diversity: stats?.diversityScore,
      populationSize: newPop.length,
    });
  }

  // ─── Status ─────────────────────────────────────────────────────

  getStatus(): EvolutionaryResolverStatus {
    const processAreas = this.engine.getAllProcessAreas().map(area => {
      const stats = this.engine.getStats(area);
      return {
        area,
        generation: stats?.generation ?? 0,
        populationSize: stats?.size ?? 0,
        bestFitness: stats?.bestFitness ?? 0,
        avgFitness: stats?.avgFitness ?? 0,
        diversity: stats?.diversityScore ?? 0,
      };
    });

    return {
      enabled: this.config.enabled,
      killSwitchActive: this.guard.isKillSwitchActive(),
      processAreas,
      safetyStats: this.guard.getStats(),
      totalEvolutionaryResolutions: this.evolutionaryCount,
      totalStaticFallbacks: this.staticFallbackCount,
    };
  }

  /** Direct access to sub-components */
  getEngine(): EvolutionEngine { return this.engine; }
  getGuard(): SafetyGuard { return this.guard; }
  getFitnessEvaluator(): FitnessEvaluator { return this.fitness; }
  getRegistry(): PrimitiveRegistry { return this.registry; }
}
