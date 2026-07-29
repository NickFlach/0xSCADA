/**
 * Digital Twin API
 * ADR-0013 [13.3] — Issue #214
 *
 * REST surface for the digital twin runtime: model registry, simulation
 * control, live-state sync/compare, what-if scenarios, and rollback
 * simulation. Deliberately mounted at /api/twin — the mock
 * /api/intelligence/digitaltwin endpoints are a separate legacy surface.
 *
 * #550: the model registry and committed checkpoints are durable. Model
 * create/delete and checkpoint commits go through the twin service, which
 * keeps storage and the in-memory registry in one transaction; the simulation
 * control routes below stay purely in-memory and only become durable when a
 * caller commits a checkpoint. See docs/api/twin-persistence.md.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { fromZodError } from "zod-validation-error/v3";
import { requireControlPlaneAccess } from "../middleware/control-plane-auth";
import {
  digitalTwinService,
  listStepFunctions,
  TwinPersistenceError,
} from "../services/twin";
import type { ProcessModel, WhatIfScenario } from "@shared/types/digital-twin";

const router = Router();
const runtime = digitalTwinService.runtime;

const requireTwinRead = requireControlPlaneAccess({
  scopes: ["twin.read"],
});
const requireTwinSimulation = requireControlPlaneAccess({
  scopes: ["twin.simulate"],
});
const requireTwinConfigure = requireControlPlaneAccess({
  scopes: ["twin.configure"],
});
const requireTwinOperate = requireControlPlaneAccess({
  scopes: ["twin.operate"],
});

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

/**
 * Same, for handlers that touch durable storage (#550). A storage failure is a
 * 503 rather than a 400: the request was well-formed, the twin simply refused
 * to hold state it could not durably store, so the caller should retry rather
 * than rewrite the request.
 */
function handleAsync(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((error: unknown) => {
      if (res.headersSent) return;
      const message = error instanceof Error ? error.message : "Invalid request";
      const status = error instanceof TwinPersistenceError ? 503 : 400;
      res.status(status).json({ error: message });
    });
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

// Registration is durable (#550): the definition and its initial checkpoint
// are committed in the same transaction as the in-memory registration, so a
// storage failure leaves neither behind.
router.post("/models", requireTwinConfigure, handleAsync(async (req, res) => {
  const parsed = ModelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: fromZodError(parsed.error).message });
    return;
  }
  const state = await digitalTwinService.registerModel(parsed.data as ProcessModel);
  res.status(201).json({ model: parsed.data, state });
}));

router.get("/models", requireTwinRead, (_req, res) => {
  res.json({ models: runtime.listModels() });
});

router.get("/models/:modelId", requireTwinRead, (req, res) => {
  const model = runtime.getModel(req.params.modelId);
  if (!model) return res.status(404).json({ error: `Model ${req.params.modelId} not found` });
  res.json({ model, state: runtime.getState(req.params.modelId) });
});

router.delete("/models/:modelId", requireTwinConfigure, handleAsync(async (req, res) => {
  if (!(await digitalTwinService.removeModel(req.params.modelId))) {
    res.status(404).json({ error: `Model ${req.params.modelId} not found` });
    return;
  }
  res.json({ removed: true });
}));

// ── Simulation control ─────────────────────────────────────────────────────

router.post("/models/:modelId/start", requireTwinOperate, handle((req, res) => {
  res.json(runtime.setRunning(req.params.modelId, true));
}));

router.post("/models/:modelId/stop", requireTwinOperate, handle((req, res) => {
  res.json(runtime.setRunning(req.params.modelId, false));
}));

router.post("/models/:modelId/reset", requireTwinOperate, handle((req, res) => {
  res.json(runtime.resetModel(req.params.modelId));
}));

router.post("/models/:modelId/step", requireTwinOperate, handle((req, res) => {
  const parsed = StepSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  res.json(runtime.step(req.params.modelId, parsed.data.ticks));
}));

router.get("/models/:modelId/state", requireTwinRead, (req, res) => {
  const state = runtime.getState(req.params.modelId);
  if (!state) return res.status(404).json({ error: `Model ${req.params.modelId} not found` });
  res.json(state);
});

/**
 * Commit the model's current simulation state as its durable checkpoint (#550)
 * — the state a restart would restore. The restored simulation always comes
 * back idle, whatever it was doing when the checkpoint was taken; only an
 * explicit start or step resumes it.
 */
router.post("/models/:modelId/checkpoint", requireTwinOperate, handleAsync(async (req, res) => {
  res.json({ checkpoint: await digitalTwinService.commitCheckpoint(req.params.modelId) });
}));

// ── Live sync & comparison ─────────────────────────────────────────────────

router.post("/models/:modelId/sync", requireTwinOperate, handle((req, res) => {
  res.json(runtime.syncFromLive(req.params.modelId, Date.now()));
}));

router.get("/models/:modelId/compare", requireTwinRead, handle((req, res) => {
  res.json({ comparisons: runtime.compare(req.params.modelId) });
}));

// ── What-if & rollback simulation ──────────────────────────────────────────

router.post("/scenarios", requireTwinSimulation, handle((req, res) => {
  const parsed = ScenarioSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  res.json(runtime.runScenario(parsed.data as WhatIfScenario));
}));

router.post(
  "/models/:modelId/rollback-simulation",
  requireTwinSimulation,
  handle((req, res) => {
    const parsed = RollbackSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: fromZodError(parsed.error).message });
    }
    res.json(
      runtime.simulateRollback(req.params.modelId, parsed.data.applied, parsed.data.durationTicks)
    );
  })
);

// ── Introspection ──────────────────────────────────────────────────────────

router.get("/step-functions", requireTwinRead, (_req, res) => {
  res.json({ stepFunctions: listStepFunctions() });
});

router.get("/status", requireTwinRead, async (_req, res) => {
  const health = await digitalTwinService.healthCheck();
  // `persistence.lastRestore.failed` lists stored models this build refused to
  // load. They are still in storage, untouched, and can be cleared with
  // DELETE /models/:modelId or replaced by re-registering the model.
  res.json({
    ...runtime.getStatus(),
    ...health,
    persistence: digitalTwinService.persistenceStatus(),
  });
});

export { router as twinRoutes };
