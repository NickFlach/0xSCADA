/**
 * Production hold for the blueprint safe-state surface (#459).
 *
 * The watchdog and safe-state controller are usable libraries, but this
 * repository does not yet contain a composition root that binds them to a
 * deployed blueprint and a field-I/O output actuator. Exposing an empty,
 * apparently healthy API in that condition would claim an actuation guarantee
 * that does not exist.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";

export const BLUEPRINT_PRODUCTION_HOLD_CODE =
  "BLUEPRINT_CONTROL_PATH_UNBOUND" as const;

export const BLUEPRINT_PRODUCTION_HOLD_REASON =
  "Blueprint safety runtime is held: no verified deployed-blueprint, watchdog, and field-I/O actuator binding is registered." as const;

export interface BlueprintProductionSafetyStatus {
  state: "HELD";
  code: typeof BLUEPRINT_PRODUCTION_HOLD_CODE;
  reason: typeof BLUEPRINT_PRODUCTION_HOLD_REASON;
  capabilities: {
    deployedBlueprintBound: false;
    watchdogRegistered: false;
    outputActuatorBound: false;
  };
}

const HELD_STATUS: BlueprintProductionSafetyStatus = Object.freeze({
  state: "HELD",
  code: BLUEPRINT_PRODUCTION_HOLD_CODE,
  reason: BLUEPRINT_PRODUCTION_HOLD_REASON,
  capabilities: Object.freeze({
    deployedBlueprintBound: false,
    watchdogRegistered: false,
    outputActuatorBound: false,
  }),
});

export function getBlueprintProductionSafetyStatus(): BlueprintProductionSafetyStatus {
  return HELD_STATUS;
}

/** Fail closed until a verified production control path replaces this hold. */
export function createBlueprintProductionHoldMiddleware(): RequestHandler {
  return (_req: Request, res: Response, _next: NextFunction): void => {
    res.status(503).json({
      error: BLUEPRINT_PRODUCTION_HOLD_CODE,
      message: BLUEPRINT_PRODUCTION_HOLD_REASON,
      safetyRuntime: HELD_STATUS,
    });
  };
}
