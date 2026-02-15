/**
 * Compliance Scanner — ADR-0014 [14.5]
 *
 * IEC 62443 checklist evaluation, NIST CSF control mapping,
 * automated evidence collection, and gap report generation.
 */

import { EventEmitter } from 'events';

export interface ComplianceControl {
  id: string;
  framework: 'IEC-62443' | 'NIST-CSF';
  category: string;
  title: string;
  description: string;
  securityLevel: number; // 1-4 for IEC 62443
  required: boolean;
}

export interface ComplianceCheck {
  controlId: string;
  status: 'pass' | 'fail' | 'partial' | 'not-applicable' | 'not-tested';
  evidence: string[];
  findings: string[];
  remediation?: string;
  timestamp: number;
}

export interface ComplianceReport {
  id: string;
  framework: string;
  generatedAt: number;
  overallScore: number; // 0-100
  totalControls: number;
  passed: number;
  failed: number;
  partial: number;
  notApplicable: number;
  notTested: number;
  checks: ComplianceCheck[];
  gaps: GapAnalysis[];
  recommendations: string[];
}

export interface GapAnalysis {
  controlId: string;
  controlTitle: string;
  currentState: string;
  requiredState: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  effort: 'small' | 'medium' | 'large';
  recommendation: string;
}

// IEC 62443 controls
const IEC_62443_CONTROLS: ComplianceControl[] = [
  { id: 'IEC-1.1', framework: 'IEC-62443', category: 'Security Management', title: 'Security Policy', description: 'Organization has a documented security policy for IACS', securityLevel: 1, required: true },
  { id: 'IEC-1.2', framework: 'IEC-62443', category: 'Security Management', title: 'Risk Assessment', description: 'Regular risk assessments are performed', securityLevel: 1, required: true },
  { id: 'IEC-2.1', framework: 'IEC-62443', category: 'Authentication', title: 'User Identification', description: 'All users are uniquely identified', securityLevel: 1, required: true },
  { id: 'IEC-2.2', framework: 'IEC-62443', category: 'Authentication', title: 'Multi-Factor Auth', description: 'MFA for privileged access', securityLevel: 2, required: true },
  { id: 'IEC-3.1', framework: 'IEC-62443', category: 'Authorization', title: 'Role-Based Access', description: 'RBAC implemented for all functions', securityLevel: 1, required: true },
  { id: 'IEC-3.2', framework: 'IEC-62443', category: 'Authorization', title: 'Least Privilege', description: 'Users have minimum necessary permissions', securityLevel: 2, required: true },
  { id: 'IEC-4.1', framework: 'IEC-62443', category: 'Data Integrity', title: 'Communication Integrity', description: 'Data integrity protection for all communications', securityLevel: 1, required: true },
  { id: 'IEC-4.2', framework: 'IEC-62443', category: 'Data Integrity', title: 'Blockchain Verification', description: 'Immutable audit trail via blockchain', securityLevel: 3, required: false },
  { id: 'IEC-5.1', framework: 'IEC-62443', category: 'Data Confidentiality', title: 'Encryption at Rest', description: 'Sensitive data encrypted at rest', securityLevel: 2, required: true },
  { id: 'IEC-5.2', framework: 'IEC-62443', category: 'Data Confidentiality', title: 'Encryption in Transit', description: 'TLS for all network communications', securityLevel: 1, required: true },
  { id: 'IEC-6.1', framework: 'IEC-62443', category: 'Availability', title: 'DoS Protection', description: 'Rate limiting and DoS mitigation', securityLevel: 1, required: true },
  { id: 'IEC-6.2', framework: 'IEC-62443', category: 'Availability', title: 'Redundancy', description: 'Critical components are redundant', securityLevel: 2, required: true },
  { id: 'IEC-7.1', framework: 'IEC-62443', category: 'Audit', title: 'Audit Logging', description: 'All security-relevant events are logged', securityLevel: 1, required: true },
  { id: 'IEC-7.2', framework: 'IEC-62443', category: 'Audit', title: 'Tamper-Proof Logs', description: 'Audit logs are tamper-evident', securityLevel: 2, required: true },
];

// NIST CSF controls
const NIST_CSF_CONTROLS: ComplianceControl[] = [
  { id: 'NIST-ID.AM-1', framework: 'NIST-CSF', category: 'Identify', title: 'Asset Inventory', description: 'Physical devices and systems are inventoried', securityLevel: 1, required: true },
  { id: 'NIST-ID.RA-1', framework: 'NIST-CSF', category: 'Identify', title: 'Vulnerability Identification', description: 'Asset vulnerabilities are identified and documented', securityLevel: 1, required: true },
  { id: 'NIST-PR.AC-1', framework: 'NIST-CSF', category: 'Protect', title: 'Identity Management', description: 'Identities and credentials managed for authorized devices/users', securityLevel: 1, required: true },
  { id: 'NIST-PR.DS-1', framework: 'NIST-CSF', category: 'Protect', title: 'Data-at-Rest Protection', description: 'Data-at-rest is protected', securityLevel: 1, required: true },
  { id: 'NIST-PR.DS-2', framework: 'NIST-CSF', category: 'Protect', title: 'Data-in-Transit Protection', description: 'Data-in-transit is protected', securityLevel: 1, required: true },
  { id: 'NIST-DE.AE-1', framework: 'NIST-CSF', category: 'Detect', title: 'Anomaly Detection', description: 'Network baseline and anomaly detection established', securityLevel: 1, required: true },
  { id: 'NIST-DE.CM-1', framework: 'NIST-CSF', category: 'Detect', title: 'Network Monitoring', description: 'Network is monitored for cybersecurity events', securityLevel: 1, required: true },
  { id: 'NIST-RS.RP-1', framework: 'NIST-CSF', category: 'Respond', title: 'Response Plan', description: 'Response plan is executed during or after an event', securityLevel: 1, required: true },
  { id: 'NIST-RC.RP-1', framework: 'NIST-CSF', category: 'Recover', title: 'Recovery Plan', description: 'Recovery plan is executed during or after an event', securityLevel: 1, required: true },
];

export class ComplianceScanner extends EventEmitter {
  private controls: ComplianceControl[] = [];
  private checks: Map<string, ComplianceCheck> = new Map();
  private automatedCheckers: Map<string, () => Promise<ComplianceCheck>> = new Map();

  constructor() {
    super();
    this.controls = [...IEC_62443_CONTROLS, ...NIST_CSF_CONTROLS];
  }

  registerAutomatedCheck(controlId: string, checker: () => Promise<ComplianceCheck>): void {
    this.automatedCheckers.set(controlId, checker);
  }

  async runScan(framework?: 'IEC-62443' | 'NIST-CSF'): Promise<ComplianceReport> {
    const controls = framework
      ? this.controls.filter((c) => c.framework === framework)
      : this.controls;

    const checks: ComplianceCheck[] = [];

    for (const control of controls) {
      const checker = this.automatedCheckers.get(control.id);
      let check: ComplianceCheck;

      if (checker) {
        try {
          check = await checker();
        } catch {
          check = {
            controlId: control.id,
            status: 'not-tested',
            evidence: [],
            findings: ['Automated check failed'],
            timestamp: Date.now(),
          };
        }
      } else {
        check = {
          controlId: control.id,
          status: 'not-tested',
          evidence: [],
          findings: ['No automated check configured — manual review required'],
          timestamp: Date.now(),
        };
      }

      this.checks.set(control.id, check);
      checks.push(check);
    }

    const gaps = this.analyzeGaps(controls, checks);

    const passed = checks.filter((c) => c.status === 'pass').length;
    const failed = checks.filter((c) => c.status === 'fail').length;
    const partial = checks.filter((c) => c.status === 'partial').length;
    const notApplicable = checks.filter((c) => c.status === 'not-applicable').length;
    const notTested = checks.filter((c) => c.status === 'not-tested').length;
    const applicable = controls.length - notApplicable;
    const score = applicable > 0 ? ((passed + partial * 0.5) / applicable) * 100 : 0;

    const report: ComplianceReport = {
      id: `report-${Date.now()}`,
      framework: framework ?? 'ALL',
      generatedAt: Date.now(),
      overallScore: Math.round(score * 10) / 10,
      totalControls: controls.length,
      passed,
      failed,
      partial,
      notApplicable,
      notTested,
      checks,
      gaps,
      recommendations: gaps
        .filter((g) => g.priority === 'critical' || g.priority === 'high')
        .map((g) => `[${g.priority.toUpperCase()}] ${g.controlTitle}: ${g.recommendation}`),
    };

    this.emit('scan-complete', report);
    return report;
  }

  getControls(framework?: string): ComplianceControl[] {
    return framework ? this.controls.filter((c) => c.framework === framework) : this.controls;
  }

  getCheck(controlId: string): ComplianceCheck | undefined {
    return this.checks.get(controlId);
  }

  private analyzeGaps(controls: ComplianceControl[], checks: ComplianceCheck[]): GapAnalysis[] {
    const gaps: GapAnalysis[] = [];

    for (let i = 0; i < controls.length; i++) {
      const control = controls[i];
      const check = checks[i];

      if (check.status === 'fail' || check.status === 'not-tested') {
        gaps.push({
          controlId: control.id,
          controlTitle: control.title,
          currentState: check.status === 'fail' ? check.findings.join('; ') : 'Not assessed',
          requiredState: control.description,
          priority: control.required ? (control.securityLevel >= 3 ? 'critical' : 'high') : 'medium',
          effort: control.securityLevel >= 3 ? 'large' : control.securityLevel >= 2 ? 'medium' : 'small',
          recommendation: check.remediation ?? `Implement ${control.title} per ${control.framework} requirements`,
        });
      }
    }

    return gaps.sort((a, b) => {
      const prio = { critical: 0, high: 1, medium: 2, low: 3 };
      return prio[a.priority] - prio[b.priority];
    });
  }
}
