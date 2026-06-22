/**
 * Blueprint watchdog & safe-state fallback (#459) — public surface.
 *
 * - {@link Watchdog}            : per-blueprint tick-budget monitor + trip logic.
 * - {@link SafeStateController} : applies / clears the declared safe state,
 *                                 anchors CRITICAL transitions, audits them.
 * - {@link WatchdogRegistry}    : tracks one watchdog per running blueprint and
 *                                 exposes status for the operator UI.
 *
 * Production adapters (anchor backend + Drizzle audit sink) live in
 * ./safe-state-adapters to keep the core dependency-free and unit-testable.
 */

import type { SafeStateConfig } from "@shared/schema";
import { Watchdog } from "./watchdog";
import type {
  AnchorBackend,
  BlueprintRuntime,
  SafeStateAuditSink,
  SafeStateStatus,
} from "./safe-state";

export * from "./safe-state";
export * from "./watchdog";
export {
  BridgeAnchorBackend,
  DrizzleSafeStateAuditSink,
} from "./safe-state-adapters";

/**
 * Registry of active blueprint watchdogs. One {@link Watchdog} is created per
 * running blueprint; the registry is the single place the runtime feeds tick
 * observations and the API/UI reads safe-state status.
 */
export class WatchdogRegistry {
  private readonly watchdogs = new Map<string, Watchdog>();

  constructor(
    private readonly anchor: AnchorBackend,
    private readonly audit: SafeStateAuditSink,
  ) {}

  /**
   * Register (or replace) the watchdog for a blueprint. Returns the watchdog so
   * the caller can feed it tick observations.
   */
  register(runtime: BlueprintRuntime, config: SafeStateConfig): Watchdog {
    const watchdog = new Watchdog(runtime, config, this.anchor, this.audit);
    this.watchdogs.set(runtime.blueprintId, watchdog);
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

  /** Safe-state status for every registered blueprint (for the operator UI). */
  getAllStatuses(): SafeStateStatus[] {
    return [...this.watchdogs.values()].map((w) => w.getStatus());
  }

  /** Only the blueprints currently running in safe state. */
  getSafeStateStatuses(): SafeStateStatus[] {
    return this.getAllStatuses().filter((s) => s.runState === "SAFE_STATE");
  }
}
