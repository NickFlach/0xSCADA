/**
 * Blueprint Control Runtime — scheduler + tick-telemetry integration (#458)
 *
 * This file owns the control-loop lifecycle from the scheduling/telemetry angle:
 * it pins the control thread to real-time scheduling at startup (or falls back),
 * drives a fixed-period tick, and measures jitter / duration / deadline misses
 * per tick, mirroring them onto the Prometheus metrics from
 * `server/metrics/blueprint.ts`.
 *
 * INTEGRATION (#457): the *deterministic* blueprint execution path (the bounded,
 * pre-allocated hot loop) is owned by the sibling "Deterministic Blueprint
 * Runtime" issue. To avoid taking a hard dependency on that branch, this file
 * defines a MINIMAL local {@link TickFn} contract: anything that executes one
 * tick of blueprint logic and returns. When #457 lands, its runtime registers
 * its tick body as a `TickFn` here (or this class is composed into it). The seam
 * is intentionally narrow so the merge is mechanical.
 *
 * @module server/blueprint/runtime
 */

import {
  TickScheduler,
  configFromEnv,
  type SchedulerConfig,
  type SchedulerStatus,
  type SchedulingMode,
  type HostProbe,
} from './scheduler.js';
import {
  TickAccountant,
  publishTickStats,
  type TickStats,
} from '../metrics/blueprint.js';
import { logInfo, logError } from '../logger.js';

// ============================================================================
// MINIMAL LOCAL RUNTIME CONTRACT (do not depend on #457's branch)
// ============================================================================

/**
 * One tick of blueprint control logic. Synchronous by contract: a real-time
 * control tick MUST NOT await — Promise micro-tasks defeat the determinism the
 * scheduler is trying to protect. (#457 enforces this in the deterministic
 * runtime; here we simply require sync execution.)
 */
export type TickFn = (tickIndex: number) => void;

export interface RuntimeOptions {
  /** Stable id for the blueprint, used as the metric label. */
  blueprintId: string;
  /** Target tick period in milliseconds (the control-loop budget). */
  periodMs: number;
  /**
   * Deadline budget in milliseconds. A tick whose body runs longer counts as a
   * missed deadline. Defaults to `periodMs` (a tick must finish within its own
   * period).
   */
  deadlineMs?: number;
  /** Rolling window (tick count) over which WCET is computed. Default 1000. */
  wcetWindow?: number;
  /** Scheduler configuration overrides. Defaults derive from env. */
  scheduler?: Partial<SchedulerConfig>;
  /** Inject a host probe (tests / non-Linux). */
  hostProbe?: HostProbe;
  /**
   * Injectable monotonic clock returning nanoseconds. Defaults to
   * `process.hrtime.bigint()`. Lets tests drive deterministic timing.
   */
  nowNs?: () => bigint;
}

export interface RuntimeHealth {
  blueprintId: string;
  running: boolean;
  schedulingMode: SchedulingMode;
  scheduler: ReturnType<TickScheduler['healthSummary']>;
  tick: TickStats;
  targetPeriodMs: number;
}

const MS_TO_NS = 1_000_000;

// ============================================================================
// BLUEPRINT RUNTIME
// ============================================================================

export class BlueprintRuntime {
  private readonly opts: Required<Omit<RuntimeOptions, 'scheduler' | 'hostProbe'>> & {
    scheduler?: Partial<SchedulerConfig>;
  };
  private readonly scheduler: TickScheduler;
  private readonly accountant: TickAccountant;
  private readonly nowNs: () => bigint;

  private timer: ReturnType<typeof setInterval> | null = null;
  private tickFn: TickFn | null = null;
  private tickIndex = 0;
  private lastTickStartNs: bigint | null = null;
  private running = false;
  private lastStats: TickStats;

  constructor(options: RuntimeOptions) {
    if (!options.blueprintId) throw new Error('blueprintId is required');
    if (!(options.periodMs > 0)) throw new Error('periodMs must be > 0');

    const periodMs = options.periodMs;
    const deadlineMs = options.deadlineMs ?? periodMs;

    this.opts = {
      blueprintId: options.blueprintId,
      periodMs,
      deadlineMs,
      wcetWindow: options.wcetWindow ?? 1000,
      nowNs: options.nowNs ?? (() => process.hrtime.bigint()),
      scheduler: options.scheduler,
    };
    this.nowNs = this.opts.nowNs;

    this.scheduler = new TickScheduler(
      options.scheduler ?? configFromEnv(),
      options.hostProbe,
    );
    this.accountant = new TickAccountant({
      targetPeriodNs: periodMs * MS_TO_NS,
      deadlineNs: deadlineMs * MS_TO_NS,
      windowSize: this.opts.wcetWindow,
    });
    this.lastStats = this.accountant.stats();
  }

  /** Register the per-tick control body. Must be called before {@link start}. */
  setTickFn(fn: TickFn): void {
    this.tickFn = fn;
  }

  /**
   * Resolve scheduler posture and begin ticking. This in-process timer never
   * supplies a dedicated control-process PID, so the scheduler must remain in
   * fallback mode and cannot elevate the Express process. A production RT
   * composition requires a separate control-process driver.
   */
  start(): SchedulerStatus {
    if (this.running) return this.scheduler.status();
    if (!this.tickFn) throw new Error('setTickFn() must be called before start()');

    const status = this.scheduler.apply();
    logInfo(
      `[runtime] blueprint '${this.opts.blueprintId}' starting in ${status.mode} mode ` +
        `(period ${this.opts.periodMs}ms, deadline ${this.opts.deadlineMs}ms)`,
    );

    this.running = true;
    this.timer = setInterval(() => this.runOneTick(), this.opts.periodMs);
    // Don't keep the process alive solely for the control loop in dev/test.
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
    return status;
  }

  /** Stop the control loop. Idempotent. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
  }

  /**
   * Execute exactly one tick: measure period jitter and execution duration,
   * run the registered control body, and publish telemetry. Exposed (not just
   * the interval callback) so a deterministic driver or test can step the loop.
   */
  runOneTick(): TickStats {
    const fn = this.tickFn;
    if (!fn) throw new Error('no tick function registered');

    const startNs = this.nowNs();
    const periodNs =
      this.lastTickStartNs === null ? undefined : Number(startNs - this.lastTickStartNs);
    this.lastTickStartNs = startNs;

    try {
      fn(this.tickIndex);
    } catch (err) {
      // A throwing control body must not crash the loop; surface and continue.
      logError(err, `[runtime] tick ${this.tickIndex} of '${this.opts.blueprintId}' threw`);
    }

    const durationNs = Number(this.nowNs() - startNs);
    this.tickIndex += 1;

    this.lastStats = publishTickStats(
      this.accountant,
      { durationNs, periodNs },
      { blueprint: this.opts.blueprintId },
    );
    return this.lastStats;
  }

  /** Current scheduling mode (mirrors the scheduler). */
  get schedulingMode(): SchedulingMode {
    return this.scheduler.mode;
  }

  /** Health snapshot for embedding in the `/health` endpoint payload. */
  health(): RuntimeHealth {
    return {
      blueprintId: this.opts.blueprintId,
      running: this.running,
      schedulingMode: this.scheduler.mode,
      scheduler: this.scheduler.healthSummary(),
      tick: this.lastStats,
      targetPeriodMs: this.opts.periodMs,
    };
  }
}
