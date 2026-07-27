/**
 * Blueprint Watchdog (#459)
 *
 * Monitors the wall-clock duration of a blueprint's deterministic control ticks
 * against a per-blueprint budget. When `consecutiveMissesBeforeSafeState`
 * consecutive ticks exceed `tickBudgetMs`, the watchdog *trips*: it halts the
 * blueprint and delegates to {@link SafeStateController} to apply the declared
 * safe state, anchor a CRITICAL `SafeStateEntered` event and audit the
 * transition.
 *
 * The miss counter is reset by any in-budget tick, so transient single-tick
 * overruns (a GC pause, a one-off scheduling hiccup) do not trip the watchdog —
 * only a *sustained* run of over-budget ticks does.
 *
 * This module is pure with respect to time: callers report observed tick
 * durations via {@link Watchdog.observeTick}. That keeps the trip logic fully
 * deterministic and unit-testable without real timers or a live runtime.
 *
 * @see server/blueprint/safe-state.ts
 */

import type { SafeStateConfig } from "@shared/schema";
import {
  SafeStateController,
  type AnchorBackend,
  type SafeStateActuator,
  type SafeStateAuditSink,
  type SafeStateStatus,
} from "./safe-state";

/** Outcome of observing a single tick. */
export interface TickObservation {
  /** Measured tick duration in milliseconds. */
  durationMs: number;
  /** True if this tick was over budget. */
  overBudget: boolean;
  /** Consecutive over-budget ticks after this observation. */
  consecutiveMisses: number;
  /** True if this observation tripped the watchdog (safe state just entered). */
  tripped: boolean;
}

/**
 * Per-blueprint watchdog. One instance per running blueprint.
 *
 * Wiring note: the deterministic runtime should call {@link observeTick} with
 * the measured duration of each completed control tick. `observeTick` is async
 * only because a trip triggers anchoring + audit; the common (in-budget) path
 * resolves synchronously.
 */
export class Watchdog {
  private consecutiveMisses = 0;
  private readonly controller: SafeStateController;
  private readonly enabled: boolean;

  constructor(
    private readonly actuator: SafeStateActuator,
    private readonly config: SafeStateConfig,
    anchor: AnchorBackend,
    audit: SafeStateAuditSink,
    now: () => Date = () => new Date(),
  ) {
    this.enabled = config.enabled;
    this.controller = new SafeStateController(actuator, config, anchor, audit, now);
  }

  /** Underlying safe-state controller (exposes resume / status to operators). */
  getController(): SafeStateController {
    return this.controller;
  }

  /** Current serialisable safe-state status for this blueprint. */
  getStatus(): SafeStateStatus {
    return this.controller.getStatus();
  }

  /** Consecutive over-budget tick count (resets on any in-budget tick). */
  getConsecutiveMisses(): number {
    return this.consecutiveMisses;
  }

  /** The blueprint this watchdog guards. */
  get blueprintId(): string {
    return this.actuator.blueprintId;
  }

  /**
   * Report the measured duration of one completed control tick.
   *
   * Returns a {@link TickObservation} describing whether the tick was over
   * budget, the running miss count, and whether this observation tripped the
   * watchdog into safe state.
   *
   * Once the blueprint is in safe state, further observations are ignored (the
   * loop should be halted anyway) until an operator resumes.
   */
  async observeTick(durationMs: number): Promise<TickObservation> {
    // Disarmed watchdog, or already safe: never (re)trip from a tick.
    if (!this.enabled || this.controller.isInSafeState()) {
      const overBudget = durationMs > this.config.tickBudgetMs;
      return {
        durationMs,
        overBudget,
        consecutiveMisses: this.consecutiveMisses,
        tripped: false,
      };
    }

    const overBudget = durationMs > this.config.tickBudgetMs;

    if (!overBudget) {
      // Any healthy tick clears the streak.
      this.consecutiveMisses = 0;
      return { durationMs, overBudget: false, consecutiveMisses: 0, tripped: false };
    }

    this.consecutiveMisses += 1;

    if (this.consecutiveMisses >= this.config.consecutiveMissesBeforeSafeState) {
      const reason =
        `${this.consecutiveMisses} consecutive ticks exceeded budget of ` +
        `${this.config.tickBudgetMs}ms (last tick ${durationMs}ms)`;
      await this.controller.enterSafeState(reason, this.consecutiveMisses);
      return {
        durationMs,
        overBudget: true,
        consecutiveMisses: this.consecutiveMisses,
        tripped: true,
      };
    }

    return {
      durationMs,
      overBudget: true,
      consecutiveMisses: this.consecutiveMisses,
      tripped: false,
    };
  }

  /**
   * Convenience wrapper: time a synchronous tick function, report its duration
   * to the watchdog, and return the function result, the observation, and
   * whether the tick was skipped.
   *
   * The tick still runs to completion before the budget is evaluated — the
   * watchdog detects budget *violations*, it does not pre-empt a tick.
   *
   * Once the blueprint is in safe state the tick is NOT executed (`skipped:
   * true`, `result: undefined`). That is the halt taking effect for callers
   * that drive the loop through this wrapper: control logic must not keep
   * recomputing outputs while the declared safe state is applied.
   */
  async runTick<T>(
    tick: () => T,
  ): Promise<{ result: T | undefined; skipped: boolean; observation: TickObservation }> {
    if (this.controller.isInSafeState()) {
      return {
        result: undefined,
        skipped: true,
        observation: {
          durationMs: 0,
          overBudget: false,
          consecutiveMisses: this.consecutiveMisses,
          tripped: false,
        },
      };
    }
    const start = performance.now();
    const result = tick();
    const durationMs = performance.now() - start;
    const observation = await this.observeTick(durationMs);
    return { result, skipped: false, observation };
  }

  /**
   * Operator-initiated resume. Clears the miss counter and exits safe state.
   * Delegates anchoring + audit to the controller.
   */
  async resume(operator: string, reason?: string): Promise<SafeStateStatus> {
    const status = await this.controller.resume(operator, reason);
    this.consecutiveMisses = 0;
    return status;
  }
}
