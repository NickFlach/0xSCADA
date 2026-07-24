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
import { fromZodError } from "zod-validation-error/v3";
import {
  controlPlanePrincipal,
  requireControlPlaneAccess,
} from "../middleware/control-plane-auth";
import {
  alarmCorrelationService,
  normalizeAlarmTimestamp,
} from "../services/alarm-correlation";
import { validateRule } from "../services/alarm-correlation/rules";
import type { CorrelationRule } from "@shared/types/alarm-correlation";

const router = Router();
const engine = alarmCorrelationService.engine;
const requireAlarmRead = requireControlPlaneAccess({
  scopes: ["alarms.read"],
});
const requireAlarmIngest = requireControlPlaneAccess({
  scopes: ["alarms.ingest"],
});
const requireAlarmAcknowledge = requireControlPlaneAccess({
  scopes: ["alarms.acknowledge"],
});
const requireAlarmClear = requireControlPlaneAccess({
  scopes: ["alarms.clear"],
});
const requireAlarmConfigure = requireControlPlaneAccess({
  scopes: ["alarms.configure"],
});

// ── Schemas ────────────────────────────────────────────────────────────────

const MAX_FUTURE_SKEW_MS = 60 * 60 * 1000;
const MAX_RULE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_TOPOLOGY_DISTANCE = 64;

const SeveritySchema = z.enum(["critical", "high", "medium", "low", "info"]);
const BoundedValueSchema = z.union([
  z.number().finite(),
  z.string().max(256),
]);

const AlarmInputSchema = z
  .object({
    id: z.string().min(1).max(128).optional(),
    name: z.string().max(256).optional(),
    tagId: z.string().max(256).optional(),
    equipmentId: z.string().max(256).optional(),
    siteId: z.string().max(64).optional(),
    processArea: z.string().max(256).optional(),
    severity: SeveritySchema,
    state: z.literal("active").optional(),
    message: z.string().max(2048).optional(),
    timestamp: z
      .union([
        z.number().finite(),
        z.string().min(1).max(64),
      ])
      .refine((timestamp) => normalizeAlarmTimestamp(timestamp) !== null, {
        message: "timestamp must be within the JavaScript Date range",
      }),
    value: BoundedValueSchema.optional(),
    limit: BoundedValueSchema.optional(),
  })
  .strict()
  .refine((a) => a.id || a.tagId, {
    message: "alarm requires at least an id or a tagId",
  });

const IngestSchema = z.object({
  alarms: z.array(AlarmInputSchema).min(1).max(500),
}).strict();

const RuleBaseSchema = {
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(10_000),
};

const WindowSchema = z.number().int().min(1).max(MAX_RULE_WINDOW_MS);

const RuleSchema = z.discriminatedUnion("type", [
  z.object({
    ...RuleBaseSchema,
    type: z.literal("causal"),
    config: z.object({
      windowMs: WindowSchema,
      maxHops: z.number().int().min(1).max(MAX_TOPOLOGY_DISTANCE),
    }).strict(),
  }).strict(),
  z.object({
    ...RuleBaseSchema,
    type: z.literal("hierarchy"),
    config: z.object({
      windowMs: WindowSchema,
      maxDistance: z.number().int().min(1).max(MAX_TOPOLOGY_DISTANCE),
    }).strict(),
  }).strict(),
  z.object({
    ...RuleBaseSchema,
    type: z.literal("temporal"),
    config: z.object({
      windowMs: WindowSchema,
      scope: z.enum(["same-tag", "same-equipment", "process-area"]),
    }).strict(),
  }).strict(),
]);

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
      }).strict()
    )
    .min(1)
    .max(1000),
}).strict();

const SuppressionPolicySchema = z
  .object({
    enabled: z.boolean(),
    neverSuppressAtOrAbove: SeveritySchema,
    unsuppressOnRootClear: z.literal(true),
  })
  .partial()
  .strict()
  .refine((policy) => Object.keys(policy).length > 0, {
    message: "at least one suppression-policy field is required",
  });

const GroupQuerySchema = z.object({
  state: z.enum(["open", "closed"]).optional(),
}).strict();

function parseTimestamp(timestamp: string | number): number | null {
  return normalizeAlarmTimestamp(timestamp);
}

// ── Alarm ingestion & lifecycle ────────────────────────────────────────────

router.post("/alarms", requireAlarmIngest, (req, res) => {
  const parsed = IngestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }

  const now = Date.now();
  const principal = controlPlanePrincipal(req);
  const results = [];
  const rejected = [];
  for (const input of parsed.data.alarms) {
    const timestamp = parseTimestamp(input.timestamp);
    if (timestamp === null) {
      rejected.push({ input, reason: "unparseable timestamp" });
      continue;
    }
    if (timestamp > now + MAX_FUTURE_SKEW_MS) {
      rejected.push({ input, reason: "timestamp too far in the future" });
      continue;
    }
    const outcome = alarmCorrelationService.ingest({
      ...input,
      timestamp,
      state: "active",
      source: `api:${principal.name}`,
    });
    if (!outcome) {
      rejected.push({ input, reason: "invalid alarm" });
      continue;
    }
    if (outcome.result.action === "duplicate") {
      rejected.push({ input, reason: outcome.result.reason });
      continue;
    }
    results.push(outcome.result);
  }
  const duplicateConflict =
    results.length === 0
    && rejected.some(({ reason }) => reason.includes("duplicate alarm id"));
  res.status(duplicateConflict ? 409 : 200).json({
    ingested: results.length,
    results,
    rejected,
  });
});

router.post("/alarms/:alarmId/clear", requireAlarmClear, (req, res) => {
  const principal = controlPlanePrincipal(req);
  const outcome = engine.alarmCleared(req.params.alarmId, principal.name);
  if (!outcome.cleared) {
    return res.status(404).json({ error: `Alarm ${req.params.alarmId} not tracked` });
  }
  res.json(outcome);
});

router.post(
  "/alarms/:alarmId/acknowledge",
  requireAlarmAcknowledge,
  (req, res) => {
    const principal = controlPlanePrincipal(req);
    const ok = engine.alarmAcknowledged(req.params.alarmId, principal.name);
    if (!ok) {
      return res.status(404).json({ error: `Alarm ${req.params.alarmId} not tracked` });
    }
    res.json({
      acknowledged: true,
      acknowledgedBy: engine.getAlarm(req.params.alarmId)?.acknowledgedBy,
    });
  },
);

// ── Groups & root cause ────────────────────────────────────────────────────

router.get("/groups", requireAlarmRead, (req, res) => {
  const parsed = GroupQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  res.json({ groups: engine.getGroups(parsed.data) });
});

router.get("/groups/:groupId", requireAlarmRead, (req, res) => {
  const group = engine.getGroup(req.params.groupId);
  if (!group) {
    return res.status(404).json({ error: `Group ${req.params.groupId} not found` });
  }
  res.json(group);
});

router.get("/groups/:groupId/root-cause", requireAlarmRead, (req, res) => {
  const rootCause = engine.getRootCause(req.params.groupId);
  if (!rootCause) {
    return res.status(404).json({ error: `Group ${req.params.groupId} not found` });
  }
  res.json(rootCause);
});

// ── Rules engine ───────────────────────────────────────────────────────────

router.get("/rules", requireAlarmRead, (_req, res) => {
  res.json({ rules: engine.rules.list() });
});

router.put("/rules/:ruleId", requireAlarmConfigure, (req, res) => {
  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body
      : {};
  const parsed = RuleSchema.safeParse({ ...body, id: req.params.ruleId });
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  const rule = parsed.data as unknown as CorrelationRule;
  const error = validateRule(rule);
  if (error) {
    return res.status(400).json({ error });
  }
  try {
    res.json(engine.rules.upsert(rule));
  } catch (upsertError) {
    res.status(400).json({
      error: upsertError instanceof Error ? upsertError.message : "invalid rule",
    });
  }
});

router.delete("/rules/:ruleId", requireAlarmConfigure, (req, res) => {
  if (!engine.rules.remove(req.params.ruleId)) {
    return res.status(404).json({ error: `Rule ${req.params.ruleId} not found` });
  }
  res.json({ removed: true });
});

router.post("/rules/:ruleId/enable", requireAlarmConfigure, (req, res) => {
  const rule = engine.rules.setEnabled(req.params.ruleId, true);
  if (!rule) return res.status(404).json({ error: `Rule ${req.params.ruleId} not found` });
  res.json(rule);
});

router.post("/rules/:ruleId/disable", requireAlarmConfigure, (req, res) => {
  const rule = engine.rules.setEnabled(req.params.ruleId, false);
  if (!rule) return res.status(404).json({ error: `Rule ${req.params.ruleId} not found` });
  res.json(rule);
});

// ── Equipment topology ─────────────────────────────────────────────────────

router.get("/topology", requireAlarmRead, (_req, res) => {
  res.json({ nodes: engine.topology.list() });
});

router.put("/topology", requireAlarmConfigure, (req, res) => {
  const parsed = TopologySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  try {
    const nodes = engine.topology.upsertMany(parsed.data.nodes);
    engine.reconcileTopology();
    res.json({ upserted: nodes.length, nodes });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "invalid topology" });
  }
});

router.delete(
  "/topology/:equipmentId",
  requireAlarmConfigure,
  (req, res) => {
    if (!engine.topology.remove(req.params.equipmentId)) {
      return res.status(404).json({
        error: `Equipment ${req.params.equipmentId} not found`,
      });
    }
    engine.reconcileTopology();
    res.json({ removed: true });
  },
);

// ── Suppression policy ─────────────────────────────────────────────────────

router.get("/suppression-policy", requireAlarmRead, (_req, res) => {
  res.json(engine.getSuppressionPolicy());
});

router.put("/suppression-policy", requireAlarmConfigure, (req, res) => {
  const parsed = SuppressionPolicySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  if (
    parsed.data.enabled === true
    && process.env.ALARM_CORRELATION_ALLOW_EPHEMERAL_SUPPRESSION !== "true"
  ) {
    return res.status(409).json({
      error:
        "Suppression is disabled until durable, replica-coordinated state is available. "
        + "Set ALARM_CORRELATION_ALLOW_EPHEMERAL_SUPPRESSION=true only for an "
        + "explicit single-process evaluation.",
      coordinationMode: "process-local",
    });
  }
  try {
    res.json(engine.setSuppressionPolicy(parsed.data));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "invalid suppression policy",
    });
  }
});

// ── Metrics & status ───────────────────────────────────────────────────────

router.get("/metrics", requireAlarmRead, (_req, res) => {
  res.json(engine.getMetrics());
});

router.get("/status", requireAlarmRead, async (_req, res) => {
  const health = await alarmCorrelationService.healthCheck();
  res.json({ ...engine.getMetrics(), ...health });
});

export { router as alarmCorrelationRoutes };
