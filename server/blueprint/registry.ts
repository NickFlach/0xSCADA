/**
 * Watchdog registry (#459).
 *
 * One {@link Watchdog} per running blueprint. The registry is the single place
 * a runtime host feeds tick observations and the API/UI reads safe-state
 * status. It lives in its own module (rather than the barrel) so the
 * composition root in ./safety-host can depend on it without an import cycle.
 */

import type { SafeStateConfig } from "@shared/schema";
import { Watchdog } from "./watchdog";
import type {
  AnchorBackend,
  SafeStateActuator,
  SafeStateAuditSink,
  SafeStateStatus,
} from "./safe-state";

export class WatchdogRegistry {
  private readonly watchdogs = new Map<string, Watchdog>();

  constructor(
    private readonly anchor: AnchorBackend,
    private readonly audit: SafeStateAuditSink,
  ) {}

  /**
   * Register (or replace) the watchdog for a blueprint. Returns the watchdog so
   * the caller can feed it tick observations.
   *
   * Fail-closed: an actuator that cannot physically apply the declared safe
   * state is rejected here, so a blueprint is never armed with a safe state it
   * could not actually enter. {@link SafeStateActuator.assertCanApply} throws in
   * that case and the caller must not start the blueprint.
   */
  register(actuator: SafeStateActuator, config: SafeStateConfig): Watchdog {
    actuator.assertCanApply(config.safeState);
    const watchdog = new Watchdog(actuator, config, this.anchor, this.audit);
    this.watchdogs.set(actuator.blueprintId, watchdog);
    return watchdog;
  }

  /** Remove a blueprint's watchdog (e.g. on blueprint stop / undeploy). */
  unregister(blueprintId: string): void {
    this.watchdogs.delete(blueprintId);
  }

  /** Get the watchdog for a blueprint, if registered. */
  get(blueprintId: string): Watchdog | undefined {
    return this.watchdogs.get(blueprintId);
  }

  /** Number of registered watchdogs (0 = no blueprint is currently armed). */
  size(): number {
    return this.watchdogs.size;
  }

  /** Registered blueprint ids, in registration order. */
  blueprintIds(): string[] {
    return [...this.watchdogs.keys()];
  }

  /** Safe-state status for every registered blueprint (for the operator UI). */
  getAllStatuses(): SafeStateStatus[] {
    return [...this.watchdogs.values()].map((w) => w.getStatus());
  }

  /** Blueprints in safe-state handling, including degraded recovery states. */
  getSafeStateStatuses(): SafeStateStatus[] {
    return this.getAllStatuses().filter((s) => s.runState !== "RUNNING");
  }
}
