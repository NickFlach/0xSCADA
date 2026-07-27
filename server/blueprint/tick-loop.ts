/**
 * Blueprint Tick Loop — scheduler + tick-telemetry integration (#458)
 *
 * Drives a fixed-period control tick and measures jitter / execution duration /
 * deadline misses per tick, mirroring them onto the Prometheus metrics in
 * `server/metrics/blueprint.ts`.
 *
 * ## Relationship to the deterministic runtime (#457) and its host
 * `server/blueprint/runtime.ts` owns the deterministic, bounded-allocation
 * blueprint *execution* (`BlueprintRuntime.tickFast()`), and
 * `server/blueprint/control-loop.ts` is its gated production host — the thing
 * composed into `server/index.ts` that loads a definition, compiles it and arms
 * a `setInterval`. This file is neither: it owns only the *timing* measurement
 * and the real-time scheduling posture, and deliberately imports neither the
 * runtime nor the host, so the three land and evolve independently. The seam is
 * the one-line {@link TickFn}:
 *
 * ```ts
 * const loop = new BlueprintTickLoop({ blueprintId: bp.id, periodMs: 10 });
 * loop.setTickFn(() => runtime.tickFast());
 * loop.start();
 * ```
 *
 * ## Scheduling
 * The loop does NOT elevate anything by itself. It asks the scheduler for a
 * decision at {@link BlueprintTickLoop.start} time, passing through whatever
 * {@link TickLoopOptions.schedulerTarget} the composition root supplied. When
 * the loop runs inside the API server process (the current deployment shape) no
 * target is available, the scheduler stays in `fallback`, and Express/WebSocket
 * are never pinned to `SCHED_FIFO`. Telemetry is emitted either way.
 *
 * @module server/blueprint/tick-loop
 */

import {
  TickScheduler,
  getScheduler,
  type DedicatedSchedulerTarget,
  type SchedulerHealthSummary,
  type SchedulerStatus,
  type SchedulingMode,
} from './scheduler.js';
import { TickAccountant, publishTickStats, type TickStats } from '../metrics/blueprint.js';
import { logInfo, logError } from '../logger.js';

/**
 * One tick of blueprint control logic. Synchronous by contract: a real-time
 * control tick MUST NOT await — Promise micro-tasks defeat the determinism the
 * scheduler is trying to protect.
 */
export type TickFn = (tickIndex: number) => void;

export interface TickLoopOptions {
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
  /**
   * Scheduler instance to consult. Defaults to the lazily-constructed
   * process-wide singleton, which is off unless `OXSCADA_RT_ENABLED=true`.
   * Injectable so tests (and a future dedicated control process) can supply
   * their own configuration and host probe.
   */
  scheduler?: TickScheduler;
  /**
   * Dedicated control-process target handed to the scheduler at `start()`.
   * Omitted by default — without it the scheduler stays in `fallback` and no
   * privileged call is made. Only a composition root that genuinely runs the
   * control loop in its own process should supply this.
   */
  schedulerTarget?: DedicatedSchedulerTarget;
  /**
   * Injectable monotonic clock returning nanoseconds. Defaults to
   * `process.hrtime.bigint()`. Lets tests drive deterministic timing.
   */
  nowNs?: () => bigint;
}

export interface TickLoopHealth {
  blueprintId: string;
  running: boolean;
  schedulingMode: SchedulingMode;
  scheduler: SchedulerHealthSummary;
  tick: TickStats;
  targetPeriodMs: number;
}

const MS_TO_NS = 1_000_000;

export class BlueprintTickLoop {
  private readonly blueprintId: string;
  private readonly periodMs: number;
  private readonly deadlineMs: number;
  private readonly schedulerTarget: DedicatedSchedulerTarget | undefined;
  private readonly scheduler: TickScheduler;
  private readonly accountant: TickAccountant;
  private readonly nowNs: () => bigint;

  private timer: ReturnType<typeof setInterval> | null = null;
  private tickFn: TickFn | null = null;
  private tickIndex = 0;
  private lastTickStartNs: bigint | null = null;
  private running = false;
  private lastStats: TickStats;

  constructor(options: TickLoopOptions) {
    if (!options.blueprintId) throw new Error('blueprintId is required');
    if (!(options.periodMs > 0)) throw new Error('periodMs must be > 0');

    this.blueprintId = options.blueprintId;
    this.periodMs = options.periodMs;
    this.deadlineMs = options.deadlineMs ?? options.periodMs;
    this.schedulerTarget = options.schedulerTarget;
    this.nowNs = options.nowNs ?? (() => process.hrtime.bigint());

    // Constructing the loop must not probe the host or touch scheduling policy;
    // `getScheduler()` is lazy and `apply()` only runs from `start()`.
    this.scheduler = options.scheduler ?? getScheduler();
    this.accountant = new TickAccountant({
      targetPeriodNs: this.periodMs * MS_TO_NS,
      deadlineNs: this.deadlineMs * MS_TO_NS,
      windowSize: options.wcetWindow ?? 1000,
    });
    this.lastStats = this.accountant.stats();
  }

  /** Register the per-tick control body. Must be called before {@link start}. */
  setTickFn(fn: TickFn): void {
    this.tickFn = fn;
  }

  /**
   * Resolve the scheduler posture and begin ticking.
   *
   * Returns the scheduler status so the caller can log/assert the mode it
   * actually got — which is `fallback` unless the deployment opted in AND
   * supplied a dedicated control-process target.
   */
  start(): SchedulerStatus {
    if (this.running) return this.scheduler.status();
    if (!this.tickFn) throw new Error('setTickFn() must be called before start()');

    const status = this.scheduler.apply(this.schedulerTarget);
    logInfo(
      `[tick-loop] blueprint '${this.blueprintId}' starting in ${status.mode} mode `
        + `(period ${this.periodMs}ms, deadline ${this.deadlineMs}ms)`,
    );

    this.running = true;
    this.timer = setInterval(() => this.runOneTick(), this.periodMs);
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
   * Execute exactly one tick: measure period jitter and execution duration, run
   * the registered control body, and publish telemetry. Exposed (not just as the
   * interval callback) so a deterministic driver or test can step the loop.
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
      logError(err, `[tick-loop] tick ${this.tickIndex} of '${this.blueprintId}' threw`);
    }

    const durationNs = Number(this.nowNs() - startNs);
    this.tickIndex += 1;

    this.lastStats = publishTickStats(
      this.accountant,
      { durationNs, periodNs },
      { blueprint: this.blueprintId },
    );
    return this.lastStats;
  }

  /** Current scheduling mode (mirrors the scheduler). */
  get schedulingMode(): SchedulingMode {
    return this.scheduler.mode;
  }

  /** Health snapshot for embedding in the `/health` endpoint payload. */
  health(): TickLoopHealth {
    return {
      blueprintId: this.blueprintId,
      running: this.running,
      schedulingMode: this.scheduler.mode,
      scheduler: this.scheduler.healthSummary(),
      tick: this.lastStats,
      targetPeriodMs: this.periodMs,
    };
  }
}
