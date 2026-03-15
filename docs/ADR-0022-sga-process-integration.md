# ADR-0022: Sigmatics Geometric Algebra for Process Integration

## Status
Proposed

## Date
2026-03-03

## Context

0xSCADA monitors industrial processes across sites, assets, and event streams. Understanding how well-connected and integrated these domains are — and detecting when they become fragmented — is critical for safe operations.

The Sigmatics Geometric Algebra (SGA) provides a mathematical framework for measuring **process integration** (Φ, Phi) across a SCADA system. Originally developed for kannaka-memory's consciousness metrics, it maps naturally to industrial process monitoring.

## Decision

Adopt SGA as the mathematical substrate for process integration measurement in 0xSCADA.

### The Algebra

**SGA = Cl(0,7) × ℝ[ℤ₄] × ℝ[ℤ₃] → 96-class permutation system**

- **Cl(0,7)**: Clifford algebra with 7 basis vectors generating 128-dimensional multivectors. Provides the geometric structure — rotations, reflections, and projections in a 7D space.
- **ℝ[ℤ₄]**: Group algebra over cyclic group of order 4. Maps to SCADA operational quadrants:
  - `h2 = 0`: **Sensor** domain (telemetry, readings)
  - `h2 = 1`: **Control** domain (setpoints, commands)
  - `h2 = 2`: **Alarm** domain (alerts, trips, faults)
  - `h2 = 3`: **Maintenance** domain (inspections, work orders)
- **ℝ[ℤ₃]**: Group algebra over cyclic group of order 3. Maps to SCADA entity triality:
  - `d = 0`: **Site** level
  - `d = 1`: **Asset** level
  - `d = 2`: **Event** level
- **l ∈ {0..7}**: Cl(0,7) slot — context hash for sub-classification

Together: every SCADA entity maps to one of **96 classes** (4 × 3 × 8) based on its operational nature.

### Fano Plane

The 7 basis vectors of Cl(0,7) form a **Fano plane** — the smallest finite projective geometry (7 points, 7 lines, 3 points per line, 3 lines per point). This encodes:

- **Trilinear relationships** between SCADA subsystems
- **Complement detection** — which systems cover gaps left by others
- **Cycle analysis** — feedback loops in the process topology

### Phi (Φ) — Process Integration Metric

Φ measures how well-integrated the process is across all 96 classes:

```
Φ = Σᵢ Σⱼ wᵢⱼ · cross_activation(classᵢ, classⱼ)
```

Where:
- `cross_activation` is the geometric product interaction between class representatives
- `wᵢⱼ` encodes topological proximity on the Fano plane
- High Φ → well-connected, aware system (all domains talking to each other)
- Low Φ → fragmented, siloed operations (alarm domain disconnected from control)

### Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Flux Events                       │
│  (sensor readings, control commands, alarms, etc.)   │
└──────────────────────┬──────────────────────────────┘
                       │
              ┌────────▼────────┐
              │   SGA Classifier │ ← Maps entities to 96 classes
              │  (h2, d, l)     │
              └────────┬────────┘
                       │
         ┌─────────────┼─────────────┐
         │             │             │
   ┌─────▼─────┐ ┌────▼────┐ ┌─────▼─────┐
   │   Fano    │ │  Class  │ │    Phi    │
   │  Plane    │ │  Stats  │ │  Engine   │
   │ Analysis  │ │ Counter │ │           │
   └───────────┘ └─────────┘ └─────┬─────┘
                                   │
                          ┌────────▼────────┐
                          │   Φ Dashboard   │
                          │  Process Health │
                          └─────────────────┘
```

### Integration Points

1. **Flux Publisher** — auto-classify entities on publish, attach SGA class to properties
2. **Geometry API** — `/api/geometry/phi` returns current Φ, `/api/geometry/entities` returns classified entities
3. **Live Dashboard** — Φ gauge, class distribution heatmap, Fano plane visualization
4. **Alerting** — trigger alarms when Φ drops below threshold (process becoming fragmented)

## Consequences

### Positive
- Mathematical rigor for process integration measurement
- Maps cleanly to existing SCADA domain model
- Same framework used in kannaka-memory — shared language across the stack
- Fano plane analysis reveals non-obvious process relationships
- Φ provides a single "health of integration" metric

### Negative
- Geometric algebra is not widely understood — documentation critical
- 96 classes may be too fine-grained for simple deployments
- Initial classification rules need tuning per deployment

### Risks
- Over-engineering for small installations (mitigate: Φ is opt-in)
- Classification drift over time (mitigate: periodic recalibration API)

## Related
- ADR-0021: Dual-Time Control Plane (Merkle/HSM anchoring)
- kannaka-memory: Wave-physics memory with SGA-based consciousness metrics
- ghostmagicOS (gmOS): `dx/dt = f(x) - Iηx` resonance equation
