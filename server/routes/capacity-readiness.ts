import { Router } from 'express';
import { z } from 'zod';
import { capacityPlanner, type CapacityWorkload } from '../services/capacity';

const router = Router();

const WorkloadSchema = z.object({
  tagCount: z.number().int().min(1).max(100_000_000),
  sampleIntervalSeconds: z.number().min(0.05).max(86_400).optional(),
  retentionDays: z.number().int().min(1).max(3_650).optional(),
  headroomPercent: z.number().min(0).max(300).optional(),
  highAvailability: z.boolean().optional(),
  historianCopies: z.number().int().min(1).max(5).optional(),
  subscriberFanout: z.number().min(0).max(10_000).optional(),
});

const HistoryPointSchema = z.object({
  timestamp: z.string().datetime({ offset: true }),
  tagCount: z.number().int().min(0).max(100_000_000),
});

/**
 * Accepts both the new explicit workload envelope and the original governance
 * route's root/constraints shape. Unlike the old route, tag count is required:
 * the server will not manufacture a capacity forecast from placeholder data.
 */
const CapacityPlanningSchema = z.object({
  workload: WorkloadSchema.optional(),
  tagCount: z.number().int().min(1).max(100_000_000).optional(),
  sampleIntervalSeconds: z.number().min(0.05).max(86_400).optional(),
  retentionDays: z.number().int().min(1).max(3_650).optional(),
  headroomPercent: z.number().min(0).max(300).optional(),
  highAvailability: z.boolean().optional(),
  historianCopies: z.number().int().min(1).max(5).optional(),
  subscriberFanout: z.number().min(0).max(10_000).optional(),
  history: z.array(HistoryPointSchema).min(2).optional(),
  historicalTagCounts: z.array(HistoryPointSchema).min(2).optional(),
  horizonMonths: z.number().int().min(1).max(120).optional(),
  providers: z.array(z.enum(['aws', 'azure', 'gcp'])).min(1).optional(),
  // Legacy request fields:
  timeHorizon: z.enum(['short', 'medium', 'long']).optional(),
  scenario: z.enum(['current', 'growth', 'stress']).optional(),
  metrics: z.array(z.string()).optional(),
  constraints: z.record(z.unknown()).optional(),
});

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map(issue => `${issue.path.join('.') || 'request'}: ${issue.message}`)
      .join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

function constraintNumber(
  constraints: Readonly<Record<string, unknown>> | undefined,
  field: string,
): number | undefined {
  const value = constraints?.[field];
  return typeof value === 'number' ? value : undefined;
}

function resolveCapacityWorkload(
  request: z.infer<typeof CapacityPlanningSchema>,
): CapacityWorkload {
  if (request.workload !== undefined) return request.workload;
  const tagCount = request.tagCount ?? constraintNumber(request.constraints, 'tagCount');
  if (tagCount === undefined) {
    throw new Error('tagCount is required in workload, at the request root, or in constraints');
  }
  return {
    tagCount,
    sampleIntervalSeconds: request.sampleIntervalSeconds
      ?? constraintNumber(request.constraints, 'sampleIntervalSeconds'),
    retentionDays: request.retentionDays
      ?? constraintNumber(request.constraints, 'retentionDays'),
    headroomPercent: request.headroomPercent
      ?? constraintNumber(request.constraints, 'headroomPercent')
      ?? (request.scenario === 'stress' ? 60 : undefined),
    highAvailability: request.highAvailability,
    historianCopies: request.historianCopies
      ?? constraintNumber(request.constraints, 'historianCopies'),
    subscriberFanout: request.subscriberFanout
      ?? constraintNumber(request.constraints, 'subscriberFanout'),
  };
}

router.post('/capacity/plan', (req, res) => {
  try {
    const request = CapacityPlanningSchema.parse(req.body);
    const workload = resolveCapacityWorkload(request);
    const history = request.history ?? request.historicalTagCounts;
    const horizonMonths = request.horizonMonths
      ?? (request.timeHorizon === 'short' ? 1 : request.timeHorizon === 'long' ? 12 : 6);
    res.json(capacityPlanner.createPlan({
      workload,
      history,
      horizonMonths,
      providers: request.providers,
    }));
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

router.get('/capacity/model', (_req, res) => {
  res.json({
    resourceCoefficients: capacityPlanner.getCoefficients(),
    cloudRateCards: capacityPlanner.getRateCards(),
  });
});

router.get('/capacity/current', (req, res) => {
  try {
    const workload = WorkloadSchema.parse({
      tagCount: z.coerce.number().parse(req.query.tagCount),
      sampleIntervalSeconds: req.query.sampleIntervalSeconds === undefined
        ? undefined
        : z.coerce.number().parse(req.query.sampleIntervalSeconds),
      retentionDays: req.query.retentionDays === undefined
        ? undefined
        : z.coerce.number().parse(req.query.retentionDays),
    });
    res.json(capacityPlanner.estimateResources(workload));
  } catch (error) {
    res.status(400).json({
      error: `A valid tagCount query parameter is required: ${errorMessage(error)}`,
    });
  }
});

router.post('/capacity/forecast', (req, res) => {
  try {
    const request = z.object({
      history: z.array(HistoryPointSchema).min(2),
      horizonMonths: z.number().int().min(1).max(120).default(6),
    }).parse(req.body);
    res.json(capacityPlanner.forecastGrowth(request.history, request.horizonMonths));
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

// Prevent the legacy placeholder handler from returning fabricated trend data.
router.get('/capacity/trends', (_req, res) => {
  res.status(400).json({
    error: 'Historical observations are required; use POST /capacity/forecast',
  });
});

export { router as capacityReadinessRoutes };
