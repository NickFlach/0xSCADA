import { Router } from 'express';
import { rateLimit as expressRateLimit } from 'express-rate-limit';
import { z } from 'zod';
import {
  RemediationAuditPersistenceError,
  RemediationRuntimeUnavailableError,
  remediationRuntime,
  sloRegistry,
} from '../services/sre';
import {
  controlPlanePrincipal,
  requireControlPlaneAccess,
} from '../middleware/control-plane-auth';
import { rateLimitMiddleware } from '../middleware/api-gateway';

const router = Router();

const SloEvaluationSchema = z.object({
  observations: z.array(z.object({
    timestamp: z.string().datetime({ offset: true }),
    goodEvents: z.number().int().nonnegative(),
    totalEvents: z.number().int().nonnegative(),
  })),
});

const RemediationExecuteSchema = z.discriminatedUnion('actionId', [
  z.object({
    actionId: z.literal('gateway-failover'),
    context: z.object({
      gatewayId: z.string().trim().min(1).max(200),
    }),
    idempotencyKey: z.string().trim().min(1).max(200),
    dryRun: z.boolean().default(true),
  }),
  z.object({
    actionId: z.literal('scale-out'),
    context: z.object({
      component: z.string().trim().min(1).max(200),
      desiredReplicas: z.number().int().min(1).max(10_000),
      maximumReplicas: z.number().int().min(1).max(10_000),
    }),
    idempotencyKey: z.string().trim().min(1).max(200),
    dryRun: z.boolean().default(true),
  }),
]);

const requireRemediationOperator = requireControlPlaneAccess({
  roles: ['operator'],
  scopes: ['sre.remediate'],
});
// Pair a per-process fail-safe with the shared limiter so requests remain
// bounded if its backend degrades. Both guards run before authentication.
const remediationStatusRateLimit = rateLimitMiddleware({
  windowMs: 60_000,
  maxRequests: 60,
});
const remediationStatusProcessRateLimit = expressRateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: false,
  legacyHeaders: true,
});
const remediationExecuteRateLimit = rateLimitMiddleware({
  windowMs: 60_000,
  maxRequests: 10,
});
const remediationExecuteProcessRateLimit = expressRateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: false,
  legacyHeaders: true,
});

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map(issue => `${issue.path.join('.') || 'request'}: ${issue.message}`)
      .join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

router.get('/sre/slos', (_req, res) => {
  res.json({ slos: sloRegistry.list() });
});

router.post('/sre/slos/:sloId/evaluate', (req, res) => {
  try {
    const request = SloEvaluationSchema.parse(req.body);
    res.json(sloRegistry.evaluate(req.params.sloId, request.observations));
  } catch (error) {
    const status = error instanceof Error && error.message.startsWith('Unknown SLO') ? 404 : 400;
    res.status(status).json({ error: errorMessage(error) });
  }
});

router.get(
  '/sre/remediations/status',
  remediationStatusProcessRateLimit,
  remediationStatusRateLimit,
  requireRemediationOperator,
  (_req, res) => {
    const status = remediationRuntime.status();
    res.status(status.configured ? 200 : 503).json(status);
  },
);

router.post(
  '/sre/remediations/execute',
  remediationExecuteProcessRateLimit,
  remediationExecuteRateLimit,
  requireRemediationOperator,
  async (req, res) => {
    try {
      const request = RemediationExecuteSchema.parse(req.body);
      const principal = controlPlanePrincipal(req);
      const result = await remediationRuntime.execute({
        ...request,
        // Approval/audit identity is always server-bound. A body/header supplied
        // identity cannot authorize its own remediation.
        approvedBy: principal.name,
      });
      res.json(result);
    } catch (error) {
      const status = error instanceof RemediationRuntimeUnavailableError
        ? 503
        : error instanceof RemediationAuditPersistenceError
          ? 500
          : 400;
      res.status(status).json({ error: errorMessage(error) });
    }
  },
);

export { router as sreReadinessRoutes };
