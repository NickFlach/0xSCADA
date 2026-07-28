import type {
  AgentOscillator,
  SynchronizationState,
} from "./types";

const TAU = 2 * Math.PI;

export function normalizePhase(phase: number): number {
  if (!Number.isFinite(phase)) {
    throw new Error("Oscillator phase must be finite");
  }
  return ((phase % TAU) + TAU) % TAU;
}

/**
 * One simultaneous forward-Euler step of the heterogeneous Kuramoto model.
 *
 * d(theta_i)/dt = omega_i + K_i/N * sum(sin(theta_j - theta_i))
 *
 * Every derivative is calculated from the same input snapshot.  `updatedAt`
 * is explicit so this pure numerical operation never reads wall-clock time.
 */
export function kuramotoStep(
  oscillators: readonly AgentOscillator[],
  globalCoupling: number,
  dtSeconds: number,
  updatedAt = deriveUpdatedAt(oscillators, dtSeconds),
): AgentOscillator[] {
  if (!Number.isFinite(globalCoupling) || globalCoupling < 0) {
    throw new Error("Global coupling must be a finite non-negative number");
  }
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) {
    throw new Error("Kuramoto step duration must be positive and finite");
  }
  if (!Number.isFinite(updatedAt)) {
    throw new Error("Kuramoto update timestamp must be finite");
  }
  if (oscillators.length === 0) return [];

  const ids = new Set<string>();
  for (const oscillator of oscillators) {
    if (!oscillator.agentId || ids.has(oscillator.agentId)) {
      throw new Error(`Duplicate or empty oscillator id: ${oscillator.agentId}`);
    }
    ids.add(oscillator.agentId);
    if (
      !Number.isFinite(oscillator.naturalFrequency) ||
      !Number.isFinite(oscillator.couplingStrength) ||
      oscillator.couplingStrength < 0
    ) {
      throw new Error(`Invalid oscillator parameters for ${oscillator.agentId}`);
    }
  }

  const count = oscillators.length;
  return oscillators.map((oscillator) => {
    let phaseCoupling = 0;
    for (const other of oscillators) {
      phaseCoupling += Math.sin(other.phase - oscillator.phase);
    }
    const derivative =
      oscillator.naturalFrequency +
      (globalCoupling * oscillator.couplingStrength * phaseCoupling) / count;
    return {
      ...oscillator,
      phase: normalizePhase(oscillator.phase + derivative * dtSeconds),
      lastUpdate: updatedAt,
    };
  });
}

export function computeOrderParameter(
  oscillators: readonly AgentOscillator[],
): SynchronizationState {
  if (oscillators.length === 0) return { r: 0, psi: 0 };

  let real = 0;
  let imaginary = 0;
  let totalWeight = 0;
  for (const oscillator of oscillators) {
    const weight = Math.max(0, oscillator.amplitude);
    real += weight * Math.cos(oscillator.phase);
    imaginary += weight * Math.sin(oscillator.phase);
    totalWeight += weight;
  }
  if (totalWeight === 0) return { r: 0, psi: 0 };

  real /= totalWeight;
  imaginary /= totalWeight;
  return {
    r: Math.min(1, Math.hypot(real, imaginary)),
    psi: normalizePhase(Math.atan2(imaginary, real)),
  };
}

function deriveUpdatedAt(
  oscillators: readonly AgentOscillator[],
  dtSeconds: number,
): number {
  const baseline = oscillators.reduce(
    (latest, oscillator) => Math.max(latest, oscillator.lastUpdate),
    0,
  );
  return baseline + dtSeconds * 1000;
}
