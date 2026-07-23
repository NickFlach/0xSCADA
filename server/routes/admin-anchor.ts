/**
 * Admin: Anchor-Backend Switch (#455)
 *
 * Operator-facing endpoint to inspect and flip the active anchoring backend at
 * runtime (production dispatch lives in server/bridge/index.ts).
 *
 *   POST /api/admin/anchor-backend
 *     body: {
 *       backend: 'l2'|'node'|'both',
 *       dryRun: boolean,
 *       confirm?,
 *       expectedCurrentBackend?,
 *       expectedBackendRevision?,
 *       eventsPerMinute?
 *     }
 *
 *   - dryRun: true  -> returns a pure projection (events/min per backend, projected
 *                      confirmation latencies, projected daily anchor cost). No state
 *                      change, no confirm token required.
 *   - dryRun: false -> requires an explicit `confirm: true` acknowledgement.
 *                      Authentication + `anchor.admin` authorization is the
 *                      security boundary; no public confirmation secret exists.
 *                      The commit must echo the backend + revision returned by
 *                      its dry-run; stale previews fail with HTTP 409.
 *                      On success it queues an authorized switch intent through
 *                      the target backend(s), then flips the active backend.
 *
 *   GET /api/admin/anchor-backend          -> current backend + recent switch history
 *   GET /api/admin/anchor-backend/projection?backend=&eventsPerMinute=
 *                                          -> projection without a POST (UI preview)
 *
 * Issue: #455 — Anchor-Backend Switch UX
 */

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fromZodError } from 'zod-validation-error/v3';
import { anchorSwitch, type AnchorBackend } from '../bridge/anchor-switch';
import {
  dispatchAnchorAuditEvent,
  isAnchorBackendRuntimeReady,
  prepareAnchorBackendRuntime,
} from '../bridge';
import {
  getAnchorBackendCoordinationStatus,
  getAnchorBackendSnapshot,
} from '../bridge/anchor-backend';
import { log, logError } from '../logger';
import {
  controlPlanePrincipal,
  requireControlPlaneAccess,
} from '../middleware/control-plane-auth';

const router = Router();
router.use(requireControlPlaneAccess({ roles: ['operator'] }));
const requireAnchorAdmin = requireControlPlaneAccess({
  roles: ['operator'],
  scopes: ['anchor.admin'],
});

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * Default sustained throughput used for projections when the caller does not
 * supply a measured value. In production this would be sourced from metrics.
 * INTEGRATION (#443): wire to the real events/min metric when available.
 */
const DEFAULT_EVENTS_PER_MINUTE = 120;

const BackendEnum = z.enum(['l2', 'node', 'both']);

// ── Validation schemas ────────────────────────────────────────────────────────

const SwitchRequestSchema = z
  .object({
    backend: BackendEnum,
    dryRun: z.boolean(),
    /** Explicit safety acknowledgement; required only for a real commit. */
    confirm: z.boolean().optional(),
    /** Backend value shown by the dry-run the operator is confirming. */
    expectedCurrentBackend: BackendEnum.optional(),
    /** Optimistic-concurrency revision returned by that dry-run. */
    expectedBackendRevision: z.number().int().nonnegative().optional(),
    /** Optional measured throughput override (events/min). */
    eventsPerMinute: z.number().nonnegative().finite().optional(),
  })
  .superRefine((val, ctx) => {
    if (!val.dryRun && val.confirm !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirm'],
        message: 'confirm must be true to commit a backend switch (dryRun=false)',
      });
    }
    if (!val.dryRun && val.expectedCurrentBackend === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectedCurrentBackend'],
        message: 'expectedCurrentBackend from a dry-run is required to commit a backend switch',
      });
    }
    if (!val.dryRun && val.expectedBackendRevision === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectedBackendRevision'],
        message: 'expectedBackendRevision from a dry-run is required to commit a backend switch',
      });
    }
  });

export type SwitchRequest = z.infer<typeof SwitchRequestSchema>;

// ── Switch history (auditable) ─────────────────────────────────────────────────

export interface SwitchHistoryEntry {
  id: string;
  at: string; // ISO timestamp
  previous: AnchorBackend;
  current: AnchorBackend;
  operator: string;
  /** Correlation ID accepted by the selected backend queue(s). */
  auditQueueId: string;
  /** Queue acceptance is not a claim of durable storage or chain confirmation. */
  auditStatus: 'queued';
}

/**
 * In-memory ring of recent committed switches. Backend audit delivery is only
 * queue-acknowledged here; durable history/confirmation requires a separate
 * persistence and receipt mechanism. Kept small to bound memory.
 */
const MAX_HISTORY = 50;
const switchHistory: SwitchHistoryEntry[] = [];

export function getSwitchHistory(): readonly SwitchHistoryEntry[] {
  return switchHistory;
}

function recordSwitch(entry: SwitchHistoryEntry): void {
  switchHistory.unshift(entry);
  if (switchHistory.length > MAX_HISTORY) {
    switchHistory.length = MAX_HISTORY;
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

/** Current active backend + recent switch history. */
router.get('/', (_req, res) => {
  const snapshot = getAnchorBackendSnapshot();
  res.json({
    backend: snapshot.backend,
    backendRevision: snapshot.revision,
    history: switchHistory,
  });
});

/** Projection preview without committing (UI convenience; mirrors dry-run POST). */
router.get('/projection', async (req, res) => {
  const parsed = z
    .object({
      backend: BackendEnum.default('both'),
      eventsPerMinute: z.coerce.number().nonnegative().finite().optional(),
    })
    .safeParse(req.query);

  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }

  const eventsPerMinute = parsed.data.eventsPerMinute ?? DEFAULT_EVENTS_PER_MINUTE;
  const projection = anchorSwitch.project(eventsPerMinute, parsed.data.backend);
  const coordination = getAnchorBackendCoordinationStatus();
  const snapshot = getAnchorBackendSnapshot();
  const runtimeReady =
    coordination.ready &&
    await isAnchorBackendRuntimeReady(parsed.data.backend);
  res.json({
    currentBackend: snapshot.backend,
    backendRevision: snapshot.revision,
    projection,
    coordination,
    runtimeReady,
    runtimePreparationSupported: parsed.data.backend !== 'node',
  });
});

/**
 * Inspect (dry-run) or commit an explicitly acknowledged backend switch.
 */
router.post('/', requireAnchorAdmin, async (req, res) => {
  const parsed = SwitchRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }

  const {
    backend,
    dryRun,
    eventsPerMinute,
    expectedCurrentBackend,
    expectedBackendRevision,
  } = parsed.data;
  const epm = eventsPerMinute ?? DEFAULT_EVENTS_PER_MINUTE;

  // ── Dry-run: pure projection, no state change ─────────────────────────────
  if (dryRun) {
    const projection = anchorSwitch.project(epm, backend);
    const coordination = getAnchorBackendCoordinationStatus();
    const snapshot = getAnchorBackendSnapshot();
    const runtimeReady =
      coordination.ready &&
      await isAnchorBackendRuntimeReady(backend);
    return res.json({
      dryRun: true,
      currentBackend: snapshot.backend,
      backendRevision: snapshot.revision,
      proposedBackend: backend,
      coordination,
      runtimeReady,
      runtimePreparationSupported: backend !== 'node',
      projection,
    });
  }

  try {
    return await anchorSwitch.runCommitExclusive(async () => {
      // Switch commits are optimistic transactions over the exact state shown
      // by the dry-run. This check lives inside the commit mutex so a later
      // operator request cannot be silently reinterpreted against newer state.
      const expectedSnapshot = {
        backend: expectedCurrentBackend!,
        revision: expectedBackendRevision!,
      };
      let currentSnapshot = getAnchorBackendSnapshot();
      if (
        currentSnapshot.backend !== expectedSnapshot.backend ||
        currentSnapshot.revision !== expectedSnapshot.revision
      ) {
        return res.status(409).json({
          error: 'Anchor backend changed since the dry-run; run a new dry-run before committing',
          code: 'anchor-backend-preview-stale',
          committed: false,
          expectedBackend: expectedSnapshot.backend,
          expectedBackendRevision: expectedSnapshot.revision,
          currentBackend: currentSnapshot.backend,
          currentBackendRevision: currentSnapshot.revision,
        });
      }

      const coordination = getAnchorBackendCoordinationStatus();
      if (!coordination.ready) {
        return res.status(503).json({
          error: coordination.reason,
          code: 'anchor-backend-coordination-unavailable',
          replicas: coordination.replicas,
        });
      }

      // A node-booted process may safely prepare a hidden L2 pipeline here.
      // Canonical routing remains unchanged unless every selected backend is
      // connected and accepts the authorized intent below.
      if (!await prepareAnchorBackendRuntime(backend)) {
        currentSnapshot = getAnchorBackendSnapshot();
        return res.status(503).json({
          error: `Anchor backend "${backend}" is not initialized`,
          code: 'anchor-backend-unavailable',
          backend,
          committed: false,
          currentBackend: currentSnapshot.backend,
          currentBackendRevision: currentSnapshot.revision,
        });
      }

      // Preparation can await network I/O. Revalidate the preview before
      // queueing any audit intent in case a non-control-plane writer changed
      // the canonical store while this request held the route-local mutex.
      currentSnapshot = getAnchorBackendSnapshot();
      if (
        currentSnapshot.backend !== expectedSnapshot.backend ||
        currentSnapshot.revision !== expectedSnapshot.revision
      ) {
        return res.status(409).json({
          error: 'Anchor backend changed while the target runtime was being prepared',
          code: 'anchor-backend-state-changed',
          committed: false,
          expectedBackend: expectedSnapshot.backend,
          expectedBackendRevision: expectedSnapshot.revision,
          currentBackend: currentSnapshot.backend,
          currentBackendRevision: currentSnapshot.revision,
        });
      }

      const previous = expectedSnapshot.backend;
      const at = new Date();
      const auditQueueId = `anchor-switch-${randomUUID()}`;
      const who = controlPlanePrincipal(req).name;
      const auditEvent = {
        id: auditQueueId,
        timestamp: at,
        eventType: 'anchor-backend-switch-intent',
        siteId: 'system',
        severity: 'warning' as const,
        message: `Authorized anchor backend switch intent from "${previous}" to "${backend}" by ${who}`,
        data: {
          previous,
          requestedBackend: backend,
          operator: who,
          eventsPerMinute: epm,
          expectedBackendRevision: expectedSnapshot.revision,
          intent: 'authorized-switch',
        },
      };

      let auditDispatch: Awaited<ReturnType<typeof dispatchAnchorAuditEvent>>;
      try {
        auditDispatch = await dispatchAnchorAuditEvent(backend, auditEvent);
      } catch (anchorErr) {
        // Queue before mutation: rejection leaves routing untouched, so there is
        // no rollback that could overwrite a later operator request.
        logError(anchorErr, 'Anchor-backend switch intent was rejected before routing changed');
        currentSnapshot = getAnchorBackendSnapshot();
        return res.status(502).json({
          error: 'Anchor-backend switch audit queueing failed',
          code: 'anchor-audit-delivery-failed',
          committed: false,
          currentBackend: currentSnapshot.backend,
          currentBackendRevision: currentSnapshot.revision,
        });
      }

      // Connectivity can change while the intent is being queued. Re-check
      // every selected backend before exposing it as the active route.
      if (!await isAnchorBackendRuntimeReady(backend)) {
        currentSnapshot = getAnchorBackendSnapshot();
        return res.status(503).json({
          error: `Anchor backend "${backend}" became unavailable before commit`,
          code: 'anchor-backend-unavailable',
          backend,
          committed: false,
          currentBackend: currentSnapshot.backend,
          currentBackendRevision: currentSnapshot.revision,
          auditQueueId: auditDispatch.auditQueueId,
          auditStatus: auditDispatch.auditStatus,
        });
      }

      // Guard against any out-of-band writer, including ABA changes that return
      // to the same backend value. The queued event remains a truthful intent.
      currentSnapshot = getAnchorBackendSnapshot();
      if (
        currentSnapshot.backend !== expectedSnapshot.backend ||
        currentSnapshot.revision !== expectedSnapshot.revision
      ) {
        return res.status(409).json({
          error: 'Anchor backend changed while the switch intent was queued',
          code: 'anchor-backend-state-changed',
          committed: false,
          currentBackend: currentSnapshot.backend,
          currentBackendRevision: currentSnapshot.revision,
          auditQueueId: auditDispatch.auditQueueId,
          auditStatus: auditDispatch.auditStatus,
        });
      }

      const { previous: committedPrevious, current } = anchorSwitch.setBackend(backend);
      const committedSnapshot = getAnchorBackendSnapshot();
      const entry: SwitchHistoryEntry = {
        id: auditQueueId,
        at: at.toISOString(),
        previous: committedPrevious,
        current,
        operator: who,
        auditQueueId: auditDispatch.auditQueueId,
        auditStatus: auditDispatch.auditStatus,
      };
      recordSwitch(entry);

      log(`Anchor backend switched ${committedPrevious} -> ${current} by ${who}`);

      const projection = anchorSwitch.project(epm, current);
      return res.json({
        dryRun: false,
        committed: true,
        previousBackend: committedPrevious,
        currentBackend: current,
        backendRevision: committedSnapshot.revision,
        auditQueueId: auditDispatch.auditQueueId,
        auditStatus: auditDispatch.auditStatus,
        projection,
      });
    });
  } catch (err) {
    logError(err, 'Failed to commit anchor-backend switch');
    return res.status(500).json({ error: 'Failed to commit anchor-backend switch' });
  }
});

export { router as adminAnchorRoutes };
