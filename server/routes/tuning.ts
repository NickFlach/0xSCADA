/**
 * PID Tuning API
 * Issue #215 — ADR-0013 [13.4] and ADR-0009, both under docs/decisions/.
 *
 * REST surface for human-gated PID auto-tuning: loop registry with safety
 * envelopes (ADR-0009), relay/Cohen-Coon/RL tuning (all simulation-based, all
 * producing approval-gated proposals), the approve/reject gate, and the
 * durable audit trail.
 *
 * Authorization follows the #576 control-plane pattern: every route carries an
 * explicit `requireControlPlaneAccess` scope, matching the central inventory in
 * `server/middleware/control-route-policy.ts`:
 *
 *   tuning.read     — read loops, proposals and the audit trail
 *   tuning.write    — register loops, change envelopes, run a tuning study
 *   tuning.approve  — decide a proposal; the only path that can move live gains
 *
 * Two identity rules, both enforced here:
 *   - The approver is `controlPlanePrincipal(req).name`. There is no code path
 *     that reads an identity from the request body.
 *   - Decision bodies are `.strict()`, so a caller-supplied `approver` field is
 *     rejected with 400 rather than silently ignored.
 *
 * Mounted at /api/tuning — /api/pid belongs to the P&ID diagram surface.
 * `PIDController.forceGains` is deliberately not exposed.
 */

import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { fromZodError } from "zod-validation-error/v3";
import {
  controlPlanePrincipal,
  requireControlPlaneAccess,
} from "../middleware/control-plane-auth";
import {
  EnvelopeViolationError,
  LoopAlreadyRegisteredError,
  TuningApprovalDeniedError,
  TuningAuditUnavailableError,
  TuningConfigurationError,
  tuningService,
} from "../services/tuning";
import type { TuningAuditDecision, TuningProposalStatus } from "@shared/types/tuning";

const router = Router();

const requireTuningRead = requireControlPlaneAccess({ scopes: ["tuning.read"] });
const requireTuningWrite = requireControlPlaneAccess({ scopes: ["tuning.write"] });
/** Highest-privilege scope: the only one that can reach a live gain write. */
const requireTuningApprove = requireControlPlaneAccess({ scopes: ["tuning.approve"] });

/**
 * Express 4 does not catch async rejections. Domain errors map to explicit
 * statuses; anything else is a 500 rather than a permissive fallthrough.
 */
function asyncHandler(
  fn: (req: Request, res: Response) => Promise<unknown>
): RequestHandler {
  return (req, res) => {
    fn(req, res).catch((error: unknown) => {
      if (res.headersSent) return;
      respondToError(res, error);
    });
  };
}

function handle(fn: (req: Request, res: Response) => void): RequestHandler {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (error) {
      if (!res.headersSent) respondToError(res, error);
    }
  };
}

function respondToError(res: Response, error: unknown): void {
  if (error instanceof TuningApprovalDeniedError) {
    res.status(403).json({ error: error.message, reason: error.reason });
    return;
  }
  if (error instanceof TuningConfigurationError) {
    // The deployment cannot gate a gain change, so it must not accept one.
    res.status(503).json({ error: error.message, reason: "approval-gate-unconfigured" });
    return;
  }
  if (error instanceof TuningAuditUnavailableError) {
    console.error("[tuning] audit store unavailable:", error.cause);
    res.status(503).json({ error: error.message, reason: "audit-store-unavailable" });
    return;
  }
  if (error instanceof EnvelopeViolationError) {
    res.status(422).json({ error: error.message, reason: "envelope-violation" });
    return;
  }
  if (error instanceof LoopAlreadyRegisteredError) {
    // Create-only registration. Overwriting a live loop is a gain write, and
    // gain writes go through the approval gate or nowhere.
    res.status(409).json({ error: error.message, reason: "loop-already-registered" });
    return;
  }
  const message = error instanceof Error ? error.message : "Invalid request";
  if (/not found$|not registered$/.test(message)) {
    res.status(404).json({ error: message });
    return;
  }
  if (/^Proposal ".*" already /.test(message)) {
    res.status(409).json({ error: message });
    return;
  }
  if (error instanceof Error) {
    res.status(400).json({ error: message });
    return;
  }
  console.error("[tuning] handler error:", error);
  res.status(500).json({ error: "Internal error" });
}

// ── Schemas ────────────────────────────────────────────────────────────────

const GainsSchema = z.object({
  kp: z.number().finite().min(0),
  ki: z.number().finite().min(0),
  kd: z.number().finite().min(0),
}).strict();

const RangeSchema = z
  .object({ min: z.number().finite().min(0), max: z.number().finite() })
  .strict()
  .refine((r) => r.min <= r.max, { message: "min must not exceed max" });

const EnvelopeSchema = z.object({
  kpRange: RangeSchema,
  kiRange: RangeSchema,
  kdRange: RangeSchema,
}).strict();

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
}).strict().refine((l) => l.outputMin < l.outputMax, {
  message: "outputMin must be below outputMax",
});

const ModelSchema = z.object({
  gain: z.number().finite().refine((g) => g !== 0, { message: "gain must be non-zero" }),
  timeConstantS: z.number().positive().max(86_400),
  deadTimeS: z.number().min(0).max(3600),
  noiseSigma: z.number().min(0).optional(),
}).strict();

const RelaySchema = z.object({
  model: ModelSchema,
  relayAmplitude: z.number().positive().optional(),
  hysteresis: z.number().positive().optional(),
  minCycles: z.number().int().min(2).max(20).optional(),
  dtS: z.number().positive().max(60).optional(),
}).strict();

const CohenCoonSchema = z.object({ model: ModelSchema }).strict();

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
    .strict()
    .partial()
    .optional(),
}).strict();

/**
 * `.strict()` is load-bearing: it turns a caller-supplied `approver` field
 * into a 400 instead of letting it look accepted. The approver identity comes
 * from the authenticated principal only.
 */
const DecisionSchema = z.object({
  comment: z.string().max(2000).optional(),
}).strict();

const PROPOSAL_STATUSES = [
  "pending",
  "applied",
  "rejected",
  "expired",
  "failed",
] as const satisfies readonly TuningProposalStatus[];

const AUDIT_DECISIONS = [
  "proposed",
  "envelope-rejected",
  "approved",
  "applied",
  "rejected",
  "denied",
  "expired",
  "failed",
] as const satisfies readonly TuningAuditDecision[];

const ProposalQuerySchema = z.object({
  status: z.enum(PROPOSAL_STATUSES).optional(),
  loopId: z.string().min(1).max(128).optional(),
}).strict();

const AuditQuerySchema = z.object({
  proposalId: z.string().min(1).max(128).optional(),
  loopId: z.string().min(1).max(128).optional(),
  decision: z.enum(AUDIT_DECISIONS).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
}).strict();

// ── Loop registry ──────────────────────────────────────────────────────────

router.post("/loops", requireTuningWrite, handle((req, res) => {
  const parsed = LoopSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: fromZodError(parsed.error).message });
    return;
  }
  const { controller, envelope } = tuningService.registerLoop(parsed.data);
  res.status(201).json({
    id: controller.id,
    name: controller.name,
    gains: controller.getGains(),
    setpoint: controller.getSetpoint(),
    envelope,
  });
}));

router.get("/loops/:loopId", requireTuningRead, handle((req, res) => {
  const controller = tuningService.getController(req.params.loopId);
  if (!controller) {
    res.status(404).json({ error: `Loop ${req.params.loopId} not found` });
    return;
  }
  res.json({
    id: controller.id,
    name: controller.name,
    gains: controller.getGains(),
    setpoint: controller.getSetpoint(),
    metrics: controller.getMetrics(),
    envelope: tuningService.getEnvelope(req.params.loopId),
  });
}));

router.put("/loops/:loopId/envelope", requireTuningWrite, handle((req, res) => {
  const parsed = EnvelopeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: fromZodError(parsed.error).message });
    return;
  }
  if (!tuningService.getController(req.params.loopId)) {
    res.status(404).json({ error: `Loop ${req.params.loopId} not found` });
    return;
  }
  res.json(tuningService.setEnvelope(req.params.loopId, parsed.data));
}));

// ── Tuning (simulation-based; every result is a gated proposal) ────────────

router.post("/loops/:loopId/tune/relay", requireTuningWrite, asyncHandler(async (req, res) => {
  const parsed = RelaySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: fromZodError(parsed.error).message });
    return;
  }
  const { model, ...options } = parsed.data;
  const proposal = await tuningService.tuneRelay(
    req.params.loopId,
    model,
    controlPlanePrincipal(req),
    options,
  );
  res.status(201).json(proposal);
}));

router.post("/loops/:loopId/tune/cohen-coon", requireTuningWrite, asyncHandler(async (req, res) => {
  const parsed = CohenCoonSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: fromZodError(parsed.error).message });
    return;
  }
  const proposal = await tuningService.tuneCohenCoon(
    req.params.loopId,
    parsed.data.model,
    controlPlanePrincipal(req),
  );
  res.status(201).json(proposal);
}));

router.post("/loops/:loopId/tune/rl", requireTuningWrite, asyncHandler(async (req, res) => {
  const parsed = RLSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: fromZodError(parsed.error).message });
    return;
  }
  const { proposal, outcome } = await tuningService.tuneRL(
    req.params.loopId,
    parsed.data.model,
    controlPlanePrincipal(req),
    parsed.data.config ?? {}
  );
  res.status(201).json({ proposal, outcome });
}));

// ── Approval gate ──────────────────────────────────────────────────────────

router.get("/proposals", requireTuningRead, handle((req, res) => {
  const parsed = ProposalQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: fromZodError(parsed.error).message });
    return;
  }
  res.json({
    proposals: tuningService.getProposals({
      status: parsed.data.status,
      controllerId: parsed.data.loopId,
    }),
  });
}));

router.get("/proposals/:proposalId", requireTuningRead, handle((req, res) => {
  const proposal = tuningService.getProposal(req.params.proposalId);
  if (!proposal) {
    res.status(404).json({ error: `Proposal ${req.params.proposalId} not found` });
    return;
  }
  res.json(proposal);
}));

router.post(
  "/proposals/:proposalId/approve",
  requireTuningApprove,
  asyncHandler(async (req, res) => {
    const parsed = DecisionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: fromZodError(parsed.error).message });
      return;
    }
    const proposal = await tuningService.decide(
      req.params.proposalId,
      controlPlanePrincipal(req),
      "approve",
      parsed.data.comment
    );
    res.json(proposal);
  }),
);

router.post(
  "/proposals/:proposalId/reject",
  requireTuningApprove,
  asyncHandler(async (req, res) => {
    const parsed = DecisionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: fromZodError(parsed.error).message });
      return;
    }
    const proposal = await tuningService.decide(
      req.params.proposalId,
      controlPlanePrincipal(req),
      "reject",
      parsed.data.comment
    );
    res.json(proposal);
  }),
);

// ── Durable audit trail ────────────────────────────────────────────────────

router.get("/audit", requireTuningRead, asyncHandler(async (req, res) => {
  const parsed = AuditQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: fromZodError(parsed.error).message });
    return;
  }
  const records = await tuningService.getAuditTrail({
    proposalId: parsed.data.proposalId,
    controllerId: parsed.data.loopId,
    decision: parsed.data.decision,
    limit: parsed.data.limit,
  });
  res.json({ records });
}));

// ── Status ─────────────────────────────────────────────────────────────────

router.get("/status", requireTuningRead, asyncHandler(async (_req, res) => {
  const health = await tuningService.healthCheck();
  res.json(health);
}));

export { router as tuningRoutes };
