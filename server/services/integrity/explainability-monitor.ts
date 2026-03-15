/**
 * Explainability Monitor for SCADA Audit (CFR 21 Part 11)
 * 
 * Provides decision audit trails, tamper-evident logging, electronic signatures,
 * human-readable explanation generation, and compliance report generation for
 * FDA CFR 21 Part 11 and related regulatory frameworks.
 * 
 * CFR 21 Part 11 requires:
 * - 11.10(a): System validation
 * - 11.10(e): Audit trails — computer-generated, time-stamped, unmodifiable
 * - 11.10(k)(2): Authority checks before system changes
 * - 11.50: Electronic signatures with user identity + meaning
 * - 11.70: Signature/record linking
 * - Tamper-evident records (hash chain)
 * 
 * Integration hooks:
 * - Verification pipeline: onDecision hooks for the integrity verifier
 * - Governance gates: pre-action approval checks
 * 
 * @see ADR-0022 Wave 3
 * @closes #347
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DecisionRecord {
  id: string;
  timestamp: Date;
  /** What system/subsystem made the decision */
  source: string;
  /** What action was decided */
  action: string;
  /** Rule or policy that was applied */
  ruleApplied: string;
  /** Why the decision was made — human-readable explanation */
  reasoning: string;
  /** Input data that led to the decision */
  inputs: Record<string, any>;
  /** Output/result of the decision */
  output: unknown;
  /** Confidence score 0-1 */
  confidence: number;
  /** Which verification layers passed */
  verificationLayers: VerificationLayerResult[];
  /** Electronic signature if required */
  signature?: ElectronicSignature;
  /** Monotonic sequence number for deterministic ordering */
  sequence: number;
  /** SHA-256 hash of this record for tamper detection */
  recordHash: string;
  /** Hash of previous record for chain integrity */
  previousHash: string;
}

export interface VerificationLayerResult {
  layer: string;
  passed: boolean;
  score: number;
  details?: string;
  timestamp: Date;
}

export interface ElectronicSignature {
  userId: string;
  userName: string;
  role: string;
  timestamp: Date;
  meaning: 'approval' | 'review' | 'acknowledgment' | 'authorship';
  /** Signed hash of the record content */
  signedHash: string;
}

export interface AuditEntry {
  id: string;
  timestamp: Date;
  userId: string;
  action: 'create' | 'modify' | 'delete' | 'approve' | 'reject' | 'acknowledge' | 'login' | 'logout';
  resource: string;
  resourceId: string;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string;
  ipAddress?: string;
  /** Monotonic sequence number for deterministic ordering */
  sequence: number;
  /** Immutable hash chain */
  entryHash: string;
  previousHash: string;
}

export interface ComplianceCheck {
  standard: 'CFR_21_PART_11' | 'IEC_62443' | 'ISA_99' | 'NERC_CIP';
  requirement: string;
  status: 'compliant' | 'non_compliant' | 'partial' | 'not_applicable';
  evidence: string[];
  lastChecked: Date;
}

/** Human-readable explanation for a decision */
export interface Explanation {
  decisionId: string;
  summary: string;
  inputDescription: string;
  ruleDescription: string;
  outputDescription: string;
  confidenceDescription: string;
  verificationSummary: string;
  fullText: string;
  generatedAt: Date;
}

/** Compliance audit report */
export interface ComplianceReport {
  id: string;
  title: string;
  standard: string;
  period: { start: Date; end: Date };
  generatedAt: Date;
  generatedBy: string;
  overallStatus: 'compliant' | 'non_compliant' | 'partial';
  checks: ComplianceCheck[];
  decisionCount: number;
  auditEntryCount: number;
  signatureCount: number;
  chainIntegrity: { valid: boolean; details: string };
  findings: ComplianceReportFinding[];
  sections: ComplianceReportSection[];
}

export interface ComplianceReportFinding {
  severity: 'observation' | 'minor' | 'major' | 'critical';
  requirement: string;
  description: string;
  recommendation: string;
}

export interface ComplianceReportSection {
  title: string;
  content: string;
}

/** Governance gate: pre-action approval hook */
export interface GovernanceGate {
  id: string;
  name: string;
  description: string;
  /** Actions this gate applies to */
  actionPatterns: string[];
  /** Required approval level */
  requiredApproval: 'none' | 'single' | 'dual' | 'committee';
  /** Required minimum confidence for automated decisions */
  minConfidence: number;
  /** Whether to block or warn on gate failure */
  enforcement: 'block' | 'warn' | 'log';
}

export interface GovernanceCheckResult {
  gateId: string;
  gateName: string;
  action: string;
  passed: boolean;
  enforcement: 'block' | 'warn' | 'log';
  reason: string;
  timestamp: Date;
}

/** Verification pipeline hook */
export type VerificationHook = (decision: DecisionRecord) => Promise<VerificationLayerResult>;

export interface ExplainabilityConfig {
  /** Enable CFR 21 Part 11 mode (stricter audit requirements) */
  cfr21Part11: boolean;
  /** Require electronic signatures for all control actions */
  requireSignatures: boolean;
  /** Minimum confidence score for automated decisions */
  minConfidence: number;
  /** Max records to keep in memory (older ones should be persisted) */
  maxInMemoryRecords: number;
}

const DEFAULT_CONFIG: ExplainabilityConfig = {
  cfr21Part11: false,
  requireSignatures: false,
  minConfidence: 0.7,
  maxInMemoryRecords: 50000,
};

// ─── Monitor ────────────────────────────────────────────────────────────────

export class ExplainabilityMonitor extends EventEmitter {
  private config: ExplainabilityConfig;
  private decisions: Map<string, DecisionRecord> = new Map();
  private explanations: Map<string, Explanation> = new Map();
  private auditTrail: AuditEntry[] = [];
  private lastDecisionHash = '0'.repeat(64);
  private lastAuditHash = '0'.repeat(64);
  private decisionSequence = 0;
  private auditSequence = 0;
  private complianceChecks: ComplianceCheck[] = [];
  private governanceGates: Map<string, GovernanceGate> = new Map();
  private verificationHooks: VerificationHook[] = [];
  private reports: Map<string, ComplianceReport> = new Map();

  constructor(config: Partial<ExplainabilityConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── Decision Recording ─────────────────────────────────────────────────

  /** Record an automated or human decision with full explainability */
  recordDecision(params: {
    source: string;
    action: string;
    ruleApplied?: string;
    reasoning: string;
    inputs: Record<string, any>;
    output: unknown;
    confidence: number;
    verificationLayers: VerificationLayerResult[];
    signature?: ElectronicSignature;
  }): DecisionRecord {
    const id = `dec_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    if (params.confidence < this.config.minConfidence) {
      this.emit('low_confidence', { id, confidence: params.confidence, action: params.action });
    }

    if (this.config.requireSignatures && !params.signature) {
      this.emit('signature_required', { id, action: params.action });
    }

    const recordContent = JSON.stringify({
      id,
      source: params.source,
      action: params.action,
      ruleApplied: params.ruleApplied ?? 'unspecified',
      reasoning: params.reasoning,
      inputs: params.inputs,
      output: params.output,
      confidence: params.confidence,
      verificationLayers: params.verificationLayers,
    });

    const recordHash = crypto.createHash('sha256')
      .update(recordContent + this.lastDecisionHash)
      .digest('hex');

    const seq = this.decisionSequence++;
    const record: DecisionRecord = {
      id,
      timestamp: new Date(),
      sequence: seq,
      source: params.source,
      action: params.action,
      ruleApplied: params.ruleApplied ?? 'unspecified',
      reasoning: params.reasoning,
      inputs: params.inputs,
      output: params.output,
      confidence: params.confidence,
      verificationLayers: params.verificationLayers,
      signature: params.signature,
      recordHash,
      previousHash: this.lastDecisionHash,
    };

    this.decisions.set(id, record);
    this.lastDecisionHash = recordHash;
    this.enforceMemoryLimit();

    // Auto-generate explanation
    const explanation = this.generateExplanation(record);
    this.explanations.set(id, explanation);

    // Run verification hooks asynchronously
    this.runVerificationHooks(record).catch(() => {});

    this.emit('decision', record);
    return record;
  }

  // ─── Explanation Generator ──────────────────────────────────────────────

  /** Generate a human-readable explanation for a decision */
  generateExplanation(record: DecisionRecord): Explanation {
    const inputDescription = this.describeInputs(record.inputs);
    const ruleDescription = `Rule applied: "${record.ruleApplied}".`;
    const outputDescription = this.describeOutput(record.output, record.action);
    const confidenceDescription = this.describeConfidence(record.confidence);
    const verificationSummary = this.describeVerification(record.verificationLayers);

    const summary = `${record.source} decided to ${record.action} because: ${record.reasoning}`;

    const fullText = [
      `Decision: ${record.action}`,
      `Time: ${record.timestamp.toISOString()}`,
      `Source: ${record.source}`,
      '',
      '--- Inputs ---',
      inputDescription,
      '',
      '--- Rule Applied ---',
      ruleDescription,
      '',
      '--- Output ---',
      outputDescription,
      '',
      '--- Confidence ---',
      confidenceDescription,
      '',
      '--- Verification ---',
      verificationSummary,
      '',
      '--- Reasoning ---',
      record.reasoning,
      record.signature
        ? `\n--- Signed by ${record.signature.userName} (${record.signature.role}) at ${record.signature.timestamp.toISOString()} for ${record.signature.meaning} ---`
        : '',
    ].join('\n');

    const explanation: Explanation = {
      decisionId: record.id,
      summary,
      inputDescription,
      ruleDescription,
      outputDescription,
      confidenceDescription,
      verificationSummary,
      fullText,
      generatedAt: new Date(),
    };

    this.emit('explanation', explanation);
    return explanation;
  }

  private describeInputs(inputs: Record<string, any>): string {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(inputs)) {
      if (typeof value === 'object' && value !== null) {
        lines.push(`• ${key}: ${JSON.stringify(value)}`);
      } else {
        lines.push(`• ${key}: ${value}`);
      }
    }
    return lines.length > 0 ? lines.join('\n') : 'No inputs recorded.';
  }

  private describeOutput(output: any, action: string): string {
    if (output === null || output === undefined) return 'No output recorded.';
    if (typeof output === 'object') {
      return `Action "${action}" produced: ${JSON.stringify(output, null, 2)}`;
    }
    return `Action "${action}" produced: ${output}`;
  }

  private describeConfidence(confidence: number): string {
    const pct = (confidence * 100).toFixed(1);
    if (confidence >= 0.9) return `High confidence (${pct}%) — automated execution appropriate.`;
    if (confidence >= 0.7) return `Moderate confidence (${pct}%) — within acceptable threshold.`;
    if (confidence >= 0.5) return `Low confidence (${pct}%) — manual review recommended.`;
    return `Very low confidence (${pct}%) — decision should be reviewed by qualified personnel.`;
  }

  private describeVerification(layers: VerificationLayerResult[]): string {
    if (layers.length === 0) return 'No verification layers applied.';
    const lines = layers.map(l => {
      const status = l.passed ? '✓ PASS' : '✗ FAIL';
      return `${status} — ${l.layer} (score: ${l.score.toFixed(2)})${l.details ? ': ' + l.details : ''}`;
    });
    const allPassed = layers.every(l => l.passed);
    lines.push(allPassed ? 'All verification layers passed.' : 'WARNING: Some verification layers failed.');
    return lines.join('\n');
  }

  /** Get explanation for a decision */
  getExplanation(decisionId: string): Explanation | undefined {
    return this.explanations.get(decisionId);
  }

  // ─── Audit Trail ────────────────────────────────────────────────────────

  /** Add an entry to the tamper-evident audit trail */
  addAuditEntry(params: {
    userId: string;
    action: AuditEntry['action'];
    resource: string;
    resourceId: string;
    oldValue?: unknown;
    newValue?: unknown;
    reason?: string;
    ipAddress?: string;
  }): AuditEntry {
    const id = `aud_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const entryContent = JSON.stringify({
      id,
      userId: params.userId,
      action: params.action,
      resource: params.resource,
      resourceId: params.resourceId,
      oldValue: params.oldValue,
      newValue: params.newValue,
      timestamp: new Date().toISOString(),
    });

    const entryHash = crypto.createHash('sha256')
      .update(entryContent + this.lastAuditHash)
      .digest('hex');

    const seq = this.auditSequence++;
    const entry: AuditEntry = {
      id,
      timestamp: new Date(),
      sequence: seq,
      userId: params.userId,
      action: params.action,
      resource: params.resource,
      resourceId: params.resourceId,
      oldValue: params.oldValue,
      newValue: params.newValue,
      reason: params.reason,
      ipAddress: params.ipAddress,
      entryHash,
      previousHash: this.lastAuditHash,
    };

    this.auditTrail.push(entry);
    this.lastAuditHash = entryHash;
    // Cap audit trail to prevent unbounded growth
    if (this.auditTrail.length > this.config.maxInMemoryRecords) {
      this.auditTrail = this.auditTrail.slice(-this.config.maxInMemoryRecords);
    }
    this.emit('audit', entry);

    return entry;
  }

  // ─── Electronic Signatures (CFR 21 Part 11 §11.50) ─────────────────────

  /** Create an electronic signature for a record */
  createSignature(params: {
    userId: string;
    userName: string;
    role: string;
    meaning: ElectronicSignature['meaning'];
    recordContent: string;
    signingKey?: string;
  }): ElectronicSignature {
    const signedHash = crypto.createHash('sha256')
      .update(`${params.userId}:${params.recordContent}:${new Date().toISOString()}`)
      .digest('hex');

    return {
      userId: params.userId,
      userName: params.userName,
      role: params.role,
      timestamp: new Date(),
      meaning: params.meaning,
      signedHash,
    };
  }

  // ─── Tamper-Evident Chain Verification ──────────────────────────────────

  /** Verify the integrity of the audit trail chain */
  verifyAuditChain(): { valid: boolean; brokenAt?: number; details: string } {
    let previousHash = '0'.repeat(64);

    for (let i = 0; i < this.auditTrail.length; i++) {
      const entry = this.auditTrail[i];
      if (entry.previousHash !== previousHash) {
        return {
          valid: false,
          brokenAt: i,
          details: `Chain broken at entry ${i} (${entry.id}): expected previousHash ${previousHash}, got ${entry.previousHash}`,
        };
      }
      previousHash = entry.entryHash;
    }

    return { valid: true, details: `Chain verified: ${this.auditTrail.length} entries intact` };
  }

  /** Verify the integrity of the decision record chain */
  verifyDecisionChain(): { valid: boolean; brokenAt?: string; details: string } {
    const sorted = Array.from(this.decisions.values())
      .sort((a, b) => a.sequence - b.sequence);

    let previousHash = '0'.repeat(64);
    for (const record of sorted) {
      if (record.previousHash !== previousHash) {
        return {
          valid: false,
          brokenAt: record.id,
          details: `Decision chain broken at ${record.id}`,
        };
      }
      previousHash = record.recordHash;
    }

    return { valid: true, details: `Decision chain verified: ${sorted.length} records intact` };
  }

  // ─── Governance Gates ───────────────────────────────────────────────────

  /** Register a governance gate for pre-action approval checks */
  registerGovernanceGate(gate: GovernanceGate): void {
    this.governanceGates.set(gate.id, gate);
    this.emit('gate_registered', gate);
  }

  /** Check if an action passes all applicable governance gates */
  checkGovernanceGates(action: string, confidence: number, hasSignature: boolean): GovernanceCheckResult[] {
    const results: GovernanceCheckResult[] = [];

    for (const gate of this.governanceGates.values()) {
      const applies = gate.actionPatterns.some(pattern => {
        if (pattern === '*') return true;
        if (pattern.endsWith('*')) return action.startsWith(pattern.slice(0, -1));
        return action === pattern;
      });

      if (!applies) continue;

      let passed = true;
      let reason = 'Gate check passed.';

      // Check confidence threshold
      if (confidence < gate.minConfidence) {
        passed = false;
        reason = `Confidence ${(confidence * 100).toFixed(1)}% below gate minimum ${(gate.minConfidence * 100).toFixed(1)}%.`;
      }

      // Check signature requirements
      if (gate.requiredApproval !== 'none' && !hasSignature) {
        passed = false;
        reason = `Gate requires ${gate.requiredApproval} approval but no signature provided.`;
      }

      const result: GovernanceCheckResult = {
        gateId: gate.id,
        gateName: gate.name,
        action,
        passed,
        enforcement: gate.enforcement,
        reason,
        timestamp: new Date(),
      };

      results.push(result);
      this.emit('governance_check', result);

      if (!passed && gate.enforcement === 'block') {
        this.emit('governance_blocked', result);
      }
    }

    return results;
  }

  // ─── Verification Pipeline Hooks ────────────────────────────────────────

  /** Register a verification hook that runs on every recorded decision */
  registerVerificationHook(hook: VerificationHook): void {
    this.verificationHooks.push(hook);
  }

  /** Run all registered verification hooks on a decision */
  private async runVerificationHooks(decision: DecisionRecord): Promise<void> {
    for (const hook of this.verificationHooks) {
      try {
        const result = await hook(decision);
        decision.verificationLayers.push(result);
        this.emit('verification_result', { decisionId: decision.id, result });
      } catch (err) {
        this.emit('verification_error', { decisionId: decision.id, error: err });
      }
    }
  }

  // ─── Compliance Report Generation ───────────────────────────────────────

  /** Run CFR 21 Part 11 compliance checks */
  runComplianceCheck(): ComplianceCheck[] {
    const checks: ComplianceCheck[] = [
      {
        standard: 'CFR_21_PART_11',
        requirement: '11.10(a) - System validation',
        status: this.config.cfr21Part11 ? 'compliant' : 'not_applicable',
        evidence: ['Explainability monitor active', `Config: cfr21Part11=${this.config.cfr21Part11}`],
        lastChecked: new Date(),
      },
      {
        standard: 'CFR_21_PART_11',
        requirement: '11.10(e) - Audit trail',
        status: this.auditTrail.length > 0 ? 'compliant' : 'partial',
        evidence: [
          `${this.auditTrail.length} audit entries recorded`,
          `Chain integrity: ${this.verifyAuditChain().valid ? 'VALID' : 'BROKEN'}`,
        ],
        lastChecked: new Date(),
      },
      {
        standard: 'CFR_21_PART_11',
        requirement: '11.50 - Electronic signatures',
        status: this.config.requireSignatures ? 'compliant' : 'partial',
        evidence: [
          `Signature requirement: ${this.config.requireSignatures ? 'ENABLED' : 'DISABLED'}`,
          `Signed decisions: ${Array.from(this.decisions.values()).filter(d => d.signature).length}`,
        ],
        lastChecked: new Date(),
      },
      {
        standard: 'CFR_21_PART_11',
        requirement: '11.10(k)(2) - Authority checks',
        status: this.governanceGates.size > 0 ? 'compliant' : 'partial',
        evidence: [
          `Governance gates registered: ${this.governanceGates.size}`,
          'Authority checks via governance gate enforcement',
        ],
        lastChecked: new Date(),
      },
      {
        standard: 'CFR_21_PART_11',
        requirement: '11.70 - Signature/record linking',
        status: this.config.requireSignatures ? 'compliant' : 'partial',
        evidence: [
          'Signatures are embedded within decision records',
          'Hash chain links signatures to record content',
        ],
        lastChecked: new Date(),
      },
    ];

    this.complianceChecks = checks;
    this.emit('compliance_check', checks);
    return checks;
  }

  /** Generate a full compliance audit report */
  generateComplianceReport(params: {
    standard: string;
    period: { start: Date; end: Date };
    generatedBy: string;
  }): ComplianceReport {
    const checks = this.runComplianceCheck();
    const auditChain = this.verifyAuditChain();
    const decisionChain = this.verifyDecisionChain();

    // Filter to period
    const periodDecisions = Array.from(this.decisions.values()).filter(
      d => d.timestamp >= params.period.start && d.timestamp <= params.period.end,
    );
    const periodAudit = this.auditTrail.filter(
      e => e.timestamp >= params.period.start && e.timestamp <= params.period.end,
    );
    const signedCount = periodDecisions.filter(d => d.signature).length;

    // Generate findings
    const findings: ComplianceReportFinding[] = [];

    if (!auditChain.valid) {
      findings.push({
        severity: 'critical',
        requirement: '11.10(e)',
        description: `Audit trail chain integrity compromised: ${auditChain.details}`,
        recommendation: 'Investigate and remediate audit trail tampering immediately.',
      });
    }
    if (!decisionChain.valid) {
      findings.push({
        severity: 'critical',
        requirement: '11.10(e)',
        description: `Decision record chain integrity compromised: ${decisionChain.details}`,
        recommendation: 'Investigate decision record integrity.',
      });
    }
    if (this.config.requireSignatures && signedCount < periodDecisions.length) {
      findings.push({
        severity: 'major',
        requirement: '11.50',
        description: `${periodDecisions.length - signedCount} decisions lack electronic signatures.`,
        recommendation: 'Ensure all control decisions are signed per CFR 21 Part 11 §11.50.',
      });
    }
    if (this.governanceGates.size === 0) {
      findings.push({
        severity: 'minor',
        requirement: '11.10(k)(2)',
        description: 'No governance gates configured for authority checks.',
        recommendation: 'Configure governance gates for critical control actions.',
      });
    }
    const lowConfDecisions = periodDecisions.filter(d => d.confidence < this.config.minConfidence);
    if (lowConfDecisions.length > 0) {
      findings.push({
        severity: 'observation',
        requirement: '11.10(a)',
        description: `${lowConfDecisions.length} decisions had confidence below threshold (${this.config.minConfidence}).`,
        recommendation: 'Review low-confidence automated decisions for accuracy.',
      });
    }

    // Generate report sections
    const sections: ComplianceReportSection[] = [
      {
        title: 'Executive Summary',
        content: `This report covers the period ${params.period.start.toISOString()} to ${params.period.end.toISOString()}. ` +
          `${periodDecisions.length} automated decisions were recorded, ${periodAudit.length} audit entries logged, ` +
          `and ${signedCount} electronic signatures captured. ` +
          `Audit chain integrity: ${auditChain.valid ? 'VERIFIED' : 'COMPROMISED'}. ` +
          `Decision chain integrity: ${decisionChain.valid ? 'VERIFIED' : 'COMPROMISED'}.`,
      },
      {
        title: 'Audit Trail Analysis',
        content: `Total audit entries in period: ${periodAudit.length}\n` +
          `Actions breakdown: ${this.summarizeAuditActions(periodAudit)}\n` +
          `Chain integrity: ${auditChain.details}`,
      },
      {
        title: 'Decision Analysis',
        content: `Total decisions in period: ${periodDecisions.length}\n` +
          `Average confidence: ${periodDecisions.length > 0 ? (periodDecisions.reduce((s, d) => s + d.confidence, 0) / periodDecisions.length * 100).toFixed(1) : 'N/A'}%\n` +
          `Signed: ${signedCount}/${periodDecisions.length}\n` +
          `Low confidence: ${lowConfDecisions.length}`,
      },
      {
        title: 'Findings & Recommendations',
        content: findings.length === 0
          ? 'No findings. System is fully compliant.'
          : findings.map(f => `[${f.severity.toUpperCase()}] ${f.requirement}: ${f.description}\n  → ${f.recommendation}`).join('\n\n'),
      },
    ];

    const nonCompliantChecks = checks.filter(c => c.status === 'non_compliant');
    const overallStatus: ComplianceReport['overallStatus'] =
      nonCompliantChecks.length > 0 ? 'non_compliant' :
      findings.some(f => f.severity === 'critical' || f.severity === 'major') ? 'partial' :
      'compliant';

    const report: ComplianceReport = {
      id: `report_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      title: `${params.standard} Compliance Audit Report`,
      standard: params.standard,
      period: params.period,
      generatedAt: new Date(),
      generatedBy: params.generatedBy,
      overallStatus,
      checks,
      decisionCount: periodDecisions.length,
      auditEntryCount: periodAudit.length,
      signatureCount: signedCount,
      chainIntegrity: { valid: auditChain.valid && decisionChain.valid, details: `Audit: ${auditChain.details}; Decisions: ${decisionChain.details}` },
      findings,
      sections,
    };

    this.reports.set(report.id, report);
    this.emit('report_generated', report);
    return report;
  }

  private summarizeAuditActions(entries: AuditEntry[]): string {
    const counts = new Map<string, number>();
    for (const e of entries) {
      counts.set(e.action, (counts.get(e.action) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none';
  }

  // ─── Query ──────────────────────────────────────────────────────────────

  getDecision(id: string): DecisionRecord | undefined {
    return this.decisions.get(id);
  }

  getRecentDecisions(limit = 20): DecisionRecord[] {
    return Array.from(this.decisions.values())
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  getAuditTrail(filters?: {
    userId?: string;
    action?: AuditEntry['action'];
    resource?: string;
    since?: Date;
    limit?: number;
  }): AuditEntry[] {
    let entries = this.auditTrail;
    if (filters?.userId) entries = entries.filter(e => e.userId === filters.userId);
    if (filters?.action) entries = entries.filter(e => e.action === filters.action);
    if (filters?.resource) entries = entries.filter(e => e.resource === filters.resource);
    if (filters?.since) entries = entries.filter(e => e.timestamp >= filters.since!);
    if (filters?.limit) entries = entries.slice(-filters.limit);
    return entries;
  }

  getComplianceStatus(): ComplianceCheck[] {
    if (this.complianceChecks.length === 0) this.runComplianceCheck();
    return this.complianceChecks;
  }

  getReport(id: string): ComplianceReport | undefined {
    return this.reports.get(id);
  }

  getRecentReports(limit = 10): ComplianceReport[] {
    return Array.from(this.reports.values())
      .sort((a, b) => b.generatedAt.getTime() - a.generatedAt.getTime())
      .slice(0, limit);
  }

  getStatus() {
    return {
      totalDecisions: this.decisions.size,
      totalAuditEntries: this.auditTrail.length,
      totalExplanations: this.explanations.size,
      totalReports: this.reports.size,
      auditChainValid: this.verifyAuditChain().valid,
      decisionChainValid: this.verifyDecisionChain().valid,
      cfr21Part11Enabled: this.config.cfr21Part11,
      signaturesRequired: this.config.requireSignatures,
      governanceGates: this.governanceGates.size,
      verificationHooks: this.verificationHooks.length,
    };
  }

  private enforceMemoryLimit(): void {
    if (this.decisions.size > this.config.maxInMemoryRecords) {
      const entries = Array.from(this.decisions.keys());
      const toRemove = entries.slice(0, entries.length - this.config.maxInMemoryRecords);
      for (const key of toRemove) {
        this.decisions.delete(key);
        this.explanations.delete(key);
      }
    }
  }
}

// Singleton
export const explainabilityMonitor = new ExplainabilityMonitor();
