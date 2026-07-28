/**
 * Control-Loop Sentinel Latency Probe (#460)
 *
 * The anchor pipeline instruments itself (server/integrity/anchor-pipeline.ts),
 * so the scada_control_loop_* stage series exist whenever the plant is actually
 * anchoring. This probe exists for the other half of the problem: on a quiet
 * plant there is nothing to measure, so a stalled pipeline and an idle pipeline
 * look identical. The probe flips a tag on an isolated sentinel blueprint at a
 * configurable cadence and feeds the flip into the same real pipeline, which
 * keeps the stage series alive and gives the round-trip a floor of traffic.
 *
 * IT MEASURES; IT DOES NOT SYNTHESISE
 * -----------------------------------
 * The probe produces no stage durations of its own. The batch/sign/anchor/
 * confirm numbers come from the pipeline timing its own real work. The only
 * thing the probe measures itself is the sentinel round-trip: the interval
 * between flipping the tag and the on-chain confirmation of the batch that
 * carried that flip — and it only reports it for flips that were genuinely
 * confirmed. A flip that never lands is counted, never timed.
 *
 * SAFETY
 * ------
 * - OFF by default. Enabled only by CONTROL_LOOP_LATENCY_PROBE=true.
 * - The sentinel blueprint is marked controlRelevant:false and carries a single
 *   synthetic boolean tag. The probe never writes a field tag, never actuates
 *   plant output, and never binds a network listener.
 * - Its events enter the pipeline as `sentinel.tag.flip` from the reserved
 *   source id below, so they are trivially separable from plant events.
 * - Enabling it costs one extra anchoring transaction per pipeline flush
 *   window, which is why it is opt-in rather than on by default.
 *
 * Part of the Dual-Time Control Plane (ADR-0021).
 */

import { EventEmitter } from 'events';
import type { AnchorLatencyEvent } from './anchor-pipeline';
import { registry } from '../metrics/prometheus.js';
import {
  monotonicClock,
  type Clock,
  type CounterMetric,
  type GaugeMetric,
  type HistogramMetric,
} from './stage-timestamps.js';

// ============================================================================
// SENTINEL BLUEPRINT
// ============================================================================

/**
 * A minimal, isolated sentinel blueprint. It carries exactly one boolean tag
 * that the probe flips each cycle, and is marked non-control-relevant so both
 * humans and downstream consumers can assert it is never on a control path.
 */
export interface SentinelBlueprint {
  /** Stable id, e.g. `sentinel/site-1`. */
  id: string;
  /** Owning site / deployment identity. */
  siteId: string;
  /** The single synthetic tag the probe toggles. */
  tagName: string;
  /** Current tag value (flipped each probe cycle). */
  tagValue: boolean;
  /** Always false — guardrail against use on a real control loop. */
  controlRelevant: false;
}

/** Event type used for sentinel flips entering the anchor pipeline. */
export const SENTINEL_EVENT_TYPE = 'sentinel.tag.flip';

/** Build a fresh sentinel blueprint for a site. */
export function createSentinelBlueprint(siteId: string): SentinelBlueprint {
  return {
    id: `sentinel/${siteId}`,
    siteId,
    tagName: 'sentinel_probe_tag',
    tagValue: false,
    controlRelevant: false,
  };
}

// ============================================================================
// PROBE METRICS (shared registry — server/metrics/prometheus.ts)
// ============================================================================

/**
 * Explicit liveness signal: 1 while the probe is running, 0 otherwise.
 *
 * This gauge is published at module load (see publishControlLoopProbeStatus
 * below, which server/health/index.ts calls during composition) precisely so
 * that "the probe is not running" is a value Prometheus can see. An alert on an
 * absent histogram can never fire; an alert on `... == 0` can.
 *
 * Metric name: scada_control_loop_probe_up
 */
export const probeUpGauge: GaugeMetric = registry.gauge(
  'control_loop_probe_up',
  'Whether the control-loop sentinel latency probe is running (1=up, 0=not running)',
);

/**
 * Sentinel tag flips fed into the anchor pipeline, by outcome:
 *   ingested  — accepted by the pipeline
 *   rejected  — the pipeline threw on ingest
 *   confirmed — the batch carrying the flip was confirmed on-chain
 *   dropped   — the batch carrying the flip failed or was never confirmed
 *
 * Metric name: scada_control_loop_probe_flips_total
 */
export const probeFlipsCounter: CounterMetric = registry.counter(
  'control_loop_probe_flips_total',
  'Sentinel tag flips driven into the anchor pipeline, by outcome',
  ['outcome'],
);

/**
 * Sentinel round-trip: tag flip -> on-chain confirmation of the batch carrying
 * it. Only observed for flips that were genuinely confirmed. Note this includes
 * the pipeline's batching window, which normally dominates it.
 *
 * Metric name: scada_control_loop_sentinel_roundtrip_seconds
 */
export const sentinelRoundTripHistogram: HistogramMetric = registry.histogram(
  'control_loop_sentinel_roundtrip_seconds',
  'Sentinel tag flip to on-chain confirmation of its batch, in seconds',
  [],
  [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
);

export type FlipOutcome = 'ingested' | 'rejected' | 'confirmed' | 'dropped';

// ============================================================================
// CONFIGURATION (opt-in, fail-closed)
// ============================================================================

/** Environment flag that turns the probe on. Anything else leaves it off. */
export const PROBE_ENABLED_ENV = 'CONTROL_LOOP_LATENCY_PROBE';
/** Flip cadence override, in milliseconds. */
export const PROBE_INTERVAL_ENV = 'CONTROL_LOOP_LATENCY_PROBE_INTERVAL_MS';
/** Sentinel site identity override. */
export const PROBE_SITE_ENV = 'CONTROL_LOOP_LATENCY_PROBE_SITE';

/** Default flip cadence (1 Hz, as described in the issue). */
export const DEFAULT_PROBE_INTERVAL_MS = 1000;
/** Floor on the configurable cadence so a typo cannot busy-loop the pipeline. */
export const MIN_PROBE_INTERVAL_MS = 100;

export interface LatencyProbeConfig {
  /** Sentinel site identity (label-free; used only to name the blueprint). */
  siteId: string;
  /** Flip cadence in milliseconds. */
  intervalMs: number;
  /**
   * Upper bound on flips awaiting an anchor outcome. Reaching it means the
   * pipeline is not confirming; further flips are still counted but their
   * round-trip is not tracked, so the probe cannot grow without bound.
   */
  maxPendingFlips: number;
  /** Injectable clock for round-trip measurement (tests use a fake clock). */
  clock?: Clock;
}

export const DEFAULT_PROBE_CONFIG: Omit<LatencyProbeConfig, 'clock'> = {
  siteId: 'local',
  intervalMs: DEFAULT_PROBE_INTERVAL_MS,
  maxPendingFlips: 512,
};

/**
 * Whether the operator explicitly opted the probe in. Fail-closed: any value
 * other than the exact string 'true' leaves the probe off.
 */
export function isLatencyProbeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PROBE_ENABLED_ENV] === 'true';
}

/** Read the probe's configuration from the environment, with safe defaults. */
export function readLatencyProbeConfig(env: NodeJS.ProcessEnv = process.env): LatencyProbeConfig {
  const rawInterval = Number(env[PROBE_INTERVAL_ENV]);
  const intervalMs =
    Number.isFinite(rawInterval) && rawInterval > 0
      ? Math.max(MIN_PROBE_INTERVAL_MS, Math.floor(rawInterval))
      : DEFAULT_PROBE_INTERVAL_MS;

  return {
    ...DEFAULT_PROBE_CONFIG,
    siteId: env[PROBE_SITE_ENV] || DEFAULT_PROBE_CONFIG.siteId,
    intervalMs,
  };
}

// ============================================================================
// PROBE
// ============================================================================

/**
 * The slice of the anchor pipeline the probe needs. Declared structurally so
 * the probe stays unit-testable without a chain, an HSM, or a relayer;
 * AnchorPipeline satisfies it.
 */
export interface SentinelAnchorTarget {
  ingestEvent(event: {
    id: string;
    timestamp: number;
    type: string;
    source: string;
    data: Record<string, unknown>;
  }): Promise<void>;
  on(event: 'anchor-latency', listener: (payload: AnchorLatencyEvent) => void): unknown;
  off(event: 'anchor-latency', listener: (payload: AnchorLatencyEvent) => void): unknown;
}

/**
 * Every probe currently flipping. The liveness gauge is derived from this, so
 * probe_up cannot drift from reality no matter who started the probe.
 */
const runningProbes = new Set<ControlLoopLatencyProbe>();

/**
 * Emits:
 *  - 'flip'       { eventId, sequence, tagValue }
 *  - 'flip-error' { sequence, error }
 *  - 'roundtrip'  { eventId, durationMs } — confirmed sentinel round-trips only
 *  - 'started' | 'stopped'
 */
export class ControlLoopLatencyProbe extends EventEmitter {
  private readonly config: LatencyProbeConfig;
  private readonly target: SentinelAnchorTarget;
  private readonly blueprint: SentinelBlueprint;
  private readonly clock: Clock;
  /** eventId -> flip timestamp, awaiting an anchor outcome. */
  private readonly pendingFlips = new Map<string, number>();
  private readonly onAnchorLatency: (payload: AnchorLatencyEvent) => void;
  private timer?: NodeJS.Timeout;
  private sequence = 0;

  constructor(target: SentinelAnchorTarget, config: Partial<LatencyProbeConfig> = {}) {
    super();
    this.target = target;
    this.config = {
      ...DEFAULT_PROBE_CONFIG,
      ...config,
      intervalMs: Math.max(
        MIN_PROBE_INTERVAL_MS,
        config.intervalMs && config.intervalMs > 0
          ? config.intervalMs
          : DEFAULT_PROBE_CONFIG.intervalMs,
      ),
      maxPendingFlips:
        config.maxPendingFlips && config.maxPendingFlips > 0
          ? config.maxPendingFlips
          : DEFAULT_PROBE_CONFIG.maxPendingFlips,
    };
    this.clock = config.clock ?? monotonicClock;
    this.blueprint = createSentinelBlueprint(this.config.siteId);
    this.onAnchorLatency = (payload) => this.handleAnchorLatency(payload);
  }

  get intervalMs(): number {
    return this.config.intervalMs;
  }

  isRunning(): boolean {
    return this.timer !== undefined;
  }

  getSentinelBlueprint(): SentinelBlueprint {
    return { ...this.blueprint };
  }

  /** Flips awaiting an anchor outcome (bounded by maxPendingFlips). */
  get pendingFlipCount(): number {
    return this.pendingFlips.size;
  }

  /** Start flipping the sentinel tag on a timer. */
  start(): void {
    if (this.timer) return;
    this.target.on('anchor-latency', this.onAnchorLatency);
    this.timer = setInterval(() => {
      void this.flipOnce();
    }, this.config.intervalMs);
    // A diagnostic probe must never be the sole reason the server stays alive.
    this.timer.unref?.();
    runningProbes.add(this);
    publishControlLoopProbeStatus();
    this.emit('started', { siteId: this.config.siteId, intervalMs: this.config.intervalMs });
  }

  /** Stop flipping and detach from the pipeline. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.target.off('anchor-latency', this.onAnchorLatency);
    this.pendingFlips.clear();
    runningProbes.delete(this);
    publishControlLoopProbeStatus();
    this.emit('stopped', { siteId: this.config.siteId });
  }

  /**
   * Flip the sentinel tag once and push it into the real pipeline. Exposed and
   * awaitable so tests can drive deterministic cycles without the timer.
   */
  async flipOnce(): Promise<string | null> {
    const sequence = ++this.sequence;
    this.blueprint.tagValue = !this.blueprint.tagValue;
    const eventId = `${this.blueprint.id}#${sequence}`;
    const flippedAt = this.clock();

    try {
      await this.target.ingestEvent({
        id: eventId,
        timestamp: Date.now(),
        type: SENTINEL_EVENT_TYPE,
        source: this.blueprint.id,
        data: {
          tag: this.blueprint.tagName,
          value: this.blueprint.tagValue,
          sentinel: true,
          controlRelevant: false,
        },
      });
    } catch (error) {
      probeFlipsCounter.inc({ outcome: 'rejected' });
      this.emit('flip-error', { sequence, error });
      return null;
    }

    if (this.pendingFlips.size < this.config.maxPendingFlips) {
      this.pendingFlips.set(eventId, flippedAt);
    }
    probeFlipsCounter.inc({ outcome: 'ingested' });
    this.emit('flip', { eventId, sequence, tagValue: this.blueprint.tagValue });
    return eventId;
  }

  /**
   * Close out any sentinel flips carried by an anchored batch. A confirmed
   * batch yields a measured round-trip; anything else is counted as dropped and
   * left untimed — there is no honest number for a flip that never landed.
   */
  private handleAnchorLatency(payload: AnchorLatencyEvent): void {
    const settledAt = this.clock();
    for (const eventId of payload.eventIds) {
      const flippedAt = this.pendingFlips.get(eventId);
      if (flippedAt === undefined) continue;
      this.pendingFlips.delete(eventId);

      if (payload.outcome !== 'confirmed') {
        probeFlipsCounter.inc({ outcome: 'dropped' });
        continue;
      }
      const durationMs = settledAt - flippedAt;
      if (durationMs < 0) continue; // non-monotonic clock: report nothing
      sentinelRoundTripHistogram.observe(durationMs / 1000);
      probeFlipsCounter.inc({ outcome: 'confirmed' });
      this.emit('roundtrip', { eventId, durationMs });
    }
  }
}

// ============================================================================
// COMPOSITION ROOT HELPERS
// ============================================================================

let activeProbe: ControlLoopLatencyProbe | null = null;

/**
 * Publish the probe's liveness gauge. Called at module load so the series
 * exists (as 0) on the very first scrape, and again by server/health/index.ts
 * during composition. Safe to call at any time: it reports the current state
 * rather than forcing one.
 */
export function publishControlLoopProbeStatus(): void {
  probeUpGauge.set(runningProbes.size > 0 ? 1 : 0);
}

publishControlLoopProbeStatus();

/** The running probe, if any. */
export function getControlLoopLatencyProbe(): ControlLoopLatencyProbe | null {
  return activeProbe;
}

/**
 * Start the sentinel probe against a live anchor pipeline, if and only if the
 * operator opted in. Returns null when the probe is disabled (the normal case)
 * or when there is no pipeline to drive — in both cases probe_up stays 0, which
 * is exactly what the ControlLoopProbeDown alert is written against.
 */
export function startControlLoopLatencyProbe(
  target: SentinelAnchorTarget | null,
  env: NodeJS.ProcessEnv = process.env,
): ControlLoopLatencyProbe | null {
  if (activeProbe) return activeProbe;
  if (!isLatencyProbeEnabled(env) || !target) {
    publishControlLoopProbeStatus();
    return null;
  }
  const probe = new ControlLoopLatencyProbe(target, readLatencyProbeConfig(env));
  probe.start();
  activeProbe = probe;
  return probe;
}

/** Stop and clear the process-wide probe. Idempotent. */
export function stopControlLoopLatencyProbe(): void {
  activeProbe?.stop();
  activeProbe = null;
  publishControlLoopProbeStatus();
}
