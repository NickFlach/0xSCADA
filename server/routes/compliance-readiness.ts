import { Router } from 'express';
import { z } from 'zod';
import { complianceService } from '../services/compliance';

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

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map(issue => `${issue.path.join('.') || 'request'}: ${issue.message}`)
      .join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

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
      evidenceRequirements: complianceService.getEvidenceRequirements(),
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

export { router as complianceReadinessRoutes };
