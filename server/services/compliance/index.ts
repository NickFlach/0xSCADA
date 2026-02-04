/**
 * NERC CIP Compliance Service
 *
 * Main entry point for the NERC CIP compliance module.
 * Provides compliance mapping, evidence collection, gap analysis,
 * and automated reporting for electric utility operators.
 */

import {
  AuditReport,
  AuditReportConfig,
  BESCyberAsset,
  CIPStandard,
  ComplianceAlert,
  ComplianceControl,
  ComplianceDashboard,
  ComplianceFinding,
  ComplianceServiceConfig,
  ImpactRating,
  RemediationPlan,
} from './types';
import {
  CIP_REQUIREMENTS,
  CIP_STANDARDS,
  EVIDENCE_SOURCES,
  getRequirementById,
  getRequirementsByImpact,
  getRequirementsByStandard,
} from './cip-requirements';
import { EvidenceCollector, createEvidenceCollector } from './evidence-collector';
import { GapAnalyzer, GapAnalysisResult, createGapAnalyzer } from './gap-analyzer';
import { ReportGenerator, createReportGenerator } from './report-generator';
import crypto from 'crypto';

/**
 * NERC CIP Compliance Service
 *
 * Central service for managing NERC CIP compliance assessments,
 * evidence collection, gap analysis, and reporting.
 */
export class ComplianceService {
  private config: ComplianceServiceConfig;
  private evidenceCollector: EvidenceCollector;
  private gapAnalyzer: GapAnalyzer;
  private reportGenerator: ReportGenerator;
  private assets: Map<string, BESCyberAsset> = new Map();
  private alerts: ComplianceAlert[] = [];
  private remediationPlans: Map<string, RemediationPlan> = new Map();

  constructor(config?: Partial<ComplianceServiceConfig>) {
    this.config = {
      assessmentIntervalDays: 90,
      evidenceRetentionDays: 1095, // 3 years per NERC requirements
      autoCollectEvidence: true,
      alertsEnabled: true,
      defaultImpactRating: 'medium',
      reportStoragePath: './reports/compliance',
      ...config,
    };

    this.evidenceCollector = createEvidenceCollector({
      retentionDays: this.config.evidenceRetentionDays,
    });
    this.gapAnalyzer = createGapAnalyzer(this.evidenceCollector);
    this.reportGenerator = createReportGenerator();
  }

  // ==================== Asset Management ====================

  /**
   * Register a BES Cyber Asset
   */
  registerAsset(asset: Omit<BESCyberAsset, 'id' | 'lastInventoryDate'>): BESCyberAsset {
    const fullAsset: BESCyberAsset = {
      ...asset,
      id: crypto.randomUUID(),
      lastInventoryDate: new Date(),
    };
    this.assets.set(fullAsset.id, fullAsset);
    return fullAsset;
  }

  /**
   * Update a BES Cyber Asset
   */
  updateAsset(id: string, updates: Partial<BESCyberAsset>): BESCyberAsset | undefined {
    const asset = this.assets.get(id);
    if (!asset) return undefined;

    const updated = { ...asset, ...updates, lastInventoryDate: new Date() };
    this.assets.set(id, updated);
    return updated;
  }

  /**
   * Get all registered assets
   */
  getAssets(): BESCyberAsset[] {
    return Array.from(this.assets.values());
  }

  /**
   * Get assets by impact rating
   */
  getAssetsByImpact(rating: ImpactRating): BESCyberAsset[] {
    return Array.from(this.assets.values()).filter((a) => a.impactRating === rating);
  }

  // ==================== Compliance Assessment ====================

  /**
   * Run full compliance assessment
   */
  async runAssessment(impactRating?: ImpactRating): Promise<GapAnalysisResult> {
    const rating = impactRating || this.config.defaultImpactRating;

    // Collect evidence if auto-collection is enabled
    if (this.config.autoCollectEvidence) {
      await this.collectAllEvidence(rating);
    }

    // Run gap analysis
    const result = await this.gapAnalyzer.runAnalysis(rating);

    // Generate alerts for gaps
    if (this.config.alertsEnabled) {
      this.generateAlerts(result);
    }

    return result;
  }

  /**
   * Assess a specific requirement
   */
  async assessRequirement(requirementId: string): Promise<ComplianceControl | undefined> {
    const requirement = getRequirementById(requirementId);
    if (!requirement) return undefined;

    return await this.gapAnalyzer.assessRequirement(requirement);
  }

  /**
   * Get current compliance status
   */
  getComplianceStatus(): {
    controls: ComplianceControl[];
    gaps: ComplianceControl[];
    criticalFindings: ComplianceFinding[];
  } {
    return {
      controls: Array.from(this.gapAnalyzer['controls'].values()),
      gaps: this.gapAnalyzer.getGaps(),
      criticalFindings: this.gapAnalyzer.getCriticalFindings(),
    };
  }

  // ==================== Evidence Management ====================

  /**
   * Collect all evidence for an impact rating
   */
  async collectAllEvidence(impactRating: ImpactRating): Promise<void> {
    const requirements = getRequirementsByImpact(impactRating);

    for (const requirement of requirements) {
      await this.evidenceCollector.collectAllEvidenceForControl(
        requirement.id,
        requirement.evidenceSources
      );
    }
  }

  /**
   * Add manual evidence
   */
  addManualEvidence(
    sourceId: string,
    controlId: string,
    content: string | object,
    userId: string
  ): void {
    this.evidenceCollector.addManualEvidence(sourceId, controlId, content, userId);
  }

  /**
   * Get evidence collection status
   */
  getEvidenceStatus(): Map<string, { lastCollected?: Date; count: number }> {
    return this.evidenceCollector.getCollectionStatus();
  }

  // ==================== Remediation Management ====================

  /**
   * Create remediation plan for a control
   */
  createRemediationPlan(
    controlId: string,
    owner: string,
    targetDays?: number
  ): RemediationPlan | undefined {
    const control = this.gapAnalyzer.getControlStatus(controlId);
    if (!control) return undefined;

    const plan = this.gapAnalyzer.generateRemediationPlan(control, owner, targetDays);
    this.remediationPlans.set(plan.id, plan);
    return plan;
  }

  /**
   * Update remediation plan status
   */
  updateRemediationPlan(
    planId: string,
    updates: Partial<Pick<RemediationPlan, 'status' | 'steps'>>
  ): RemediationPlan | undefined {
    const plan = this.remediationPlans.get(planId);
    if (!plan) return undefined;

    const updated = { ...plan, ...updates, updatedAt: new Date() };
    this.remediationPlans.set(planId, updated);
    return updated;
  }

  /**
   * Get all remediation plans
   */
  getRemediationPlans(): RemediationPlan[] {
    return Array.from(this.remediationPlans.values());
  }

  /**
   * Get overdue remediation plans
   */
  getOverdueRemediations(): RemediationPlan[] {
    const now = new Date();
    return Array.from(this.remediationPlans.values()).filter(
      (p) => p.status !== 'completed' && p.targetDate < now
    );
  }

  // ==================== Reporting ====================

  /**
   * Generate audit report
   */
  generateReport(
    result: GapAnalysisResult,
    config: AuditReportConfig
  ): AuditReport {
    return this.reportGenerator.generateAuditReport(result, config);
  }

  /**
   * Generate compliance dashboard
   */
  generateDashboard(result: GapAnalysisResult): ComplianceDashboard {
    return this.reportGenerator.generateDashboard(result);
  }

  /**
   * Generate executive summary
   */
  generateExecutiveSummary(result: GapAnalysisResult): string {
    return this.reportGenerator.generateExecutiveSummary(result);
  }

  // ==================== Alerts ====================

  /**
   * Get active alerts
   */
  getAlerts(options?: { unacknowledged?: boolean }): ComplianceAlert[] {
    if (options?.unacknowledged) {
      return this.alerts.filter((a) => !a.acknowledgedAt);
    }
    return [...this.alerts];
  }

  /**
   * Acknowledge an alert
   */
  acknowledgeAlert(alertId: string, userId: string): boolean {
    const alert = this.alerts.find((a) => a.id === alertId);
    if (!alert) return false;

    alert.acknowledgedAt = new Date();
    alert.acknowledgedBy = userId;
    return true;
  }

  // ==================== Reference Data ====================

  /**
   * Get all CIP standards metadata
   */
  getStandards(): typeof CIP_STANDARDS {
    return CIP_STANDARDS;
  }

  /**
   * Get requirements for a standard
   */
  getRequirements(standard?: CIPStandard) {
    if (standard) {
      return getRequirementsByStandard(standard);
    }
    return CIP_REQUIREMENTS;
  }

  /**
   * Get available evidence sources
   */
  getEvidenceSources() {
    return EVIDENCE_SOURCES;
  }

  // ==================== Private Methods ====================

  private generateAlerts(result: GapAnalysisResult): void {
    const now = new Date();

    // Alert for new gaps
    const gaps = result.controls.filter((c) => c.status === 'gap');
    for (const gap of gaps) {
      this.alerts.push({
        id: crypto.randomUUID(),
        type: 'status-change',
        severity: 'critical',
        controlId: gap.id,
        message: `Compliance gap detected: ${gap.requirementId} - ${gap.requirement}`,
        createdAt: now,
        metadata: { requirementId: gap.requirementId },
      });
    }

    // Alert for critical findings
    const criticalFindings = result.findings.filter((f) => f.severity === 'critical');
    for (const finding of criticalFindings) {
      this.alerts.push({
        id: crypto.randomUUID(),
        type: 'finding-detected',
        severity: 'critical',
        controlId: finding.controlId,
        message: `Critical finding: ${finding.title}`,
        createdAt: now,
        metadata: { findingId: finding.id },
      });
    }

    // Alert for upcoming assessments
    const thirtyDays = new Date();
    thirtyDays.setDate(thirtyDays.getDate() + 30);

    const upcoming = result.controls.filter(
      (c) => c.nextAssessmentDue <= thirtyDays
    );

    for (const control of upcoming) {
      this.alerts.push({
        id: crypto.randomUUID(),
        type: 'assessment-due',
        severity: 'warning',
        controlId: control.id,
        message: `Assessment due within 30 days: ${control.requirementId}`,
        createdAt: now,
        metadata: {
          dueDate: control.nextAssessmentDue.toISOString(),
        },
      });
    }
  }
}

// Re-export types and utilities
export * from './types';
export { CIP_REQUIREMENTS, CIP_STANDARDS, EVIDENCE_SOURCES } from './cip-requirements';
export { EvidenceCollector, createEvidenceCollector } from './evidence-collector';
export { GapAnalyzer, GapAnalysisResult, createGapAnalyzer } from './gap-analyzer';
export { ReportGenerator, createReportGenerator } from './report-generator';

/**
 * Create compliance service instance
 */
export function createComplianceService(
  config?: Partial<ComplianceServiceConfig>
): ComplianceService {
  return new ComplianceService(config);
}

export default ComplianceService;
