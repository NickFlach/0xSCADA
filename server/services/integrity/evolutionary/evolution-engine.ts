/**
 * Evolution Engine — genetic programming for resolution strategies
 *
 * Manages populations of ResolutionGenomes per process area. Each generation:
 * 1. Tournament selection (k=3, fitness-weighted)
 * 2. Crossover: swap primitive subsequences between parents
 * 3. Mutation: add/remove/reweight primitives
 * 4. Elitism: top 2 always survive
 *
 * Inspired by ParadoxResolver/evolutionary_engine.py
 *
 * @see ADR-0023
 * @closes #382
 */

import { ResolutionGenome, WeightedPrimitive } from './genome';
import { PrimitiveRegistry } from './registry';
import { FitnessEvaluator } from './fitness';
import { mulberry32, shuffleInPlace, type Rng } from './rng';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EvolutionConfig {
  /** Population size per process area (default 30) */
  populationSize: number;
  /** Tournament size for selection (default 3) */
  tournamentK: number;
  /** Number of elite genomes preserved each generation (default 2) */
  eliteCount: number;
  /** Mutation rate: probability of mutation per offspring (default 0.15) */
  mutationRate: number;
  /** Crossover rate: probability of crossover vs cloning (default 0.7) */
  crossoverRate: number;
  /** Max primitive weight after mutation (default 3.0) */
  maxWeight: number;
  /** Min primitive weight (default 0.1) */
  minWeight: number;
  /** Number of resolved paradoxes before triggering evolution (default 100) */
  resolutionsPerCycle: number;
  /**
   * Fraction of resolutions that pick a random (non-best) genome so the whole
   * population accrues fitness, not just the incumbent best (#451 M3). Default 0.2.
   */
  explorationRate: number;
  /**
   * Optional seed for reproducible/auditable evolution (#451). When set, all
   * randomness draws from a seeded stream; otherwise Math.random is used.
   */
  seed?: number;
}

export interface PopulationStats {
  processArea: string;
  generation: number;
  size: number;
  bestFitness: number;
  avgFitness: number;
  worstFitness: number;
  diversityScore: number;
  resolutionsSinceLast: number;
}

export interface EvolutionEvent {
  type: 'generation_complete' | 'genome_retired' | 'genome_born';
  processArea: string;
  generation: number;
  details: Record<string, unknown>;
  timestamp: number;
}

const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  populationSize: 30,
  tournamentK: 3,
  eliteCount: 2,
  mutationRate: 0.15,
  crossoverRate: 0.7,
  maxWeight: 3.0,
  minWeight: 0.1,
  resolutionsPerCycle: 100,
  explorationRate: 0.2,
};

// ─── Evolution Engine ───────────────────────────────────────────────────────

export class EvolutionEngine {
  private config: EvolutionConfig;
  private registry: PrimitiveRegistry;
  private fitnessEval: FitnessEvaluator;
  private rng: Rng;

  /** processArea → population of genomes */
  private populations: Map<string, ResolutionGenome[]> = new Map();
  /** processArea → current generation number */
  private generations: Map<string, number> = new Map();
  /** processArea → resolutions since last evolution */
  private resolutionCounters: Map<string, number> = new Map();
  /** Event log (bounded) */
  private eventLog: EvolutionEvent[] = [];
  private static readonly MAX_EVENT_LOG = 500;

  constructor(
    registry: PrimitiveRegistry,
    fitnessEval: FitnessEvaluator,
    config: Partial<EvolutionConfig> = {},
  ) {
    this.config = { ...DEFAULT_EVOLUTION_CONFIG, ...config };
    this.registry = registry;
    this.fitnessEval = fitnessEval;
    this.rng = this.config.seed !== undefined ? mulberry32(this.config.seed) : Math.random;
  }

  // ─── Population Management ──────────────────────────────────────

  /**
   * Initialize a population for a process area with random genomes.
   * Each genome gets a random subset of primitives with random weights.
   */
  initializePopulation(processArea: string): ResolutionGenome[] {
    const primitiveIds = this.registry.list().map(p => p.id);
    const population: ResolutionGenome[] = [];

    for (let i = 0; i < this.config.populationSize; i++) {
      const genome = this.createRandomGenome(primitiveIds, processArea);
      population.push(genome);
    }

    this.populations.set(processArea, population);
    this.generations.set(processArea, 0);
    this.resolutionCounters.set(processArea, 0);

    return population;
  }

  /**
   * Get the population for a process area. Initializes if not yet created.
   */
  getPopulation(processArea: string): ResolutionGenome[] {
    if (!this.populations.has(processArea)) {
      this.initializePopulation(processArea);
    }
    return this.populations.get(processArea)!;
  }

  /**
   * Get the best genome for a process area (highest fitness).
   */
  getBestGenome(processArea: string): ResolutionGenome | null {
    const pop = this.populations.get(processArea);
    if (!pop || pop.length === 0) return null;

    let best = pop[0];
    let bestFitness = this.fitnessEval.getFitnessForGenome(best);

    for (let i = 1; i < pop.length; i++) {
      const f = this.fitnessEval.getFitnessForGenome(pop[i]);
      if (f > bestFitness) {
        bestFitness = f;
        best = pop[i];
      }
    }

    return best;
  }

  /**
   * Select a genome to resolve the next conflict. Epsilon-greedy (#451 M3):
   * with probability `explorationRate`, return a random population member so
   * the whole population accrues fitness records; otherwise the current best.
   */
  selectResolutionGenome(processArea: string): ResolutionGenome | null {
    const pop = this.populations.get(processArea);
    if (!pop || pop.length === 0) return null;
    if (pop.length > 1 && this.rng() < this.config.explorationRate) {
      return pop[Math.floor(this.rng() * pop.length)];
    }
    return this.getBestGenome(processArea);
  }

  /**
   * Record that a resolution was made in a process area.
   * Returns true if evolution should be triggered.
   */
  recordResolution(processArea: string): boolean {
    const count = (this.resolutionCounters.get(processArea) ?? 0) + 1;
    this.resolutionCounters.set(processArea, count);
    return count >= this.config.resolutionsPerCycle;
  }

  // ─── Evolution Cycle ────────────────────────────────────────────

  /**
   * Run one generation of evolution for a process area.
   * Returns the new population.
   */
  evolve(processArea: string): ResolutionGenome[] {
    const population = this.getPopulation(processArea);
    const gen = (this.generations.get(processArea) ?? 0) + 1;

    // 1. Sort by fitness (descending)
    const ranked = this.rankByFitness(population);

    // 2. Elitism: preserve top genomes BY REFERENCE (#451 M2). Keeping the
    //    same object (and id) means their accumulated fitness records survive
    //    the pruneInactive below, so ranking is meaningful next generation.
    const elites = ranked.slice(0, this.config.eliteCount);
    for (const elite of elites) {
      elite.generation = gen;
    }

    // 3. Generate offspring to fill remaining slots
    const offspring: ResolutionGenome[] = [];
    const targetSize = this.config.populationSize - elites.length;

    for (let i = 0; i < targetSize; i++) {
      let child: ResolutionGenome;

      if (this.rng() < this.config.crossoverRate && population.length >= 2) {
        // Crossover
        const parent1 = this.tournamentSelect(ranked);
        const parent2 = this.tournamentSelect(ranked);
        child = this.crossover(parent1, parent2);
      } else {
        // Clone + mutate
        const parent = this.tournamentSelect(ranked);
        child = parent.clone();
      }

      // Mutation
      if (this.rng() < this.config.mutationRate) {
        this.mutate(child);
      }

      child.generation = gen;
      child.processAreaAffinity = processArea;
      offspring.push(child);
    }

    // 4. Build new population
    const newPopulation = [...elites, ...offspring];

    // 5. Prune fitness records for retired genomes (elites' ids are retained
    //    because they were preserved by reference above)
    const activeIds = new Set(newPopulation.map(g => g.id));
    const pruned = this.fitnessEval.pruneInactive(activeIds);

    // 6. Update state
    this.populations.set(processArea, newPopulation);
    this.generations.set(processArea, gen);
    this.resolutionCounters.set(processArea, 0);

    // 7. Log event
    this.logEvent({
      type: 'generation_complete',
      processArea,
      generation: gen,
      details: {
        populationSize: newPopulation.length,
        elitesPreserved: elites.length,
        offspringCreated: offspring.length,
        genomesPruned: pruned,
        bestFitness: newPopulation[0] ? this.fitnessEval.getFitnessForGenome(newPopulation[0]) : 0,
      },
      timestamp: Date.now(),
    });

    return newPopulation;
  }

  // ─── Selection ──────────────────────────────────────────────────

  /**
   * Tournament selection: pick k random genomes, return the fittest.
   */
  private tournamentSelect(ranked: ResolutionGenome[]): ResolutionGenome {
    const k = Math.min(this.config.tournamentK, ranked.length);
    let best: ResolutionGenome | null = null;
    let bestFitness = -Infinity;

    // Pick k random indices without replacement
    const indices = new Set<number>();
    while (indices.size < k) {
      indices.add(Math.floor(this.rng() * ranked.length));
    }

    for (const idx of indices) {
      const genome = ranked[idx];
      const fitness = this.fitnessEval.getFitnessForGenome(genome);
      if (fitness > bestFitness) {
        bestFitness = fitness;
        best = genome;
      }
    }

    return best ?? ranked[0];
  }

  // ─── Crossover ──────────────────────────────────────────────────

  /**
   * Crossover: create a child by blending primitive sequences from two parents.
   * Uses single-point crossover on the primitive arrays.
   */
  private crossover(parent1: ResolutionGenome, parent2: ResolutionGenome): ResolutionGenome {
    const p1 = parent1.primitives;
    const p2 = parent2.primitives;

    if (p1.length === 0 && p2.length === 0) {
      return parent1.clone();
    }

    // Single-point crossover. Cuts sampled in [0, len] INCLUSIVE (#451 M6) so
    // every gene position is inheritable — cut=len takes all of p1's head /
    // none of p2's tail; cut=0 the reverse. Sampling [0, len-1] would make
    // p1's last gene un-inheritable and p2's last gene always inherited.
    const cut1 = Math.floor(this.rng() * (p1.length + 1));
    const cut2 = Math.floor(this.rng() * (p2.length + 1));

    const childPrimitives: WeightedPrimitive[] = [
      ...p1.slice(0, cut1).map(p => ({ ...p })),
      ...p2.slice(cut2).map(p => ({ ...p })),
    ];

    // Deduplicate: if same primitive appears twice, merge weights (average)
    const seen = new Map<string, WeightedPrimitive>();
    for (const wp of childPrimitives) {
      const existing = seen.get(wp.primitiveId);
      if (existing) {
        existing.weight = (existing.weight + wp.weight) / 2;
      } else {
        seen.set(wp.primitiveId, { ...wp });
      }
    }

    return new ResolutionGenome({
      primitives: Array.from(seen.values()),
      generation: parent1.generation,
      ancestry: [parent1.id, parent2.id],
      processAreaAffinity: parent1.processAreaAffinity ?? parent2.processAreaAffinity,
    });
  }

  // ─── Mutation ───────────────────────────────────────────────────

  /**
   * Mutate a genome in-place. One of three operations:
   * 1. Add a random primitive (if room)
   * 2. Remove a random primitive (if >1)
   * 3. Reweight a random primitive
   */
  private mutate(genome: ResolutionGenome): void {
    const roll = this.rng();
    const primitiveIds = this.registry.list().map(p => p.id);

    if (roll < 0.33 && genome.primitives.length < primitiveIds.length) {
      // Add: pick a primitive not already in the genome
      const existing = new Set(genome.primitives.map(p => p.primitiveId));
      const available = primitiveIds.filter(id => !existing.has(id));
      if (available.length > 0) {
        const newId = available[Math.floor(this.rng() * available.length)];
        const weight = this.config.minWeight + this.rng() * (this.config.maxWeight - this.config.minWeight);
        genome.primitives.push({ primitiveId: newId, weight });
      }
    } else if (roll < 0.66 && genome.primitives.length > 1) {
      // Remove: drop a random primitive
      const idx = Math.floor(this.rng() * genome.primitives.length);
      genome.primitives.splice(idx, 1);
    } else if (genome.primitives.length > 0) {
      // Reweight: adjust a random primitive's weight
      const idx = Math.floor(this.rng() * genome.primitives.length);
      const delta = (this.rng() - 0.5) * 1.0; // ±0.5
      genome.primitives[idx].weight = Math.max(
        this.config.minWeight,
        Math.min(this.config.maxWeight, genome.primitives[idx].weight + delta),
      );
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private rankByFitness(population: ResolutionGenome[]): ResolutionGenome[] {
    return [...population].sort(
      (a, b) => this.fitnessEval.getFitnessForGenome(b) - this.fitnessEval.getFitnessForGenome(a),
    );
  }

  private createRandomGenome(primitiveIds: string[], processArea: string): ResolutionGenome {
    // Each genome gets 2-5 random primitives with random weights
    const count = 2 + Math.floor(this.rng() * 4);
    const shuffled = shuffleInPlace([...primitiveIds], this.rng);
    const selected = shuffled.slice(0, Math.min(count, shuffled.length));

    const primitives: WeightedPrimitive[] = selected.map(id => ({
      primitiveId: id,
      weight: this.config.minWeight + this.rng() * (this.config.maxWeight - this.config.minWeight),
    }));

    return new ResolutionGenome({
      primitives,
      generation: 0,
      processAreaAffinity: processArea,
    });
  }

  /**
   * Compute diversity score: ratio of unique primitive combinations in the population.
   */
  private computeDiversity(population: ResolutionGenome[]): number {
    if (population.length <= 1) return 0;
    const signatures = new Set<string>();
    for (const g of population) {
      const sig = g.primitives.map(p => p.primitiveId).sort().join(',');
      signatures.add(sig);
    }
    return signatures.size / population.length;
  }

  // ─── Stats & Events ─────────────────────────────────────────────

  getStats(processArea: string): PopulationStats | null {
    const pop = this.populations.get(processArea);
    if (!pop) return null;

    const fitnesses = pop.map(g => this.fitnessEval.getFitnessForGenome(g));

    return {
      processArea,
      generation: this.generations.get(processArea) ?? 0,
      size: pop.length,
      bestFitness: Math.max(...fitnesses),
      avgFitness: fitnesses.reduce((a, b) => a + b, 0) / fitnesses.length,
      worstFitness: Math.min(...fitnesses),
      diversityScore: this.computeDiversity(pop),
      resolutionsSinceLast: this.resolutionCounters.get(processArea) ?? 0,
    };
  }

  getAllProcessAreas(): string[] {
    return Array.from(this.populations.keys());
  }

  getEventLog(): EvolutionEvent[] {
    return this.eventLog;
  }

  private logEvent(event: EvolutionEvent): void {
    this.eventLog.push(event);
    if (this.eventLog.length > EvolutionEngine.MAX_EVENT_LOG) {
      this.eventLog = this.eventLog.slice(-EvolutionEngine.MAX_EVENT_LOG);
    }
  }

  /** Serialize all populations for persistence */
  serializeAll(): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const [area, pop] of this.populations) {
      data[area] = {
        generation: this.generations.get(area) ?? 0,
        genomes: pop.map(g => g.serialize()),
      };
    }
    return data;
  }
}
