import { EventEmitter } from "events";
import {
  computeOrderParameter,
  kuramotoStep,
  normalizePhase,
} from "./kuramoto";
import {
  systemClock,
  type AgentOscillator,
  type Clock,
  type ResonancePattern,
  type Signal,
  type SynchronizationState,
} from "./types";

export interface GhostOSBridgeOptions {
  clock?: Clock;
  maxSignals?: number;
  maxPatterns?: number;
  correlationThreshold?: number;
  minAlignedSamples?: number;
  alignmentMs?: number;
  globalCoupling?: number;
}

interface BucketValue {
  value: number;
  signalIds: string[];
}

/**
 * Signal and Resonance layers plus deterministic Kuramoto state.
 *
 * This class does not execute actions.  Emergence and its security gates live
 * in GhostOSOrchestrator so phase alignment cannot become authorization.
 */
export class GhostOSBridge extends EventEmitter {
  private readonly clock: Clock;
  private readonly maxSignals: number;
  private readonly maxPatterns: number;
  private readonly correlationThreshold: number;
  private readonly minAlignedSamples: number;
  private readonly alignmentMs: number;
  private globalCoupling: number;
  private readonly signalIds = new Set<string>();
  private readonly signalBuffer: Signal[] = [];
  private readonly patterns = new Map<string, ResonancePattern>();
  private readonly detectedWindows = new Set<string>();
  private readonly patternSignatures = new Map<string, string>();
  private readonly oscillators = new Map<string, AgentOscillator>();
  private patternCounter = 0;

  constructor(options: GhostOSBridgeOptions | number = {}) {
    super();
    const normalized =
      typeof options === "number" ? { maxSignals: options } : options;
    this.clock = normalized.clock ?? systemClock;
    this.maxSignals = positiveInteger(normalized.maxSignals ?? 1_000, "maxSignals");
    this.maxPatterns = positiveInteger(normalized.maxPatterns ?? 500, "maxPatterns");
    this.correlationThreshold = bounded(
      normalized.correlationThreshold ?? 0.75,
      0,
      1,
      "correlationThreshold",
    );
    this.minAlignedSamples = positiveInteger(
      normalized.minAlignedSamples ?? 4,
      "minAlignedSamples",
    );
    this.alignmentMs = positiveInteger(
      normalized.alignmentMs ?? 1_000,
      "alignmentMs",
    );
    this.globalCoupling = nonNegative(
      normalized.globalCoupling ?? 1,
      "globalCoupling",
    );
  }

  ingestSignal(input: Signal): boolean {
    validateSignal(input);
    if (this.signalIds.has(input.id)) {
      this.emit("signal-rejected", {
        signalId: input.id,
        reason: "duplicate-signal-id",
      });
      return false;
    }

    const signal: Signal = Object.freeze({
      ...input,
      metadata: input.metadata
        ? Object.freeze({ ...input.metadata })
        : Object.freeze({}),
    });
    this.signalIds.add(signal.id);
    this.signalBuffer.push(signal);
    while (this.signalBuffer.length > this.maxSignals) {
      const removed = this.signalBuffer.shift();
      if (removed) this.signalIds.delete(removed.id);
    }
    this.emit("signal", signal);
    return true;
  }

  /** Historical name retained for callers of the original issue prototype. */
  emitSignal(signal: Signal): void {
    this.ingestSignal(signal);
  }

  getSignals(source?: string): Signal[] {
    return this.signalBuffer
      .filter((signal) => source === undefined || signal.source === source)
      .map(cloneSignal);
  }

  detectResonance(windowMs = 10_000, at = this.clock.now()): ResonancePattern[] {
    positiveInteger(windowMs, "windowMs");
    if (!Number.isFinite(at)) throw new Error("Detection timestamp must be finite");
    const lowerBound = at - windowMs;
    const recent = this.signalBuffer
      .filter((signal) => signal.timestamp >= lowerBound && signal.timestamp <= at)
      .sort(compareSignals);

    const bySource = new Map<string, Signal[]>();
    for (const signal of recent) {
      const sourceSignals = bySource.get(signal.source) ?? [];
      sourceSignals.push(signal);
      bySource.set(signal.source, sourceSignals);
    }

    const sources = [...bySource.keys()].sort();
    const created: ResonancePattern[] = [];
    for (let leftIndex = 0; leftIndex < sources.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < sources.length;
        rightIndex += 1
      ) {
        const leftSource = sources[leftIndex];
        const rightSource = sources[rightIndex];
        const aligned = alignByBucket(
          bySource.get(leftSource) ?? [],
          bySource.get(rightSource) ?? [],
          this.alignmentMs,
        );
        if (aligned.values.length < this.minAlignedSamples) continue;

        const correlation = pearsonCorrelation(aligned.values);
        if (Math.abs(correlation) < this.correlationThreshold) continue;
        const firstBucket = aligned.buckets[0];
        const lastBucket = aligned.buckets[aligned.buckets.length - 1];
        const signature = [
          leftSource,
          rightSource,
          firstBucket,
          lastBucket,
          aligned.signalIds.join(","),
        ].join("|");
        if (this.detectedWindows.has(signature)) continue;
        this.detectedWindows.add(signature);

        const durationSeconds =
          ((lastBucket - firstBucket) * this.alignmentMs) / 1_000;
        const pattern: ResonancePattern = Object.freeze({
          id: `RP-${String(++this.patternCounter).padStart(6, "0")}`,
          sourceIds: Object.freeze([leftSource, rightSource]) as readonly [
            string,
            string,
          ],
          signalIds: Object.freeze([...aligned.signalIds]),
          strength: Math.abs(correlation),
          correlation,
          frequencyHz:
            durationSeconds > 0
              ? (aligned.values.length - 1) / durationSeconds
              : 0,
          phaseOffset: correlation >= 0 ? 0 : Math.PI,
          sampleCount: aligned.values.length,
          windowStart: firstBucket * this.alignmentMs,
          windowEnd: (lastBucket + 1) * this.alignmentMs,
          detectedAt: at,
        });
        this.patterns.set(pattern.id, pattern);
        this.patternSignatures.set(pattern.id, signature);
        while (this.patterns.size > this.maxPatterns) {
          const oldest = this.patterns.keys().next().value as string | undefined;
          if (!oldest) break;
          this.patterns.delete(oldest);
          const oldSignature = this.patternSignatures.get(oldest);
          if (oldSignature) this.detectedWindows.delete(oldSignature);
          this.patternSignatures.delete(oldest);
        }
        created.push(pattern);
        this.emit("resonance", pattern);
      }
    }
    return created.map(clonePattern);
  }

  getPattern(patternId: string): ResonancePattern | undefined {
    const pattern = this.patterns.get(patternId);
    return pattern ? clonePattern(pattern) : undefined;
  }

  getPatterns(): ResonancePattern[] {
    return [...this.patterns.values()].map(clonePattern);
  }

  registerAgent(config: {
    agentId: string;
    naturalFrequency: number;
    couplingStrength?: number;
    amplitude?: number;
    initialPhase?: number;
  }): AgentOscillator;
  registerAgent(
    agentId: string,
    naturalFrequency: number,
    couplingStrength?: number,
  ): AgentOscillator;
  registerAgent(
    configOrAgentId:
      | string
      | {
          agentId: string;
          naturalFrequency: number;
          couplingStrength?: number;
          amplitude?: number;
          initialPhase?: number;
        },
    legacyNaturalFrequency?: number,
    legacyCouplingStrength?: number,
  ): AgentOscillator {
    const config =
      typeof configOrAgentId === "string"
        ? {
            agentId: configOrAgentId,
            naturalFrequency: legacyNaturalFrequency as number,
            couplingStrength: legacyCouplingStrength,
          }
        : configOrAgentId;
    if (!config.agentId) throw new Error("Agent id is required");
    if (this.oscillators.has(config.agentId)) {
      throw new Error(`Agent ${config.agentId} is already registered`);
    }
    if (!Number.isFinite(config.naturalFrequency)) {
      throw new Error("Agent natural frequency must be finite");
    }
    const phase =
      config.initialPhase === undefined
        ? deterministicPhase(config.agentId)
        : normalizePhase(config.initialPhase);
    const oscillator: AgentOscillator = Object.freeze({
      agentId: config.agentId,
      naturalFrequency: config.naturalFrequency,
      couplingStrength: nonNegative(
        config.couplingStrength ?? 1,
        "couplingStrength",
      ),
      amplitude: nonNegative(config.amplitude ?? 1, "amplitude"),
      phase,
      lastUpdate: this.clock.now(),
    });
    this.oscillators.set(config.agentId, oscillator);
    this.emit("agent-registered", oscillator);
    return { ...oscillator };
  }

  unregisterAgent(agentId: string): boolean {
    return this.oscillators.delete(agentId);
  }

  hasAgent(agentId: string): boolean {
    return this.oscillators.has(agentId);
  }

  stepSynchronization(
    dtSeconds = 0.1,
    at = this.clock.now(),
  ): {
    oscillators: AgentOscillator[];
    orderParameter: SynchronizationState;
  } {
    const current = [...this.oscillators.values()].sort((left, right) =>
      left.agentId.localeCompare(right.agentId),
    );
    const updated = kuramotoStep(current, this.globalCoupling, dtSeconds, at);
    for (const oscillator of updated) {
      this.oscillators.set(oscillator.agentId, Object.freeze(oscillator));
    }
    const result = {
      oscillators: updated.map((oscillator) => ({ ...oscillator })),
      orderParameter: computeOrderParameter(updated),
    };
    this.emit("coordination", result);
    return result;
  }

  /** Historical method name retained for compatibility. */
  stepSync(dtSeconds = 0.1): {
    oscillators: AgentOscillator[];
    orderParameter: SynchronizationState;
  } {
    return this.stepSynchronization(dtSeconds);
  }

  getSynchronizationState(): SynchronizationState {
    return computeOrderParameter([...this.oscillators.values()]);
  }

  /** Historical method name retained for compatibility. */
  getSyncState(): SynchronizationState {
    return this.getSynchronizationState();
  }

  setGlobalCoupling(coupling: number): void {
    this.globalCoupling = nonNegative(coupling, "globalCoupling");
  }

  getOscillators(): AgentOscillator[] {
    return [...this.oscillators.values()]
      .sort((left, right) => left.agentId.localeCompare(right.agentId))
      .map((oscillator) => ({ ...oscillator }));
  }
}

function alignByBucket(
  left: readonly Signal[],
  right: readonly Signal[],
  alignmentMs: number,
): {
  buckets: number[];
  values: Array<readonly [number, number]>;
  signalIds: string[];
} {
  const leftBuckets = bucketSignals(left, alignmentMs);
  const rightBuckets = bucketSignals(right, alignmentMs);
  const buckets = [...leftBuckets.keys()]
    .filter((bucket) => rightBuckets.has(bucket))
    .sort((a, b) => a - b);
  const values: Array<readonly [number, number]> = [];
  const signalIds: string[] = [];
  for (const bucket of buckets) {
    const leftValue = leftBuckets.get(bucket)!;
    const rightValue = rightBuckets.get(bucket)!;
    values.push([leftValue.value, rightValue.value]);
    signalIds.push(...leftValue.signalIds, ...rightValue.signalIds);
  }
  return { buckets, values, signalIds };
}

function bucketSignals(
  signals: readonly Signal[],
  alignmentMs: number,
): Map<number, BucketValue> {
  const accumulators = new Map<number, { sum: number; ids: string[] }>();
  for (const signal of signals) {
    const bucket = Math.floor(signal.timestamp / alignmentMs);
    const accumulator = accumulators.get(bucket) ?? { sum: 0, ids: [] };
    accumulator.sum += signal.value;
    accumulator.ids.push(signal.id);
    accumulators.set(bucket, accumulator);
  }
  const result = new Map<number, BucketValue>();
  for (const [bucket, accumulator] of accumulators) {
    result.set(bucket, {
      value: accumulator.sum / accumulator.ids.length,
      signalIds: accumulator.ids.sort(),
    });
  }
  return result;
}

function pearsonCorrelation(
  pairs: readonly (readonly [number, number])[],
): number {
  if (pairs.length < 2) return 0;
  const leftMean =
    pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
  const rightMean =
    pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (const [left, right] of pairs) {
    const leftDelta = left - leftMean;
    const rightDelta = right - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta ** 2;
    rightVariance += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator === 0 ? 0 : covariance / denominator;
}

function deterministicPhase(agentId: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < agentId.length; index += 1) {
    hash ^= agentId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 0x1_0000_0000 * 2 * Math.PI;
}

function validateSignal(signal: Signal): void {
  if (!signal.id || !signal.source) {
    throw new Error("Signal id and source are required");
  }
  if (!Number.isFinite(signal.value) || !Number.isFinite(signal.timestamp)) {
    throw new Error(`Signal ${signal.id} value and timestamp must be finite`);
  }
}

function compareSignals(left: Signal, right: Signal): number {
  return (
    left.timestamp - right.timestamp ||
    left.source.localeCompare(right.source) ||
    left.id.localeCompare(right.id)
  );
}

function cloneSignal(signal: Signal): Signal {
  return {
    ...signal,
    metadata: signal.metadata ? { ...signal.metadata } : {},
  };
}

function clonePattern(pattern: ResonancePattern): ResonancePattern {
  return {
    ...pattern,
    sourceIds: [...pattern.sourceIds] as [string, string],
    signalIds: [...pattern.signalIds],
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be finite and non-negative`);
  }
  return value;
}

function bounded(value: number, min: number, max: number, name: string): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}
