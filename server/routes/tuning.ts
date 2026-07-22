/**
 * PID Tuning API
 * ADR-0013 [13.4] — Issue #215
 *
 * REST surface for human-gated PID auto-tuning: loop registry with
 * safety envelopes, relay/Cohen-Coon/RL tuning (all simulation-based,
 * all producing approval-gated proposals), and the approve/reject gate.
 * Mounted at /api/tuning — /api/pid is semantically claimed by P&ID
 * diagrams. forceGains is deliberately not exposed.
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { fromZodError } from "zod-validation-error";
import { tuningService } from "../services/tuning";

const router = Router();

// Auth middleware placeholder — same pattern as other protected routes
function requireAuth(req: Request, res: Response, next: NextFunction) {
  // TODO: implement real auth check (JWT / session validation)
  next();
}
router.use(requireAuth);

/** Async handler wrapper (Express 4 does not catch async rejections) */
function asyncHandler(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((error) => {
      if (!res.headersSent) {
        res.status(400).json({ error: error instanceof Error ? error.message : "Invalid request" });
      }
    });
  };
}

// ── Schemas ────────────────────────────────────────────────────────────────

const GainsSchema = z.object({
  kp: z.number().finite().min(0),
  ki: z.number().finite().min(0),
  kd: z.number().finite().min(0),
});

const RangeSchema = z
  .object({ min: z.number().finite().min(0), max: z.number().finite() })
  .refine((r) => r.min <= r.max, { message: "min must not exceed max" });

const EnvelopeSchema = z.object({
  kpRange: RangeSchema,
  kiRange: RangeSchema,
  kdRange: RangeSchema,
});

const LoopSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  gains: GainsSchema,
  setpoint: z.number().finite(),
  outputMin: z.number().finite(),
  outputMax: z.number().finite(),
  maxGainChangeFraction: z.number().gt(0).lte(1).optional(),
  sampleTime: z.number().positive().optional(),
  envelope: EnvelopeSchema.optional(),
}).refine((l) => l.outputMin < l.outputMax, { message: "outputMin must be below outputMax" });

const ModelSchema = z.object({
  gain: z.number().finite().refine((g) => g !== 0, { message: "gain must be non-zero" }),
  timeConstantS: z.number().positive().max(86_400),
  deadTimeS: z.number().min(0).max(3600),
  noiseSigma: z.number().min(0).optional(),
});

const RelaySchema = z.object({
  model: ModelSchema,
  relayAmplitude: z.number().positive().optional(),
  hysteresis: z.number().positive().optional(),
  minCycles: z.number().int().min(2).max(20).optional(),
  dtS: z.number().positive().max(60).optional(),
});

const RLSchema = z.object({
  model: ModelSchema,
  config: z
    .object({
      episodes: z.number().int().min(1).max(500),
      episodeTicks: z.number().int().min(10).max(10_000),
      dtS: z.number().positive().max(60),
      epsilon: z.number().min(0).max(1),
      epsilonDecay: z.number().gt(0).lte(1),
      learningRate: z.number().gt(0).lte(1),
      discount: z.number().min(0).lte(1),
      overshootPenalty: z.number().min(0),
      oscillationPenalty: z.number().min(0),
      seed: z.number().int().optional(),
    })
    .partial()
    .optional(),
});

const DecisionSchema = z.object({
  approver: z.string().min(1).max(128),
  comment: z.string().max(2000).optional(),
});

// ── Loop registry ──────────────────────────────────────────────────────────

router.post("/loops", (req, res) => {
  const parsed = LoopSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  try {
    const { controller, envelope } = tuningService.registerLoop(parsed.data);
    res.status(201).json({
      id: controller.id,
      name: controller.name,
      gains: controller.getGains(),
      setpoint: controller.getSetpoint(),
      envelope,
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid loop" });
  }
});

router.get("/loops/:loopId", (req, res) => {
  const controller = tuningService.getController(req.params.loopId);
  if (!controller) {
    return res.status(404).json({ error: `Loop ${req.params.loopId} not found` });
  }
  res.json({
    id: controller.id,
    name: controller.name,
    gains: controller.getGains(),
    setpoint: controller.getSetpoint(),
    metrics: controller.getMetrics(),
    envelope: tuningService.getEnvelope(req.params.loopId),
  });
});

router.put("/loops/:loopId/envelope", (req, res) => {
  const parsed = EnvelopeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  if (!tuningService.getController(req.params.loopId)) {
    return res.status(404).json({ error: `Loop ${req.params.loopId} not found` });
  }
  res.json(tuningService.setEnvelope(req.params.loopId, parsed.data));
});

// ── Tuning (simulation-based; every result is a gated proposal) ────────────

router.post("/loops/:loopId/tune/relay", asyncHandler(async (req, res) => {
  const parsed = RelaySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  const { model, ...options } = parsed.data;
  const proposal = await tuningService.tuneRelay(req.params.loopId, model, options);
  res.status(201).json(proposal);
}));

router.post("/loops/:loopId/tune/cohen-coon", asyncHandler(async (req, res) => {
  const parsed = z.object({ model: ModelSchema }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  const proposal = await tuningService.tuneCohenCoon(req.params.loopId, parsed.data.model);
  res.status(201).json(proposal);
}));

router.post("/loops/:loopId/tune/rl", asyncHandler(async (req, res) => {
  const parsed = RLSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  const { proposal, outcome } = await tuningService.tuneRL(
    req.params.loopId,
    parsed.data.model,
    parsed.data.config ?? {}
  );
  res.status(201).json({ proposal, outcome });
}));

// ── Approval gate ──────────────────────────────────────────────────────────

router.get("/proposals", (req, res) => {
  const status = req.query.status as string | undefined;
  const controllerId = req.query.loopId as string | undefined;
  res.json({
    proposals: tuningService.getProposals({
      status: status as never,
      controllerId,
    }),
  });
});

router.get("/proposals/:proposalId", (req, res) => {
  const proposal = tuningService.getProposal(req.params.proposalId);
  if (!proposal) {
    return res.status(404).json({ error: `Proposal ${req.params.proposalId} not found` });
  }
  res.json(proposal);
});

router.post("/proposals/:proposalId/approve", asyncHandler(async (req, res) => {
  const parsed = DecisionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  const proposal = await tuningService.decide(
    req.params.proposalId,
    parsed.data.approver,
    "approve",
    parsed.data.comment
  );
  res.json(proposal);
}));

router.post("/proposals/:proposalId/reject", asyncHandler(async (req, res) => {
  const parsed = DecisionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  const proposal = await tuningService.decide(
    req.params.proposalId,
    parsed.data.approver,
    "reject",
    parsed.data.comment
  );
  res.json(proposal);
}));

// ── Status ─────────────────────────────────────────────────────────────────

router.get("/status", asyncHandler(async (_req, res) => {
  const health = await tuningService.healthCheck();
  res.json(health);
}));

export { router as tuningRoutes };
