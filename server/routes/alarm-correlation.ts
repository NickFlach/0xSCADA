/**
 * Alarm Correlation API
 * ADR-0013 [13.2] — Issue #213
 *
 * REST surface for the alarm correlation engine: alarm ingestion and
 * lifecycle, correlated groups and root causes, the correlation rules
 * engine, equipment topology, and suppression policy.
 */

import { Router, type Request, type Response } from "express";
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
import { EquipmentTopology } from "../services/alarm-correlation/topology";
import type {
  CorrelationRule,
  EquipmentNode,
} from "@shared/types/alarm-correlation";

const router = Router();
/**
 * Resolved per request, never captured at module load: attaching the durable
 * coordinator (#573) swaps the engine holding correlation state, and a cached
 * reference would leave REST serving the abandoned process-local engine while
 * WebSocket served the coordinated one.
 */
const currentEngine = () => alarmCorrelationService.engine;
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

const IdempotencyKeySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);

const IDEMPOTENCY_KEY_ERROR =
  "Idempotency-Key must be 1..128 characters of [A-Za-z0-9._:-]";

/**
 * Configuration edits have no natural idempotency key — setting a rule to A,
 * then B, then back to A is three distinct operations, so deriving a key from
 * the content would silently drop the third. The caller supplies one to make a
 * retry safe; without a header each request is its own journal entry.
 *
 * Returns `undefined` for "no key supplied" and `null` for "supplied but
 * invalid", which is a 400 rather than a silently ignored header.
 */
function idempotencyKey(req: Request): string | undefined | null {
  const raw = req.header("idempotency-key");
  if (raw === undefined) return undefined;
  const parsed = IdempotencyKeySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function principalName(req: Request): string {
  return controlPlanePrincipal(req).name;
}

/**
 * A config mutation that could not reach the journal did not happen on any
 * replica. Reporting success would leave the operator believing a rule change
 * took effect when the next restart will forget it.
 */
function coordinationUnavailable(error: unknown): Record<string, unknown> {
  return {
    error:
      "Durable coordination is unavailable, so this configuration change was "
      + "not recorded on any replica. Suppression has been disabled and every "
      + "suppressed alarm restored.",
    detail: error instanceof Error ? error.message : String(error),
    coordination: alarmCorrelationService.durableCoordinator?.health() ?? null,
  };
}

const IDEMPOTENCY_KEY_REUSED =
  "Idempotency-Key has already been used for a different operation, so this "
  + "request was NOT applied. Retry with a fresh key.";

/**
 * A submission that returned `created: false` collapsed onto a journal entry
 * that was already there. That is exactly right for a genuine retry, and wrong
 * for a key accidentally reused with different content — in which case nothing
 * this request asked for happened. So the effect is read back and verified, and
 * a mismatch is a 409 rather than a 200 describing a change that never landed.
 */
function reportConfigOutcome(
  res: Response,
  created: boolean,
  effectApplied: boolean,
  body: Record<string, unknown>,
): void {
  if (!created && !effectApplied) {
    res.status(409).json({ error: IDEMPOTENCY_KEY_REUSED });
    return;
  }
  res.json({ ...body, applied: created });
}

function sameEquipment(
  stored: EquipmentNode | undefined,
  requested: EquipmentNode,
): boolean {
  if (!stored) return false;
  return (
    stored.name === requested.name
    && stored.parentId === requested.parentId
    && stored.siteId === requested.siteId
    && stored.processArea === requested.processArea
    // Topology upsert de-duplicates and drops self-edges, so compare as sets.
    && JSON.stringify([...new Set(stored.causalDownstream)].sort())
      === JSON.stringify(
        [...new Set(requested.causalDownstream)]
          .filter((id) => id !== requested.equipmentId)
          .sort(),
      )
  );
}

function sameRule(a: CorrelationRule | undefined, b: CorrelationRule): boolean {
  if (!a) return false;
  return (
    a.name === b.name
    && a.type === b.type
    && a.enabled === b.enabled
    && a.priority === b.priority
    && JSON.stringify(a.config) === JSON.stringify(b.config)
  );
}

// ── Alarm ingestion & lifecycle ────────────────────────────────────────────

router.post("/alarms", requireAlarmIngest, async (req, res) => {
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
    // Goes through the shared journal when durable coordination is up, so an
    // alarm ingested on one replica is grouped identically on every other.
    const outcome = await alarmCorrelationService.submit(
      {
        ...input,
        timestamp,
        state: "active",
        source: `api:${principal.name}`,
      },
      principal.name,
    );
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
    coordinationMode: alarmCorrelationService.coordinationMode(),
  });
});

router.post("/alarms/:alarmId/clear", requireAlarmClear, async (req, res) => {
  const principal = controlPlanePrincipal(req);
  const outcome = await alarmCorrelationService.clear(
    req.params.alarmId,
    principal.name,
  );
  if (!outcome.cleared) {
    return res.status(404).json({ error: `Alarm ${req.params.alarmId} not tracked` });
  }
  res.json(outcome);
});

router.post(
  "/alarms/:alarmId/acknowledge",
  requireAlarmAcknowledge,
  async (req, res) => {
    const principal = controlPlanePrincipal(req);
    const ok = await alarmCorrelationService.acknowledge(
      req.params.alarmId,
      principal.name,
    );
    if (!ok) {
      return res.status(404).json({ error: `Alarm ${req.params.alarmId} not tracked` });
    }
    res.json({
      acknowledged: true,
      acknowledgedBy: currentEngine().getAlarm(req.params.alarmId)?.acknowledgedBy,
    });
  },
);

/**
 * Latest canonical state for every alarm an operator could still act on —
 * the REST twin of the WebSocket reconnect snapshot, so a client that
 * reconnects on either surface sees the same thing.
 */
router.get("/snapshot", requireAlarmRead, (_req, res) => {
  res.json({
    alarms: alarmCorrelationService.getReconnectSnapshot(),
    coordinationMode: alarmCorrelationService.coordinationMode(),
  });
});

// ── Groups & root cause ────────────────────────────────────────────────────

router.get("/groups", requireAlarmRead, (req, res) => {
  const parsed = GroupQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  res.json({ groups: currentEngine().getGroups(parsed.data) });
});

router.get("/groups/:groupId", requireAlarmRead, (req, res) => {
  const group = currentEngine().getGroup(req.params.groupId);
  if (!group) {
    return res.status(404).json({ error: `Group ${req.params.groupId} not found` });
  }
  res.json(group);
});

router.get("/groups/:groupId/root-cause", requireAlarmRead, (req, res) => {
  const rootCause = currentEngine().getRootCause(req.params.groupId);
  if (!rootCause) {
    return res.status(404).json({ error: `Group ${req.params.groupId} not found` });
  }
  res.json(rootCause);
});

// ── Rules engine ───────────────────────────────────────────────────────────

router.get("/rules", requireAlarmRead, (_req, res) => {
  res.json({ rules: currentEngine().rules.list() });
});

router.put("/rules/:ruleId", requireAlarmConfigure, async (req, res) => {
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
  const coordinator = alarmCorrelationService.durableCoordinator;
  if (coordinator) {
    const key = idempotencyKey(req);
    if (key === null) return res.status(400).json({ error: IDEMPOTENCY_KEY_ERROR });
    try {
      const submitted = await coordinator.submitConfig(
        "rule-upsert",
        { rule },
        principalName(req),
        key,
      );
      const stored = currentEngine().rules.get(rule.id);
      return reportConfigOutcome(
        res,
        submitted.created,
        sameRule(stored, rule),
        { ...stored },
      );
    } catch (submitError) {
      return res.status(503).json(coordinationUnavailable(submitError));
    }
  }
  try {
    res.json({ ...currentEngine().rules.upsert(rule), applied: true });
  } catch (upsertError) {
    res.status(400).json({
      error: upsertError instanceof Error ? upsertError.message : "invalid rule",
    });
  }
});

router.delete("/rules/:ruleId", requireAlarmConfigure, async (req, res) => {
  if (!currentEngine().rules.get(req.params.ruleId)) {
    return res.status(404).json({ error: `Rule ${req.params.ruleId} not found` });
  }
  const coordinator = alarmCorrelationService.durableCoordinator;
  if (coordinator) {
    const key = idempotencyKey(req);
    if (key === null) return res.status(400).json({ error: IDEMPOTENCY_KEY_ERROR });
    try {
      const submitted = await coordinator.submitConfig(
        "rule-remove",
        { ruleId: req.params.ruleId },
        principalName(req),
        key,
      );
      return reportConfigOutcome(
        res,
        submitted.created,
        currentEngine().rules.get(req.params.ruleId) === undefined,
        { removed: true },
      );
    } catch (error) {
      return res.status(503).json(coordinationUnavailable(error));
    }
  }
  currentEngine().rules.remove(req.params.ruleId);
  res.json({ removed: true, applied: true });
});

async function setRuleEnabled(
  req: Request,
  res: Response,
  enabled: boolean,
): Promise<void> {
  const ruleId = req.params.ruleId;
  if (!currentEngine().rules.get(ruleId)) {
    res.status(404).json({ error: `Rule ${ruleId} not found` });
    return;
  }
  const coordinator = alarmCorrelationService.durableCoordinator;
  if (coordinator) {
    const key = idempotencyKey(req);
    if (key === null) {
      res.status(400).json({ error: IDEMPOTENCY_KEY_ERROR });
      return;
    }
    try {
      const submitted = await coordinator.submitConfig(
        "rule-enabled",
        { ruleId, enabled },
        principalName(req),
        key,
      );
      const stored = currentEngine().rules.get(ruleId);
      reportConfigOutcome(
        res,
        submitted.created,
        stored?.enabled === enabled,
        { ...stored },
      );
    } catch (error) {
      res.status(503).json(coordinationUnavailable(error));
    }
    return;
  }
  res.json({ ...currentEngine().rules.setEnabled(ruleId, enabled), applied: true });
}

router.post("/rules/:ruleId/enable", requireAlarmConfigure, (req, res) =>
  setRuleEnabled(req, res, true));

router.post("/rules/:ruleId/disable", requireAlarmConfigure, (req, res) =>
  setRuleEnabled(req, res, false));

// ── Equipment topology ─────────────────────────────────────────────────────

router.get("/topology", requireAlarmRead, (_req, res) => {
  res.json({ nodes: currentEngine().topology.list() });
});

router.put("/topology", requireAlarmConfigure, async (req, res) => {
  const parsed = TopologySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  const coordinator = alarmCorrelationService.durableCoordinator;
  if (coordinator) {
    const key = idempotencyKey(req);
    if (key === null) return res.status(400).json({ error: IDEMPOTENCY_KEY_ERROR });
    // Validate against a throwaway copy of the live graph first: a cycle must
    // be a 400, not a journal entry every replica then fails to apply.
    const probe = new EquipmentTopology();
    probe.upsertMany(currentEngine().topology.list());
    try {
      probe.upsertMany(parsed.data.nodes);
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : "invalid topology",
      });
    }
    let submitted;
    try {
      submitted = await coordinator.submitConfig(
        "topology-upsert",
        { nodes: parsed.data.nodes },
        principalName(req),
        key,
      );
    } catch (error) {
      return res.status(503).json(coordinationUnavailable(error));
    }
    const stored = parsed.data.nodes.map((node) =>
      currentEngine().topology.get(node.equipmentId));
    return reportConfigOutcome(
      res,
      submitted.created,
      stored.every((node, index) => sameEquipment(node, parsed.data.nodes[index])),
      { upserted: stored.filter((node) => node !== undefined).length, nodes: stored },
    );
  }
  try {
    const nodes = currentEngine().topology.upsertMany(parsed.data.nodes);
    currentEngine().reconcileTopology();
    res.json({ upserted: nodes.length, nodes, applied: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "invalid topology" });
  }
});

router.delete(
  "/topology/:equipmentId",
  requireAlarmConfigure,
  async (req, res) => {
    if (!currentEngine().topology.get(req.params.equipmentId)) {
      return res.status(404).json({
        error: `Equipment ${req.params.equipmentId} not found`,
      });
    }
    const coordinator = alarmCorrelationService.durableCoordinator;
    if (coordinator) {
      const key = idempotencyKey(req);
      if (key === null) return res.status(400).json({ error: IDEMPOTENCY_KEY_ERROR });
      try {
        const submitted = await coordinator.submitConfig(
          "topology-remove",
          { equipmentId: req.params.equipmentId },
          principalName(req),
          key,
        );
        return reportConfigOutcome(
          res,
          submitted.created,
          currentEngine().topology.get(req.params.equipmentId) === undefined,
          { removed: true },
        );
      } catch (error) {
        return res.status(503).json(coordinationUnavailable(error));
      }
    }
    currentEngine().topology.remove(req.params.equipmentId);
    currentEngine().reconcileTopology();
    res.json({ removed: true, applied: true });
  },
);

// ── Suppression policy ─────────────────────────────────────────────────────

router.get("/suppression-policy", requireAlarmRead, (_req, res) => {
  res.json(currentEngine().getSuppressionPolicy());
});

/**
 * Turning suppression ON is the one mutation in this router that can stop an
 * operator from seeing an alarm, so it is gated twice: durable coordination
 * must be reporting healthy right now, or the operator must have explicitly
 * accepted a single-process evaluation via the env flag. Everything else about
 * the policy (the never-suppress floor) is always settable.
 */
router.put("/suppression-policy", requireAlarmConfigure, async (req, res) => {
  const parsed = SuppressionPolicySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  const health = await alarmCorrelationService.healthCheck();
  if (
    parsed.data.enabled === true
    && !health.durableSuppressionAvailable
    && !health.ephemeralSuppressionAllowed
  ) {
    return res.status(409).json({
      error:
        "Suppression is disabled until durable, replica-coordinated state reports "
        + "healthy. Start the server with ALARM_CORRELATION_DURABLE=true and a "
        + "reachable database, or set "
        + "ALARM_CORRELATION_ALLOW_EPHEMERAL_SUPPRESSION=true only for an "
        + "explicit single-process evaluation.",
      coordinationMode: health.coordinationMode,
      coordination: health.coordination,
    });
  }

  const coordinator = alarmCorrelationService.durableCoordinator;
  if (coordinator) {
    const key = idempotencyKey(req);
    if (key === null) return res.status(400).json({ error: IDEMPOTENCY_KEY_ERROR });
    try {
      await coordinator.submitConfig(
        "policy-set",
        { policy: parsed.data },
        principalName(req),
        key,
      );
    } catch (error) {
      return res.status(503).json(coordinationUnavailable(error));
    }
    return res.json(currentEngine().getSuppressionPolicy());
  }

  try {
    res.json(currentEngine().setSuppressionPolicy(parsed.data));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "invalid suppression policy",
    });
  }
});

// ── Metrics & status ───────────────────────────────────────────────────────

router.get("/metrics", requireAlarmRead, (_req, res) => {
  res.json(currentEngine().getMetrics());
});

router.get("/status", requireAlarmRead, async (_req, res) => {
  const health = await alarmCorrelationService.healthCheck();
  res.json({ ...currentEngine().getMetrics(), ...health });
});

/** Observable coordination health, for operators and for readiness probes. */
router.get("/coordination", requireAlarmRead, (_req, res) => {
  const coordinator = alarmCorrelationService.durableCoordinator;
  if (!coordinator) {
    return res.json({
      healthy: false,
      mode: "process-local",
      backend: "none",
      appliedSeq: 0,
      materializedSeq: 0,
      policyEnabledIntent: false,
      suppressionActive: currentEngine().getSuppressionPolicy().enabled,
      suppressionDisabledByHealth: false,
      lastError: null,
      lastHealthyAt: null,
      instanceId: "",
      detail:
        "Durable coordination is not enabled. Correlation state is process-local: "
        + "it is lost on restart and is not shared with other replicas.",
    });
  }
  res.json(coordinator.health());
});

export { router as alarmCorrelationRoutes };
