/**
 * Honest production status for the blueprint safe-state surface (#459).
 *
 * The watchdog is only as good as the actuation and registration behind it, so
 * this module reports what is *actually* bound rather than asserting that
 * safety handling is active:
 *
 *   - DISABLED — no blueprint safety bindings are configured, so no blueprint
 *                is loaded and there is nothing to guard. This is the default
 *                deployment state and is NOT a claim that safe-state handling
 *                is protecting anything.
 *   - DEGRADED — bindings were configured but at least one was refused (for
 *                example a `force-zero` safe state without the plant-output
 *                opt-in), or an armed blueprint is currently in safe state.
 *   - ACTIVE   — every configured blueprint is armed and running.
 *
 * `outputSinks` names the sink each armed actuator really drives. On current
 * main that is `runtime-tag-store` unless a deployment binds a field-output
 * sink; no wire-level output driver ships in this repository.
 */

import { blueprintSafetyHost, safeStateRegistry } from "./safety-host";

export interface BlueprintProductionSafetyStatus {
  state: "DISABLED" | "DEGRADED" | "ACTIVE";
  reason: string;
  capabilities: {
    /** At least one blueprint runtime is constructed and bound. */
    deployedBlueprintBound: boolean;
    /** At least one watchdog is registered in the shared registry. */
    watchdogRegistered: boolean;
    /** A real field-output sink is bound (none ships in this repository). */
    fieldOutputSinkBound: boolean;
    /** The sink each armed actuator drives. */
    outputSinks: string[];
  };
  registeredBlueprintIds: string[];
  /** Bindings refused at arm time, with the refusal reason. */
  rejected: Array<{ blueprintId: string; message: string }>;
  /** Armed blueprints not currently in RUNNING (safe state / recovery). */
  blueprintsNotRunning: number;
}

export function getBlueprintProductionSafetyStatus(): BlueprintProductionSafetyStatus {
  const host = blueprintSafetyHost.getStatus();
  const notRunning = safeStateRegistry.getSafeStateStatuses().length;
  const registered = safeStateRegistry.blueprintIds();

  const capabilities = {
    deployedBlueprintBound: host.registeredBlueprintIds.length > 0,
    watchdogRegistered: registered.length > 0,
    fieldOutputSinkBound: host.actuators.some((a) => a.fieldSinkBound),
    outputSinks: [...new Set(host.actuators.map((a) => a.outputSink))],
  };

  if (host.state === "DISABLED") {
    return {
      state: "DISABLED",
      reason: host.reason,
      capabilities,
      registeredBlueprintIds: registered,
      rejected: host.rejected,
      blueprintsNotRunning: notRunning,
    };
  }

  if (host.state === "FAILED" || host.rejected.length > 0 || notRunning > 0) {
    const parts = [host.reason];
    if (host.rejected.length > 0) {
      parts.push(
        `Refused bindings: ${host.rejected
          .map((entry) => `${entry.blueprintId} (${entry.message})`)
          .join("; ")}`,
      );
    }
    if (notRunning > 0) {
      parts.push(`${notRunning} armed blueprint(s) are not RUNNING.`);
    }
    return {
      state: "DEGRADED",
      reason: parts.join(" "),
      capabilities,
      registeredBlueprintIds: registered,
      rejected: host.rejected,
      blueprintsNotRunning: notRunning,
    };
  }

  return {
    state: "ACTIVE",
    reason: host.reason,
    capabilities,
    registeredBlueprintIds: registered,
    rejected: host.rejected,
    blueprintsNotRunning: notRunning,
  };
}
