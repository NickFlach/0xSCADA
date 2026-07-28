/**
 * Predictive Maintenance API
 * ADR-0013 [13.1] — Issue #212, made durable by #546
 *
 * REST surface for the predictive maintenance engine: tag ingestion,
 * on-demand analysis, per-tag threshold configuration, alerts, and
 * trend-based failure prediction.
 *
 * ─── IDENTITY (#546, composed with the control-plane auth of #576) ──────────
 *
 * Every route that writes durable state attributes the write to
 * `controlPlanePrincipal(req).name` — the name on the server-owned API key
 * record bound by `requireControlPlaneAccess`. That helper throws if the guard
 * did not run, so an unauthenticated write cannot reach the store even if a
 * future refactor drops a guard. The request bodies below are `.strict()`, so
 * a caller that tries to supply its own `updatedBy` / `acknowledgedBy` is
 * rejected with 400 rather than having the field quietly ignored: spoofed
 * attribution fails loudly instead of looking accepted.
 *
 * ─── FAIL-CLOSED (#546) ────────────────────────────────────────────────────
 *
 * Durable state has no in-memory fallback. If the store cannot be read or
 * written, every handler here answers 503 and nothing is mutated — a threshold
 * or acknowledgement that is only in RAM is the defect this feature removed.
 */

import { Router } from "express";
import type { Request, Response, RequestHandler } from "express";
import { z } from "zod";
import { fromZodError } from "zod-validation-error";
import {
  controlPlanePrincipal,
  requireControlPlaneAccess,
} from "../middleware/control-plane-auth";
import { predictiveMaintenanceService } from "../services/predictive";
import { PredictiveStoreUnavailableError } from "../services/predictive/store";
import type { SeverityLevel } from "@shared/types/predictive";

const router = Router();
const engine = predictiveMaintenanceService.engine;
const requirePredictiveRead = requireControlPlaneAccess({
  scopes: ["predictive.read"],
});
const requirePredictiveRecommend = requireControlPlaneAccess({
  scopes: ["predictive.recommend"],
});
const requirePredictiveIngest = requireControlPlaneAccess({
  scopes: ["predictive.ingest"],
});
const requirePredictiveConfigure = requireControlPlaneAccess({
  scopes: ["predictive.configure"],
});
const requirePredictiveAcknowledge = requireControlPlaneAccess({
  scopes: ["predictive.acknowledge"],
});

/**
 * Express 4 does not catch async rejections — wrap every async handler.
 * A durable-store failure is answered 503 (fail closed and retryable) rather
 * than 500, so a caller can tell "your request was refused because state could
 * not be recorded" from "the server is broken".
 */
function asyncHandler(
  fn: (req: Request, res: Response) => Promise<unknown>
): RequestHandler {
  return (req, res) => {
    fn(req, res).catch((error) => {
      if (!res.headersSent) {
        if (error instanceof PredictiveStoreUnavailableError) {
          res.status(503).json({
            error: "Durable predictive state unavailable",
            message: error.message,
          });
        } else {
          res.status(500).json({ error: "Internal error" });
        }
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

// `.strict()`: a body carrying `updatedBy` (or any other unknown key) is
// rejected. Attribution comes from the authenticated principal only.
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
  .partial()
  .strict();

/**
 * Acknowledgement takes no body at all. Declaring it `.strict()` and empty is
 * what makes `{"acknowledgedBy":"someone-else"}` a 400 instead of a silently
 * dropped field.
 */
const AcknowledgeBodySchema = z.object({}).strict();

/** Same bound as IngestSchema.tagId and the durable `varchar(256)` column. */
const TagIdParamSchema = z.string().min(1).max(256);

const AlertQuerySchema = z.object({
  severity: SeveritySchema.optional(),
  tagId: z.string().min(1).max(256).optional(),
  acknowledged: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

// ── Ingestion & analysis ───────────────────────────────────────────────────

router.post(
  "/ingest",
  requirePredictiveIngest,
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
    // analyze() persists any alert it raises before emitting it, so a store
    // outage surfaces here as a 503 rather than as an alert nobody can
    // acknowledge later.
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
  requirePredictiveRecommend,
  asyncHandler(async (req, res) => {
    const assessment = await engine.analyze(req.params.tagId, { generateAlerts: false });
    if (!assessment) {
      const thresholds = await engine.getThresholds(req.params.tagId);
      return res.status(404).json({
        error: "Insufficient data for analysis",
        required: thresholds.minSamples,
        available: engine.getHistory(req.params.tagId).length,
      });
    }
    res.json(assessment);
  })
);

router.get(
  "/prediction/:tagId",
  requirePredictiveRecommend,
  asyncHandler(async (req, res) => {
    const prediction = await engine.predictFailure(req.params.tagId);
    if (!prediction) {
      return res.status(404).json({ error: "Insufficient data for prediction" });
    }
    res.json(prediction);
  })
);

// ── Tags & thresholds ──────────────────────────────────────────────────────

router.get("/tags", requirePredictiveRead, (_req, res) => {
  res.json({ tags: engine.getTrackedTags() });
});

/** Durably configured tags, with the principal that last wrote each one. */
router.get(
  "/configured-tags",
  requirePredictiveRead,
  asyncHandler(async (_req, res) => {
    const configured = await engine.listConfiguredTags();
    res.json({
      tags: configured.map(({ tagId, thresholds, updatedBy, updatedAt }) => ({
        tagId,
        thresholds,
        updatedBy,
        updatedAt: updatedAt.toISOString(),
      })),
    });
  })
);

router.get(
  "/thresholds/:tagId",
  requirePredictiveRead,
  asyncHandler(async (req, res) => {
    res.json(await engine.getThresholds(req.params.tagId));
  })
);

router.put(
  "/thresholds/:tagId",
  requirePredictiveConfigure,
  asyncHandler(async (req, res) => {
    // The tag id is a caller-controlled path segment that becomes a durable
    // primary key. It must be bounded HERE, at the same 256 characters the
    // ingest schema and the `varchar(256)` column use: without this an
    // over-long id is accepted on SQLite and, on PostgreSQL, is rejected by
    // the driver and surfaces as a 503 "durable state unavailable" plus a
    // `store-error` event — a caller-forged store-outage signal for what is
    // really a bad request.
    const tagIdCheck = TagIdParamSchema.safeParse(req.params.tagId);
    if (!tagIdCheck.success) {
      return res.status(400).json({ error: fromZodError(tagIdCheck.error as any).message });
    }
    const tagId = tagIdCheck.data;

    const parsed = ThresholdsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: fromZodError(parsed.error as any).message });
    }
    const overrides = parsed.data;

    // Cross-field checks run against the merged result so partial updates
    // can't sneak an inconsistent final configuration past validation.
    const current = await engine.getThresholds(tagId);
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

    // Attribution is the authenticated principal, never the request body.
    const principal = controlPlanePrincipal(req);
    res.json(await engine.setThresholds(tagId, overrides, principal.name));
  })
);

// ── Alerts ─────────────────────────────────────────────────────────────────

router.get(
  "/alerts",
  requirePredictiveRead,
  asyncHandler(async (req, res) => {
    const parsed = AlertQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: fromZodError(parsed.error as any).message });
    }
    const { severity, acknowledged, tagId, limit } = parsed.data;
    res.json({
      alerts: await engine.listAlerts({
        severity: severity as SeverityLevel | undefined,
        acknowledged,
        tagId,
        limit,
      }),
    });
  })
);

router.post(
  "/alerts/:alertId/acknowledge",
  requirePredictiveAcknowledge,
  asyncHandler(async (req, res) => {
    const parsed = AcknowledgeBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error:
          "Acknowledgement takes no body; the acknowledging identity is the "
          + "authenticated principal and cannot be supplied by the caller.",
        detail: fromZodError(parsed.error as any).message,
      });
    }

    const principal = controlPlanePrincipal(req);
    const outcome = await engine.acknowledgeAlert(req.params.alertId, principal.name);
    if (outcome.status === "not-found") {
      return res.status(404).json({ error: `Alert ${req.params.alertId} not found` });
    }
    if (outcome.status === "already-acknowledged") {
      // Conflict rather than success: the caller did not acknowledge this
      // alert, and the original attribution is what stays on the record.
      return res.status(409).json({
        error: "Alert already acknowledged",
        acknowledgedBy: outcome.alert?.acknowledgedBy ?? null,
        acknowledgedAt: outcome.alert?.acknowledgedAt ?? null,
      });
    }
    res.json({
      acknowledged: true,
      alertId: req.params.alertId,
      acknowledgedBy: outcome.alert?.acknowledgedBy ?? principal.name,
      acknowledgedAt: outcome.alert?.acknowledgedAt ?? null,
    });
  })
);

// ── Status ─────────────────────────────────────────────────────────────────

router.get(
  "/status",
  requirePredictiveRead,
  asyncHandler(async (_req, res) => {
    const health = await predictiveMaintenanceService.healthCheck();
    const hydration = predictiveMaintenanceService.getHydration();
    const inMemory = engine.getStatus();
    // Durable counts are reported best-effort: /status must still answer when
    // the store is down, because that is exactly when an operator needs to
    // see WHY their writes are being refused.
    let durable: {
      backend: string;
      configuredTags: number;
      activeAlerts: number;
      totalAlerts: number;
    } | null = null;
    try {
      durable = await engine.getDurableStatus();
    } catch {
      durable = null;
    }
    res.json({
      ...inMemory,
      ...health,
      durable: durable !== null,
      storeBackend: engine.storeBackend(),
      lastStoreError: engine.getLastStoreError(),
      hydrated: hydration !== null,
      hydration,
      configuredTags: durable?.configuredTags ?? null,
      activeAlerts: durable?.activeAlerts ?? null,
      totalAlerts: durable?.totalAlerts ?? null,
    });
  })
);

export { router as predictiveRoutes };
