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
 * COMMIT-ONCE INVARIANT: an approved evolved resolution calls
 * `resolver.commitResolution(...)`. If you ALSO let the same base resolver
 * auto-resolve the same conflict inside its own `ingestEvent` (the default
 * ParadoxResolver behavior), that conflict is committed twice. When driving
 * events through `ingestEvent` and then routing the conflict here, construct
 * the base resolver with `externalResolution: true` (the IntegrityService does
 * this). Calling `resolveConflict(conflict)` directly on a conflict object —
 * as the unit tests do — never double-commits.
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
import { EvolutionEngine, type EvolutionConfig } from './evolution-engine';
import { SafetyGuard, type SafetyConfig } from './safety-guard';
import { FitnessEvaluator } from './fitness';
import { PrimitiveRegistry } from './registry';
import { ResolutionGenome, type GenomeEvaluation } from './genome';
import { ConflictContext } from './primitives';
import type { ExplainabilityMonitor } from '../explainability-monitor';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EvolutionaryResolverConfig {
  /** Whether evolved strategies are enabled (default true) */
  enabled: boolean;
  /** Process areas where evolution is allowed (empty = all) */
  allowedProcessAreas: string[];
  /** Evolution-engine overrides (population size, seed, resolutionsPerCycle, …) */
  evolution?: Partial<EvolutionConfig>;
  /** Safety-guard overrides (confidence floor, novelty budget, maturity gen, …) */
  safety?: Partial<SafetyConfig>;
  /**
   * Action string used for governance gates + explainability decisions
   * (ADR-0023 / CFR 21 Part 11). Default 'evolved_resolution'.
   */
  governanceAction?: string;
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
  totalGovernanceBlocked: number;
  /** Whether a CFR-21-Part-11 compliance monitor is wired */
  complianceMonitorActive: boolean;
}

const DEFAULT_CONFIG: EvolutionaryResolverConfig = {
  enabled: true,
  allowedProcessAreas: [],
  governanceAction: 'evolved_resolution',
};

// ─── Evolutionary Resolver ──────────────────────────────────────────────────

export class EvolutionaryResolver extends EventEmitter {
  private config: EvolutionaryResolverConfig;
  private resolver: ParadoxResolver;
  private engine: EvolutionEngine;
  private guard: SafetyGuard;
  private fitness: FitnessEvaluator;
  private registry: PrimitiveRegistry;
  /** Optional CFR-21-Part-11 compliance layer (governance gates + audit). */
  private monitor?: ExplainabilityMonitor;

  /** Counters for status tracking */
  private evolutionaryCount = 0;
  private staticFallbackCount = 0;
  private governanceBlockedCount = 0;

  constructor(
    resolver: ParadoxResolver,
    config: Partial<EvolutionaryResolverConfig> = {},
    monitor?: ExplainabilityMonitor,
  ) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.resolver = resolver;
    this.monitor = monitor;

    // Initialize sub-components
    this.registry = new PrimitiveRegistry();
    this.fitness = new FitnessEvaluator();
    this.engine = new EvolutionEngine(this.registry, this.fitness, this.config.evolution);
    this.guard = new SafetyGuard(this.fitness, this.config.safety);
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

    // Select a genome for this process area (epsilon-greedy — #451 M3 — so the
    // whole population accrues fitness, not only the incumbent best).
    const genome = this.engine.selectResolutionGenome(processArea);
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

    // Every conflict handled here (allowed OR blocked-after-evaluation) counts
    // toward the evolution cycle (#451 B1). Counting only allowed resolutions
    // meant the counter never advanced while the novelty budget was blocking,
    // so genomes never matured and evolution stalled permanently.
    const shouldEvolve = this.engine.recordResolution(processArea);

    if (!safetyDecision.allowed) {
      // Safety guard blocked — fall back to static resolver
      const resolution = await this.resolver.resolve(conflict);
      this.staticFallbackCount++;

      // Record fitness from the GENOME'S OWN evaluation (#451 B2), NOT the
      // static fallback's confidence. Crediting a blocked (low-confidence)
      // genome with the static strategy's high confidence inverted selection
      // pressure — failing genomes would out-compete good ones.
      const genomeResolution: Resolution = {
        conflictId: conflict.conflictId,
        method: 'confidence_weighted',
        confidence: evaluation.score,
        reasoning: `[Evolved-blocked] ${evaluation.reasoning}`,
        resolvedAt: new Date(),
      };
      this.fitness.evaluate(genome, genomeResolution, evaluation);

      if (shouldEvolve) this.evolveAndEmit(processArea);

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

    // SafetyGuard approved — build the evolved resolution from the evaluation.
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

    // Governance gate (#492 M7): ADR-0023 requires evolved strategies to pass a
    // gate before production use. A blocking gate failure demotes to static.
    const govBlockReason = this.checkGovernance(resolution);
    if (govBlockReason) {
      const staticResolution = await this.resolver.resolve(conflict);
      this.staticFallbackCount++;
      this.governanceBlockedCount++;
      this.fitness.evaluate(genome, this.genomeSelfResolution(conflict, evaluation), evaluation);
      this.recordExplainability(resolution, genome, evaluation, processArea, false, govBlockReason);
      if (shouldEvolve) this.evolveAndEmit(processArea);
      this.emit('governance_blocked', { processArea, genomeId: genome.id, reason: govBlockReason });
      return {
        resolution: staticResolution,
        usedEvolved: false,
        genomeId: genome.id,
        generation: genome.generation,
        safetyDecision: { allowed: false, reason: `Governance gate: ${govBlockReason}` },
      };
    }

    this.evolutionaryCount++;

    // Record fitness
    this.fitness.evaluate(genome, resolution, evaluation);

    // Commit through the base resolver (#492 M1) so its maps update and
    // downstream `resolved` / `resolved_event` listeners (ADR-0024/0025) fire.
    this.resolver.commitResolution(conflict, resolution);

    // Explainability audit for the approved evolved decision (#492 M7).
    this.recordExplainability(resolution, genome, evaluation, processArea, true);

    if (shouldEvolve) this.evolveAndEmit(processArea);

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
    // #492 M5: populate the context from the base resolver's state so the
    // history_bias / rate_filter (recentReadings) and neighbor_correlation
    // (neighborValues) primitives actually run instead of returning neutral.
    const tag = conflict.events[0]?.tag;
    let recentReadings: ScadaEvent[] | undefined;
    let neighborValues: Map<string, unknown> | undefined;

    if (tag) {
      const conflictIds = new Set(conflict.events.map(e => e.id));
      const readings = this.resolver.getRecentReadings(tag, conflictIds);
      if (readings.length > 0) recentReadings = readings;

      const neighborTags = this.resolver.getNeighborTags(tag, conflict.processArea);
      if (neighborTags.length > 0) {
        const values = new Map<string, unknown>();
        for (const nt of neighborTags) {
          const v = this.resolver.getLatestValue(nt);
          if (v !== undefined) values.set(nt, v);
        }
        if (values.size > 0) neighborValues = values;
      }
    }

    return {
      conflict,
      recentReadings,
      neighborValues,
      physicsValid: conflict.type !== 'physics_violation' ? undefined : false,
    };
  }

  /** A resolution carrying the genome's OWN score, for fitness on demoted paths. */
  private genomeSelfResolution(conflict: ConflictDetection, evaluation: GenomeEvaluation): Resolution {
    return {
      conflictId: conflict.conflictId,
      method: 'confidence_weighted',
      confidence: evaluation.score,
      reasoning: `[Evolved-demoted] ${evaluation.reasoning}`,
      resolvedAt: new Date(),
    };
  }

  /**
   * Run the evolved resolution through the compliance governance gates.
   * Returns a block reason if any applicable gate with `block` enforcement
   * fails, otherwise null (including when no monitor is wired).
   */
  private checkGovernance(resolution: Resolution): string | null {
    if (!this.monitor) return null;
    const results = this.monitor.checkGovernanceGates(
      this.config.governanceAction ?? 'evolved_resolution',
      resolution.confidence,
      false, // evolved resolutions are automated — no electronic signature
    );
    const blocking = results.find(r => !r.passed && r.enforcement === 'block');
    return blocking ? blocking.reason : null;
  }

  /**
   * Record a CFR-21-Part-11 explainability decision + tamper-evident audit
   * entry for an evolved-resolution decision (#492 M7). No-op without a monitor.
   */
  private recordExplainability(
    resolution: Resolution,
    genome: ResolutionGenome,
    evaluation: GenomeEvaluation,
    processArea: string,
    approved: boolean,
    blockReason?: string,
  ): void {
    if (!this.monitor) return;
    const decision = this.monitor.recordDecision({
      source: 'EvolutionaryResolver',
      action: this.config.governanceAction ?? 'evolved_resolution',
      ruleApplied: `evolved-genome:${genome.id} gen=${genome.generation}`,
      reasoning: approved ? resolution.reasoning : `Gated: ${blockReason}. ${resolution.reasoning}`,
      inputs: {
        conflictId: resolution.conflictId,
        processArea,
        primitivesEvaluated: evaluation.primitivesEvaluated,
        genomeId: genome.id,
        generation: genome.generation,
      },
      output: {
        method: resolution.method,
        winner: resolution.winner?.id,
        mergedValue: resolution.mergedValue,
        applied: approved,
      },
      confidence: resolution.confidence,
      verificationLayers: [
        { layer: 'safety_guard', passed: true, score: resolution.confidence, timestamp: new Date() },
        { layer: 'governance_gate', passed: approved, score: resolution.confidence, details: blockReason, timestamp: new Date() },
      ],
    });

    this.monitor.addAuditEntry({
      userId: 'system:evolutionary-resolver',
      action: approved ? 'approve' : 'reject',
      resource: 'evolved_resolution',
      resourceId: decision.id,
      reason: approved ? 'Evolved strategy applied' : `Evolved strategy gated: ${blockReason}`,
    });
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
      totalGovernanceBlocked: this.governanceBlockedCount,
      complianceMonitorActive: this.monitor !== undefined,
    };
  }

  /** Direct access to sub-components */
  getEngine(): EvolutionEngine { return this.engine; }
  getGuard(): SafetyGuard { return this.guard; }
  getFitnessEvaluator(): FitnessEvaluator { return this.fitness; }
  getRegistry(): PrimitiveRegistry { return this.registry; }
}
