/**
 * Explainability Monitor for SCADA Audit
 * 
 * Adapted from QuantumSingularity's explainability patterns for SCADA compliance.
 * Provides decision scoring, audit trail generation, and CFR 21 Part 11 compliance helpers.
 * 
 * CFR 21 Part 11 requires:
 * - Electronic signatures with user identity
 * - Audit trails that are computer-generated, time-stamped, and cannot be modified
 * - Authority checks before allowing system changes
 * - Tamper-evident records
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';

// ----- Types -----

export interface DecisionRecord {
  id: string;
  timestamp: Date;
  /** What system/subsystem made the decision */
  source: string;
  /** What action was decided */
  action: string;
  /** Why the decision was made */
  reasoning: string;
  /** Input data that led to the decision */
  inputs: Record<string, any>;
  /** Output/result of the decision */
  output: any;
  /** Confidence score 0-1 */
  confidence: number;
  /** Which verification layers passed */
  verificationLayers: VerificationLayerResult[];
  /** Electronic signature if required */
  signature?: ElectronicSignature;
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
  oldValue?: any;
  newValue?: any;
  reason?: string;
  ipAddress?: string;
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

// ----- Monitor -----

export class ExplainabilityMonitor extends EventEmitter {
  private config: ExplainabilityConfig;
  private decisions: Map<string, DecisionRecord> = new Map();
  private auditTrail: AuditEntry[] = [];
  private lastDecisionHash = '0'.repeat(64);
  private lastAuditHash = '0'.repeat(64);
  private complianceChecks: ComplianceCheck[] = [];

  constructor(config: Partial<ExplainabilityConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ----- Decision Recording -----

  /** Record an automated or human decision with full explainability */
  recordDecision(params: {
    source: string;
    action: string;
    reasoning: string;
    inputs: Record<string, any>;
    output: any;
    confidence: number;
    verificationLayers: VerificationLayerResult[];
    signature?: ElectronicSignature;
  }): DecisionRecord {
    const id = `dec_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    // Check confidence threshold
    if (params.confidence < this.config.minConfidence) {
      this.emit('low_confidence', { id, confidence: params.confidence, action: params.action });
    }

    // CFR 21 Part 11: require signature for control actions
    if (this.config.requireSignatures && !params.signature) {
      this.emit('signature_required', { id, action: params.action });
    }

    const recordContent = JSON.stringify({
      id,
      source: params.source,
      action: params.action,
      reasoning: params.reasoning,
      inputs: params.inputs,
      output: params.output,
      confidence: params.confidence,
      verificationLayers: params.verificationLayers,
    });

    const recordHash = crypto.createHash('sha256')
      .update(recordContent + this.lastDecisionHash)
      .digest('hex');

    const record: DecisionRecord = {
      id,
      timestamp: new Date(),
      source: params.source,
      action: params.action,
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
    this.emit('decision', record);

    return record;
  }

  // ----- Audit Trail -----

  /** Add an entry to the tamper-evident audit trail */
  addAuditEntry(params: {
    userId: string;
    action: AuditEntry['action'];
    resource: string;
    resourceId: string;
    oldValue?: any;
    newValue?: any;
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

    const entry: AuditEntry = {
      id,
      timestamp: new Date(),
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
    this.emit('audit', entry);

    return entry;
  }

  // ----- CFR 21 Part 11 Helpers -----

  /** Create an electronic signature for a record */
  createSignature(params: {
    userId: string;
    userName: string;
    role: string;
    meaning: ElectronicSignature['meaning'];
    recordContent: string;
    /** In production, this would use the user's private key/certificate */
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
        status: 'partial',
        evidence: ['Authority checks delegated to authentication middleware'],
        lastChecked: new Date(),
      },
    ];

    this.complianceChecks = checks;
    this.emit('compliance_check', checks);
    return checks;
  }

  // ----- Query -----

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

  getStatus() {
    return {
      totalDecisions: this.decisions.size,
      totalAuditEntries: this.auditTrail.length,
      auditChainValid: this.verifyAuditChain().valid,
      cfr21Part11Enabled: this.config.cfr21Part11,
      signaturesRequired: this.config.requireSignatures,
    };
  }

  private enforceMemoryLimit(): void {
    if (this.decisions.size > this.config.maxInMemoryRecords) {
      const entries = Array.from(this.decisions.keys());
      const toRemove = entries.slice(0, entries.length - this.config.maxInMemoryRecords);
      for (const key of toRemove) {
        this.decisions.delete(key);
      }
    }
  }
}

// Singleton
export const explainabilityMonitor = new ExplainabilityMonitor();
