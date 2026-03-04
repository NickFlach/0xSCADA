# ADR-0023: Evolutionary Paradox Resolution

**Status:** Proposed  
**Date:** 2026-03-04  
**Authors:** Kannaka  
**Bridge:** ParadoxResolver → 0xSCADA Paradox Resolution Engine

## Context

The 0xSCADA paradox resolution engine (ADR-0022, #346) resolves conflicting sensor readings using four static strategies: temporal priority, sensor confidence weighting, voting with quorum, and physics-based arbitration. The strategy is selected per process area via configuration.

Meanwhile, the `ParadoxResolver` repo implements a fundamentally different approach: an **evolutionary engine** where transformation rules are encoded as genomes that mutate, crossover, and evolve over generations using genetic programming. Rules that resolve paradoxes more effectively (measured by convergence speed, stability, and delta magnitude) survive; weak rules die off.

The bridge insight: **SCADA conflict resolution strategies should evolve based on what actually works in each process area, not be statically configured.**

## Decision

Integrate ParadoxResolver's evolutionary engine pattern into the 0xSCADA paradox resolver, enabling resolution strategies to self-improve over time.

### Architecture

```
                    ┌─────────────────────────────┐
                    │   Evolutionary Strategy Pool  │
                    │                               │
                    │  ┌─────────┐  ┌─────────┐   │
                    │  │ Gen N   │  │ Gen N+1 │   │
                    │  │ Rules   │→ │ Rules   │   │
                    │  └─────────┘  └─────────┘   │
                    │       ↑            ↑         │
                    │    fitness      mutate/       │
                    │    scores      crossover      │
                    └───────┬─────────────┬────────┘
                            │             │
                    ┌───────┴─────────────┴────────┐
                    │    Paradox Resolution Engine   │
                    │                               │
  Conflicting  ──→  │  1. Detect paradox type       │ ──→  Resolved
  Events            │  2. Select strategy (evolved)  │      Events
                    │  3. Resolve + score confidence │
                    │  4. Feed fitness back          │
                    └───────────────────────────────┘
```

### Components

#### 1. Resolution Genome (`ResolutionGenome`)
Encodes a resolution strategy as a composable sequence of primitives:
- **Primitives:** temporal_weight, confidence_weight, vote, physics_check, history_bias, neighbor_correlation, rate_filter
- **Composition:** Weighted pipeline — each primitive contributes a partial resolution, blended by evolved weights
- **Metadata:** Generation, ancestry, fitness history, process area affinity

#### 2. Fitness Function
The fitness function is already implicit in the existing system — **resolution confidence scores**:
- High confidence + correct resolution (validated by subsequent readings) = high fitness
- Low confidence or contradicted by future data = low fitness
- Bonus for speed (fewer primitives evaluated)
- Penalty for false positives (resolved "correctly" but physics says impossible)

#### 3. Evolution Cycle
- **Population:** 20-50 strategy genomes per process area
- **Selection:** Tournament selection (k=3) weighted by recent fitness
- **Crossover:** Swap primitive subsequences between two parent strategies
- **Mutation:** Add/remove/reweight primitives (rate: 0.15)
- **Elitism:** Top 2 strategies always survive
- **Cycle trigger:** Every N resolved paradoxes (configurable, default 100) or on schedule

#### 4. Safety Constraints
- **Floor strategies:** The four original static strategies are immortal — they can never be evolved away
- **Confidence floor:** If an evolved strategy produces confidence < 0.3, fall back to best static strategy
- **Novelty budget:** Maximum 30% of resolutions can use experimental (gen < 5) strategies
- **Audit trail:** Every evolved strategy decision logged to explainability monitor (CFR 21 Part 11)

### Integration Points

| Component | Integration |
|-----------|------------|
| Paradox Resolver | Host for evolved strategies, feeds fitness scores |
| Explainability Monitor | Logs evolved strategy decisions with full genome lineage |
| Governance Gates | New evolved strategies require gate approval before production use |
| Verification Pipeline | Validates evolved strategy outputs against physics constraints |
| Flux Publisher | Publishes strategy evolution events for cross-site learning |

### Cross-Site Evolution (Future)
Via Flux Universe, evolved strategies from one facility can be shared:
- Publish top-performing genomes as SingularisPrime events
- Other facilities can import and evaluate them
- Federated evolution across the constellation

## Consequences

### Positive
- Resolution strategies improve automatically based on real operational data
- Different process areas naturally evolve specialized strategies
- Novel resolution approaches can emerge that humans wouldn't design
- Continuous improvement without manual tuning

### Negative
- Harder to predict exactly how conflicts will be resolved
- Evolution requires sufficient paradox volume to drive selection pressure
- Computational overhead of maintaining and evaluating populations
- Regulatory review needed for evolved strategies in safety-critical systems

### Risks
- Evolved strategies could overfit to specific sensor failure modes
- Mitigation: periodic genome diversity injection + immortal floor strategies
- In safety-critical areas, governance gates should require human approval for new genomes

## References
- `ParadoxResolver/evolutionary_engine.py` — Genetic programming engine
- `ParadoxResolver/meta_resolver.py` — Phase-based resolution with convergence/divergence
- `server/services/integrity/paradox-resolver.ts` — Current static resolver
- ADR-0022 — Constellation Unification (parent)
