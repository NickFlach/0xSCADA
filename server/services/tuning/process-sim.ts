/**
 * FOPDT Process Simulation
 * ADR-0013 [13.4] — Issue #215
 *
 * First-order-plus-dead-time plant used for tuning episodes: relay
 * identification and RL exploration run against this model, never the
 * real plant (ADR-0009 — exploration happens in simulation only).
 *
 * Everything here runs on SIM time. The existing PIDAutoTuner.relayStep
 * path stamps peaks with wall-clock time, which is correct against a live
 * plant but meaningless in a fast loop — hence the separate sim-time
 * identification below.
 */

import type { EpisodeMetrics, FOPDTModel } from '@shared/types/tuning';
import { PIDController, type PIDGains } from '../optimization/pid-controller';

/** Deterministic RNG (mulberry32) so simulated noise is reproducible */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class FOPDTPlant {
  private y = 0;
  private readonly delayBuffer: number[];
  private readonly model: FOPDTModel;
  private readonly rng: (() => number) | null;

  constructor(model: FOPDTModel, dtS: number, seed = 1) {
    this.model = model;
    const delaySteps = Math.max(0, Math.round(model.deadTimeS / dtS));
    this.delayBuffer = new Array(delaySteps).fill(0);
    this.rng = model.noiseSigma ? makeRng(seed) : null;
  }

  get output(): number {
    return this.y;
  }

  /** Advance one step with control input u */
  step(u: number, dtS: number): number {
    let delayed = u;
    if (this.delayBuffer.length > 0) {
      this.delayBuffer.push(u);
      delayed = this.delayBuffer.shift()!;
    }
    const { gain, timeConstantS } = this.model;
    this.y += (dtS / timeConstantS) * (gain * delayed - this.y);
    if (this.rng) {
      // Box-Muller from two uniforms
      const u1 = Math.max(this.rng(), 1e-12);
      const u2 = this.rng();
      this.y += this.model.noiseSigma! * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }
    return this.y;
  }
}

export interface EpisodeOptions {
  setpoint: number;
  ticks: number;
  dtS: number;
  outputMin?: number;
  outputMax?: number;
  seed?: number;
}

/**
 * Run one closed-loop episode of the given gains against a FOPDT model.
 * Metrics are computed from the sim-time trajectory (the controller's
 * internal metrics are wall-clock based and unusable in a fast loop).
 */
export function runClosedLoopEpisode(
  gains: PIDGains,
  model: FOPDTModel,
  options: EpisodeOptions
): EpisodeMetrics {
  const { setpoint, ticks, dtS } = options;
  const plant = new FOPDTPlant(model, dtS, options.seed ?? 1);
  const controller = new PIDController({
    id: 'episode',
    name: 'episode',
    gains,
    setpoint,
    outputMin: options.outputMin ?? 0,
    outputMax: options.outputMax ?? 100,
    sampleTime: dtS,
  });

  let ise = 0;
  let iae = 0;
  let itae = 0;
  let peak = -Infinity;
  let settledSince: number | null = null;
  let zeroCrossings = 0;
  let prevError = setpoint - plant.output;
  const band = Math.abs(setpoint) * 0.02 || 0.02;

  for (let i = 0; i < ticks; i++) {
    const t = i * dtS;
    const pv = plant.output;
    const { output } = controller.update(pv, dtS);
    plant.step(output, dtS);

    const error = setpoint - plant.output;
    ise += error * error * dtS;
    iae += Math.abs(error) * dtS;
    itae += t * Math.abs(error) * dtS;
    if (plant.output > peak) peak = plant.output;
    if ((error > 0 && prevError < 0) || (error < 0 && prevError > 0)) zeroCrossings++;
    if (Math.abs(error) <= band) {
      if (settledSince === null) settledSince = t;
    } else {
      settledSince = null;
    }
    prevError = error;
  }

  return {
    ise,
    iae,
    itae,
    overshoot: setpoint !== 0 ? Math.max(0, (peak - setpoint) / Math.abs(setpoint)) : 0,
    settlingTimeS: settledSince,
    oscillating: zeroCrossings > 6,
  };
}

/** Ziegler-Nichols classic PID from ultimate gain and period */
export function zieglerNicholsFromUltimate(ku: number, tu: number): PIDGains {
  return { kp: 0.6 * ku, ki: (1.2 * ku) / tu, kd: 0.075 * ku * tu };
}

export interface RelayIdentification {
  ku: number;
  tu: number;
  cycles: number;
}

/**
 * Åström-Hägglund relay identification against the FOPDT model in sim
 * time: toggle a relay output around the setpoint, measure the induced
 * limit-cycle amplitude and period, and derive Ku = 4d/(π·a), Tu.
 */
export function relayIdentify(
  model: FOPDTModel,
  options: {
    setpoint: number;
    relayAmplitude: number;
    hysteresis: number;
    minCycles: number;
    dtS: number;
    maxTicks?: number;
    /** Output bias the relay toggles around */
    outputBias?: number;
  }
): RelayIdentification | null {
  const { setpoint, relayAmplitude, hysteresis, minCycles, dtS } = options;
  const maxTicks = options.maxTicks ?? 200_000;
  // Toggle around the steady-state input that holds the setpoint, so the
  // limit cycle oscillates about the setpoint for any process gain.
  const bias = options.outputBias ?? (model.gain !== 0 ? setpoint / model.gain : 0);

  const plant = new FOPDTPlant(model, dtS, 1);
  let relay = relayAmplitude;
  const peakTimes: number[] = [];
  const peakValues: number[] = [];
  const valleyValues: number[] = [];
  let rising = true;

  for (let i = 0; i < maxTicks; i++) {
    const t = i * dtS;
    const pv = plant.output;
    const error = setpoint - pv;

    if (error > hysteresis && relay < 0) relay = relayAmplitude;
    else if (error < -hysteresis && relay > 0) relay = -relayAmplitude;

    plant.step(bias + relay, dtS);

    const nextPv = plant.output;
    if (rising && nextPv < pv && pv > setpoint) {
      peakTimes.push(t);
      peakValues.push(pv);
      rising = false;
      if (peakTimes.length > minCycles) break;
    } else if (!rising && nextPv > pv && pv < setpoint) {
      valleyValues.push(pv);
      rising = true;
    }
  }

  if (peakTimes.length < 2 || valleyValues.length < 1) return null;

  const peakAvg = peakValues.reduce((a, b) => a + b, 0) / peakValues.length;
  const valleyAvg = valleyValues.reduce((a, b) => a + b, 0) / valleyValues.length;
  const amplitude = (peakAvg - valleyAvg) / 2;
  if (amplitude <= 0) return null;

  let totalPeriod = 0;
  for (let i = 1; i < peakTimes.length; i++) totalPeriod += peakTimes[i] - peakTimes[i - 1];
  const tu = totalPeriod / (peakTimes.length - 1);
  if (tu <= 0) return null;

  return {
    ku: (4 * relayAmplitude) / (Math.PI * amplitude),
    tu,
    cycles: peakTimes.length,
  };
}
