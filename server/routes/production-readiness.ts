import { Router } from 'express';
import { z } from 'zod';
import { complianceService } from '../services/compliance';
import { capacityPlanner, type CapacityWorkload } from '../services/capacity';
import { sloRegistry } from '../services/sre';

const router = Router();

const EvidenceValueSchema = z.union([
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(z.string()),
]);

const ComplianceEvidenceSchema = z.object({
  key: z.string().min(1),
  value: EvidenceValueSchema,
  source: z.string().min(1),
  collectedAt: z.string().datetime({ offset: true }).optional(),
  description: z.string().optional(),
});

const ComplianceScanSchema = z.object({
  scope: z.enum(['full', 'incremental', 'targeted']).default('full'),
  frameworks: z.array(z.enum(['IEC-62443', 'NIST-CSF'])).min(1)
    .default(['IEC-62443', 'NIST-CSF']),
  targetSecurityLevel: z.number().int().min(1).max(4).default(2),
  evidence: z.array(ComplianceEvidenceSchema).default([]),
  /** Legacy name retained for API compatibility; these are control ids. */
  rules: z.array(z.string().min(1)).optional(),
  controlIds: z.array(z.string().min(1)).optional(),
  target: z.string().min(1).optional(),
  schedule: z.boolean().default(false),
}).superRefine((value, context) => {
  if (value.schedule) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['schedule'],
      message: 'Use COMPLIANCE_SCAN_INTERVAL_MS for server-managed recurring scans',
    });
  }
  if (value.scope === 'targeted'
    && value.controlIds === undefined
    && value.rules === undefined
    && value.target === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['controlIds'],
      message: 'A targeted scan requires controlIds, rules, or target',
    });
  }
});

const AuditReportSchema = z.object({
  organization: z.string().min(1),
  auditor: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
});

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

const SloEvaluationSchema = z.object({
  observations: z.array(z.object({
    timestamp: z.string().datetime({ offset: true }),
    goodEvents: z.number().int().nonnegative(),
    totalEvents: z.number().int().nonnegative(),
  })),
});

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map(issue => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ');
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

// ── Compliance certification toolkit (#225) ────────────────────────────────

router.post('/compliance/scan', async (req, res) => {
  try {
    const request = ComplianceScanSchema.parse(req.body);
    const selectedIds = request.controlIds
      ?? request.rules
      ?? (request.target === undefined ? undefined : [request.target]);
    const result = await complianceService.scan({
      frameworks: request.frameworks,
      targetSecurityLevel: request.targetSecurityLevel as 1 | 2 | 3 | 4,
      controlIds: selectedIds,
      evidence: request.evidence.map(evidence => ({
        ...evidence,
        collectedAt: evidence.collectedAt ?? new Date().toISOString(),
      })),
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

router.get('/compliance/scans', (req, res) => {
  try {
    const limit = z.coerce.number().int().min(1).max(100).default(20).parse(req.query.limit);
    res.json({ scans: complianceService.getScans(limit) });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

router.get('/compliance/findings/:scanId', (req, res) => {
  const scan = complianceService.getScan(req.params.scanId);
  if (scan === undefined) {
    res.status(404).json({ error: `Unknown compliance scan: ${req.params.scanId}` });
    return;
  }
  res.json({ scanId: scan.scanId, findings: scan.gaps, summary: scan.summary });
});

router.get('/compliance/rules', (req, res) => {
  try {
    const framework = z.enum(['IEC-62443', 'NIST-CSF']).optional().parse(req.query.framework);
    res.json({
      catalogVersion: complianceService.getStatus().catalogVersion,
      rules: complianceService.getControls(framework),
    });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

router.post('/compliance/reports/:scanId', (req, res) => {
  try {
    const options = AuditReportSchema.parse(req.body);
    res.json(complianceService.generateAuditReport(req.params.scanId, options));
  } catch (error) {
    const status = error instanceof Error && error.message.startsWith('Unknown compliance scan')
      ? 404
      : 400;
    res.status(status).json({ error: errorMessage(error) });
  }
});

// ── Capacity planning and cost modeling (#228) ──────────────────────────────

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

// ── SLO/SLI evaluation (#226) ───────────────────────────────────────────────

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

export { router as productionReadinessRoutes };
