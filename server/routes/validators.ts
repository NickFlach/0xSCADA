/**
 * Validator Dashboard API (issue #453).
 *
 *   GET /api/validators — aggregated, server-polled view of the oxscada
 *   validator set configured in `ANCHOR_NODE_URLS`.
 *
 * WHY THIS EXISTS AS A PROXY
 * The dashboard used to poll each node's `:9090` RPC straight from the browser.
 * That breaks the moment the UI is served over TLS (blocked mixed content) and
 * it forces every node to run permissive CORS. Polling here means the browser
 * only ever issues a same-origin request, and node URLs never leave the server.
 *
 * AUTH: guarded by the repository's real control-plane guard at a read scope.
 * The node fleet's topology and health is operational intelligence, so the route
 * fails closed for anonymous callers.
 *
 * PROVENANCE: the aggregate is unsigned node-reported telemetry. The response
 * carries an explicit `provenance` block with `verified: false` and the UI
 * renders it; see shared/types/services/validator-dashboard.ts.
 */

import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';

import { getValidatorOverview } from '../blockchain/validator-dashboard';
import { logError } from '../logger';
import { requireControlPlaneAccess } from '../middleware/control-plane-auth';

const router = Router();

const requireValidatorRead = requireControlPlaneAccess({
  scopes: ['validators.read'],
});

/** Express 4 does not catch async rejections — wrap every async handler. */
function asyncHandler(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res) => {
    fn(req, res).catch((error: unknown) => {
      logError(error, 'validator dashboard request failed');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to collect validator overview' });
      }
    });
  };
}

router.get(
  '/',
  requireValidatorRead,
  asyncHandler(async (_req, res) => {
    // getValidatorOverview never rejects on a node failure: unreachable nodes
    // are reported per-node so one dead validator cannot 500 the dashboard.
    const overview = await getValidatorOverview();
    res.json(overview);
  }),
);

export { router as validatorRoutes };
