/**
 * Tests for NERC CIP Compliance Service
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ComplianceService,
  createComplianceService,
  CIP_REQUIREMENTS,
  CIP_STANDARDS,
  EVIDENCE_SOURCES,
  createEvidenceCollector,
  createGapAnalyzer,
  createReportGenerator,
} from '../services/compliance';

describe('NERC CIP Compliance Service', () => {
  let service: ComplianceService;

  beforeEach(() => {
    service = createComplianceService({
      autoCollectEvidence: false,
      alertsEnabled: false,
    });
  });

  describe('CIP Requirements Database', () => {
    it('should have all major CIP standards defined', () => {
      const standards = Object.keys(CIP_STANDARDS);
      expect(standards).toContain('CIP-002');
      expect(standards).toContain('CIP-003');
      expect(standards).toContain('CIP-004');
      expect(standards).toContain('CIP-005');
      expect(standards).toContain('CIP-007');
      expect(standards).toContain('CIP-010');
      expect(standards).toContain('CIP-011');
    });

    it('should have requirements for each standard', () => {
      const standards = ['CIP-002', 'CIP-003', 'CIP-004', 'CIP-005', 'CIP-007', 'CIP-010', 'CIP-011'];

      for (const standard of standards) {
        const requirements = service.getRequirements(standard as any);
        expect(requirements.length).toBeGreaterThan(0);
      }
    });

    it('should have valid requirement structure', () => {
      const requirement = CIP_REQUIREMENTS[0];

      expect(requirement).toHaveProperty('id');
      expect(requirement).toHaveProperty('standard');
      expect(requirement).toHaveProperty('section');
      expect(requirement).toHaveProperty('title');
      expect(requirement).toHaveProperty('description');
      expect(requirement).toHaveProperty('applicability');
      expect(requirement).toHaveProperty('priority');
      expect(requirement).toHaveProperty('evidenceSources');
      expect(requirement).toHaveProperty('controlMappings');
      expect(requirement).toHaveProperty('violationRisk');
      expect(requirement).toHaveProperty('remediationGuidance');
    });

    it('should have evidence sources defined', () => {
      expect(EVIDENCE_SOURCES.length).toBeGreaterThan(0);

      const source = EVIDENCE_SOURCES[0];
      expect(source).toHaveProperty('id');
      expect(source).toHaveProperty('type');
      expect(source).toHaveProperty('name');
      expect(source).toHaveProperty('description');
      expect(source).toHaveProperty('automatable');
    });
  });

  describe('Asset Management', () => {
    it('should register a BES Cyber Asset', () => {
      const asset = service.registerAsset({
        name: 'Control Server 1',
        type: 'cyber-asset',
        impactRating: 'high',
        description: 'Primary control server',
        location: 'Data Center A',
        owner: 'Operations',
        applicableStandards: ['CIP-005', 'CIP-007'],
        metadata: {},
      });

      expect(asset.id).toBeDefined();
      expect(asset.name).toBe('Control Server 1');
      expect(asset.impactRating).toBe('high');
      expect(asset.lastInventoryDate).toBeInstanceOf(Date);
    });

    it('should update a BES Cyber Asset', () => {
      const asset = service.registerAsset({
        name: 'Test Asset',
        type: 'cyber-system',
        impactRating: 'medium',
        description: 'Test',
        location: 'Test',
        owner: 'Test',
        applicableStandards: [],
        metadata: {},
      });

      const updated = service.updateAsset(asset.id, {
        impactRating: 'high',
        description: 'Updated description',
      });

      expect(updated?.impactRating).toBe('high');
      expect(updated?.description).toBe('Updated description');
    });

    it('should filter assets by impact rating', () => {
      service.registerAsset({
        name: 'High Impact Asset',
        type: 'cyber-asset',
        impactRating: 'high',
        description: 'Test',
        location: 'Test',
        owner: 'Test',
        applicableStandards: [],
        metadata: {},
      });

      service.registerAsset({
        name: 'Low Impact Asset',
        type: 'cyber-asset',
        impactRating: 'low',
        description: 'Test',
        location: 'Test',
        owner: 'Test',
        applicableStandards: [],
        metadata: {},
      });

      const highImpact = service.getAssetsByImpact('high');
      expect(highImpact.length).toBe(1);
      expect(highImpact[0].name).toBe('High Impact Asset');
    });
  });

  describe('Evidence Collector', () => {
    it('should create evidence collector', () => {
      const collector = createEvidenceCollector();
      expect(collector).toBeDefined();
    });

    it('should add manual evidence', () => {
      const collector = createEvidenceCollector();

      const artifact = collector.addManualEvidence(
        'audit-log-auth',
        'CIP-007-R4',
        { logs: 'sample log data' },
        'user-123'
      );

      expect(artifact.id).toBeDefined();
      expect(artifact.sourceId).toBe('audit-log-auth');
      expect(artifact.controlId).toBe('CIP-007-R4');
      expect(artifact.collector).toBe('manual');
      expect(artifact.collectorId).toBe('user-123');
      expect(artifact.hash).toBeDefined();
    });

    it('should verify evidence integrity', () => {
      const collector = createEvidenceCollector();

      const artifact = collector.addManualEvidence(
        'audit-log-auth',
        'CIP-007-R4',
        'test content',
        'user-123'
      );

      expect(collector.verifyEvidence(artifact)).toBe(true);
    });

    it('should export evidence as JSON', () => {
      const collector = createEvidenceCollector();

      collector.addManualEvidence(
        'audit-log-auth',
        'CIP-007-R4',
        'test content',
        'user-123'
      );

      const exported = collector.exportEvidence(['CIP-007-R4'], { format: 'json' });
      const parsed = JSON.parse(exported);

      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(1);
    });

    it('should export evidence as CSV', () => {
      const collector = createEvidenceCollector();

      collector.addManualEvidence(
        'audit-log-auth',
        'CIP-007-R4',
        'test content',
        'user-123'
      );

      const exported = collector.exportEvidence(undefined, { format: 'csv' });

      expect(exported).toContain('id,sourceId,controlId');
      expect(exported).toContain('CIP-007-R4');
    });
  });

  describe('Gap Analyzer', () => {
    it('should create gap analyzer', () => {
      const collector = createEvidenceCollector();
      const analyzer = createGapAnalyzer(collector);
      expect(analyzer).toBeDefined();
    });

    it('should identify controls without evidence as gaps', async () => {
      const collector = createEvidenceCollector();
      const analyzer = createGapAnalyzer(collector);

      const result = await analyzer.runAnalysis('high');

      // Without evidence, most controls should be gaps
      expect(result.metrics.gaps).toBeGreaterThan(0);
    });

    it('should calculate compliance metrics', async () => {
      const collector = createEvidenceCollector();
      const analyzer = createGapAnalyzer(collector);

      const result = await analyzer.runAnalysis('medium');

      expect(result.metrics).toHaveProperty('totalRequirements');
      expect(result.metrics).toHaveProperty('compliant');
      expect(result.metrics).toHaveProperty('partial');
      expect(result.metrics).toHaveProperty('gaps');
      expect(result.metrics).toHaveProperty('overallScore');
      expect(result.metrics.overallScore).toBeGreaterThanOrEqual(0);
      expect(result.metrics.overallScore).toBeLessThanOrEqual(100);
    });

    it('should generate prioritized gaps list', async () => {
      const collector = createEvidenceCollector();
      const analyzer = createGapAnalyzer(collector);

      const result = await analyzer.runAnalysis('medium');

      expect(result.prioritizedGaps).toBeDefined();
      expect(Array.isArray(result.prioritizedGaps)).toBe(true);

      if (result.prioritizedGaps.length > 1) {
        // Should be sorted by priority (descending)
        expect(result.prioritizedGaps[0].priority).toBeGreaterThanOrEqual(
          result.prioritizedGaps[1].priority
        );
      }
    });

    it('should generate remediation plan', async () => {
      const collector = createEvidenceCollector();
      const analyzer = createGapAnalyzer(collector);

      const result = await analyzer.runAnalysis('medium');
      const gapControl = result.controls.find((c) => c.status === 'gap');

      if (gapControl) {
        const plan = analyzer.generateRemediationPlan(gapControl, 'admin-user', 90);

        expect(plan.id).toBeDefined();
        expect(plan.controlId).toBe(gapControl.id);
        expect(plan.owner).toBe('admin-user');
        expect(plan.status).toBe('planned');
        expect(plan.steps.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Report Generator', () => {
    it('should create report generator', () => {
      const generator = createReportGenerator();
      expect(generator).toBeDefined();
    });

    it('should generate HTML report', async () => {
      const collector = createEvidenceCollector();
      const analyzer = createGapAnalyzer(collector);
      const generator = createReportGenerator();

      const result = await analyzer.runAnalysis('medium');
      const report = generator.generateAuditReport(result, {
        title: 'Test Compliance Report',
        includeEvidence: false,
        includeFindings: true,
        includeRemediation: false,
        includeHistory: false,
        format: 'html',
      });

      expect(report.id).toBeDefined();
      expect(report.contentType).toBe('text/html');
      expect(report.content).toBeDefined();
      expect(report.hash).toBeDefined();
    });

    it('should generate JSON report', async () => {
      const collector = createEvidenceCollector();
      const analyzer = createGapAnalyzer(collector);
      const generator = createReportGenerator();

      const result = await analyzer.runAnalysis('medium');
      const report = generator.generateAuditReport(result, {
        title: 'Test Compliance Report',
        includeEvidence: false,
        includeFindings: true,
        includeRemediation: false,
        includeHistory: false,
        format: 'json',
      });

      expect(report.contentType).toBe('application/json');

      const content = report.content.toString();
      const parsed = JSON.parse(content);
      expect(parsed.meta.title).toBe('Test Compliance Report');
    });

    it('should generate compliance dashboard', async () => {
      const collector = createEvidenceCollector();
      const analyzer = createGapAnalyzer(collector);
      const generator = createReportGenerator();

      const result = await analyzer.runAnalysis('medium');
      const dashboard = generator.generateDashboard(result);

      expect(dashboard.overallScore).toBeDefined();
      expect(dashboard.totalControls).toBeGreaterThan(0);
      expect(dashboard.byStandard).toBeDefined();
      expect(dashboard.lastUpdated).toBeInstanceOf(Date);
    });

    it('should generate executive summary', async () => {
      const collector = createEvidenceCollector();
      const analyzer = createGapAnalyzer(collector);
      const generator = createReportGenerator();

      const result = await analyzer.runAnalysis('medium');
      const summary = generator.generateExecutiveSummary(result);

      expect(summary).toContain('NERC CIP Compliance Executive Summary');
      expect(summary).toContain('Overall Compliance Score');
      expect(summary).toContain('Summary Statistics');
    });
  });

  describe('Compliance Service Integration', () => {
    it('should run full assessment', async () => {
      const result = await service.runAssessment('medium');

      expect(result.timestamp).toBeInstanceOf(Date);
      expect(result.impactRating).toBe('medium');
      expect(result.controls.length).toBeGreaterThan(0);
      expect(result.metrics).toBeDefined();
    });

    it('should create remediation plan through service', async () => {
      await service.runAssessment('medium');
      const status = service.getComplianceStatus();

      if (status.gaps.length > 0) {
        const plan = service.createRemediationPlan(
          status.gaps[0].id,
          'admin@example.com',
          60
        );

        expect(plan).toBeDefined();
        expect(plan?.owner).toBe('admin@example.com');
      }
    });

    it('should update remediation plan status', async () => {
      await service.runAssessment('medium');
      const status = service.getComplianceStatus();

      if (status.gaps.length > 0) {
        const plan = service.createRemediationPlan(
          status.gaps[0].id,
          'admin@example.com'
        );

        if (plan) {
          const updated = service.updateRemediationPlan(plan.id, {
            status: 'in-progress',
          });

          expect(updated?.status).toBe('in-progress');
        }
      }
    });

    it('should generate report through service', async () => {
      const result = await service.runAssessment('medium');

      const report = service.generateReport(result, {
        title: 'Q1 Compliance Report',
        format: 'html',
        includeEvidence: false,
        includeFindings: true,
        includeRemediation: true,
        includeHistory: false,
        preparedBy: 'Compliance Team',
      });

      expect(report.id).toBeDefined();
      expect(report.metadata.controlsAssessed).toBeGreaterThan(0);
    });

    it('should generate dashboard through service', async () => {
      const result = await service.runAssessment('high');
      const dashboard = service.generateDashboard(result);

      expect(dashboard.overallScore).toBeGreaterThanOrEqual(0);
      expect(dashboard.totalControls).toBeGreaterThan(0);
      expect(dashboard.byStandard).toBeDefined();
    });
  });
});

describe('Requirement Applicability', () => {
  it('should filter requirements by high impact', () => {
    const service = createComplianceService();
    const highImpactReqs = CIP_REQUIREMENTS.filter((r) => r.applicability.highImpact);

    expect(highImpactReqs.length).toBeGreaterThan(0);
  });

  it('should filter requirements by medium impact', () => {
    const mediumImpactReqs = CIP_REQUIREMENTS.filter((r) => r.applicability.mediumImpact);

    expect(mediumImpactReqs.length).toBeGreaterThan(0);
  });

  it('should filter requirements by low impact', () => {
    const lowImpactReqs = CIP_REQUIREMENTS.filter((r) => r.applicability.lowImpact);

    // Low impact has fewer requirements
    expect(lowImpactReqs.length).toBeGreaterThan(0);
    expect(lowImpactReqs.length).toBeLessThanOrEqual(
      CIP_REQUIREMENTS.filter((r) => r.applicability.highImpact).length
    );
  });
});
