/**
 * Report Generator for NERC CIP Compliance
 *
 * Generates auditor-ready compliance reports in multiple formats.
 */

import {
  AuditReport,
  AuditReportConfig,
  CIPStandard,
  ComplianceControl,
  ComplianceDashboard,
  ComplianceFinding,
  StandardMetrics,
} from './types';
import { GapAnalysisResult } from './gap-analyzer';
import { CIP_STANDARDS } from './cip-requirements';
import crypto from 'crypto';

/**
 * Report Generator class
 *
 * Creates compliance reports for auditors and stakeholders.
 */
export class ReportGenerator {
  /**
   * Generate audit report from gap analysis results
   */
  generateAuditReport(
    result: GapAnalysisResult,
    config: AuditReportConfig
  ): AuditReport {
    let content: string;
    let contentType: string;

    // Filter by standards if specified
    let controls = result.controls;
    let findings = result.findings;

    if (config.standards && config.standards.length > 0) {
      controls = controls.filter((c) => config.standards!.includes(c.standard));
      findings = findings.filter((f) => {
        const control = controls.find((c) => c.findings.some((cf) => cf.id === f.id));
        return control !== undefined;
      });
    }

    // Filter by date range if specified
    if (config.dateRange) {
      findings = findings.filter(
        (f) =>
          f.detectedAt >= config.dateRange!.start &&
          f.detectedAt <= config.dateRange!.end
      );
    }

    switch (config.format) {
      case 'html':
        content = this.generateHtmlReport(result, controls, findings, config);
        contentType = 'text/html';
        break;
      case 'json':
        content = this.generateJsonReport(result, controls, findings, config);
        contentType = 'application/json';
        break;
      case 'excel':
        content = this.generateCsvReport(result, controls, findings, config);
        contentType = 'text/csv';
        break;
      case 'pdf':
      default:
        // Generate HTML that can be converted to PDF
        content = this.generateHtmlReport(result, controls, findings, config);
        contentType = 'text/html';
        break;
    }

    return {
      id: crypto.randomUUID(),
      config,
      generatedAt: new Date(),
      generatedBy: config.preparedBy || 'System',
      content: Buffer.from(content),
      contentType,
      hash: crypto.createHash('sha256').update(content).digest('hex'),
      metadata: {
        controlsAssessed: controls.length,
        findingsIncluded: findings.length,
      },
    };
  }

  /**
   * Generate compliance dashboard data
   */
  generateDashboard(result: GapAnalysisResult): ComplianceDashboard {
    const byStandard: Record<CIPStandard, StandardMetrics> = {} as Record<
      CIPStandard,
      StandardMetrics
    >;

    result.byStandard.forEach((metrics, standard) => {
      byStandard[standard] = metrics;
    });

    // Get upcoming assessments (due within 30 days)
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

    const upcomingAssessments = result.controls
      .filter((c) => c.nextAssessmentDue <= thirtyDaysFromNow)
      .map((c) => ({
        controlId: c.id,
        requirementId: c.requirementId,
        standard: c.standard,
        dueDate: c.nextAssessmentDue,
        daysUntilDue: Math.ceil(
          (c.nextAssessmentDue.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
        ),
      }))
      .sort((a, b) => a.daysUntilDue - b.daysUntilDue);

    return {
      overallScore: result.metrics.overallScore,
      byStandard,
      totalControls: result.metrics.totalRequirements,
      compliantControls: result.metrics.compliant,
      partialControls: result.metrics.partial,
      gapControls: result.metrics.gaps,
      pendingControls: result.controls.filter((c) => c.status === 'pending-review').length,
      criticalFindings: result.findings.filter((f) => f.severity === 'critical').length,
      majorFindings: result.findings.filter((f) => f.severity === 'major').length,
      upcomingAssessments,
      recentChanges: [], // Would be populated from change tracking
      lastUpdated: result.timestamp,
    };
  }

  /**
   * Generate executive summary
   */
  generateExecutiveSummary(result: GapAnalysisResult): string {
    const { metrics, prioritizedGaps } = result;
    const topGaps = prioritizedGaps.slice(0, 5);

    return `
# NERC CIP Compliance Executive Summary

**Assessment Date:** ${result.timestamp.toLocaleDateString()}
**Impact Rating:** ${result.impactRating.toUpperCase()}

## Overall Compliance Score: ${metrics.overallScore}%

### Summary Statistics
- **Total Requirements Assessed:** ${metrics.totalRequirements}
- **Compliant:** ${metrics.compliant} (${Math.round((metrics.compliant / metrics.totalRequirements) * 100)}%)
- **Partial:** ${metrics.partial} (${Math.round((metrics.partial / metrics.totalRequirements) * 100)}%)
- **Gaps:** ${metrics.gaps} (${Math.round((metrics.gaps / metrics.totalRequirements) * 100)}%)
- **Not Applicable:** ${metrics.notApplicable}

### Compliance by Standard
${Array.from(result.byStandard.entries())
  .map(
    ([standard, m]) =>
      `- **${standard}** (${CIP_STANDARDS[standard]?.title || standard}): ${m.compliancePercentage}%`
  )
  .join('\n')}

### Top Priority Gaps
${
  topGaps.length > 0
    ? topGaps
        .map(
          (gap, i) =>
            `${i + 1}. **${gap.requirement.id}** - ${gap.requirement.title}
   - Priority: ${gap.priority}/10
   - Effort: ${gap.estimatedEffort}
   - Risk: ${gap.riskExposure}`
        )
        .join('\n\n')
    : 'No critical gaps identified.'
}

### Recommended Actions
1. Address critical findings immediately
2. Develop remediation plans for all gaps
3. Schedule follow-up assessments for partial controls
4. Review and update evidence collection processes

---
*Report generated by 0xSCADA Compliance Module*
    `.trim();
  }

  // Private methods

  private generateHtmlReport(
    result: GapAnalysisResult,
    controls: ComplianceControl[],
    findings: ComplianceFinding[],
    config: AuditReportConfig
  ): string {
    const standardsHtml = Array.from(result.byStandard.entries())
      .map(
        ([standard, metrics]) => `
        <div class="standard-card">
          <h3>${standard}: ${CIP_STANDARDS[standard]?.title || ''}</h3>
          <div class="metrics-grid">
            <div class="metric">
              <span class="value">${metrics.compliancePercentage}%</span>
              <span class="label">Compliance</span>
            </div>
            <div class="metric">
              <span class="value">${metrics.compliant}</span>
              <span class="label">Compliant</span>
            </div>
            <div class="metric">
              <span class="value">${metrics.partial}</span>
              <span class="label">Partial</span>
            </div>
            <div class="metric">
              <span class="value">${metrics.gaps}</span>
              <span class="label">Gaps</span>
            </div>
          </div>
        </div>
      `
      )
      .join('');

    const controlsHtml = controls
      .map(
        (control) => `
        <tr class="status-${control.status}">
          <td>${control.requirementId}</td>
          <td>${control.requirement}</td>
          <td>${control.standard}</td>
          <td><span class="status-badge ${control.status}">${control.status}</span></td>
          <td>${control.findings.length}</td>
          <td>${control.lastAssessed.toLocaleDateString()}</td>
        </tr>
      `
      )
      .join('');

    const findingsHtml = config.includeFindings
      ? findings
          .map(
            (finding) => `
          <tr class="severity-${finding.severity}">
            <td>${finding.id.slice(0, 8)}</td>
            <td>${finding.controlId}</td>
            <td><span class="severity-badge ${finding.severity}">${finding.severity}</span></td>
            <td>${finding.title}</td>
            <td>${finding.description}</td>
            <td>${finding.detectedAt.toLocaleDateString()}</td>
          </tr>
        `
          )
          .join('')
      : '';

    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${config.title}</title>
  <style>
    :root {
      --compliant: #22c55e;
      --partial: #f59e0b;
      --gap: #ef4444;
      --critical: #dc2626;
      --major: #f97316;
      --minor: #eab308;
      --observation: #3b82f6;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      line-height: 1.6;
      color: #1f2937;
      max-width: 1200px;
      margin: 0 auto;
      padding: 2rem;
    }
    h1, h2, h3 { color: #111827; }
    .header {
      border-bottom: 2px solid #e5e7eb;
      padding-bottom: 1rem;
      margin-bottom: 2rem;
    }
    .meta { color: #6b7280; font-size: 0.875rem; }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin: 2rem 0;
    }
    .summary-card {
      background: #f9fafb;
      border-radius: 8px;
      padding: 1.5rem;
      text-align: center;
    }
    .summary-card .value {
      font-size: 2.5rem;
      font-weight: bold;
      color: #111827;
    }
    .summary-card .label { color: #6b7280; }
    .standard-card {
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 1rem;
      margin-bottom: 1rem;
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 1rem;
      margin-top: 1rem;
    }
    .metric {
      text-align: center;
    }
    .metric .value {
      font-size: 1.5rem;
      font-weight: bold;
    }
    .metric .label {
      font-size: 0.75rem;
      color: #6b7280;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 1rem 0;
    }
    th, td {
      padding: 0.75rem;
      text-align: left;
      border-bottom: 1px solid #e5e7eb;
    }
    th {
      background: #f9fafb;
      font-weight: 600;
    }
    .status-badge, .severity-badge {
      display: inline-block;
      padding: 0.25rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 500;
      text-transform: uppercase;
    }
    .status-badge.compliant { background: #dcfce7; color: #166534; }
    .status-badge.partial { background: #fef3c7; color: #92400e; }
    .status-badge.gap { background: #fee2e2; color: #991b1b; }
    .severity-badge.critical { background: #fee2e2; color: #991b1b; }
    .severity-badge.major { background: #ffedd5; color: #9a3412; }
    .severity-badge.minor { background: #fef9c3; color: #854d0e; }
    .severity-badge.observation { background: #dbeafe; color: #1e40af; }
    .footer {
      margin-top: 3rem;
      padding-top: 1rem;
      border-top: 1px solid #e5e7eb;
      color: #6b7280;
      font-size: 0.875rem;
    }
    @media print {
      body { padding: 0; }
      .no-print { display: none; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>${config.title}</h1>
    <div class="meta">
      <p>Assessment Date: ${result.timestamp.toLocaleDateString()}</p>
      <p>Impact Rating: ${result.impactRating.toUpperCase()}</p>
      ${config.preparedFor ? `<p>Prepared For: ${config.preparedFor}</p>` : ''}
      ${config.preparedBy ? `<p>Prepared By: ${config.preparedBy}</p>` : ''}
    </div>
  </div>

  <section>
    <h2>Executive Summary</h2>
    <div class="summary-grid">
      <div class="summary-card">
        <div class="value">${result.metrics.overallScore}%</div>
        <div class="label">Overall Compliance Score</div>
      </div>
      <div class="summary-card">
        <div class="value">${result.metrics.compliant}</div>
        <div class="label">Compliant Controls</div>
      </div>
      <div class="summary-card">
        <div class="value">${result.metrics.partial}</div>
        <div class="label">Partial Controls</div>
      </div>
      <div class="summary-card">
        <div class="value">${result.metrics.gaps}</div>
        <div class="label">Gaps Identified</div>
      </div>
    </div>
  </section>

  <section>
    <h2>Compliance by Standard</h2>
    ${standardsHtml}
  </section>

  <section>
    <h2>Control Assessment Details</h2>
    <table>
      <thead>
        <tr>
          <th>Requirement</th>
          <th>Title</th>
          <th>Standard</th>
          <th>Status</th>
          <th>Findings</th>
          <th>Last Assessed</th>
        </tr>
      </thead>
      <tbody>
        ${controlsHtml}
      </tbody>
    </table>
  </section>

  ${
    config.includeFindings && findings.length > 0
      ? `
  <section>
    <h2>Findings</h2>
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Control</th>
          <th>Severity</th>
          <th>Title</th>
          <th>Description</th>
          <th>Detected</th>
        </tr>
      </thead>
      <tbody>
        ${findingsHtml}
      </tbody>
    </table>
  </section>
  `
      : ''
  }

  <div class="footer">
    <p>Report generated by 0xSCADA NERC CIP Compliance Module</p>
    <p>Document Hash: ${crypto.createHash('sha256').update(Date.now().toString()).digest('hex').slice(0, 16)}</p>
  </div>
</body>
</html>
    `.trim();
  }

  private generateJsonReport(
    result: GapAnalysisResult,
    controls: ComplianceControl[],
    findings: ComplianceFinding[],
    config: AuditReportConfig
  ): string {
    const report = {
      meta: {
        title: config.title,
        generatedAt: new Date().toISOString(),
        assessmentDate: result.timestamp.toISOString(),
        impactRating: result.impactRating,
        preparedFor: config.preparedFor,
        preparedBy: config.preparedBy,
      },
      summary: {
        overallScore: result.metrics.overallScore,
        totalRequirements: result.metrics.totalRequirements,
        compliant: result.metrics.compliant,
        partial: result.metrics.partial,
        gaps: result.metrics.gaps,
        notApplicable: result.metrics.notApplicable,
      },
      byStandard: Object.fromEntries(result.byStandard),
      controls: controls.map((c) => ({
        ...c,
        evidenceArtifacts: config.includeEvidence ? c.evidenceArtifacts : undefined,
      })),
      findings: config.includeFindings ? findings : undefined,
      prioritizedGaps: result.prioritizedGaps.slice(0, 10),
    };

    return JSON.stringify(report, null, 2);
  }

  private generateCsvReport(
    result: GapAnalysisResult,
    controls: ComplianceControl[],
    findings: ComplianceFinding[],
    config: AuditReportConfig
  ): string {
    const headers = [
      'Requirement ID',
      'Title',
      'Standard',
      'Status',
      'Findings Count',
      'Last Assessed',
      'Next Assessment Due',
    ];

    const rows = controls.map((c) => [
      c.requirementId,
      `"${c.requirement.replace(/"/g, '""')}"`,
      c.standard,
      c.status,
      c.findings.length.toString(),
      c.lastAssessed.toISOString(),
      c.nextAssessmentDue.toISOString(),
    ]);

    let csv = headers.join(',') + '\n';
    csv += rows.map((r) => r.join(',')).join('\n');

    if (config.includeFindings && findings.length > 0) {
      csv += '\n\nFindings\n';
      csv += 'ID,Control ID,Severity,Title,Description,Detected At\n';
      csv += findings
        .map((f) =>
          [
            f.id,
            f.controlId,
            f.severity,
            `"${f.title.replace(/"/g, '""')}"`,
            `"${f.description.replace(/"/g, '""')}"`,
            f.detectedAt.toISOString(),
          ].join(',')
        )
        .join('\n');
    }

    return csv;
  }
}

/**
 * Create report generator
 */
export function createReportGenerator(): ReportGenerator {
  return new ReportGenerator();
}
