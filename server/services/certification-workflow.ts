/**
 * 0xSCADA Certification Workflow Service
 * 
 * VERITY Architecture - Phase δ.2: Certification Workflow
 * 
 * Implements end-to-end workflow for issuing operational certifications:
 * - Create certification request linked to LFS artifact hash
 * - Multi-signature approval workflow
 * - Mint NFT on approval
 * - Track validity periods
 * - Handle renewals and supersession
 * 
 * "NFT = Certified operational state, not art."
 */

import { EventEmitter } from "events";
import { createHash } from "crypto";
import { db } from "../db";
import {
  certificationRequests,
  certificationApprovals,
  mintedCertifications,
  certificationValidityChecks,
  sites,
  type CertificationRequest,
  type CertificationApproval,
  type MintedCertification,
  type InsertCertificationRequest,
  type InsertCertificationApproval,
  type InsertMintedCertification,
  CERTIFICATION_TYPES,
  CERTIFICATION_REQUEST_STATUSES,
  APPROVAL_STATUSES,
} from "@shared/schema";
import { eq, desc, and, or, isNull, gte, lte } from "drizzle-orm";
import { artifactStorage } from "./artifact-storage";

// =============================================================================
// TYPES
// =============================================================================

export type CertificationType = (typeof CERTIFICATION_TYPES)[number];
export type CertificationRequestStatus = (typeof CERTIFICATION_REQUEST_STATUSES)[number];
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export interface CreateCertificationRequestInput {
  certType: CertificationType;
  title: string;
  description?: string;
  artifactHash: string;
  artifactUri?: string;
  validFrom?: Date;
  validUntil?: Date;
  siteId: string;
  assetId?: string;
  metadata?: Record<string, unknown>;
  requestedBy: string;
  requiredApprovals?: number;
  supersedes?: string;
}

export interface ApprovalDecision {
  certificationRequestId: string;
  approverId: string;
  approverRole?: string;
  status: "APPROVED" | "REJECTED";
  comment?: string;
  signature?: string;
}

export interface MintCertificationInput {
  certificationRequestId: string;
  tokenId: string;
  contractAddress: string;
  txHash: string;
  blockNumber?: number;
  certifier: string;
  owner: string;
  metadataUri?: string;
  chain?: string;
}

export interface RenewCertificationInput {
  originalCertificationId: string;
  newArtifactHash: string;
  newArtifactUri?: string;
  newValidUntil?: Date;
  requestedBy: string;
  metadata?: Record<string, unknown>;
}

export interface VerifyCertificationResult {
  isValid: boolean;
  reason: string;
  tokenId?: string;
  certType?: CertificationType;
  validFrom?: Date;
  validUntil?: Date;
  remainingDays?: number;
}

export interface CertificationStats {
  total: number;
  byType: Record<CertificationType, number>;
  byStatus: Record<CertificationRequestStatus, number>;
  activeCount: number;
  expiringSoonCount: number; // within 30 days
  expiredCount: number;
}

// =============================================================================
// CERTIFICATION WORKFLOW SERVICE
// =============================================================================

export class CertificationWorkflowService extends EventEmitter {
  
  // ===========================================================================
  // CERTIFICATION REQUEST MANAGEMENT
  // ===========================================================================

  /**
   * Create a new certification request
   */
  async createRequest(input: CreateCertificationRequestInput): Promise<CertificationRequest> {
    // Validate certification type
    if (!CERTIFICATION_TYPES.includes(input.certType as any)) {
      throw new Error(`Invalid certification type: ${input.certType}`);
    }

    // Validate site exists
    const [site] = await db.select().from(sites).where(eq(sites.id, input.siteId));
    if (!site) {
      throw new Error(`Site not found: ${input.siteId}`);
    }

    // Optionally verify artifact exists in LFS
    if (input.artifactHash && await artifactStorage.exists(input.artifactHash as any)) {
      console.log(`[CertificationWorkflow] Verified artifact ${input.artifactHash.slice(0, 12)}... exists in LFS`);
    }

    // Check if superseding another certification
    if (input.supersedes) {
      const [original] = await db
        .select()
        .from(certificationRequests)
        .where(eq(certificationRequests.id, input.supersedes));
      
      if (!original) {
        throw new Error(`Original certification to supersede not found: ${input.supersedes}`);
      }

      if (original.status === "SUPERSEDED") {
        throw new Error("Cannot supersede an already superseded certification");
      }
    }

    // Create the request
    const [request] = await db.insert(certificationRequests).values({
      certType: input.certType,
      title: input.title,
      description: input.description,
      artifactHash: input.artifactHash,
      artifactUri: input.artifactUri,
      validFrom: input.validFrom ?? new Date(),
      validUntil: input.validUntil,
      siteId: input.siteId,
      assetId: input.assetId,
      metadata: input.metadata ?? {},
      requestedBy: input.requestedBy,
      requiredApprovals: input.requiredApprovals ?? 1,
      status: "DRAFT",
      supersedes: input.supersedes,
    }).returning();

    this.emit("request:created", request);
    console.log(`[CertificationWorkflow] Created request ${request.id} (${request.certType})`);

    return request;
  }

  /**
   * Submit a request for approval
   */
  async submitForApproval(requestId: string): Promise<CertificationRequest> {
    const [request] = await db
      .select()
      .from(certificationRequests)
      .where(eq(certificationRequests.id, requestId));

    if (!request) {
      throw new Error(`Certification request not found: ${requestId}`);
    }

    if (request.status !== "DRAFT") {
      throw new Error(`Request must be in DRAFT status to submit. Current: ${request.status}`);
    }

    const [updated] = await db
      .update(certificationRequests)
      .set({ 
        status: "PENDING_APPROVAL",
        updatedAt: new Date(),
      })
      .where(eq(certificationRequests.id, requestId))
      .returning();

    this.emit("request:submitted", updated);
    console.log(`[CertificationWorkflow] Request ${requestId} submitted for approval`);

    return updated;
  }

  /**
   * Get a certification request by ID
   */
  async getRequest(requestId: string): Promise<CertificationRequest | null> {
    const [request] = await db
      .select()
      .from(certificationRequests)
      .where(eq(certificationRequests.id, requestId));
    
    return request || null;
  }

  /**
   * List certification requests with filters
   */
  async listRequests(filters?: {
    siteId?: string;
    status?: CertificationRequestStatus;
    certType?: CertificationType;
    requestedBy?: string;
    limit?: number;
    offset?: number;
  }): Promise<CertificationRequest[]> {
    const conditions: any[] = [];

    if (filters?.siteId) {
      conditions.push(eq(certificationRequests.siteId, filters.siteId));
    }
    if (filters?.status) {
      conditions.push(eq(certificationRequests.status, filters.status));
    }
    if (filters?.certType) {
      conditions.push(eq(certificationRequests.certType, filters.certType));
    }
    if (filters?.requestedBy) {
      conditions.push(eq(certificationRequests.requestedBy, filters.requestedBy));
    }

    let query = db.select().from(certificationRequests);
    
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    return await query
      .orderBy(desc(certificationRequests.createdAt))
      .limit(filters?.limit ?? 100)
      .offset(filters?.offset ?? 0);
  }

  // ===========================================================================
  // APPROVAL WORKFLOW
  // ===========================================================================

  /**
   * Record an approval decision
   */
  async recordApproval(decision: ApprovalDecision): Promise<CertificationApproval> {
    const [request] = await db
      .select()
      .from(certificationRequests)
      .where(eq(certificationRequests.id, decision.certificationRequestId));

    if (!request) {
      throw new Error(`Certification request not found: ${decision.certificationRequestId}`);
    }

    if (request.status !== "PENDING_APPROVAL") {
      throw new Error(`Request must be in PENDING_APPROVAL status. Current: ${request.status}`);
    }

    // Check for existing approval from this approver
    const [existing] = await db
      .select()
      .from(certificationApprovals)
      .where(and(
        eq(certificationApprovals.certificationRequestId, decision.certificationRequestId),
        eq(certificationApprovals.approverId, decision.approverId)
      ));

    if (existing) {
      throw new Error(`Approver ${decision.approverId} has already provided a decision`);
    }

    // Record the approval
    const [approval] = await db.insert(certificationApprovals).values({
      certificationRequestId: decision.certificationRequestId,
      approverId: decision.approverId,
      approverRole: decision.approverRole,
      status: decision.status,
      comment: decision.comment,
      signature: decision.signature,
      decidedAt: new Date(),
    }).returning();

    this.emit("approval:recorded", approval);

    // Update request status based on approvals
    if (decision.status === "REJECTED") {
      await db
        .update(certificationRequests)
        .set({ 
          status: "REJECTED",
          updatedAt: new Date(),
        })
        .where(eq(certificationRequests.id, decision.certificationRequestId));

      this.emit("request:rejected", request);
      console.log(`[CertificationWorkflow] Request ${decision.certificationRequestId} rejected by ${decision.approverId}`);
    } else if (decision.status === "APPROVED") {
      const newApprovalCount = request.currentApprovals + 1;
      
      if (newApprovalCount >= request.requiredApprovals) {
        await db
          .update(certificationRequests)
          .set({ 
            status: "APPROVED",
            currentApprovals: newApprovalCount,
            updatedAt: new Date(),
          })
          .where(eq(certificationRequests.id, decision.certificationRequestId));

        this.emit("request:approved", request);
        console.log(`[CertificationWorkflow] Request ${decision.certificationRequestId} fully approved (${newApprovalCount}/${request.requiredApprovals})`);
      } else {
        await db
          .update(certificationRequests)
          .set({ 
            currentApprovals: newApprovalCount,
            updatedAt: new Date(),
          })
          .where(eq(certificationRequests.id, decision.certificationRequestId));

        console.log(`[CertificationWorkflow] Request ${decision.certificationRequestId} approved by ${decision.approverId} (${newApprovalCount}/${request.requiredApprovals})`);
      }
    }

    return approval;
  }

  /**
   * Get all approvals for a request
   */
  async getApprovalsForRequest(requestId: string): Promise<CertificationApproval[]> {
    return await db
      .select()
      .from(certificationApprovals)
      .where(eq(certificationApprovals.certificationRequestId, requestId))
      .orderBy(desc(certificationApprovals.createdAt));
  }

  /**
   * Get pending approvals for an approver
   */
  async getPendingApprovalsForApprover(approverId: string): Promise<CertificationRequest[]> {
    // Get all pending requests
    const pendingRequests = await db
      .select()
      .from(certificationRequests)
      .where(eq(certificationRequests.status, "PENDING_APPROVAL"));

    // Filter out requests already approved by this approver
    const results: CertificationRequest[] = [];
    
    for (const request of pendingRequests) {
      const [existing] = await db
        .select()
        .from(certificationApprovals)
        .where(and(
          eq(certificationApprovals.certificationRequestId, request.id),
          eq(certificationApprovals.approverId, approverId)
        ));

      if (!existing) {
        results.push(request);
      }
    }

    return results;
  }

  // ===========================================================================
  // NFT MINTING
  // ===========================================================================

  /**
   * Record a minted certification NFT
   */
  async recordMinting(input: MintCertificationInput): Promise<MintedCertification> {
    const [request] = await db
      .select()
      .from(certificationRequests)
      .where(eq(certificationRequests.id, input.certificationRequestId));

    if (!request) {
      throw new Error(`Certification request not found: ${input.certificationRequestId}`);
    }

    if (request.status !== "APPROVED") {
      throw new Error(`Request must be APPROVED before minting. Current: ${request.status}`);
    }

    // Create the minted certification record
    const [minted] = await db.insert(mintedCertifications).values({
      certificationRequestId: input.certificationRequestId,
      tokenId: input.tokenId,
      contractAddress: input.contractAddress,
      txHash: input.txHash,
      blockNumber: input.blockNumber,
      certType: request.certType,
      artifactHash: request.artifactHash,
      validFrom: request.validFrom ?? new Date(),
      validUntil: request.validUntil,
      certifier: input.certifier,
      owner: input.owner,
      siteId: request.siteId,
      metadataUri: input.metadataUri,
      chain: input.chain ?? "ethereum",
    }).returning();

    // Update the request status
    await db
      .update(certificationRequests)
      .set({
        status: "MINTED",
        tokenId: input.tokenId,
        txHash: input.txHash,
        mintedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(certificationRequests.id, input.certificationRequestId));

    // If superseding another certification, mark it as superseded
    if (request.supersedes) {
      await db
        .update(certificationRequests)
        .set({
          status: "SUPERSEDED",
          supersededBy: request.id,
          updatedAt: new Date(),
        })
        .where(eq(certificationRequests.id, request.supersedes));

      // Also update the minted certification if it exists
      const [originalMinted] = await db
        .select()
        .from(mintedCertifications)
        .where(eq(mintedCertifications.certificationRequestId, request.supersedes));

      if (originalMinted) {
        await db
          .update(mintedCertifications)
          .set({
            isActive: false,
            supersededBy: input.tokenId,
          })
          .where(eq(mintedCertifications.id, originalMinted.id));
      }
    }

    this.emit("certification:minted", minted);
    console.log(`[CertificationWorkflow] Certification minted: Token ${input.tokenId}, Tx ${input.txHash}`);

    return minted;
  }

  /**
   * Get minted certification by token ID
   */
  async getMintedCertification(tokenId: string): Promise<MintedCertification | null> {
    const [cert] = await db
      .select()
      .from(mintedCertifications)
      .where(eq(mintedCertifications.tokenId, tokenId));
    
    return cert || null;
  }

  /**
   * Get minted certification by artifact hash
   */
  async getMintedCertificationByArtifact(artifactHash: string): Promise<MintedCertification | null> {
    const [cert] = await db
      .select()
      .from(mintedCertifications)
      .where(eq(mintedCertifications.artifactHash, artifactHash));
    
    return cert || null;
  }

  /**
   * List minted certifications
   */
  async listMintedCertifications(filters?: {
    siteId?: string;
    certType?: CertificationType;
    isActive?: boolean;
    owner?: string;
    limit?: number;
    offset?: number;
  }): Promise<MintedCertification[]> {
    const conditions: any[] = [];

    if (filters?.siteId) {
      conditions.push(eq(mintedCertifications.siteId, filters.siteId));
    }
    if (filters?.certType) {
      conditions.push(eq(mintedCertifications.certType, filters.certType));
    }
    if (filters?.isActive !== undefined) {
      conditions.push(eq(mintedCertifications.isActive, filters.isActive));
    }
    if (filters?.owner) {
      conditions.push(eq(mintedCertifications.owner, filters.owner));
    }

    let query = db.select().from(mintedCertifications);
    
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    return await query
      .orderBy(desc(mintedCertifications.mintedAt))
      .limit(filters?.limit ?? 100)
      .offset(filters?.offset ?? 0);
  }

  // ===========================================================================
  // VERIFICATION & VALIDITY
  // ===========================================================================

  /**
   * Verify a certification's validity
   */
  async verifyCertification(tokenId: string): Promise<VerifyCertificationResult> {
    const cert = await this.getMintedCertification(tokenId);
    
    if (!cert) {
      return { isValid: false, reason: "Certification not found" };
    }

    // Check if superseded
    if (cert.supersededBy) {
      return { 
        isValid: false, 
        reason: "Certification superseded",
        tokenId: cert.tokenId,
        certType: cert.certType as CertificationType,
      };
    }

    // Check if revoked
    if (cert.revokedAt) {
      return {
        isValid: false,
        reason: "Certification revoked",
        tokenId: cert.tokenId,
        certType: cert.certType as CertificationType,
      };
    }

    // Check if not yet valid
    const now = new Date();
    if (cert.validFrom > now) {
      return {
        isValid: false,
        reason: "Certification not yet valid",
        tokenId: cert.tokenId,
        certType: cert.certType as CertificationType,
        validFrom: cert.validFrom,
      };
    }

    // Check expiration
    if (cert.validUntil && cert.validUntil < now) {
      return {
        isValid: false,
        reason: "Certification expired",
        tokenId: cert.tokenId,
        certType: cert.certType as CertificationType,
        validUntil: cert.validUntil,
      };
    }

    // Calculate remaining days
    let remainingDays: number | undefined;
    if (cert.validUntil) {
      remainingDays = Math.ceil((cert.validUntil.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    }

    // Record the verification check
    await db.insert(certificationValidityChecks).values({
      mintedCertificationId: cert.id,
      isValid: true,
      reason: "Certification valid",
      checkedBy: "SYSTEM",
    });

    return {
      isValid: true,
      reason: "Certification valid",
      tokenId: cert.tokenId,
      certType: cert.certType as CertificationType,
      validFrom: cert.validFrom,
      validUntil: cert.validUntil ?? undefined,
      remainingDays,
    };
  }

  /**
   * Verify a certification by artifact hash
   */
  async verifyCertificationByArtifact(artifactHash: string): Promise<VerifyCertificationResult> {
    const cert = await this.getMintedCertificationByArtifact(artifactHash);
    
    if (!cert) {
      return { isValid: false, reason: "Artifact not certified" };
    }

    return this.verifyCertification(cert.tokenId);
  }

  /**
   * Get certifications expiring within a time window
   */
  async getExpiringCertifications(days: number = 30): Promise<MintedCertification[]> {
    const now = new Date();
    const futureDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    return await db
      .select()
      .from(mintedCertifications)
      .where(and(
        eq(mintedCertifications.isActive, true),
        gte(mintedCertifications.validUntil, now),
        lte(mintedCertifications.validUntil, futureDate)
      ))
      .orderBy(mintedCertifications.validUntil);
  }

  // ===========================================================================
  // RENEWAL & SUPERSESSION
  // ===========================================================================

  /**
   * Create a renewal request for an existing certification
   */
  async createRenewalRequest(input: RenewCertificationInput): Promise<CertificationRequest> {
    const [original] = await db
      .select()
      .from(mintedCertifications)
      .where(eq(mintedCertifications.id, input.originalCertificationId));

    if (!original) {
      throw new Error(`Original certification not found: ${input.originalCertificationId}`);
    }

    if (!original.isActive) {
      throw new Error("Cannot renew an inactive certification");
    }

    // Get the original request for metadata
    const [originalRequest] = await db
      .select()
      .from(certificationRequests)
      .where(eq(certificationRequests.id, original.certificationRequestId));

    // Create a new request that supersedes the original
    return this.createRequest({
      certType: original.certType as CertificationType,
      title: `Renewal: ${originalRequest?.title ?? original.certType}`,
      description: `Renewal of certification ${original.tokenId}`,
      artifactHash: input.newArtifactHash,
      artifactUri: input.newArtifactUri,
      validFrom: new Date(),
      validUntil: input.newValidUntil,
      siteId: original.siteId,
      metadata: {
        ...input.metadata,
        renewedFrom: original.tokenId,
        originalArtifactHash: original.artifactHash,
      },
      requestedBy: input.requestedBy,
      requiredApprovals: originalRequest?.requiredApprovals ?? 1,
      supersedes: originalRequest?.id,
    });
  }

  /**
   * Record a revocation (without supersession)
   */
  async recordRevocation(tokenId: string, txHash: string): Promise<MintedCertification> {
    const [cert] = await db
      .select()
      .from(mintedCertifications)
      .where(eq(mintedCertifications.tokenId, tokenId));

    if (!cert) {
      throw new Error(`Certification not found: ${tokenId}`);
    }

    if (!cert.isActive) {
      throw new Error("Certification is already inactive");
    }

    const [updated] = await db
      .update(mintedCertifications)
      .set({
        isActive: false,
        revokedAt: new Date(),
        revocationTxHash: txHash,
      })
      .where(eq(mintedCertifications.id, cert.id))
      .returning();

    // Also update the request
    await db
      .update(certificationRequests)
      .set({
        status: "SUPERSEDED",
        updatedAt: new Date(),
      })
      .where(eq(certificationRequests.id, cert.certificationRequestId));

    this.emit("certification:revoked", updated);
    console.log(`[CertificationWorkflow] Certification ${tokenId} revoked`);

    return updated;
  }

  // ===========================================================================
  // STATISTICS
  // ===========================================================================

  /**
   * Get certification statistics
   */
  async getStats(siteId?: string): Promise<CertificationStats> {
    const conditions: any[] = [];
    if (siteId) {
      conditions.push(eq(certificationRequests.siteId, siteId));
    }

    let query = db.select().from(certificationRequests);
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    const requests = await query;

    const stats: CertificationStats = {
      total: requests.length,
      byType: {} as Record<CertificationType, number>,
      byStatus: {} as Record<CertificationRequestStatus, number>,
      activeCount: 0,
      expiringSoonCount: 0,
      expiredCount: 0,
    };

    // Initialize counters
    for (const type of CERTIFICATION_TYPES) {
      stats.byType[type] = 0;
    }
    for (const status of CERTIFICATION_REQUEST_STATUSES) {
      stats.byStatus[status] = 0;
    }

    // Count requests
    for (const request of requests) {
      stats.byType[request.certType as CertificationType]++;
      stats.byStatus[request.status as CertificationRequestStatus]++;
    }

    // Get active/expiring/expired counts from minted certifications
    const mintedConditions: any[] = [];
    if (siteId) {
      mintedConditions.push(eq(mintedCertifications.siteId, siteId));
    }

    let mintedQuery = db.select().from(mintedCertifications);
    if (mintedConditions.length > 0) {
      mintedQuery = mintedQuery.where(and(...mintedConditions)) as any;
    }

    const minted = await mintedQuery;
    const now = new Date();
    const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    for (const cert of minted) {
      if (cert.isActive) {
        stats.activeCount++;
        
        if (cert.validUntil) {
          if (cert.validUntil < now) {
            stats.expiredCount++;
          } else if (cert.validUntil <= thirtyDaysFromNow) {
            stats.expiringSoonCount++;
          }
        }
      }
    }

    return stats;
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

export const certificationWorkflow = new CertificationWorkflowService();

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get certification type display name
 */
export function getCertificationTypeDisplayName(type: CertificationType): string {
  const names: Record<CertificationType, string> = {
    MACHINE_STATE: "Machine State",
    SAFETY_CONDITION: "Safety Condition",
    AGENT_CAPABILITY: "Agent Capability",
    COMPLIANCE_SNAPSHOT: "Compliance Snapshot",
    CALIBRATION_RECORD: "Calibration Record",
  };
  return names[type] || type;
}

/**
 * Get certification type description
 */
export function getCertificationTypeDescription(type: CertificationType): string {
  const descriptions: Record<CertificationType, string> = {
    MACHINE_STATE: "Certified snapshot of physical equipment state (twin checkpoint, PLC states, sensor readings)",
    SAFETY_CONDITION: "Validated safety system state per functional safety standards (IEC 61511, IEC 62061)",
    AGENT_CAPABILITY: "Certified AI/agent operational capability and boundaries",
    COMPLIANCE_SNAPSHOT: "Regulatory compliance evidence bundle (ISO, IEC, NIST audits)",
    CALIBRATION_RECORD: "Instrument calibration verification with traceability",
  };
  return descriptions[type] || "";
}
