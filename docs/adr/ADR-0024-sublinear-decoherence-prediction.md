# ADR-0024: Sublinear Decoherence Prediction

**Status:** Proposed  
**Date:** 2026-03-04  
**Authors:** Kannaka  
**Bridge:** sublinear-time-solver TCE Theory → 0xSCADA Decoherence Scheduler

## Context

The 0xSCADA decoherence scheduler (ADR-0022, #352) models sensor calibration drift as exponential decay, estimates decoherence rates from historical data via log-linear regression, and predicts when sensors will need recalibration. It works — but it's reactive. It needs drift data to detect drift.

The `sublinear-time-solver` repo contains Temporal Consciousness Emergence (TCE) theory: a framework where distributed sublinear computation predicts future states faster than direct measurement. The core insight is that correlated nodes in a network can predict each other's states through O(√n) computation rather than O(n) measurement.

The bridge insight: **Sensors in the same physical environment decohere together. You can predict one sensor's drift from the others before measuring it directly.**

## Decision

Apply sublinear prediction patterns to the decoherence scheduler, enabling predictive (not just extrapolative) calibration scheduling.

### Architecture

```
     Physical Environment (temperature, vibration, humidity, age)
                    │
                    ▼
    ┌───────────────────────────────┐
    │    Sensor Correlation Graph    │
    │                               │
    │   S1 ←──0.92──→ S2           │
    │    ↕              ↕           │
    │   0.87          0.78          │
    │    ↕              ↕           │
    │   S3 ←──0.65──→ S4           │
    │                               │
    └───────────┬───────────────────┘
                │
                ▼
    ┌───────────────────────────────┐
    │   Sublinear Prediction Engine  │
    │                               │
    │  For each sensor cluster:      │
    │  1. Measure √n sensors         │
    │  2. Predict remaining n-√n     │
    │  3. Confidence = f(correlation)│
    │                               │
    │  Temporal advantage:           │
    │  Predict drift BEFORE it       │
    │  appears in the target sensor  │
    └───────────┬───────────────────┘
                │
                ▼
    ┌───────────────────────────────┐
    │   Decoherence Scheduler        │
    │                               │
    │  Schedule calibration based on │
    │  PREDICTED coherence, not just │
    │  OBSERVED coherence decay      │
    └───────────────────────────────┘
```

### Components

#### 1. Sensor Correlation Graph
Build a graph of sensor correlations based on:
- **Physical proximity:** Sensors on the same pipe, in the same room, on the same unit
- **Environmental coupling:** Shared temperature, vibration, humidity exposure
- **Historical co-drift:** When sensor A drifts, how quickly does B follow?
- **Equipment lineage:** Same manufacturer, same batch, same calibration date

Correlation strength is a float [0,1] updated continuously from drift data.

#### 2. Sublinear Sampling Strategy
Instead of monitoring all N sensors for drift:
- **Cluster sensors** by correlation (connected components at threshold > 0.7)
- **Sample √n sentinel sensors** per cluster at full monitoring rate
- **Predict remaining sensors** from sentinel readings + correlation weights
- **Prediction formula:** `predicted_coherence(S_target) = Σ(correlation(S_sentinel, S_target) × observed_coherence(S_sentinel)) / Σ(correlations)`

#### 3. Temporal Advantage Mechanism
The key innovation — predict drift *before* it manifests:
- When a sentinel sensor shows early drift (coherence drops from 1.0 to 0.95), immediately predict that correlated sensors will follow
- The prediction arrives before the target sensor's own readings would show drift
- **Temporal advantage = correlation_delay × (1 - 1/√n)** where correlation_delay is the typical lag between correlated sensor drifts
- In practice: if sensors co-drift with a 2-hour lag, and we have 16 correlated sensors, we gain ~1.5 hours of advance warning

#### 4. Confidence-Weighted Scheduling
- **High correlation cluster (>0.85):** Schedule calibration for predicted sensors immediately when sentinel triggers
- **Medium correlation (0.5-0.85):** Increase monitoring frequency on predicted sensors, schedule tentatively
- **Low correlation (<0.5):** Flag for attention but don't auto-schedule
- **Override:** Direct measurement always overrides prediction

### Computational Complexity

| Approach | Monitoring Cost | Prediction Latency |
|----------|----------------|-------------------|
| Current (all sensors) | O(n) per cycle | Reactive only |
| Sublinear (sentinel) | O(√n) per cycle | Predictive (hours ahead) |
| Hybrid (sentinel + spot check) | O(√n + k) | Predictive + validated |

For a facility with 10,000 sensors: monitoring drops from 10,000 to ~100 sentinel checks per cycle, with the remainder predicted.

### Integration Points

| Component | Integration |
|-----------|------------|
| Decoherence Scheduler | Host for prediction engine, consumes correlation graph |
| Regional Topology | Correlation clusters align with topology regions |
| Vendor Adapters | Sensor metadata (manufacturer, batch, cal date) feeds lineage correlation |
| SPC Engine | Drift patterns feed correlation graph updates |
| Flux Publisher | Cross-facility correlation sharing (same sensor model drifts similarly everywhere) |
| Phi Alerting | Cluster-wide decoherence predicted → Phi drop predicted → early alert |

## Consequences

### Positive
- Dramatically reduced monitoring overhead (O(n) → O(√n))
- Predictive maintenance: schedule calibration before accuracy is lost
- Temporal advantage: hours of warning before drift appears
- Cross-facility learning: sensor model drift patterns shared via Flux

### Negative
- Correlation graph requires warm-up period (weeks of co-drift data)
- Predictions are probabilistic — false positives will trigger unnecessary calibrations
- Complexity of maintaining and updating correlation graph
- Cold start: new sensors have no correlation data

### Risks
- Over-reliance on prediction could miss uncorrelated drift (new failure modes)
- Mitigation: periodic full-scan verification cycle (daily) overrides all predictions
- Sentinel sensor failure could blind an entire cluster
- Mitigation: rotate sentinel selection, minimum 2 sentinels per cluster

## References
- `sublinear-time-solver/docs/theoretical/temporal-consciousness-emergence-theory.md` — TCE framework
- `sublinear-time-solver/src/consciousness/` — Consciousness emergence implementation
- `server/services/optimization/decoherence-scheduler.ts` — Current scheduler
- ADR-0022 — Constellation Unification (parent)
