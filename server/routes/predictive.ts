/**
 * Predictive Maintenance API
 * ADR-0013 [13.1] — Issue #212
 *
 * REST surface for the predictive maintenance engine: tag ingestion,
 * on-demand analysis, per-tag threshold configuration, alerts, and
 * trend-based failure prediction.
 */

import { Router } from "express";
import { z } from "zod";
import { fromZodError } from "zod-validation-error";
import { predictiveMaintenanceService } from "../services/predictive";
import type { SeverityLevel } from "@shared/types/predictive";

const router = Router();
const engine = predictiveMaintenanceService.engine;

// ── Schemas ────────────────────────────────────────────────────────────────

const IngestSchema = z.object({
  tagId: z.string().min(1),
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
    minSamples: z.number().int().min(3).max(100_000),
    zScoreThreshold: z.number().positive(),
    ewmaAlpha: z.number().gt(0).lte(1),
    ewmaL: z.number().positive(),
    iqrMultiplier: z.number().positive(),
    ensembleWeights: z.record(z.number().min(0)),
    severityThresholds: z.object({
      warning: z.number().min(0).max(1),
      critical: z.number().min(0).max(1),
      emergency: z.number().min(0).max(1),
    }),
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

router.post("/ingest", async (req, res) => {
  const parsed = IngestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  const { tagId, points } = parsed.data;
  engine.ingestSeries(tagId, points);
  const assessment = await engine.analyze(tagId);
  res.json({ ingested: points.length, assessment });
});

router.get("/analyze/:tagId", async (req, res) => {
  const assessment = await engine.analyze(req.params.tagId);
  if (!assessment) {
    return res.status(404).json({
      error: "Insufficient data for analysis",
      required: engine.getThresholds(req.params.tagId).minSamples,
      available: engine.getHistory(req.params.tagId).length,
    });
  }
  res.json(assessment);
});

router.get("/prediction/:tagId", async (req, res) => {
  const prediction = await engine.predictFailure(req.params.tagId);
  if (!prediction) {
    return res.status(404).json({ error: "Insufficient data for prediction" });
  }
  res.json(prediction);
});

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
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  const updated = engine.setThresholds(req.params.tagId, parsed.data);
  res.json(updated);
});

// ── Alerts ─────────────────────────────────────────────────────────────────

router.get("/alerts", (req, res) => {
  const parsed = AlertQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
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

router.get("/status", async (_req, res) => {
  const health = await predictiveMaintenanceService.healthCheck();
  res.json({ ...engine.getStatus(), ...health });
});

export { router as predictiveRoutes };
