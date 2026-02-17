# Resonant Scheduler with λ-Adaptive Damping

> Issue #141: [Kernel] Implement resonant scheduler with λ-adaptive damping

## Overview

A task scheduler inspired by the Kuramoto model of coupled oscillators. Tasks have natural frequencies (execution rates) and are grouped. The scheduler synchronizes tasks within groups through phase coupling while using adaptive damping to prevent oscillation.

## Kuramoto Model

The Kuramoto model describes synchronization of coupled oscillators:

```
dθ_i/dt = ω_i + (K/N) × Σ_j w_j × sin(θ_j − θ_i)
```

Where:
- `θ_i` = phase of task i
- `ω_i` = natural frequency of task i
- `K` = coupling strength
- `N` = number of tasks in group
- `w_j` = weight of task j

## λ-Adaptive Damping

To prevent runaway synchronization oscillations:

```
effective_drive = ω_natural + (raw_coupling - ω_natural) / (1 + λ)
```

λ adapts based on the Kuramoto order parameter r:
- r > target → decrease λ (system is synchronized, allow more freedom)
- r < target → increase λ (damp oscillations to find equilibrium)

```
λ(t+1) = λ(t) + α × (r_target - r(t))
λ ∈ [λ_min, λ_max]
```

## Order Parameter

The global coherence is measured by:

```
r × e^(iψ) = (1/N) × Σ e^(iθ_j)
```

- r = 1: perfect synchronization
- r = 0: completely incoherent
- Target: 0.8 (allows some phase diversity while maintaining group coordination)

## Use Cases in 0xSCADA

| Task Group | Natural Frequency | Purpose |
|-----------|-------------------|---------|
| consensus | 1 Hz | Epoch ticking |
| batching | 0.2 Hz | Event batch flushes |
| anchoring | 0.05 Hz | L2 submissions |
| monitoring | 2 Hz | Health checks |

Related tasks (e.g., batching → anchoring) naturally synchronize so batches are ready when the anchor submitter fires.

## Implementation

See `server/kernel/resonant-scheduler.ts` for the TypeScript implementation.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| couplingStrength (K) | 2.0 | Kuramoto coupling constant |
| lambda | 0.5 | Initial damping factor |
| lambdaMin | 0.01 | Minimum damping |
| lambdaMax | 5.0 | Maximum damping |
| lambdaAdaptRate | 0.1 | How fast λ adjusts |
| tickIntervalMs | 100 | Scheduler tick rate |
| coherenceTarget | 0.8 | Desired order parameter |
