/**
 * Certification API Routes
 * 
 * VERITY Architecture - Phase δ.2: Certification Workflow
 * 
 * Provides REST API endpoints for:
 * - Creating and managing certification requests
 * - Multi-signature approval workflow
 * - Recording minted NFTs
 * - Verification and validity checking
 * - Renewal and supersession
 */

import { Router } from "express";
import { 
  certificationWorkflow,
  getCertificationTypeDisplayName,
  getCertificationTypeDescription,
  type CertificationType,
  type CertificationRequestStatus,
} from "../services/certification-workflow";
import { CERTIFICATION_TYPES, CERTIFICATION_REQUEST_STATUSES } from "@shared/schema";

export const certificationRoutes = Router();

// =============================================================================
// CERTIFICATION TYPES METADATA
// =============================================================================

/**
 * GET /api/certifications/types
 * Get all certification types with their descriptions
 */
certificationRoutes.get("/types", (req, res) => {
  try {
    const types = CERTIFICATION_TYPES.map(type => ({
      type,
      displayName: getCertificationTypeDisplayName(type),
      description: getCertificationTypeDescription(type),
    }));

    res.json({
      types,
      statuses: CERTIFICATION_REQUEST_STATUSES,
    });
  } catch (error) {
    console.error("Error fetching certification types:", error);
    res.status(500).json({ error: "Failed to fetch certification types" });
  }
});

// =============================================================================
// CERTIFICATION REQUEST ENDPOINTS
// =============================================================================

/**
 * POST /api/certifications/requests
 * Create a new certification request
 */
certificationRoutes.post("/requests", async (req, res) => {
  try {
    const {
      certType,
      title,
      description,
      artifactHash,
      artifactUri,
      validFrom,
      validUntil,
      siteId,
      assetId,
      metadata,
      requestedBy,
      requiredApprovals,
      supersedes,
    } = req.body;

    if (!certType || !title || !artifactHash || !siteId || !requestedBy) {
      return res.status(400).json({
        error: "Missing required fields: certType, title, artifactHash, siteId, requestedBy",
      });
    }

    if (!CERTIFICATION_TYPES.includes(certType)) {
      return res.status(400).json({
        error: `Invalid certType. Must be one of: ${CERTIFICATION_TYPES.join(", ")}`,
      });
    }

    const request = await certificationWorkflow.createRequest({
      certType,
      title,
      description,
      artifactHash,
      artifactUri,
      validFrom: validFrom ? new Date(validFrom) : undefined,
      validUntil: validUntil ? new Date(validUntil) : undefined,
      siteId,
      assetId,
      metadata,
      requestedBy,
      requiredApprovals,
      supersedes,
    });

    res.status(201).json(request);
  } catch (error: any) {
    console.error("Error creating certification request:", error);
    res.status(400).json({ error: error.message || "Failed to create certification request" });
  }
});

/**
 * GET /api/certifications/requests
 * List certification requests with optional filters
 */
certificationRoutes.get("/requests", async (req, res) => {
  try {
    const { siteId, status, certType, requestedBy, limit, offset } = req.query;

    const requests = await certificationWorkflow.listRequests({
      siteId: siteId as string | undefined,
      status: status as CertificationRequestStatus | undefined,
      certType: certType as CertificationType | undefined,
      requestedBy: requestedBy as string | undefined,
      limit: limit ? parseInt(limit as string) : undefined,
      offset: offset ? parseInt(offset as string) : undefined,
    });

    res.json({
      requests,
      pagination: {
        limit: limit ? parseInt(limit as string) : 100,
        offset: offset ? parseInt(offset as string) : 0,
        count: requests.length,
      },
    });
  } catch (error) {
    console.error("Error listing certification requests:", error);
    res.status(500).json({ error: "Failed to list certification requests" });
  }
});

/**
 * GET /api/certifications/requests/:id
 * Get a single certification request with approvals
 */
certificationRoutes.get("/requests/:id", async (req, res) => {
  try {
    const request = await certificationWorkflow.getRequest(req.params.id);

    if (!request) {
      return res.status(404).json({ error: "Certification request not found" });
    }

    const approvals = await certificationWorkflow.getApprovalsForRequest(req.params.id);

    res.json({
      request,
      approvals,
      approvalProgress: {
        required: request.requiredApprovals,
        current: request.currentApprovals,
        remaining: request.requiredApprovals - request.currentApprovals,
      },
    });
  } catch (error) {
    console.error("Error fetching certification request:", error);
    res.status(500).json({ error: "Failed to fetch certification request" });
  }
});

/**
 * POST /api/certifications/requests/:id/submit
 * Submit a request for approval
 */
certificationRoutes.post("/requests/:id/submit", async (req, res) => {
  try {
    const request = await certificationWorkflow.submitForApproval(req.params.id);
    res.json(request);
  } catch (error: any) {
    console.error("Error submitting certification request:", error);
    res.status(400).json({ error: error.message || "Failed to submit certification request" });
  }
});

// =============================================================================
// APPROVAL WORKFLOW ENDPOINTS
// =============================================================================

/**
 * POST /api/certifications/requests/:id/approve
 * Record an approval decision
 */
certificationRoutes.post("/requests/:id/approve", async (req, res) => {
  try {
    const { approverId, approverRole, status, comment, signature } = req.body;

    if (!approverId || !status) {
      return res.status(400).json({
        error: "Missing required fields: approverId, status",
      });
    }

    if (!["APPROVED", "REJECTED"].includes(status)) {
      return res.status(400).json({
        error: "Status must be APPROVED or REJECTED",
      });
    }

    const approval = await certificationWorkflow.recordApproval({
      certificationRequestId: req.params.id,
      approverId,
      approverRole,
      status,
      comment,
      signature,
    });

    // Get updated request
    const request = await certificationWorkflow.getRequest(req.params.id);

    res.json({
      approval,
      request,
    });
  } catch (error: any) {
    console.error("Error recording approval:", error);
    res.status(400).json({ error: error.message || "Failed to record approval" });
  }
});

/**
 * GET /api/certifications/approvals/pending
 * Get pending approvals for an approver
 */
certificationRoutes.get("/approvals/pending", async (req, res) => {
  try {
    const { approverId } = req.query;

    if (!approverId) {
      return res.status(400).json({ error: "Missing required query parameter: approverId" });
    }

    const requests = await certificationWorkflow.getPendingApprovalsForApprover(approverId as string);

    res.json({
      requests,
      count: requests.length,
    });
  } catch (error) {
    console.error("Error fetching pending approvals:", error);
    res.status(500).json({ error: "Failed to fetch pending approvals" });
  }
});

// =============================================================================
// MINTING ENDPOINTS
// =============================================================================

/**
 * POST /api/certifications/requests/:id/mint
 * Record a minted certification NFT
 */
certificationRoutes.post("/requests/:id/mint", async (req, res) => {
  try {
    const {
      tokenId,
      contractAddress,
      txHash,
      blockNumber,
      certifier,
      owner,
      metadataUri,
      chain,
    } = req.body;

    if (!tokenId || !contractAddress || !txHash || !certifier || !owner) {
      return res.status(400).json({
        error: "Missing required fields: tokenId, contractAddress, txHash, certifier, owner",
      });
    }

    const minted = await certificationWorkflow.recordMinting({
      certificationRequestId: req.params.id,
      tokenId,
      contractAddress,
      txHash,
      blockNumber,
      certifier,
      owner,
      metadataUri,
      chain,
    });

    res.status(201).json(minted);
  } catch (error: any) {
    console.error("Error recording minted certification:", error);
    res.status(400).json({ error: error.message || "Failed to record minted certification" });
  }
});

/**
 * GET /api/certifications/minted
 * List minted certifications
 */
certificationRoutes.get("/minted", async (req, res) => {
  try {
    const { siteId, certType, isActive, owner, limit, offset } = req.query;

    const certifications = await certificationWorkflow.listMintedCertifications({
      siteId: siteId as string | undefined,
      certType: certType as CertificationType | undefined,
      isActive: isActive !== undefined ? isActive === "true" : undefined,
      owner: owner as string | undefined,
      limit: limit ? parseInt(limit as string) : undefined,
      offset: offset ? parseInt(offset as string) : undefined,
    });

    res.json({
      certifications,
      pagination: {
        limit: limit ? parseInt(limit as string) : 100,
        offset: offset ? parseInt(offset as string) : 0,
        count: certifications.length,
      },
    });
  } catch (error) {
    console.error("Error listing minted certifications:", error);
    res.status(500).json({ error: "Failed to list minted certifications" });
  }
});

/**
 * GET /api/certifications/minted/:tokenId
 * Get a minted certification by token ID
 */
certificationRoutes.get("/minted/:tokenId", async (req, res) => {
  try {
    const certification = await certificationWorkflow.getMintedCertification(req.params.tokenId);

    if (!certification) {
      return res.status(404).json({ error: "Minted certification not found" });
    }

    res.json(certification);
  } catch (error) {
    console.error("Error fetching minted certification:", error);
    res.status(500).json({ error: "Failed to fetch minted certification" });
  }
});

// =============================================================================
// VERIFICATION ENDPOINTS
// =============================================================================

/**
 * GET /api/certifications/verify/:tokenId
 * Verify a certification's validity
 */
certificationRoutes.get("/verify/:tokenId", async (req, res) => {
  try {
    const result = await certificationWorkflow.verifyCertification(req.params.tokenId);
    res.json(result);
  } catch (error) {
    console.error("Error verifying certification:", error);
    res.status(500).json({ error: "Failed to verify certification" });
  }
});

/**
 * GET /api/certifications/verify/artifact/:artifactHash
 * Verify a certification by artifact hash
 */
certificationRoutes.get("/verify/artifact/:artifactHash", async (req, res) => {
  try {
    const result = await certificationWorkflow.verifyCertificationByArtifact(req.params.artifactHash);
    res.json(result);
  } catch (error) {
    console.error("Error verifying certification by artifact:", error);
    res.status(500).json({ error: "Failed to verify certification by artifact" });
  }
});

/**
 * GET /api/certifications/expiring
 * Get certifications expiring soon
 */
certificationRoutes.get("/expiring", async (req, res) => {
  try {
    const days = req.query.days ? parseInt(req.query.days as string) : 30;
    const certifications = await certificationWorkflow.getExpiringCertifications(days);

    res.json({
      certifications,
      count: certifications.length,
      withinDays: days,
    });
  } catch (error) {
    console.error("Error fetching expiring certifications:", error);
    res.status(500).json({ error: "Failed to fetch expiring certifications" });
  }
});

// =============================================================================
// RENEWAL & REVOCATION ENDPOINTS
// =============================================================================

/**
 * POST /api/certifications/minted/:id/renew
 * Create a renewal request for an existing certification
 */
certificationRoutes.post("/minted/:id/renew", async (req, res) => {
  try {
    const { newArtifactHash, newArtifactUri, newValidUntil, requestedBy, metadata } = req.body;

    if (!newArtifactHash || !requestedBy) {
      return res.status(400).json({
        error: "Missing required fields: newArtifactHash, requestedBy",
      });
    }

    const request = await certificationWorkflow.createRenewalRequest({
      originalCertificationId: req.params.id,
      newArtifactHash,
      newArtifactUri,
      newValidUntil: newValidUntil ? new Date(newValidUntil) : undefined,
      requestedBy,
      metadata,
    });

    res.status(201).json(request);
  } catch (error: any) {
    console.error("Error creating renewal request:", error);
    res.status(400).json({ error: error.message || "Failed to create renewal request" });
  }
});

/**
 * POST /api/certifications/minted/:tokenId/revoke
 * Record a revocation
 */
certificationRoutes.post("/minted/:tokenId/revoke", async (req, res) => {
  try {
    const { txHash } = req.body;

    if (!txHash) {
      return res.status(400).json({ error: "Missing required field: txHash" });
    }

    const certification = await certificationWorkflow.recordRevocation(req.params.tokenId, txHash);
    res.json(certification);
  } catch (error: any) {
    console.error("Error recording revocation:", error);
    res.status(400).json({ error: error.message || "Failed to record revocation" });
  }
});

// =============================================================================
// STATISTICS ENDPOINT
// =============================================================================

/**
 * GET /api/certifications/stats
 * Get certification statistics
 */
certificationRoutes.get("/stats", async (req, res) => {
  try {
    const { siteId } = req.query;
    const stats = await certificationWorkflow.getStats(siteId as string | undefined);
    res.json(stats);
  } catch (error) {
    console.error("Error fetching certification stats:", error);
    res.status(500).json({ error: "Failed to fetch certification stats" });
  }
});
