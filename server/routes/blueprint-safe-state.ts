/**
 * Blueprint Safe-State API (#459)
 *
 * Read-only status endpoints plus an explicit operator `resume` action for the
 * watchdog / safe-state subsystem. The composition root in
 * server/blueprint/safety-host.ts registers a {@link Watchdog} per armed
 * blueprint with the shared {@link safeStateRegistry} and drives its ticks;
 * this router exposes that state to the operator UI and is the ONLY way to
 * leave a safe state (there is no auto-resume).
 *
 * Every response carries the host status, so an empty `statuses` array is
 * always attributable: `state: "DISABLED"` means no blueprint is loaded, which
 * is a different statement from a blueprint being loaded but unguarded.
 *
 * AUTH: the whole router requires an authenticated control-plane principal;
 * `resume` additionally requires the `safety.resume` scope, matching the
 * `safe-state-resume` entry in server/middleware/control-route-policy.ts.
 *
 * @see server/blueprint/safety-host.ts
 */

import { Router } from "express";
import { z } from "zod";
import { getBlueprintProductionSafetyStatus } from "../blueprint/production-safety";
import { blueprintSafetyHost, safeStateRegistry } from "../blueprint/safety-host";
import { logError } from "../logger";
import {
  controlPlanePrincipal,
  requireControlPlaneAccess,
} from "../middleware/control-plane-auth";

const router = Router();

router.use(requireControlPlaneAccess({ roles: ["operator"] }));
const requireSafetyResume = requireControlPlaneAccess({
  roles: ["operator"],
  scopes: ["safety.resume"],
});

const resumeBodySchema = z.object({
  /** Optional reason recorded with the SafeStateExited event. */
  reason: z.string().optional(),
});

/** GET /api/blueprint-safe-state — status for every registered blueprint. */
router.get("/", (_req, res) => {
  res.json({
    statuses: safeStateRegistry.getAllStatuses(),
    host: blueprintSafetyHost.getStatus(),
  });
});

/** GET /api/blueprint-safe-state/host — what is actually bound, and why. */
router.get("/host", (_req, res) => {
  res.json({
    host: blueprintSafetyHost.getStatus(),
    safety: getBlueprintProductionSafetyStatus(),
  });
});

/** GET /api/blueprint-safe-state/active — only blueprints in safe state. */
router.get("/active", (_req, res) => {
  res.json({
    statuses: safeStateRegistry.getSafeStateStatuses(),
    host: blueprintSafetyHost.getStatus(),
  });
});

/** GET /api/blueprint-safe-state/:blueprintId — status for one blueprint. */
router.get("/:blueprintId", (req, res) => {
  const watchdog = safeStateRegistry.get(req.params.blueprintId);
  if (!watchdog) {
    res.status(404).json({
      error: "blueprint watchdog not registered",
      host: blueprintSafetyHost.getStatus(),
    });
    return;
  }
  res.json({ status: watchdog.getStatus() });
});

/**
 * POST /api/blueprint-safe-state/:blueprintId/resume
 * Explicit operator action required to leave a safe state.
 */
router.post("/:blueprintId/resume", requireSafetyResume, async (req, res) => {
  const watchdog = safeStateRegistry.get(req.params.blueprintId);
  if (!watchdog) {
    res.status(404).json({
      error: "blueprint watchdog not registered",
      host: blueprintSafetyHost.getStatus(),
    });
    return;
  }

  const parsed = resumeBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const error = parsed.error.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ");
    res.status(400).json({ error });
    return;
  }

  try {
    const status = await watchdog.resume(
      controlPlanePrincipal(req).name,
      parsed.data.reason,
    );
    res.json({ status });
  } catch (error) {
    logError(error, `Failed to resume blueprint ${req.params.blueprintId}`);
    res.status(409).json({ error: (error as Error).message });
  }
});

export { safeStateRegistry };
export const blueprintSafeStateRoutes = router;
export default router;
