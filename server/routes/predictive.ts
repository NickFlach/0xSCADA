/**
 * Predictive Maintenance API
 * ADR-0013 [13.1] — Issue #212
 *
 * REST surface for the predictive maintenance engine: tag ingestion,
 * on-demand analysis, per-tag threshold configuration, alerts, and
 * trend-based failure prediction.
 */

import { Router } from "express";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { z } from "zod";
import { fromZodError } from "zod-validation-error";
import { predictiveMaintenanceService } from "../services/predictive";
import type { SeverityLevel } from "@shared/types/predictive";

const router = Router();
const engine = predictiveMaintenanceService.engine;

// Auth middleware placeholder — same pattern as other protected routes
function requireAuth(req: Request, res: Response, next: NextFunction) {
  // TODO: implement real auth check (JWT / session validation)
  next();
}
router.use(requireAuth);

/** Express 4 does not catch async rejections — wrap every async handler */
function asyncHandler(
  fn: (req: Request, res: Response) => Promise<unknown>
): RequestHandler {
  return (req, res) => {
    fn(req, res).catch((error) => {
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal error" });
      }
      console.error("[predictive] handler error:", error);
    });
  };
}

// ── Schemas ────────────────────────────────────────────────────────────────

/** Must match the engine's history window — larger minSamples can never be met */
const MAX_WINDOW = 1000;
/** Reject data stamped further than this into the future */
const MAX_FUTURE_SKEW_MS = 60 * 60 * 1000;
/** New tags rejected once the engine tracks this many (DoS guard) */
const MAX_TRACKED_TAGS = 500;

const IngestSchema = z.object({
  tagId: z.string().min(1).max(256),
  points: z
    .array(
      z.object({
        timestamp: z.number().finite(),
        value: z.number().finite(),
      })
    )
    .min(1)
    .max(10_000),
});

const SeveritySchema = z.enum(["info", "warning", "critical", "emergency"]);

const ThresholdsSchema = z
  .object({
    minSamples: z.number().int().min(3).max(MAX_WINDOW),
    zScoreThreshold: z.number().positive(),
    ewmaAlpha: z.number().gt(0).lte(1),
    ewmaL: z.number().positive(),
    iqrMultiplier: z.number().positive(),
    ensembleWeights: z.record(z.number().min(0).finite()),
    severityThresholds: z
      .object({
        warning: z.number().min(0).max(1),
        critical: z.number().min(0).max(1),
        emergency: z.number().min(0).max(1),
      })
      .partial(),
    failureLimits: z.object({
      low: z.number().optional(),
      high: z.number().optional(),
    }),
  })
  .partial();

const AlertQuerySchema = z.object({
  severity: SeveritySchema.optional(),
  acknowledged: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

// ── Ingestion & analysis ───────────────────────────────────────────────────

router.post(
  "/ingest",
  asyncHandler(async (req, res) => {
    const parsed = IngestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: fromZodError(parsed.error as any).message });
    }
    const { tagId, points } = parsed.data;

    const isNewTag = engine.getHistory(tagId).length === 0;
    if (isNewTag && engine.getStatus().trackedTags >= MAX_TRACKED_TAGS) {
      return res.status(429).json({
        error: `Tracked-tag limit (${MAX_TRACKED_TAGS}) reached; new tags rejected`,
      });
    }

    const cutoff = Date.now() + MAX_FUTURE_SKEW_MS;
    const usable = points.filter((p) => p.timestamp <= cutoff);
    engine.ingestSeries(tagId, usable);
    const assessment = await engine.analyze(tagId);
    res.json({
      ingested: usable.length,
      rejectedFuturePoints: points.length - usable.length,
      assessment,
    });
  })
);

// Read-only analysis — alert generation happens on ingest and in the sweep,
// never from a GET.
router.get(
  "/analyze/:tagId",
  asyncHandler(async (req, res) => {
    const assessment = await engine.analyze(req.params.tagId, { generateAlerts: false });
    if (!assessment) {
      return res.status(404).json({
        error: "Insufficient data for analysis",
        required: engine.getThresholds(req.params.tagId).minSamples,
        available: engine.getHistory(req.params.tagId).length,
      });
    }
    res.json(assessment);
  })
);

router.get(
  "/prediction/:tagId",
  asyncHandler(async (req, res) => {
    const prediction = await engine.predictFailure(req.params.tagId);
    if (!prediction) {
      return res.status(404).json({ error: "Insufficient data for prediction" });
    }
    res.json(prediction);
  })
);

// ── Tags & thresholds ──────────────────────────────────────────────────────

router.get("/tags", (_req, res) => {
  res.json({ tags: engine.getTrackedTags() });
});

router.get("/thresholds/:tagId", (req, res) => {
  res.json(engine.getThresholds(req.params.tagId));
});

router.put("/thresholds/:tagId", (req, res) => {
  const parsed = ThresholdsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error as any).message });
  }
  const overrides = parsed.data;

  // Cross-field checks run against the merged result so partial updates
  // can't sneak an inconsistent final configuration past validation.
  const current = engine.getThresholds(req.params.tagId);
  const merged = {
    ...current,
    ...overrides,
    severityThresholds: { ...current.severityThresholds, ...overrides.severityThresholds },
    failureLimits: overrides.failureLimits ?? current.failureLimits,
  };
  const { warning, critical, emergency } = merged.severityThresholds;
  if (!(warning <= critical && critical <= emergency)) {
    return res.status(400).json({
      error: "severityThresholds must satisfy warning <= critical <= emergency",
    });
  }
  if (
    merged.failureLimits?.low !== undefined &&
    merged.failureLimits?.high !== undefined &&
    merged.failureLimits.low >= merged.failureLimits.high
  ) {
    return res.status(400).json({ error: "failureLimits.low must be below failureLimits.high" });
  }
  if (overrides.ensembleWeights) {
    const known = new Set(engine.getDetectors().map((d) => d.name));
    const unknown = Object.keys(overrides.ensembleWeights).filter((k) => !known.has(k));
    if (unknown.length > 0) {
      return res.status(400).json({
        error: `Unknown detectors in ensembleWeights: ${unknown.join(", ")}`,
      });
    }
    const mergedWeights = { ...current.ensembleWeights, ...overrides.ensembleWeights };
    if (!Object.values(mergedWeights).some((w) => w > 0)) {
      return res.status(400).json({ error: "ensembleWeights must include a positive weight" });
    }
  }
  if (merged.minSamples > MAX_WINDOW) {
    return res.status(400).json({
      error: `minSamples cannot exceed the ${MAX_WINDOW}-point history window`,
    });
  }

  res.json(engine.setThresholds(req.params.tagId, overrides));
});

// ── Alerts ─────────────────────────────────────────────────────────────────

router.get("/alerts", (req, res) => {
  const parsed = AlertQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error as any).message });
  }
  const { severity, acknowledged } = parsed.data;
  res.json({
    alerts: engine.getAlerts({ severity: severity as SeverityLevel | undefined, acknowledged }),
  });
});

router.post("/alerts/:alertId/acknowledge", (req, res) => {
  const ok = engine.acknowledgeAlert(req.params.alertId);
  if (!ok) {
    return res.status(404).json({ error: `Alert ${req.params.alertId} not found` });
  }
  res.json({ acknowledged: true });
});

// ── Status ─────────────────────────────────────────────────────────────────

router.get(
  "/status",
  asyncHandler(async (_req, res) => {
    const health = await predictiveMaintenanceService.healthCheck();
    res.json({ ...engine.getStatus(), ...health });
  })
);

export { router as predictiveRoutes };
