/**
 * Control-Loop Latency Probe (#460)
 *
 * Drives an end-to-end synthetic round-trip through the integrity pipeline by
 * flipping a tag on a per-validator SENTINEL blueprint at a configurable
 * cadence (default 1Hz). The flip enters the pipeline at `tick`, is batched,
 * signed, anchored, and the round-trip latency is measured per stage via the
 * LatencyTrace instrument (server/integrity/stage-timestamps.ts).
 *
 * The sentinel blueprint is cheap and ISOLATED — it is explicitly NOT a
 * control-relevant blueprint. Flipping its tag has no industrial side effect;
 * it exists solely to exercise the control-loop and observe the budget
 * breakdown per stage.
 *
 * Stage execution is injected (StageExecutors) so:
 *  - production wiring supplies real pipeline/sign/anchor callbacks, and
 *  - tests supply deterministic callbacks (e.g. a 200ms delay at `sign`) and
 *    assert the per-stage histogram reflects it — all without a live
 *    blockchain, HSM, or scheduler.
 *
 * Part of the Dual-Time Control Plane (ADR-0021).
 */

import { EventEmitter } from 'events';
import {
  LatencyTrace,
  type Clock,
  type LatencyMeasurement,
} from './stage-timestamps.js';

// ============================================================================
// SENTINEL BLUEPRINT
// ============================================================================

/**
 * A minimal, isolated sentinel blueprint owned by a single validator.
 * Carries exactly one boolean tag that the probe flips each cycle. Marked
 * `controlRelevant: false` so downstream consumers (and humans) can assert it
 * is never on a control path.
 */
export interface SentinelBlueprint {
  /** Stable id, e.g. `sentinel/<validator>`. */
  id: string;
  /** Owning validator. */
  validator: string;
  /** The single synthetic tag the probe toggles. */
  tagName: string;
  /** Current tag value (flipped each probe cycle). */
  tagValue: boolean;
  /** Always false — guardrail against accidental use on a real control loop. */
  controlRelevant: false;
}

/** Build a fresh sentinel blueprint for a validator. */
export function createSentinelBlueprint(validator: string): SentinelBlueprint {
  return {
    id: `sentinel/${validator}`,
    validator,
    tagName: 'sentinel_probe_tag',
    tagValue: false,
    controlRelevant: false,
  };
}

// ============================================================================
// STAGE EXECUTORS (injected)
// ============================================================================

/**
 * Context handed to each stage executor for a single probe cycle.
 */
export interface ProbeCycleContext {
  validator: string;
  blueprint: SentinelBlueprint;
  /** Monotonic cycle counter, starting at 1. */
  sequence: number;
  /** The synthetic event payload entering the pipeline this cycle. */
  event: SentinelEvent;
}

export interface SentinelEvent {
  id: string;
  validator: string;
  tagName: string;
  tagValue: boolean;
  /** Wall-clock ms at flip time (informational; latency uses the trace clock). */
  flippedAt: number;
}

/**
 * The pipeline operations the probe drives. Each returns once its stage's work
 * is complete; the probe stamps enter/exit around each call. `anchor` is the
 * terminal stage whose completion stamps `anchor-confirmed`.
 *
 * In production these wrap the existing EventIntegrityPipeline / HSM signer /
 * AnchorRelayerService. The core probe loop does not depend on any of those
 * concrete types, keeping it unit-testable.
 */
export interface StageExecutors {
  /** Ingest the flipped tag as a SCADA event (tick stage). */
  tick(ctx: ProbeCycleContext): Promise<void>;
  /** Batch the event into a Merkle batch (batch stage). */
  batch(ctx: ProbeCycleContext): Promise<void>;
  /** Sign the batch's Merkle root via HSM (sign stage). */
  sign(ctx: ProbeCycleContext): Promise<void>;
  /** Submit + await confirmation of the anchor on-chain (anchor stage). */
  anchor(ctx: ProbeCycleContext): Promise<void>;
}

// ============================================================================
// PROBE CONFIG
// ============================================================================

export interface LatencyProbeConfig {
  /** Validator identity owning the sentinel blueprint. */
  validator: string;
  /** Flip cadence in Hz. Default 1 (one round-trip per second). */
  cadenceHz: number;
  /**
   * Optional ceiling on concurrent in-flight cycles. The default of 1 prevents
   * a slow anchor confirmation from stacking up sentinel events. Set higher to
   * pipeline cycles.
   */
  maxConcurrentCycles: number;
  /** Injectable clock for the latency traces (tests use a fake clock). */
  clock?: Clock;
}

const DEFAULT_CONFIG: Omit<LatencyProbeConfig, 'validator' | 'clock'> = {
  cadenceHz: 1,
  maxConcurrentCycles: 1,
};

// ============================================================================
// PROBE
// ============================================================================

/**
 * Emits:
 *  - 'cycle-start'    { sequence, validator }
 *  - 'measurement'    LatencyMeasurement (one per completed round-trip)
 *  - 'slo-breach'     { measurement } when any stage/total exceeds its budget
 *  - 'cycle-error'    { sequence, error }
 *  - 'started' | 'stopped'
 */
export class ControlLoopLatencyProbe extends EventEmitter {
  private readonly config: LatencyProbeConfig;
  private readonly executors: StageExecutors;
  private readonly blueprint: SentinelBlueprint;
  private timer?: NodeJS.Timeout;
  private sequence = 0;
  private inFlight = 0;

  constructor(executors: StageExecutors, config: Partial<LatencyProbeConfig> & { validator: string }) {
    super();
    this.executors = executors;
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      cadenceHz: config.cadenceHz && config.cadenceHz > 0 ? config.cadenceHz : DEFAULT_CONFIG.cadenceHz,
      maxConcurrentCycles:
        config.maxConcurrentCycles && config.maxConcurrentCycles > 0
          ? config.maxConcurrentCycles
          : DEFAULT_CONFIG.maxConcurrentCycles,
    };
    this.blueprint = createSentinelBlueprint(this.config.validator);
  }

  /** Interval between flips in milliseconds, derived from cadence. */
  get intervalMs(): number {
    return 1000 / this.config.cadenceHz;
  }

  getSentinelBlueprint(): SentinelBlueprint {
    return { ...this.blueprint };
  }

  /** Start flipping the sentinel tag on a timer. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // Skip a tick if we are at the concurrency ceiling rather than queueing
      // unbounded work — a stuck anchor stage must not amplify load.
      if (this.inFlight >= this.config.maxConcurrentCycles) return;
      void this.runCycle();
    }, this.intervalMs);
    this.emit('started', { validator: this.config.validator, cadenceHz: this.config.cadenceHz });
  }

  /** Stop the timer. In-flight cycles are allowed to finish. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.emit('stopped', { validator: this.config.validator });
  }

  /**
   * Execute a single end-to-end round-trip and return its measurement.
   * Exposed (and awaitable) so tests can drive deterministic cycles without
   * the timer. Each stage is wrapped with enter/exit stamps; the terminal
   * anchor stage's completion stamps `anchor-confirmed`.
   */
  async runCycle(): Promise<LatencyMeasurement | null> {
    this.inFlight++;
    const sequence = ++this.sequence;

    // Flip the sentinel tag.
    this.blueprint.tagValue = !this.blueprint.tagValue;
    const event: SentinelEvent = {
      id: `${this.blueprint.id}#${sequence}`,
      validator: this.config.validator,
      tagName: this.blueprint.tagName,
      tagValue: this.blueprint.tagValue,
      flippedAt: Date.now(),
    };
    const ctx: ProbeCycleContext = {
      validator: this.config.validator,
      blueprint: this.blueprint,
      sequence,
      event,
    };

    const trace = new LatencyTrace({
      traceId: event.id,
      validator: this.config.validator,
      clock: this.config.clock,
    });

    this.emit('cycle-start', { sequence, validator: this.config.validator });

    try {
      trace.mark('tick-enter');
      await this.executors.tick(ctx);
      trace.mark('tick-exit');

      trace.mark('batch-enter');
      await this.executors.batch(ctx);
      trace.mark('batch-exit');

      trace.mark('sign-enter');
      await this.executors.sign(ctx);
      trace.mark('sign-exit');

      trace.mark('anchor-enter');
      await this.executors.anchor(ctx);
      trace.mark('anchor-confirmed');

      const measurement = trace.finalize();
      this.emit('measurement', measurement);
      if (!measurement.withinSlo) {
        this.emit('slo-breach', { measurement });
      }
      return measurement;
    } catch (error) {
      this.emit('cycle-error', { sequence, error });
      return null;
    } finally {
      this.inFlight--;
    }
  }
}

// ============================================================================
// PRODUCTION WIRING (additive — see INTEGRATION notes)
// ============================================================================

/**
 * Minimal structural contracts the probe needs from the live pipeline pieces.
 * Declared locally (rather than importing concrete classes) so this module is
 * decoupled and unit-testable. The shapes match server/integrity/pipeline.ts,
 * server/integrity/hsm.ts and server/integrity/relayer.ts.
 */
export interface PipelineLike {
  ingestEvent(event: {
    id: string;
    timestamp: number;
    type: string;
    source: string;
    data: Record<string, unknown>;
  }): Promise<void>;
}

export interface SignerLike {
  sign(data: string, keyId?: string): Promise<{ signature: string; merkleRoot: string; timestamp: number }>;
}

export interface RelayerLike {
  submitAnchor(
    merkleRoot: string,
    batchId: number,
    eventCount: number,
    signatureResult: { signature: string; merkleRoot: string; timestamp: number },
    priority?: 'normal' | 'high' | 'urgent',
  ): Promise<void>;
}

/**
 * Build StageExecutors that drive the real integrity pipeline.
 *
 * INTEGRATION (#460): this is the additive seam into the existing anchor
 * pipeline. It is intentionally thin — each executor calls the corresponding
 * production method and resolves once that method completes. Because the
 * EventIntegrityPipeline and AnchorRelayerService are event-driven (batch
 * coalescing, async confirmation), a fully faithful "wait for THIS sentinel's
 * anchor to confirm" requires correlating the relayer's `anchorSuccess` event
 * back to the sentinel batch. That correlation is deferred (see TODO) and is
 * the only partial part of this file: the synthetic driver, trace, histograms,
 * dashboard, alerts, and tests are complete.
 */
export function createPipelineStageExecutors(deps: {
  pipeline: PipelineLike;
  signer: SignerLike;
  relayer: RelayerLike;
  /** Compute the sentinel batch's Merkle root for signing. */
  computeMerkleRoot: (ctx: ProbeCycleContext) => string;
}): StageExecutors {
  let lastRoot = '';
  let lastSignature: { signature: string; merkleRoot: string; timestamp: number } | null = null;

  return {
    async tick(ctx) {
      await deps.pipeline.ingestEvent({
        id: ctx.event.id,
        timestamp: ctx.event.flippedAt,
        type: 'sentinel.tag.flip',
        source: ctx.blueprint.id,
        data: { tag: ctx.event.tagName, value: ctx.event.tagValue, sentinel: true },
      });
    },
    async batch(ctx) {
      // The pipeline batches by time window; for the synthetic sentinel we
      // derive a deterministic root for this single-event batch.
      lastRoot = deps.computeMerkleRoot(ctx);
    },
    async sign() {
      lastSignature = await deps.signer.sign(lastRoot);
    },
    async anchor(ctx) {
      if (!lastSignature) throw new Error('sign stage did not run before anchor');
      // TODO(#460 integration): await the relayer's confirmation event for THIS
      // batch instead of resolving on submit. Requires threading the sentinel
      // batchId through the relayer's `anchorSuccess`/`anchorFailed` events.
      await deps.relayer.submitAnchor(lastRoot, ctx.sequence, 1, lastSignature, 'high');
    },
  };
}
