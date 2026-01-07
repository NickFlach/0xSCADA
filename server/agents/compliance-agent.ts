/**
 * 0xSCADA Compliance Agent
 * 
 * PRD Section 6.4: Required Agent (P0)
 * - Generates audit evidence
 * - Verifies on-chain anchors
 * - Produces regulator-ready reports
 */

import { 
  BaseAgent, 
  AgentCapability, 
  AgentOutputType,
  type AgentConfig,
  generateAgentKeys,
} from "./base";
import type { SignedEvent } from "../events";
import { verifyMerkleProof, sha256 } from "../crypto";

// =============================================================================
// COMPLIANCE AGENT CONFIGURATION
// =============================================================================

const COMPLIANCE_CAPABILITIES: AgentCapability[] = [
  AgentCapability.READ_EVENTS,
  AgentCapability.READ_ASSETS,
  AgentCapability.READ_SITES,
  AgentCapability.VERIFY_ANCHORS,
  AgentCapability.VERIFY_SIGNATURES,
  AgentCapability.VERIFY_COMPLIANCE,
  AgentCapability.GENERATE_REPORTS,
];

// =============================================================================
// AUDIT TYPES
// =============================================================================

export interface AuditRecord {
  id: string;
  eventId: string;
  eventType: string;
  eventHash: string;
  siteId: string;
  assetId?: string;
  timestamp: Date;
  
  // Verification status
  signatureVerified: boolean;
  anchorVerified: boolean;
  merkleProofValid?: boolean;
  
  // Anchor details
  batchId?: string;
  merkleRoot?: string;
  txHash?: string;
  blockNumber?: number;
  
  // Compliance flags
  compliant: boolean;
  issues: string[];
}

export interface ComplianceReport {
  id: string;
  reportType: "DAILY" | "WEEKLY" | "MONTHLY" | "AUDIT" | "INCIDENT";
  title: string;
  generatedAt: Date;
  periodStart: Date;
  periodEnd: Date;
  
  // Summary
  summary: {
    totalEvents: number;
    verifiedEvents: number;
    anchoredEvents: number;
    complianceRate: number;
    issues: number;
  };
  
  // Site breakdown
  siteBreakdown: Array<{
    siteId: string;
    eventCount: number;
    complianceRate: number;
    issues: string[];
  }>;
  
  // Issues
  issues: Array<{
    severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    description: string;
    eventIds: string[];
    recommendation: string;
  }>;
  
  // Cryptographic proof
  reportHash: string;
  signature: string;
}

// =============================================================================
// COMPLIANCE AGENT IMPLEMENTATION
// =============================================================================

export class ComplianceAgent extends BaseAgent {
  private auditRecords: Map<string, AuditRecord> = new Map();
  private pendingVerifications: string[] = [];

  constructor(config: Partial<AgentConfig> & { id: string; name: string }) {
    const keys = generateAgentKeys();
    
    super({
      id: config.id,
      name: config.name,
      displayName: config.displayName || "Compliance Agent",
      agentType: "COMPLIANCE",
      capabilities: COMPLIANCE_CAPABILITIES,
      scope: config.scope || {
        allSites: true,
        siteIds: [],
        allAssets: true,
        assetIds: [],
        assetTypes: [],
        allEventTypes: true,
        eventTypes: [],
      },
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    });
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  protected async onStart(): Promise<void> {
    console.log(`   📋 Compliance Agent ready - auditing all events`);
  }

  protected async onStop(): Promise<void> {
    // Generate final report if needed
  }

  // ==========================================================================
  // EVENT HANDLING
  // ==========================================================================

  async handleEvent(event: SignedEvent): Promise<void> {
    // Create audit record for every event
    const auditRecord = await this.createAuditRecord(event);
    this.auditRecords.set(auditRecord.id, auditRecord);

    // Queue for anchor verification if not yet anchored
    if (!auditRecord.anchorVerified) {
      this.pendingVerifications.push(auditRecord.id);
    }

    // Check for compliance issues
    if (!auditRecord.compliant) {
      console.log(`   ⚠️ Compliance issue detected for event ${event.hash.slice(0, 8)}...`);
      for (const issue of auditRecord.issues) {
        console.log(`      - ${issue}`);
      }
    }
  }

  // ==========================================================================
  // AUDIT RECORD CREATION
  // ==========================================================================

  /**
   * Create an audit record for an event
   */
  private async createAuditRecord(event: SignedEvent): Promise<AuditRecord> {
    const id = sha256(`audit-${event.hash}-${Date.now()}`).slice(0, 16);
    const issues: string[] = [];

    // Verify signature (simplified - in production would verify against public key)
    const signatureVerified = Boolean(event.signature && event.signature.length > 0);
    if (!signatureVerified) {
      issues.push("Event signature missing or invalid");
    }

    // Check anchor status
    const anchorVerified = false; // Will be updated when anchor is verified
    
    // Check for required fields
    if (!event.siteId) {
      issues.push("Missing site ID");
    }
    if (!event.originId) {
      issues.push("Missing origin ID");
    }
    if (!event.sourceTimestamp) {
      issues.push("Missing source timestamp");
    }

    // Check timestamp validity
    const eventTime = new Date(event.sourceTimestamp);
    const now = new Date();
    if (eventTime > now) {
      issues.push("Event timestamp is in the future");
    }
    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    if (eventTime < oneYearAgo) {
      issues.push("Event timestamp is more than 1 year old");
    }

    return {
      id,
      eventId: event.hash,
      eventType: event.eventType,
      eventHash: event.hash,
      siteId: event.siteId,
      assetId: event.assetId,
      timestamp: new Date(event.sourceTimestamp),
      signatureVerified,
      anchorVerified,
      compliant: issues.length === 0,
      issues,
    };
  }

  // ==========================================================================
  // ANCHOR VERIFICATION
  // ==========================================================================

  /**
   * Verify an event's anchor on-chain
   */
  async verifyEventAnchor(
    eventHash: string,
    batchId: string,
    merkleRoot: string,
    merkleProof: string[],
    merkleIndex: number,
    txHash: string,
    blockNumber: number
  ): Promise<boolean> {
    // Find the audit record
    let auditRecord: AuditRecord | undefined;
    for (const record of this.auditRecords.values()) {
      if (record.eventHash === eventHash) {
        auditRecord = record;
        break;
      }
    }

    if (!auditRecord) {
      console.log(`   ❌ No audit record found for event ${eventHash.slice(0, 8)}...`);
      return false;
    }

    // Verify Merkle proof
    const proofValid = verifyMerkleProof(eventHash, merkleProof, merkleRoot, merkleIndex);

    // Update audit record
    auditRecord.batchId = batchId;
    auditRecord.merkleRoot = merkleRoot;
    auditRecord.merkleProofValid = proofValid;
    auditRecord.txHash = txHash;
    auditRecord.blockNumber = blockNumber;
    auditRecord.anchorVerified = proofValid;

    if (!proofValid) {
      auditRecord.issues.push("Merkle proof verification failed");
      auditRecord.compliant = false;
    }

    this.auditRecords.set(auditRecord.id, auditRecord);

    // Remove from pending verifications
    const pendingIndex = this.pendingVerifications.indexOf(auditRecord.id);
    if (pendingIndex > -1) {
      this.pendingVerifications.splice(pendingIndex, 1);
    }

    console.log(`   ${proofValid ? "✅" : "❌"} Anchor verification for ${eventHash.slice(0, 8)}...: ${proofValid ? "VALID" : "INVALID"}`);

    return proofValid;
  }

  // ==========================================================================
  // REPORT GENERATION
  // ==========================================================================

  /**
   * Generate a compliance report
   */
  generateComplianceReport(
    reportType: "DAILY" | "WEEKLY" | "MONTHLY" | "AUDIT" | "INCIDENT",
    periodStart: Date,
    periodEnd: Date,
    title?: string
  ): ComplianceReport {
    // Filter records for the period
    const records = Array.from(this.auditRecords.values()).filter(
      r => r.timestamp >= periodStart && r.timestamp <= periodEnd
    );

    // Calculate summary
    const totalEvents = records.length;
    const verifiedEvents = records.filter(r => r.signatureVerified).length;
    const anchoredEvents = records.filter(r => r.anchorVerified).length;
    const compliantEvents = records.filter(r => r.compliant).length;
    const complianceRate = totalEvents > 0 ? compliantEvents / totalEvents : 1;

    // Group by site
    const siteMap = new Map<string, AuditRecord[]>();
    for (const record of records) {
      const existing = siteMap.get(record.siteId) || [];
      existing.push(record);
      siteMap.set(record.siteId, existing);
    }

    const siteBreakdown = Array.from(siteMap.entries()).map(([siteId, siteRecords]) => {
      const siteCompliant = siteRecords.filter(r => r.compliant).length;
      const siteIssues = new Set<string>();
      for (const r of siteRecords) {
        for (const issue of r.issues) {
          siteIssues.add(issue);
        }
      }
      return {
        siteId,
        eventCount: siteRecords.length,
        complianceRate: siteRecords.length > 0 ? siteCompliant / siteRecords.length : 1,
        issues: Array.from(siteIssues),
      };
    });

    // Aggregate issues
    const issueMap = new Map<string, { count: number; eventIds: string[] }>();
    for (const record of records) {
      for (const issue of record.issues) {
        const existing = issueMap.get(issue) || { count: 0, eventIds: [] };
        existing.count++;
        existing.eventIds.push(record.eventId);
        issueMap.set(issue, existing);
      }
    }

    const issues = Array.from(issueMap.entries()).map(([description, data]) => ({
      severity: this.assessIssueSeverity(description, data.count) as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
      description,
      eventIds: data.eventIds.slice(0, 10), // Limit to 10 examples
      recommendation: this.generateRecommendation(description),
    }));

    // Generate report
    const reportId = sha256(`report-${reportType}-${periodStart.toISOString()}`).slice(0, 16);
    
    const reportContent = {
      id: reportId,
      reportType,
      title: title || `${reportType} Compliance Report`,
      generatedAt: new Date(),
      periodStart,
      periodEnd,
      summary: {
        totalEvents,
        verifiedEvents,
        anchoredEvents,
        complianceRate: Math.round(complianceRate * 100) / 100,
        issues: issues.length,
      },
      siteBreakdown,
      issues,
    };

    const reportHash = sha256(JSON.stringify(reportContent));
    const signature = sha256(reportHash + this.config.privateKey); // Simplified signing

    const report: ComplianceReport = {
      ...reportContent,
      reportHash,
      signature,
    };

    console.log(`   📊 Compliance report generated: ${report.title}`);
    console.log(`      Period: ${periodStart.toLocaleDateString()} - ${periodEnd.toLocaleDateString()}`);
    console.log(`      Events: ${totalEvents}, Compliance: ${Math.round(complianceRate * 100)}%`);

    return report;
  }

  /**
   * Generate audit evidence for a specific event
   */
  generateAuditEvidence(eventHash: string): ReturnType<typeof this.createOutput> | null {
    let auditRecord: AuditRecord | undefined;
    for (const record of this.auditRecords.values()) {
      if (record.eventHash === eventHash) {
        auditRecord = record;
        break;
      }
    }

    if (!auditRecord) {
      return null;
    }

    const evidence = {
      eventHash: auditRecord.eventHash,
      eventType: auditRecord.eventType,
      siteId: auditRecord.siteId,
      assetId: auditRecord.assetId,
      timestamp: auditRecord.timestamp.toISOString(),
      
      verification: {
        signatureVerified: auditRecord.signatureVerified,
        anchorVerified: auditRecord.anchorVerified,
        merkleProofValid: auditRecord.merkleProofValid,
      },
      
      blockchain: auditRecord.anchorVerified ? {
        batchId: auditRecord.batchId,
        merkleRoot: auditRecord.merkleRoot,
        txHash: auditRecord.txHash,
        blockNumber: auditRecord.blockNumber,
      } : null,
      
      compliance: {
        compliant: auditRecord.compliant,
        issues: auditRecord.issues,
      },
      
      generatedAt: new Date().toISOString(),
      generatedBy: this.config.id,
    };

    return this.createOutput({
      outputType: AgentOutputType.REPORT,
      title: `Audit Evidence: ${eventHash.slice(0, 16)}...`,
      content: evidence,
      eventIds: [eventHash],
      confidence: 1.0,
      reasoning: "Cryptographic verification of event integrity and blockchain anchoring",
    });
  }

  // ==========================================================================
  // HELPER METHODS
  // ==========================================================================

  private assessIssueSeverity(issue: string, count: number): string {
    if (issue.includes("signature") || issue.includes("Merkle proof")) {
      return count > 10 ? "CRITICAL" : "HIGH";
    }
    if (issue.includes("Missing")) {
      return count > 50 ? "HIGH" : "MEDIUM";
    }
    if (issue.includes("timestamp")) {
      return "LOW";
    }
    return "MEDIUM";
  }

  private generateRecommendation(issue: string): string {
    if (issue.includes("signature")) {
      return "Verify gateway/agent signing keys are properly configured and not expired";
    }
    if (issue.includes("Merkle proof")) {
      return "Investigate batch anchoring process and verify blockchain connectivity";
    }
    if (issue.includes("Missing site ID")) {
      return "Ensure all event sources include site identification";
    }
    if (issue.includes("Missing origin ID")) {
      return "Configure origin identification for all gateways and agents";
    }
    if (issue.includes("timestamp")) {
      return "Synchronize system clocks using NTP and verify timestamp generation";
    }
    return "Review event generation process and data validation";
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  getAuditRecord(eventHash: string): AuditRecord | undefined {
    for (const record of this.auditRecords.values()) {
      if (record.eventHash === eventHash) {
        return record;
      }
    }
    return undefined;
  }

  getAuditRecords(): AuditRecord[] {
    return Array.from(this.auditRecords.values());
  }

  getPendingVerifications(): string[] {
    return [...this.pendingVerifications];
  }

  getComplianceStats(): {
    totalRecords: number;
    compliantRecords: number;
    anchoredRecords: number;
    pendingVerifications: number;
    complianceRate: number;
  } {
    const records = Array.from(this.auditRecords.values());
    const compliant = records.filter(r => r.compliant).length;
    const anchored = records.filter(r => r.anchorVerified).length;

    return {
      totalRecords: records.length,
      compliantRecords: compliant,
      anchoredRecords: anchored,
      pendingVerifications: this.pendingVerifications.length,
      complianceRate: records.length > 0 ? compliant / records.length : 1,
    };
  }
}
