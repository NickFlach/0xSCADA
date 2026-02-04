/**
 * Gap Analyzer for NERC CIP Compliance
 *
 * Identifies compliance gaps by comparing current controls
 * against CIP requirements.
 */

import {
  CIPRequirement,
  CIPStandard,
  ComplianceControl,
  ComplianceFinding,
  ComplianceStatus,
  EvidenceArtifact,
  ImpactRating,
  RemediationPlan,
  StandardMetrics,
} from './types';
import {
  CIP_REQUIREMENTS,
  CIP_STANDARDS,
  getRequirementsByImpact,
  getRequirementsByStandard,
} from './cip-requirements';
import { EvidenceCollector } from './evidence-collector';
import crypto from 'crypto';

/**
 * Gap analysis result
 */
export interface GapAnalysisResult {
  timestamp: Date;
  impactRating: ImpactRating;
  controls: ComplianceControl[];
  findings: ComplianceFinding[];
  metrics: {
    totalRequirements: number;
    compliant: number;
    partial: number;
    gaps: number;
    notApplicable: number;
    overallScore: number;
  };
  byStandard: Map<CIPStandard, StandardMetrics>;
  prioritizedGaps: PrioritizedGap[];
}

/**
 * Prioritized compliance gap
 */
export interface PrioritizedGap {
  control: ComplianceControl;
  requirement: CIPRequirement;
  priority: number; // 1-10, 10 being highest
  estimatedEffort: 'low' | 'medium' | 'high';
  riskExposure: string;
  suggestedRemediation: string;
}

/**
 * Gap Analyzer class
 *
 * Analyzes compliance controls against NERC CIP requirements
 * to identify gaps and prioritize remediation.
 */
export class GapAnalyzer {
  private evidenceCollector: EvidenceCollector;
  private controls: Map<string, ComplianceControl> = new Map();
  private assessmentHistory: GapAnalysisResult[] = [];

  constructor(evidenceCollector: EvidenceCollector) {
    this.evidenceCollector = evidenceCollector;
  }

  /**
   * Run full gap analysis
   */
  async runAnalysis(impactRating: ImpactRating): Promise<GapAnalysisResult> {
    const requirements = getRequirementsByImpact(impactRating);
    const controls: ComplianceControl[] = [];
    const findings: ComplianceFinding[] = [];

    // Assess each requirement
    for (const requirement of requirements) {
      const control = await this.assessRequirement(requirement);
      controls.push(control);
      findings.push(...control.findings);
      this.controls.set(control.id, control);
    }

    // Calculate metrics
    const metrics = this.calculateMetrics(controls);
    const byStandard = this.calculateStandardMetrics(controls, requirements);
    const prioritizedGaps = this.prioritizeGaps(controls, requirements);

    const result: GapAnalysisResult = {
      timestamp: new Date(),
      impactRating,
      controls,
      findings,
      metrics,
      byStandard,
      prioritizedGaps,
    };

    this.assessmentHistory.push(result);
    return result;
  }

  /**
   * Assess a single requirement
   */
  async assessRequirement(requirement: CIPRequirement): Promise<ComplianceControl> {
    const evidenceArtifacts = this.evidenceCollector.getEvidenceForControl(requirement.id);
    const findings = this.evaluateCompliance(requirement, evidenceArtifacts);
    const status = this.determineStatus(requirement, evidenceArtifacts, findings);

    const now = new Date();
    const nextDue = new Date(now);
    nextDue.setMonth(nextDue.getMonth() + 15); // NERC requires at least 15-month review cycle

    return {
      id: crypto.randomUUID(),
      requirementId: requirement.id,
      standard: requirement.standard,
      requirement: requirement.title,
      status,
      evidenceArtifacts,
      lastAssessed: now,
      nextAssessmentDue: nextDue,
      assessedBy: 'automated',
      findings,
    };
  }

  /**
   * Get compliance status for a specific requirement
   */
  getControlStatus(requirementId: string): ComplianceControl | undefined {
    return Array.from(this.controls.values()).find(
      (c) => c.requirementId === requirementId
    );
  }

  /**
   * Get all controls with gaps
   */
  getGaps(): ComplianceControl[] {
    return Array.from(this.controls.values()).filter(
      (c) => c.status === 'gap' || c.status === 'partial'
    );
  }

  /**
   * Get critical findings
   */
  getCriticalFindings(): ComplianceFinding[] {
    return Array.from(this.controls.values())
      .flatMap((c) => c.findings)
      .filter((f) => f.severity === 'critical');
  }

  /**
   * Generate remediation plan for a control
   */
  generateRemediationPlan(
    control: ComplianceControl,
    owner: string,
    targetDays: number = 90
  ): RemediationPlan {
    const requirement = CIP_REQUIREMENTS.find(
      (r) => r.id === control.requirementId
    );

    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + targetDays);

    const steps = this.generateRemediationSteps(control, requirement);

    return {
      id: crypto.randomUUID(),
      controlId: control.id,
      findingIds: control.findings.map((f) => f.id),
      description: requirement?.remediationGuidance || 'Address identified compliance gaps',
      steps,
      owner,
      targetDate,
      status: 'planned',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  /**
   * Get assessment history
   */
  getAssessmentHistory(): GapAnalysisResult[] {
    return [...this.assessmentHistory];
  }

  /**
   * Compare two assessments to identify changes
   */
  compareAssessments(
    oldResult: GapAnalysisResult,
    newResult: GapAnalysisResult
  ): {
    improved: string[];
    degraded: string[];
    unchanged: string[];
    newGaps: string[];
    resolvedGaps: string[];
  } {
    const oldControls = new Map(oldResult.controls.map((c) => [c.requirementId, c]));
    const newControls = new Map(newResult.controls.map((c) => [c.requirementId, c]));

    const improved: string[] = [];
    const degraded: string[] = [];
    const unchanged: string[] = [];
    const newGaps: string[] = [];
    const resolvedGaps: string[] = [];

    newControls.forEach((newControl, reqId) => {
      const oldControl = oldControls.get(reqId);

      if (!oldControl) {
        if (newControl.status === 'gap' || newControl.status === 'partial') {
          newGaps.push(reqId);
        }
        return;
      }

      const oldScore = this.statusToScore(oldControl.status);
      const newScore = this.statusToScore(newControl.status);

      if (newScore > oldScore) {
        improved.push(reqId);
        if (
          (oldControl.status === 'gap' || oldControl.status === 'partial') &&
          newControl.status === 'compliant'
        ) {
          resolvedGaps.push(reqId);
        }
      } else if (newScore < oldScore) {
        degraded.push(reqId);
        if (
          oldControl.status === 'compliant' &&
          (newControl.status === 'gap' || newControl.status === 'partial')
        ) {
          newGaps.push(reqId);
        }
      } else {
        unchanged.push(reqId);
      }
    });

    return { improved, degraded, unchanged, newGaps, resolvedGaps };
  }

  // Private methods

  private evaluateCompliance(
    requirement: CIPRequirement,
    evidence: EvidenceArtifact[]
  ): ComplianceFinding[] {
    const findings: ComplianceFinding[] = [];
    const now = new Date();

    // Check for missing evidence sources
    const collectedSources = new Set(evidence.map((e) => e.sourceId));
    const missingSources = requirement.evidenceSources.filter(
      (s) => !collectedSources.has(s)
    );

    if (missingSources.length > 0) {
      findings.push({
        id: crypto.randomUUID(),
        controlId: requirement.id,
        severity: missingSources.length === requirement.evidenceSources.length ? 'critical' : 'major',
        title: 'Missing Evidence',
        description: `Required evidence not collected: ${missingSources.join(', ')}`,
        detectedAt: now,
      });
    }

    // Check for expired evidence
    const expiredEvidence = evidence.filter(
      (e) => e.expiresAt && e.expiresAt < now
    );

    if (expiredEvidence.length > 0) {
      findings.push({
        id: crypto.randomUUID(),
        controlId: requirement.id,
        severity: 'minor',
        title: 'Expired Evidence',
        description: `${expiredEvidence.length} evidence artifact(s) have expired and need refresh`,
        detectedAt: now,
      });
    }

    // Check control mappings for implementation gaps
    const partialMappings = requirement.controlMappings.filter(
      (m) => m.coverageLevel === 'partial'
    );
    const noMappings = requirement.controlMappings.filter(
      (m) => m.coverageLevel === 'none'
    );

    if (noMappings.length > 0) {
      findings.push({
        id: crypto.randomUUID(),
        controlId: requirement.id,
        severity: 'critical',
        title: 'Control Not Implemented',
        description: `Feature mappings indicate no coverage: ${noMappings.map((m) => m.featureName).join(', ')}`,
        detectedAt: now,
      });
    }

    if (partialMappings.length > 0) {
      findings.push({
        id: crypto.randomUUID(),
        controlId: requirement.id,
        severity: 'major',
        title: 'Partial Control Implementation',
        description: `Features with partial coverage: ${partialMappings.map((m) => m.featureName).join(', ')}`,
        detectedAt: now,
      });
    }

    return findings;
  }

  private determineStatus(
    requirement: CIPRequirement,
    evidence: EvidenceArtifact[],
    findings: ComplianceFinding[]
  ): ComplianceStatus {
    // No evidence at all = gap
    if (evidence.length === 0) {
      return 'gap';
    }

    // Critical findings = gap
    const criticalFindings = findings.filter((f) => f.severity === 'critical');
    if (criticalFindings.length > 0) {
      return 'gap';
    }

    // Major findings = partial
    const majorFindings = findings.filter((f) => f.severity === 'major');
    if (majorFindings.length > 0) {
      return 'partial';
    }

    // Check if all required evidence is present and valid
    const requiredSources = new Set(requirement.evidenceSources);
    const collectedSources = new Set(evidence.map((e) => e.sourceId));
    const allPresent = [...requiredSources].every((s) => collectedSources.has(s));

    if (!allPresent) {
      return 'partial';
    }

    // Check if any mappings have full coverage
    const hasFullCoverage = requirement.controlMappings.some(
      (m) => m.coverageLevel === 'full'
    );

    if (!hasFullCoverage) {
      return 'partial';
    }

    return 'compliant';
  }

  private calculateMetrics(controls: ComplianceControl[]): GapAnalysisResult['metrics'] {
    const total = controls.length;
    const compliant = controls.filter((c) => c.status === 'compliant').length;
    const partial = controls.filter((c) => c.status === 'partial').length;
    const gaps = controls.filter((c) => c.status === 'gap').length;
    const notApplicable = controls.filter((c) => c.status === 'not-applicable').length;

    const applicable = total - notApplicable;
    const score = applicable > 0
      ? Math.round(((compliant + partial * 0.5) / applicable) * 100)
      : 100;

    return {
      totalRequirements: total,
      compliant,
      partial,
      gaps,
      notApplicable,
      overallScore: score,
    };
  }

  private calculateStandardMetrics(
    controls: ComplianceControl[],
    requirements: CIPRequirement[]
  ): Map<CIPStandard, StandardMetrics> {
    const metrics = new Map<CIPStandard, StandardMetrics>();
    const standards = [...new Set(requirements.map((r) => r.standard))];

    for (const standard of standards) {
      const standardControls = controls.filter((c) => c.standard === standard);
      const total = standardControls.length;
      const compliant = standardControls.filter((c) => c.status === 'compliant').length;
      const partial = standardControls.filter((c) => c.status === 'partial').length;
      const gaps = standardControls.filter((c) => c.status === 'gap').length;
      const notApplicable = standardControls.filter((c) => c.status === 'not-applicable').length;

      const applicable = total - notApplicable;
      const percentage = applicable > 0
        ? Math.round(((compliant + partial * 0.5) / applicable) * 100)
        : 100;

      const lastAssessed = standardControls.length > 0
        ? new Date(Math.max(...standardControls.map((c) => c.lastAssessed.getTime())))
        : new Date();

      metrics.set(standard, {
        standard,
        title: CIP_STANDARDS[standard]?.title || standard,
        totalRequirements: total,
        compliant,
        partial,
        gaps,
        notApplicable,
        compliancePercentage: percentage,
        lastAssessed,
      });
    }

    return metrics;
  }

  private prioritizeGaps(
    controls: ComplianceControl[],
    requirements: CIPRequirement[]
  ): PrioritizedGap[] {
    const gaps = controls.filter(
      (c) => c.status === 'gap' || c.status === 'partial'
    );

    return gaps
      .map((control) => {
        const requirement = requirements.find((r) => r.id === control.requirementId);
        if (!requirement) return null;

        const priority = this.calculatePriority(control, requirement);
        const effort = this.estimateEffort(control, requirement);

        return {
          control,
          requirement,
          priority,
          estimatedEffort: effort,
          riskExposure: requirement.violationRisk,
          suggestedRemediation: requirement.remediationGuidance,
        };
      })
      .filter((g): g is PrioritizedGap => g !== null)
      .sort((a, b) => b.priority - a.priority);
  }

  private calculatePriority(
    control: ComplianceControl,
    requirement: CIPRequirement
  ): number {
    let priority = 0;

    // Base priority from requirement
    switch (requirement.priority) {
      case 'critical':
        priority += 4;
        break;
      case 'high':
        priority += 3;
        break;
      case 'medium':
        priority += 2;
        break;
      case 'low':
        priority += 1;
        break;
    }

    // Increase for gaps vs partial
    if (control.status === 'gap') {
      priority += 3;
    } else {
      priority += 1;
    }

    // Increase for critical findings
    const criticalFindings = control.findings.filter((f) => f.severity === 'critical');
    priority += Math.min(criticalFindings.length, 3);

    return Math.min(priority, 10);
  }

  private estimateEffort(
    control: ComplianceControl,
    requirement: CIPRequirement
  ): 'low' | 'medium' | 'high' {
    // Check control mappings for coverage level
    const noMappings = requirement.controlMappings.filter(
      (m) => m.coverageLevel === 'none'
    );

    if (noMappings.length > 0) {
      return 'high'; // Need to implement new features
    }

    const partialMappings = requirement.controlMappings.filter(
      (m) => m.coverageLevel === 'partial'
    );

    if (partialMappings.length > 1) {
      return 'high';
    }

    if (partialMappings.length === 1) {
      return 'medium';
    }

    // Just need evidence collection or minor configuration
    return 'low';
  }

  private generateRemediationSteps(
    control: ComplianceControl,
    requirement?: CIPRequirement
  ): RemediationPlan['steps'] {
    const steps: RemediationPlan['steps'] = [];
    let order = 1;

    // Step for each finding
    for (const finding of control.findings) {
      steps.push({
        id: crypto.randomUUID(),
        order: order++,
        description: `Address finding: ${finding.title} - ${finding.description}`,
      });
    }

    // Step for evidence collection if needed
    if (requirement) {
      const collectedSources = new Set(control.evidenceArtifacts.map((e) => e.sourceId));
      const missingSources = requirement.evidenceSources.filter(
        (s) => !collectedSources.has(s)
      );

      if (missingSources.length > 0) {
        steps.push({
          id: crypto.randomUUID(),
          order: order++,
          description: `Collect missing evidence from: ${missingSources.join(', ')}`,
        });
      }
    }

    // Final verification step
    steps.push({
      id: crypto.randomUUID(),
      order: order++,
      description: 'Re-run compliance assessment to verify remediation',
    });

    return steps;
  }

  private statusToScore(status: ComplianceStatus): number {
    switch (status) {
      case 'compliant':
        return 3;
      case 'partial':
        return 2;
      case 'pending-review':
        return 1;
      case 'gap':
        return 0;
      case 'not-applicable':
        return 3; // N/A doesn't affect score negatively
      default:
        return 0;
    }
  }
}

/**
 * Create gap analyzer
 */
export function createGapAnalyzer(evidenceCollector: EvidenceCollector): GapAnalyzer {
  return new GapAnalyzer(evidenceCollector);
}
