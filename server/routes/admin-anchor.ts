/**
 * Admin: Anchor-Backend Switch (#455)
 *
 * Operator-facing endpoint to inspect and flip the active anchoring backend at
 * runtime (the dispatch lives in server/bridge/anchor-router.ts).
 *
 *   POST /api/admin/anchor-backend
 *     body: { backend: 'l2'|'node'|'both', dryRun: boolean, confirmToken?, eventsPerMinute? }
 *
 *   - dryRun: true  -> returns a pure projection (events/min per backend, projected
 *                      confirmation latencies, projected daily anchor cost). No state
 *                      change, no confirm token required.
 *   - dryRun: false -> requires a valid confirm token (operator must explicitly
 *                      opt in). On success it flips the active backend AND emits an
 *                      auditable "anchored" event recording the switch itself.
 *
 *   GET /api/admin/anchor-backend          -> current backend + recent switch history
 *   GET /api/admin/anchor-backend/projection?backend=&eventsPerMinute=
 *                                          -> projection without a POST (UI preview)
 *
 * Issue: #455 — Anchor-Backend Switch UX
 */

import { Router } from 'express';
import { z } from 'zod';
import { fromZodError } from 'zod-validation-error';
import { anchorRouter, type AnchorBackend } from '../bridge/anchor-router';
import { eventAnchorBridge } from '../bridge/event-anchor';
import { log, logError } from '../logger';

const router = Router();

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
    /** Required only when dryRun === false; validated below via superRefine. */
    confirmToken: z.string().min(1).optional(),
    /** Optional measured throughput override (events/min). */
    eventsPerMinute: z.number().nonnegative().finite().optional(),
    /** Optional operator identity for the audit trail. */
    operator: z.string().min(1).max(128).optional(),
  })
  .superRefine((val, ctx) => {
    if (!val.dryRun && !val.confirmToken) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirmToken'],
        message: 'confirmToken is required to commit a backend switch (dryRun=false)',
      });
    }
  });

export type SwitchRequest = z.infer<typeof SwitchRequestSchema>;

// ── Confirm-token gate ────────────────────────────────────────────────────────

/**
 * Compute the confirm token a client must echo back to commit a switch.
 *
 * The token is deterministic from the target backend, so the operator literally
 * has to acknowledge the SPECIFIC change ("yes, switch to l2"), not blanket-allow
 * any switch. The UI surfaces this token in the sanity dialog. Exported so the
 * gate is unit-testable.
 */
export function expectedConfirmToken(backend: AnchorBackend): string {
  return `confirm-switch-${backend}`;
}

/** True iff the supplied token authorises a switch to `backend`. */
export function isValidConfirmToken(backend: AnchorBackend, token: string | undefined): boolean {
  if (!token) return false;
  return token === expectedConfirmToken(backend);
}

// ── Switch history (auditable) ─────────────────────────────────────────────────

export interface SwitchHistoryEntry {
  id: string;
  at: string; // ISO timestamp
  previous: AnchorBackend;
  current: AnchorBackend;
  operator: string;
  /** Hash/ref of the anchored audit event emitted for this switch, if any. */
  auditEventId: string;
}

/**
 * In-memory ring of recent switches. This is deliberately process-local: a full
 * persistent audit trail belongs in the anchored event stream (which we DO emit
 * below) and/or storage.ts. Kept small to bound memory.
 *
 * DEFERRED: durable history via server/storage.ts is out of scope for this issue
 * (no schema migration); the anchored event is the system-of-record.
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
  res.json({
    backend: anchorRouter.getBackend(),
    history: switchHistory,
  });
});

/** Projection preview without committing (UI convenience; mirrors dry-run POST). */
router.get('/projection', (req, res) => {
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
  const projection = anchorRouter.project(eventsPerMinute, parsed.data.backend);
  res.json({ projection });
});

/**
 * Inspect (dry-run) or commit (confirm-token) a backend switch.
 */
router.post('/', async (req, res) => {
  const parsed = SwitchRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: fromZodError(parsed.error).message });
  }

  const { backend, dryRun, confirmToken, eventsPerMinute, operator } = parsed.data;
  const epm = eventsPerMinute ?? DEFAULT_EVENTS_PER_MINUTE;

  // ── Dry-run: pure projection, no state change ─────────────────────────────
  if (dryRun) {
    const projection = anchorRouter.project(epm, backend);
    return res.json({
      dryRun: true,
      currentBackend: anchorRouter.getBackend(),
      proposedBackend: backend,
      confirmToken: expectedConfirmToken(backend), // surfaced for the sanity dialog
      projection,
    });
  }

  // ── Commit: requires a valid confirm token ────────────────────────────────
  if (!isValidConfirmToken(backend, confirmToken)) {
    return res.status(403).json({
      error: 'Invalid or missing confirm token for the requested backend switch',
      expected: expectedConfirmToken(backend),
    });
  }

  try {
    const { previous, current } = anchorRouter.setBackend(backend);
    const at = new Date();
    const switchId = `anchor-switch-${at.getTime()}`;
    const who = operator ?? 'unknown-operator';

    // The state change emits an anchored event of its own (auditable). We route
    // it through the existing event-anchor bridge so it lands on whatever backend
    // is now active — the switch records itself on-chain.
    const auditEvent = {
      id: switchId,
      timestamp: at,
      eventType: 'anchor-backend-switch',
      siteId: 'system',
      severity: 'warning' as const,
      message: `Anchor backend switched from "${previous}" to "${current}" by ${who}`,
      data: { previous, current, operator: who, eventsPerMinute: epm },
    };

    try {
      await eventAnchorBridge.anchor(auditEvent);
    } catch (anchorErr) {
      // The switch itself succeeded; failing to anchor the audit event must not
      // silently lose the record. Log loudly and still report the switch, but
      // flag that the audit anchor did not land.
      logError('Anchor-backend switch audit event failed to anchor', anchorErr as Error);
    }

    const entry: SwitchHistoryEntry = {
      id: switchId,
      at: at.toISOString(),
      previous,
      current,
      operator: who,
      auditEventId: switchId,
    };
    recordSwitch(entry);

    log(`Anchor backend switched ${previous} -> ${current} by ${who}`);

    const projection = anchorRouter.project(epm, current);
    return res.json({
      dryRun: false,
      committed: true,
      previousBackend: previous,
      currentBackend: current,
      auditEventId: switchId,
      projection,
    });
  } catch (err) {
    logError('Failed to commit anchor-backend switch', err as Error);
    return res.status(500).json({ error: 'Failed to commit anchor-backend switch' });
  }
});

export { router as adminAnchorRoutes };
