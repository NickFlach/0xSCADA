/**
 * Blueprint Safe-State API (#459)
 *
 * Read-only status endpoints plus an explicit operator `resume` action for the
 * watchdog / safe-state subsystem. The deterministic runtime registers a
 * {@link Watchdog} per blueprint with the shared {@link WatchdogRegistry}
 * exported here and feeds it tick observations; this router exposes that state
 * to the operator UI and is the ONLY way to leave a safe state (no auto-resume).
 *
 * @see server/blueprint/index.ts
 */

import { Router } from "express";
import { z } from "zod";
import { fromZodError } from "zod-validation-error";
import {
  WatchdogRegistry,
  BridgeAnchorBackend,
  DrizzleSafeStateAuditSink,
} from "../blueprint";
import { logError } from "../logger";

const router = Router();

// Auth middleware placeholder — same pattern as other protected routes.
function requireAuth(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
) {
  // TODO: implement real auth check (JWT / session validation).
  next();
}
router.use(requireAuth);

// Shared registry, composed with the production anchor + audit adapters. The
// runtime imports `safeStateRegistry` to register watchdogs and report ticks.
export const safeStateRegistry = new WatchdogRegistry(
  new BridgeAnchorBackend(),
  new DrizzleSafeStateAuditSink(),
);

const resumeBodySchema = z.object({
  /** Operator identity performing the resume (audited + anchored). */
  operator: z.string().min(1),
  /** Optional reason recorded with the SafeStateExited event. */
  reason: z.string().optional(),
});

/** GET /api/blueprint-safe-state — status for every registered blueprint. */
router.get("/", (_req, res) => {
  res.json({ statuses: safeStateRegistry.getAllStatuses() });
});

/** GET /api/blueprint-safe-state/active — only blueprints in safe state. */
router.get("/active", (_req, res) => {
  res.json({ statuses: safeStateRegistry.getSafeStateStatuses() });
});

/** GET /api/blueprint-safe-state/:blueprintId — status for one blueprint. */
router.get("/:blueprintId", (req, res) => {
  const watchdog = safeStateRegistry.get(req.params.blueprintId);
  if (!watchdog) {
    res.status(404).json({ error: "blueprint watchdog not registered" });
    return;
  }
  res.json({ status: watchdog.getStatus() });
});

/**
 * POST /api/blueprint-safe-state/:blueprintId/resume
 * Explicit operator action required to leave a safe state.
 */
router.post("/:blueprintId/resume", async (req, res) => {
  const watchdog = safeStateRegistry.get(req.params.blueprintId);
  if (!watchdog) {
    res.status(404).json({ error: "blueprint watchdog not registered" });
    return;
  }

  const parsed = resumeBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: fromZodError(parsed.error).message });
    return;
  }

  try {
    const status = await watchdog.resume(parsed.data.operator, parsed.data.reason);
    res.json({ status });
  } catch (error) {
    logError(error, `Failed to resume blueprint ${req.params.blueprintId}`);
    res.status(409).json({ error: (error as Error).message });
  }
});

export const blueprintSafeStateRoutes = router;
export default router;
