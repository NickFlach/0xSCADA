/**
 * Digital Twin API
 * ADR-0013 [13.3] — Issue #214
 *
 * REST surface for the digital twin runtime: model registry, simulation
 * control, live-state sync/compare, what-if scenarios, and rollback
 * simulation. Deliberately mounted at /api/twin — the mock
 * /api/intelligence/digitaltwin endpoints are a separate legacy surface.
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { fromZodError } from "zod-validation-error/v3";
import { digitalTwinService, listStepFunctions } from "../services/twin";
import type { ProcessModel, WhatIfScenario } from "@shared/types/digital-twin";

const router = Router();
const runtime = digitalTwinService.runtime;

// Auth middleware placeholder — same pattern as other protected routes
function requireAuth(req: Request, res: Response, next: NextFunction) {
  // TODO: implement real auth check (JWT / session validation)
  next();
}
router.use(requireAuth);

/** Uniform 400 for engine validation errors thrown from handlers */
function handle(fn: (req: Request, res: Response) => void) {
  return (req: Request, res: Response) => {
    try {
      fn(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.status(400).json({ error: error instanceof Error ? error.message : "Invalid request" });
      }
    }
  };
}

// ── Schemas ────────────────────────────────────────────────────────────────

const ParameterRecordSchema = z
  .record(z.number().finite())
  .refine(
    (parameters) => Object.keys(parameters).every(
      (parameter) => parameter.length >= 1 && parameter.length <= 64
    ),
    { message: "component parameter names must contain 1..64 characters" }
  )
  .refine((parameters) => Object.keys(parameters).length <= 128, {
    message: "component parameter records may contain at most 128 fields",
  });

const ComponentSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.enum(["tank", "pipe", "valve", "pump", "controller", "sensor", "heater", "mixer"]),
  name: z.string().min(1).max(256),
  config: ParameterRecordSchema.default({}),
  initialState: ParameterRecordSchema.default({}),
  connections: z.array(z.string().min(1)).max(64).default([]),
  pvSource: z.string().min(1).optional(),
});

const ModelSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  description: z.string().max(2000).optional(),
  components: z.array(ComponentSchema).min(1).max(500),
  tagBindings: z
    .array(
      z.object({
        tagId: z.string().min(1).max(256),
        componentId: z.string().min(1),
        parameter: z.string().min(1).max(64),
      })
    )
    .max(1000)
    .default([]),
  stepFunction: z.string().min(1).default("basic-flow"),
  timeStepMs: z.number().int().min(10).max(3_600_000),
});

const ModificationSchema = z.object({
  componentId: z.string().min(1),
  parameter: z.string().min(1).max(64),
  value: z.number().finite(),
  target: z.enum(["config", "state"]).optional(),
});

const ScenarioSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  baseModelId: z.string().min(1),
  modifications: z.array(ModificationSchema).max(100),
  durationTicks: z.number().int().min(1).max(100_000),
  fromLiveState: z.boolean().optional(),
});

const RollbackSchema = z.object({
  applied: z.array(ModificationSchema).min(1).max(100),
  durationTicks: z.number().int().min(1).max(100_000),
});

const StepSchema = z.object({
  ticks: z.number().int().min(1).max(10_000).default(1),
});

// ── Model registry ─────────────────────────────────────────────────────────

router.post("/models", handle((req, res) => {
  const parsed = ModelSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  const state = runtime.registerModel(parsed.data as ProcessModel);
  res.status(201).json({ model: parsed.data, state });
}));

router.get("/models", (_req, res) => {
  res.json({ models: runtime.listModels() });
});

router.get("/models/:modelId", (req, res) => {
  const model = runtime.getModel(req.params.modelId);
  if (!model) return res.status(404).json({ error: `Model ${req.params.modelId} not found` });
  res.json({ model, state: runtime.getState(req.params.modelId) });
});

router.delete("/models/:modelId", (req, res) => {
  if (!runtime.removeModel(req.params.modelId)) {
    return res.status(404).json({ error: `Model ${req.params.modelId} not found` });
  }
  res.json({ removed: true });
});

// ── Simulation control ─────────────────────────────────────────────────────

router.post("/models/:modelId/start", handle((req, res) => {
  res.json(runtime.setRunning(req.params.modelId, true));
}));

router.post("/models/:modelId/stop", handle((req, res) => {
  res.json(runtime.setRunning(req.params.modelId, false));
}));

router.post("/models/:modelId/reset", handle((req, res) => {
  res.json(runtime.resetModel(req.params.modelId));
}));

router.post("/models/:modelId/step", handle((req, res) => {
  const parsed = StepSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  res.json(runtime.step(req.params.modelId, parsed.data.ticks));
}));

router.get("/models/:modelId/state", (req, res) => {
  const state = runtime.getState(req.params.modelId);
  if (!state) return res.status(404).json({ error: `Model ${req.params.modelId} not found` });
  res.json(state);
});

// ── Live sync & comparison ─────────────────────────────────────────────────

router.post("/models/:modelId/sync", handle((req, res) => {
  res.json(runtime.syncFromLive(req.params.modelId, Date.now()));
}));

router.get("/models/:modelId/compare", handle((req, res) => {
  res.json({ comparisons: runtime.compare(req.params.modelId) });
}));

// ── What-if & rollback simulation ──────────────────────────────────────────

router.post("/scenarios", handle((req, res) => {
  const parsed = ScenarioSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  res.json(runtime.runScenario(parsed.data as WhatIfScenario));
}));

router.post("/models/:modelId/rollback-simulation", handle((req, res) => {
  const parsed = RollbackSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  res.json(
    runtime.simulateRollback(req.params.modelId, parsed.data.applied, parsed.data.durationTicks)
  );
}));

// ── Introspection ──────────────────────────────────────────────────────────

router.get("/step-functions", (_req, res) => {
  res.json({ stepFunctions: listStepFunctions() });
});

router.get("/status", async (_req, res) => {
  const health = await digitalTwinService.healthCheck();
  res.json({ ...runtime.getStatus(), ...health });
});

export { router as twinRoutes };
