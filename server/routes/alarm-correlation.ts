/**
 * Alarm Correlation API
 * ADR-0013 [13.2] — Issue #213
 *
 * REST surface for the alarm correlation engine: alarm ingestion and
 * lifecycle, correlated groups and root causes, the correlation rules
 * engine, equipment topology, and suppression policy.
 */

import { Router } from "express";
import { z } from "zod";
import { fromZodError } from "zod-validation-error";
import { alarmCorrelationService } from "../services/alarm-correlation";
import { validateRule } from "../services/alarm-correlation/rules";
import type { CorrelationRule } from "@shared/types/alarm-correlation";

const router = Router();
const engine = alarmCorrelationService.engine;

// Auth middleware placeholder — same pattern as other protected routes
function requireAuth(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction
) {
  // TODO: implement real auth check (JWT / session validation)
  next();
}
router.use(requireAuth);

// ── Schemas ────────────────────────────────────────────────────────────────

const MAX_FUTURE_SKEW_MS = 60 * 60 * 1000;

const SeveritySchema = z.enum(["critical", "high", "medium", "low", "info"]);

const AlarmInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().optional(),
    tagId: z.string().optional(),
    equipmentId: z.string().optional(),
    siteId: z.string().optional(),
    processArea: z.string().optional(),
    severity: z.string().optional(),
    state: z.string().optional(),
    message: z.string().optional(),
    timestamp: z.union([z.number().finite(), z.string().min(1)]),
    value: z.union([z.number(), z.string()]).optional(),
    limit: z.union([z.number(), z.string()]).optional(),
    source: z.string().optional(),
  })
  .refine((a) => a.id || a.tagId, {
    message: "alarm requires at least an id or a tagId",
  });

const IngestSchema = z.object({
  alarms: z.array(AlarmInputSchema).min(1).max(1000),
});

const RuleSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  type: z.enum(["causal", "hierarchy", "temporal"]),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(10_000),
  config: z.record(z.unknown()),
});

const TopologySchema = z.object({
  nodes: z
    .array(
      z.object({
        equipmentId: z.string().min(1).max(256),
        name: z.string().max(256).optional(),
        parentId: z.string().max(256).optional(),
        causalDownstream: z.array(z.string().min(1).max(256)).max(64).default([]),
        siteId: z.string().max(64).optional(),
        processArea: z.string().max(256).optional(),
      })
    )
    .min(1)
    .max(1000),
});

const SuppressionPolicySchema = z
  .object({
    enabled: z.boolean(),
    neverSuppressAtOrAbove: SeveritySchema,
    unsuppressOnRootClear: z.boolean(),
  })
  .partial();

const GroupQuerySchema = z.object({
  state: z.enum(["open", "closed"]).optional(),
});

// ── Alarm ingestion & lifecycle ────────────────────────────────────────────

router.post("/alarms", (req, res) => {
  const parsed = IngestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }

  const now = Date.now();
  const results = [];
  const rejected = [];
  for (const input of parsed.data.alarms) {
    const outcome = alarmCorrelationService.ingest(input as Record<string, unknown>);
    if (!outcome) {
      rejected.push({ input, reason: "unparseable timestamp" });
      continue;
    }
    if (outcome.alarm.timestamp > now + MAX_FUTURE_SKEW_MS) {
      rejected.push({ input, reason: "timestamp too far in the future" });
      continue;
    }
    results.push(outcome.result);
  }
  res.json({ ingested: results.length, results, rejected });
});

router.post("/alarms/:alarmId/clear", (req, res) => {
  const outcome = engine.alarmCleared(req.params.alarmId);
  res.json(outcome);
});

router.post("/alarms/:alarmId/acknowledge", (req, res) => {
  const ok = engine.alarmAcknowledged(req.params.alarmId);
  if (!ok) {
    return res.status(404).json({ error: `Alarm ${req.params.alarmId} not tracked` });
  }
  res.json({ acknowledged: true });
});

// ── Groups & root cause ────────────────────────────────────────────────────

router.get("/groups", (req, res) => {
  const parsed = GroupQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  res.json({ groups: engine.getGroups(parsed.data) });
});

router.get("/groups/:groupId", (req, res) => {
  const group = engine.getGroup(req.params.groupId);
  if (!group) {
    return res.status(404).json({ error: `Group ${req.params.groupId} not found` });
  }
  res.json(group);
});

router.get("/groups/:groupId/root-cause", (req, res) => {
  const rootCause = engine.getRootCause(req.params.groupId);
  if (!rootCause) {
    return res.status(404).json({ error: `Group ${req.params.groupId} not found` });
  }
  res.json(rootCause);
});

// ── Rules engine ───────────────────────────────────────────────────────────

router.get("/rules", (_req, res) => {
  res.json({ rules: engine.rules.list() });
});

router.put("/rules/:ruleId", (req, res) => {
  const parsed = RuleSchema.safeParse({ ...req.body, id: req.params.ruleId });
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  const rule = parsed.data as unknown as CorrelationRule;
  const error = validateRule(rule);
  if (error) {
    return res.status(400).json({ error });
  }
  res.json(engine.rules.upsert(rule));
});

router.delete("/rules/:ruleId", (req, res) => {
  if (!engine.rules.remove(req.params.ruleId)) {
    return res.status(404).json({ error: `Rule ${req.params.ruleId} not found` });
  }
  res.json({ removed: true });
});

router.post("/rules/:ruleId/enable", (req, res) => {
  const rule = engine.rules.setEnabled(req.params.ruleId, true);
  if (!rule) return res.status(404).json({ error: `Rule ${req.params.ruleId} not found` });
  res.json(rule);
});

router.post("/rules/:ruleId/disable", (req, res) => {
  const rule = engine.rules.setEnabled(req.params.ruleId, false);
  if (!rule) return res.status(404).json({ error: `Rule ${req.params.ruleId} not found` });
  res.json(rule);
});

// ── Equipment topology ─────────────────────────────────────────────────────

router.get("/topology", (_req, res) => {
  res.json({ nodes: engine.topology.list() });
});

router.put("/topology", (req, res) => {
  const parsed = TopologySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  try {
    const nodes = engine.topology.upsertMany(parsed.data.nodes);
    res.json({ upserted: nodes.length, nodes });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "invalid topology" });
  }
});

router.delete("/topology/:equipmentId", (req, res) => {
  if (!engine.topology.remove(req.params.equipmentId)) {
    return res.status(404).json({ error: `Equipment ${req.params.equipmentId} not found` });
  }
  res.json({ removed: true });
});

// ── Suppression policy ─────────────────────────────────────────────────────

router.get("/suppression-policy", (_req, res) => {
  res.json(engine.getSuppressionPolicy());
});

router.put("/suppression-policy", (req, res) => {
  const parsed = SuppressionPolicySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  res.json(engine.setSuppressionPolicy(parsed.data));
});

// ── Metrics & status ───────────────────────────────────────────────────────

router.get("/metrics", (_req, res) => {
  res.json(engine.getMetrics());
});

router.get("/status", async (_req, res) => {
  const health = await alarmCorrelationService.healthCheck();
  res.json({ ...engine.getMetrics(), ...health });
});

export { router as alarmCorrelationRoutes };
