/**
 * 0xSCADA Agent Certification Manager
 * 
 * ADR-0010: Agent Certification Framework
 * 
 * Manages the lifecycle of agent certifications:
 * - Initiate certification process (SUBMIT → REVIEW → TEST → AUDIT → CERTIFY)
 * - Evaluate requirements per certification level
 * - Record certifier sign-offs
 * - Track recertification triggers
 * - Provide certification status queries
 */

import { randomUUID } from "crypto";
import { sha256, canonicalize } from "../crypto";
import { log, logError } from "../logger";
import type {
  CertificationRecord,
  CertificationCheck,
  CertificationLevel,
  CertificationStage,
  RecertificationTrigger,
  LevelRequirement,
} from "@shared/types/agent-certification";
import {
  CertificationLevel as Levels,
  CertificationCheckStatus,
  CertificationStage as Stages,
  REQUIREMENTS_BY_LEVEL,
  CERTIFICATION_LEVEL_META,
  CERTIFICATION_LEVEL_ORDER,
} from "@shared/types/agent-certification";

// =============================================================================
// CERTIFICATION MANAGER
// =============================================================================

export class CertificationManager {
  /** Active certifications indexed by ID */
  private certifications: Map<string, CertificationRecord> = new Map();

  /** Certifications indexed by agent ID */
  private agentCertifications: Map<string, string[]> = new Map();

  /** Recertification watch list */
  private recertificationTriggers: Array<{
    agentId: string;
    trigger: RecertificationTrigger;
    triggeredAt: string;
    resolved: boolean;
  }> = [];

  // ==========================================================================
  // CERTIFICATION LIFECYCLE
  // ==========================================================================

  /**
   * Initiate a new certification process for an agent
   */
  initiateCertification(
    agentId: string,
    agentVersion: string,
    targetLevel: CertificationLevel
  ): CertificationRecord {
    const requirements = REQUIREMENTS_BY_LEVEL[targetLevel];
    if (!requirements) {
      throw new Error(`Unknown certification level: ${targetLevel}`);
    }

    // Build initial check list from requirements
    const checks: CertificationCheck[] = requirements.map((req) => ({
      id: req.id,
      description: req.description,
      requiredForLevel: targetLevel,
      status: "PENDING" as const,
    }));

    const now = new Date().toISOString();
    const record: CertificationRecord = {
      id: randomUUID(),
      agentId,
      agentVersion,
      level: targetLevel,
      testSuiteHash: "",
      checks,
      certifiers: [],
      status: "IN_PROGRESS",
      revoked: false,
      createdAt: now,
      updatedAt: now,
    };

    this.certifications.set(record.id, record);

    if (!this.agentCertifications.has(agentId)) {
      this.agentCertifications.set(agentId, []);
    }
    this.agentCertifications.get(agentId)!.push(record.id);

    log(
      `📋 Certification initiated: ${agentId} → ${CERTIFICATION_LEVEL_META[targetLevel].name} (${record.id})`,
      "certification"
    );

    return record;
  }

  /**
   * Update a check result within a certification
   */
  updateCheck(
    certificationId: string,
    checkId: string,
    status: "PASSED" | "FAILED" | "NOT_APPLICABLE",
    options: { evidenceHash?: string; verifiedBy?: string; notes?: string } = {}
  ): CertificationRecord | null {
    const record = this.certifications.get(certificationId);
    if (!record || record.status !== "IN_PROGRESS") {
      return null;
    }

    const check = record.checks.find((c) => c.id === checkId);
    if (!check) {
      return null;
    }

    check.status = status;
    check.evaluatedAt = new Date().toISOString();
    if (options.evidenceHash) check.evidenceHash = options.evidenceHash;
    if (options.verifiedBy) check.verifiedBy = options.verifiedBy;
    if (options.notes) check.notes = options.notes;

    record.updatedAt = new Date().toISOString();

    log(
      `✅ Check updated: ${checkId} → ${status} (cert: ${certificationId})`,
      "certification"
    );

    return record;
  }

  /**
   * Submit test suite results for a certification
   */
  submitTestResults(certificationId: string, testResultsData: unknown): CertificationRecord | null {
    const record = this.certifications.get(certificationId);
    if (!record || record.status !== "IN_PROGRESS") {
      return null;
    }

    record.testSuiteHash = sha256(canonicalize(testResultsData));
    record.updatedAt = new Date().toISOString();

    return record;
  }

  /**
   * Add a certifier sign-off
   */
  addCertifierSignOff(
    certificationId: string,
    certifier: { id: string; name: string; role: string; signature: string }
  ): CertificationRecord | null {
    const record = this.certifications.get(certificationId);
    if (!record || record.status !== "IN_PROGRESS") {
      return null;
    }

    record.certifiers.push({
      ...certifier,
      signedAt: new Date().toISOString(),
    });
    record.updatedAt = new Date().toISOString();

    log(
      `🖊️ Certifier sign-off: ${certifier.name} (${certifier.role}) on ${certificationId}`,
      "certification"
    );

    return record;
  }

  /**
   * Finalize certification — checks all requirements are met
   */
  finalizeCertification(certificationId: string): {
    success: boolean;
    record?: CertificationRecord;
    failedChecks?: CertificationCheck[];
    reason?: string;
  } {
    const record = this.certifications.get(certificationId);
    if (!record) {
      return { success: false, reason: "Certification not found" };
    }

    if (record.status !== "IN_PROGRESS") {
      return { success: false, reason: `Certification is ${record.status}, not IN_PROGRESS` };
    }

    // Check all requirements are passed or N/A
    const failedChecks = record.checks.filter(
      (c) => c.status !== "PASSED" && c.status !== "NOT_APPLICABLE"
    );

    if (failedChecks.length > 0) {
      return {
        success: false,
        failedChecks,
        reason: `${failedChecks.length} checks not passed: ${failedChecks.map((c) => c.id).join(", ")}`,
      };
    }

    // Check test suite hash is present
    if (!record.testSuiteHash) {
      return { success: false, reason: "Test suite results not submitted" };
    }

    // Check at least one certifier
    if (record.certifiers.length === 0) {
      return { success: false, reason: "No certifier sign-offs" };
    }

    // AC-3 and AC-4 require audit report
    if (
      (record.level === Levels.AC3_OPERATOR || record.level === Levels.AC4_AUTONOMOUS) &&
      !record.auditReportHash
    ) {
      return { success: false, reason: "Audit report required for AC-3/AC-4" };
    }

    // Certify!
    const now = new Date();
    record.status = "CERTIFIED";
    record.issuedAt = now.toISOString();
    record.expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString(); // 12 months
    record.updatedAt = now.toISOString();

    log(
      `🏆 Certification granted: ${record.agentId} → ${CERTIFICATION_LEVEL_META[record.level].name}`,
      "certification"
    );

    return { success: true, record };
  }

  /**
   * Submit an audit report hash
   */
  submitAuditReport(certificationId: string, auditReportHash: string): CertificationRecord | null {
    const record = this.certifications.get(certificationId);
    if (!record || record.status !== "IN_PROGRESS") {
      return null;
    }

    record.auditReportHash = auditReportHash;
    record.updatedAt = new Date().toISOString();
    return record;
  }

  // ==========================================================================
  // REVOCATION & RECERTIFICATION
  // ==========================================================================

  /**
   * Revoke a certification
   */
  revokeCertification(certificationId: string, reason: string): boolean {
    const record = this.certifications.get(certificationId);
    if (!record || record.status !== "CERTIFIED") {
      return false;
    }

    record.status = "REVOKED";
    record.revoked = true;
    record.revokedReason = reason;
    record.updatedAt = new Date().toISOString();

    log(`🚫 Certification revoked: ${certificationId} — ${reason}`, "certification");

    return true;
  }

  /**
   * Record a recertification trigger
   */
  triggerRecertification(agentId: string, trigger: RecertificationTrigger): void {
    this.recertificationTriggers.push({
      agentId,
      trigger,
      triggeredAt: new Date().toISOString(),
      resolved: false,
    });

    // Expire all active certifications for this agent
    const certIds = this.agentCertifications.get(agentId) || [];
    for (const certId of certIds) {
      const record = this.certifications.get(certId);
      if (record && record.status === "CERTIFIED") {
        record.status = "EXPIRED";
        record.updatedAt = new Date().toISOString();
      }
    }

    log(
      `⚠️ Recertification triggered for ${agentId}: ${trigger}`,
      "certification"
    );
  }

  // ==========================================================================
  // QUERIES
  // ==========================================================================

  /**
   * Get current active certification for an agent
   */
  getActiveCertification(agentId: string): CertificationRecord | null {
    const certIds = this.agentCertifications.get(agentId) || [];
    for (const certId of certIds) {
      const record = this.certifications.get(certId);
      if (record && record.status === "CERTIFIED") {
        // Check expiry
        if (record.expiresAt && new Date(record.expiresAt) < new Date()) {
          record.status = "EXPIRED";
          continue;
        }
        return record;
      }
    }
    return null;
  }

  /**
   * Get certification by ID
   */
  getCertification(certificationId: string): CertificationRecord | undefined {
    return this.certifications.get(certificationId);
  }

  /**
   * Get all certifications for an agent
   */
  getAgentCertifications(agentId: string): CertificationRecord[] {
    const certIds = this.agentCertifications.get(agentId) || [];
    return certIds
      .map((id) => this.certifications.get(id))
      .filter((r): r is CertificationRecord => r !== undefined);
  }

  /**
   * Get pending recertification triggers for an agent
   */
  getPendingRecertifications(agentId: string): typeof this.recertificationTriggers {
    return this.recertificationTriggers.filter(
      (t) => t.agentId === agentId && !t.resolved
    );
  }

  /**
   * Check if an agent is certified at or above a given level
   */
  isAgentCertified(agentId: string, minimumLevel: CertificationLevel): boolean {
    const active = this.getActiveCertification(agentId);
    if (!active) return false;

    const activeIndex = CERTIFICATION_LEVEL_ORDER.indexOf(active.level as CertificationLevel);
    const requiredIndex = CERTIFICATION_LEVEL_ORDER.indexOf(minimumLevel);

    return activeIndex >= requiredIndex;
  }

  /**
   * Get requirements for a certification level
   */
  getRequirements(level: CertificationLevel): LevelRequirement[] {
    return REQUIREMENTS_BY_LEVEL[level] || [];
  }

  /**
   * Get certification progress summary
   */
  getCertificationProgress(certificationId: string): {
    total: number;
    passed: number;
    failed: number;
    pending: number;
    percentComplete: number;
  } | null {
    const record = this.certifications.get(certificationId);
    if (!record) return null;

    const total = record.checks.length;
    const passed = record.checks.filter((c) => c.status === "PASSED" || c.status === "NOT_APPLICABLE").length;
    const failed = record.checks.filter((c) => c.status === "FAILED").length;
    const pending = record.checks.filter((c) => c.status === "PENDING").length;

    return {
      total,
      passed,
      failed,
      pending,
      percentComplete: total > 0 ? Math.round((passed / total) * 100) : 0,
    };
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalCertifications: number;
    certified: number;
    inProgress: number;
    expired: number;
    revoked: number;
    pendingRecertifications: number;
  } {
    let certified = 0, inProgress = 0, expired = 0, revoked = 0;
    for (const record of this.certifications.values()) {
      switch (record.status) {
        case "CERTIFIED": certified++; break;
        case "IN_PROGRESS": inProgress++; break;
        case "EXPIRED": expired++; break;
        case "REVOKED": revoked++; break;
      }
    }
    return {
      totalCertifications: this.certifications.size,
      certified,
      inProgress,
      expired,
      revoked,
      pendingRecertifications: this.recertificationTriggers.filter((t) => !t.resolved).length,
    };
  }
}

// =============================================================================
// SINGLETON
// =============================================================================

let certManagerInstance: CertificationManager | null = null;

export function getCertificationManager(): CertificationManager {
  if (!certManagerInstance) {
    certManagerInstance = new CertificationManager();
  }
  return certManagerInstance;
}

export function initCertificationManager(): CertificationManager {
  certManagerInstance = new CertificationManager();
  return certManagerInstance;
}
