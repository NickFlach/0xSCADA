/**
 * Edge-case + regression suite for the ADR-0023 evolutionary resolver (#491).
 * The subsystem previously had zero tests. These encode the CORRECT behavior
 * for the blockers/majors identified in the #451 review.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EvolutionEngine } from '../evolution-engine';
import { FitnessEvaluator } from '../fitness';
import { SafetyGuard } from '../safety-guard';
import { PrimitiveRegistry } from '../registry';
import { ResolutionGenome } from '../genome';
import { EvolutionaryResolver } from '../evolutionary-resolver';
import { mulberry32, shuffleInPlace } from '../rng';
import { ParadoxResolver, type ConflictDetection, type ScadaEvent } from '../../paradox-resolver';

// ─── Helpers ──────────────────────────────────────────────────────────────

function evt(overrides: Partial<ScadaEvent> = {}): ScadaEvent {
  return {
    id: `e_${Math.random().toString(36).slice(2)}`,
    deviceId: 'dev-1',
    tag: 'TT-101',
    value: 100,
    timestamp: new Date('2026-03-15T00:00:00Z'),
    quality: 'good',
    source: 'sensor',
    logicalClock: 1,
    vectorClock: {},
    ...overrides,
  };
}

function conflict(events: ScadaEvent[], area = 'area-1'): ConflictDetection {
  return {
    conflictId: `c_${Math.random().toString(36).slice(2)}`,
    type: 'simultaneous_reading',
    events,
    severity: 'medium',
    detectedAt: new Date(),
    description: 'test conflict',
    processArea: area,
  };
}

// ─── RNG ──────────────────────────────────────────────────────────────────

describe('seedable RNG (#451)', () => {
  it('same seed → identical stream; different seed → different', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const seqA = Array.from({ length: 8 }, () => a());
    const seqB = Array.from({ length: 8 }, () => b());
    const seqC = Array.from({ length: 8 }, () => c());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    for (const x of seqA) expect(x).toBeGreaterThanOrEqual(0), expect(x).toBeLessThan(1);
  });

  it('shuffleInPlace preserves the multiset and actually reorders (not a no-op)', () => {
    const src = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = shuffleInPlace([...src], mulberry32(7));
    expect([...out].sort((a, b) => a - b)).toEqual(src);
    // A `return arr` no-op would leave order unchanged — require movement.
    expect(out).not.toEqual(src);
  });
});

// ─── FitnessEvaluator ─────────────────────────────────────────────────────

describe('FitnessEvaluator', () => {
  it('getFitnessForGenome falls back to the genome fitnessHistory when records are pruned (#451 M2)', () => {
    const fitness = new FitnessEvaluator();
    const g = new ResolutionGenome({ id: 'g1', primitives: [] });
    g.recordFitness(0.9);
    g.recordFitness(0.85);
    // No evaluator records for g1 → must use the genome's own history, not 0
    expect(fitness.getFitness('g1')).toBe(0);
    expect(fitness.getFitnessForGenome(g)).toBeGreaterThan(0.5);
  });

  it('clamps NaN/Infinity fitness inputs to 0 (does not poison ranking)', () => {
    const fitness = new FitnessEvaluator();
    const g = new ResolutionGenome({ id: 'gNaN', primitives: [] });
    const evalObj = { score: NaN, primitiveResults: [], primitivesEvaluated: 0, reasoning: '' };
    const raw = fitness.evaluate(g, { conflictId: 'c', method: 'confidence_weighted', confidence: NaN, reasoning: '', resolvedAt: new Date() }, evalObj as any);
    expect(Number.isFinite(raw)).toBe(true);
    expect(raw).toBe(0);
  });

  it('recordValidation adjusts the latest record within [0,1]', () => {
    const fitness = new FitnessEvaluator();
    const g = new ResolutionGenome({ id: 'gv', primitives: [] });
    const evalObj = { score: 0.5, primitiveResults: [], primitivesEvaluated: 1, reasoning: '' };
    fitness.evaluate(g, { conflictId: 'c', method: 'confidence_weighted', confidence: 0.5, reasoning: '', resolvedAt: new Date() }, evalObj as any);
    const before = fitness.getFitness('gv');
    fitness.recordValidation('gv', true);
    expect(fitness.getFitness('gv')).toBeGreaterThan(before);
    expect(fitness.getFitness('gv')).toBeLessThanOrEqual(1);
  });
});

// ─── EvolutionEngine ──────────────────────────────────────────────────────

describe('EvolutionEngine', () => {
  let registry: PrimitiveRegistry;
  let fitness: FitnessEvaluator;

  beforeEach(() => {
    registry = new PrimitiveRegistry();
    fitness = new FitnessEvaluator();
  });

  it('is deterministic under a fixed seed', () => {
    const mk = () =>
      new EvolutionEngine(new PrimitiveRegistry(), new FitnessEvaluator(), { seed: 123, populationSize: 10 });
    const e1 = mk();
    const e2 = mk();
    const p1 = e1.initializePopulation('a').map(g => g.primitives.map(p => p.primitiveId).join(','));
    const p2 = e2.initializePopulation('a').map(g => g.primitives.map(p => p.primitiveId).join(','));
    expect(p1).toEqual(p2);
  });

  it('preserves elite fitness identity across a generation (#451 M2)', () => {
    const engine = new EvolutionEngine(registry, fitness, { seed: 1, populationSize: 8, eliteCount: 2 });
    const pop = engine.initializePopulation('a');
    // Give the first genome a strong, repeated fitness signal
    const star = pop[0];
    for (let i = 0; i < 5; i++) {
      fitness.evaluate(star, { conflictId: 'c', method: 'confidence_weighted', confidence: 0.95, reasoning: '', resolvedAt: new Date() }, { score: 0.95, primitiveResults: [], primitivesEvaluated: 1, reasoning: '' } as any);
    }
    const starFitnessBefore = fitness.getFitnessForGenome(star);
    expect(starFitnessBefore).toBeGreaterThan(0.8);

    const newPop = engine.evolve('a');
    // The elite (same object/id) must still be present with its fitness intact
    const survivor = newPop.find(g => g.id === star.id);
    expect(survivor).toBeDefined();
    expect(fitness.getFitnessForGenome(survivor!)).toBeGreaterThan(0.8);
    // getStats bestFitness must be non-zero (was always 0 before the fix)
    expect(engine.getStats('a')!.bestFitness).toBeGreaterThan(0.8);
  });

  it('getBestGenome returns the genome with the highest fitness', () => {
    const engine = new EvolutionEngine(registry, fitness, { seed: 5, populationSize: 6 });
    const pop = engine.initializePopulation('a');
    const target = pop[3];
    fitness.evaluate(target, { conflictId: 'c', method: 'confidence_weighted', confidence: 0.99, reasoning: '', resolvedAt: new Date() }, { score: 0.99, primitiveResults: [], primitivesEvaluated: 1, reasoning: '' } as any);
    expect(engine.getBestGenome('a')!.id).toBe(target.id);
  });

  it('single-genome population: evolve and select do not crash', () => {
    const engine = new EvolutionEngine(registry, fitness, { seed: 2, populationSize: 1, eliteCount: 1 });
    engine.initializePopulation('a');
    expect(() => engine.evolve('a')).not.toThrow();
    expect(engine.selectResolutionGenome('a')).not.toBeNull();
  });

  it('selectResolutionGenome explores non-best genomes under exploration pressure (#451 M3)', () => {
    const engine = new EvolutionEngine(registry, fitness, { seed: 9, populationSize: 10, explorationRate: 1.0 });
    engine.initializePopulation('a');
    // With explorationRate 1.0 every pick is random — over 40 draws on a pop of
    // 10 the exploration should reach most of the population, not just the best.
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) seen.add(engine.selectResolutionGenome('a')!.id);
    expect(seen.size).toBeGreaterThanOrEqual(5);
  });

  it('never crosses over into an empty genome (verification-workflow finding)', () => {
    const engine = new EvolutionEngine(registry, fitness, { seed: 13 });
    const p1 = new ResolutionGenome({ primitives: [{ primitiveId: 'A', weight: 1 }] });
    const p2 = new ResolutionGenome({ primitives: [{ primitiveId: 'B', weight: 1 }] });
    // cut1=0 + cut2=len (=1) is the empty-child case; exercise many draws.
    for (let i = 0; i < 300; i++) {
      const child = (engine as any).crossover(p1, p2) as ResolutionGenome;
      expect(child.primitives.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('crossover can inherit the last gene of parent1 (#451 M6)', () => {
    const engine = new EvolutionEngine(registry, fitness, { seed: 3 });
    const p1 = new ResolutionGenome({ primitives: [
      { primitiveId: 'AA', weight: 1 },
      { primitiveId: 'BB', weight: 1 },
      { primitiveId: 'ZZ_LAST', weight: 1 },
    ]});
    const p2 = new ResolutionGenome({ primitives: [{ primitiveId: 'P2ONLY', weight: 1 }] });
    // Over many crossovers the exclusive tail gene of parent1 must appear at
    // least once (impossible when cuts are sampled [0, len-1]).
    let sawLast = false;
    for (let i = 0; i < 200 && !sawLast; i++) {
      const child = (engine as any).crossover(p1, p2) as ResolutionGenome;
      if (child.primitives.some(p => p.primitiveId === 'ZZ_LAST')) sawLast = true;
    }
    expect(sawLast).toBe(true);
  });

  it('mutation never empties a genome and keeps weights in range', () => {
    const engine = new EvolutionEngine(registry, fitness, { seed: 11 });
    const g = new ResolutionGenome({ primitives: [{ primitiveId: 'temporal_weight', weight: 1 }] });
    for (let i = 0; i < 100; i++) (engine as any).mutate(g);
    expect(g.primitives.length).toBeGreaterThanOrEqual(1);
    for (const p of g.primitives) {
      expect(p.weight).toBeGreaterThanOrEqual(0.1);
      expect(p.weight).toBeLessThanOrEqual(3.0);
    }
  });

  it('all-identical population still evolves without error and reports diversity', () => {
    const engine = new EvolutionEngine(registry, fitness, { seed: 4, populationSize: 6 });
    const genome = new ResolutionGenome({ primitives: [{ primitiveId: 'vote', weight: 1 }], processAreaAffinity: 'a' });
    // Force a homogeneous population
    (engine as any).populations.set('a', Array.from({ length: 6 }, () => genome.clone()));
    (engine as any).generations.set('a', 0);
    (engine as any).resolutionCounters.set('a', 0);
    expect(() => engine.evolve('a')).not.toThrow();
    const stats = engine.getStats('a')!;
    // Diversity is (unique signatures / population size); post-evolve the pop
    // is no longer perfectly homogeneous but stays a proper ratio in (0, 1].
    expect(stats.diversityScore).toBeGreaterThan(0);
    expect(stats.diversityScore).toBeLessThanOrEqual(1);
  });

  it('computeDiversity reports the concrete ratio for a homogeneous population', () => {
    const engine = new EvolutionEngine(registry, fitness, { seed: 8 });
    const g = new ResolutionGenome({ primitives: [{ primitiveId: 'vote', weight: 1 }], processAreaAffinity: 'a' });
    (engine as any).populations.set('a', Array.from({ length: 6 }, () => g.clone()));
    (engine as any).generations.set('a', 0);
    (engine as any).resolutionCounters.set('a', 0);
    // 1 unique signature across 6 identical genomes → 1/6.
    expect(engine.getStats('a')!.diversityScore).toBeCloseTo(1 / 6, 5);
  });

  it('serialize → deserialize round-trips a genome, and evaluate skips unknown primitive ids', () => {
    const g = new ResolutionGenome({
      primitives: [{ primitiveId: 'confidence_weight', weight: 1.5 }, { primitiveId: 'DOES_NOT_EXIST', weight: 2 }],
      generation: 3,
      ancestry: ['x', 'y'],
      processAreaAffinity: 'area-1',
    });
    g.recordFitness(0.7);
    const round = ResolutionGenome.deserialize(g.serialize());
    expect(round.id).toBe(g.id);
    expect(round.primitives).toEqual(g.primitives);
    expect(round.generation).toBe(3);
    expect(round.ancestry).toEqual(['x', 'y']);
    expect(round.fitnessHistory).toEqual([0.7]);

    // Unknown primitive id is silently skipped, not a crash; the known one still counts.
    const ev = round.evaluate(
      { conflict: conflict([evt({ sensorConfidence: 0.9 }), evt({ id: 'e2', value: 101, sensorConfidence: 0.8 })]) } as any,
      new PrimitiveRegistry().getMap(),
    );
    expect(ev.primitivesEvaluated).toBe(1);
    expect(Number.isFinite(ev.score)).toBe(true);
  });
});

// ─── SafetyGuard novelty budget ───────────────────────────────────────────

describe('SafetyGuard novelty budget (#451 B1)', () => {
  it('does NOT deadlock after the first experimental resolution', () => {
    const fitness = new FitnessEvaluator();
    const guard = new SafetyGuard(fitness, { noveltyBudget: 0.3, maturityGeneration: 5, confidenceFloor: 0.3 });
    const experimental = new ResolutionGenome({ id: 'exp', primitives: [], generation: 0 });
    const goodEval = { score: 0.9, primitiveResults: [], primitivesEvaluated: 1, reasoning: 'ok' };

    let allowed = 0;
    for (let i = 0; i < 100; i++) {
      const d = guard.checkResolution(experimental, goodEval as any, 'a');
      if (d.allowed) allowed++;
    }
    // The old accounting allowed exactly 1. Correct behavior lets ~30% through.
    expect(allowed).toBeGreaterThan(10);
    // And it must respect the budget ceiling (never runaway to all-allowed).
    expect(allowed).toBeLessThan(60);
    // Steady-state ratio should hover around the budget.
    expect(guard.getNoveltyRatio()).toBeLessThanOrEqual(0.35);
  });

  it('mature genomes are never novelty-blocked', () => {
    const guard = new SafetyGuard(new FitnessEvaluator(), { noveltyBudget: 0.3, maturityGeneration: 5 });
    const mature = new ResolutionGenome({ id: 'mat', primitives: [], generation: 10 });
    const goodEval = { score: 0.9, primitiveResults: [], primitivesEvaluated: 1, reasoning: 'ok' };
    for (let i = 0; i < 50; i++) {
      expect(guard.checkResolution(mature, goodEval as any, 'a').allowed).toBe(true);
    }
  });

  it('confidence floor still blocks low-confidence evolved strategies', () => {
    const guard = new SafetyGuard(new FitnessEvaluator(), { confidenceFloor: 0.3 });
    const g = new ResolutionGenome({ id: 'low', primitives: [], generation: 10 });
    const lowEval = { score: 0.1, primitiveResults: [], primitivesEvaluated: 1, reasoning: 'weak' };
    const d = guard.checkResolution(g, lowEval as any, 'a');
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/below floor/);
  });

  it('kill switch blocks everything', () => {
    const guard = new SafetyGuard(new FitnessEvaluator());
    guard.activateKillSwitch();
    const g = new ResolutionGenome({ id: 'k', primitives: [], generation: 10 });
    expect(guard.checkResolution(g, { score: 0.99, primitiveResults: [], primitivesEvaluated: 1, reasoning: '' } as any, 'a').allowed).toBe(false);
  });
});

// ─── EvolutionaryResolver end-to-end ──────────────────────────────────────

describe('EvolutionaryResolver (#451 B1/B2 integration)', () => {
  it('a genome blocked by the confidence floor records its OWN low fitness, not the static fallbacks (#451 B2)', async () => {
    // Discriminating setup: a genome that always evaluates LOW while the static
    // resolver handles the same (good-quality) conflict with HIGH confidence.
    // The B2 bug credited the blocked genome with the static HIGH confidence,
    // inverting selection. Correct behavior records the genome's own LOW score.
    const base = new ParadoxResolver();
    const resolver = new EvolutionaryResolver(base, {
      evolution: { seed: 1, populationSize: 4, explorationRate: 0 }, // always the (only) genome
      safety: { confidenceFloor: 0.9, maturityGeneration: 5 }, // floor forces a block
    });
    const fitness = resolver.getFitnessEvaluator();
    const engine = resolver.getEngine();

    // A custom primitive that always scores 0.01 → genome eval ≈ 0.01, well
    // below the 0.9 floor → always blocked.
    resolver.getRegistry().add({
      id: 'always_low',
      name: 'Always Low',
      description: 'test primitive',
      evaluate: () => ({ score: 0.01, weight: 1, reasoning: 'always low' }),
    });
    const weak = new ResolutionGenome({
      id: 'weak',
      primitives: [{ primitiveId: 'always_low', weight: 1 }],
      generation: 10,
      processAreaAffinity: 'area-1',
    });
    (engine as any).populations.set('area-1', [weak]);
    (engine as any).generations.set('area-1', 0);
    (engine as any).resolutionCounters.set('area-1', 0);

    // GOOD events → the static resolver resolves with HIGH confidence (~0.9).
    const goodEvents = [
      evt({ deviceId: 'd1', quality: 'good', sensorConfidence: 0.9 }),
      evt({ id: 'e2', deviceId: 'd2', value: 101, quality: 'good', sensorConfidence: 0.9 }),
    ];

    let out;
    for (let i = 0; i < 5; i++) {
      out = await resolver.resolveConflict(conflict(
        goodEvents.map((e, k) => ({ ...e, id: `g${i}_${k}` })),
      ));
    }

    // It was blocked (fell back to static)…
    expect(out!.usedEvolved).toBe(false);
    expect(out!.safetyDecision.allowed).toBe(false);
    // …the static fallback is highly confident on these good readings…
    expect(out!.resolution.confidence).toBeGreaterThan(0.7);
    // …but the genome's recorded fitness reflects ITS OWN weak eval, not that.
    // (Under the B2 bug this would be ~0.99 — the static confidence.)
    expect(fitness.getFitnessForGenome(weak)).toBeLessThan(0.3);
  });

  it('resolveConflict returns a valid resolution and does not throw on a fresh area', async () => {
    const base = new ParadoxResolver();
    const resolver = new EvolutionaryResolver(base, { evolution: { seed: 2, populationSize: 4 } });
    const events = [evt({ deviceId: 'd1' }), evt({ id: 'e2', deviceId: 'd2', value: 105 })];
    const out = await resolver.resolveConflict(conflict(events));
    expect(out.resolution).toBeDefined();
    expect(out.resolution.conflictId).toBeDefined();
  });

  it('evolution eventually triggers over a long run (no permanent stall) (#451 B1)', async () => {
    const base = new ParadoxResolver();
    let evolved = 0;
    const resolver = new EvolutionaryResolver(base, {
      evolution: { seed: 7, populationSize: 6, resolutionsPerCycle: 20 },
      safety: { maturityGeneration: 2, noveltyBudget: 0.3, confidenceFloor: 0.2 },
    });
    resolver.on('evolution_complete', () => { evolved++; });
    const events = [evt({ deviceId: 'd1', sensorConfidence: 0.8 }), evt({ id: 'e2', deviceId: 'd2', value: 101, sensorConfidence: 0.75 })];
    for (let i = 0; i < 200; i++) {
      await resolver.resolveConflict(conflict([
        { ...events[0], id: `a${i}` },
        { ...events[1], id: `b${i}` },
      ]));
    }
    // With blocked resolutions counting toward the cycle, generations advance.
    expect(evolved).toBeGreaterThan(0);
    const status = resolver.getStatus();
    expect(status.processAreas[0].generation).toBeGreaterThan(0);
  });
});
