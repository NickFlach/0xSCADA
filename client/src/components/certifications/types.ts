/**
 * Certification Types for UI Components
 * 
 * VERITY Architecture - Phase δ.2: Certification Workflow
 */

export const CERTIFICATION_TYPES = [
  "MACHINE_STATE",
  "SAFETY_CONDITION",
  "AGENT_CAPABILITY",
  "COMPLIANCE_SNAPSHOT",
  "CALIBRATION_RECORD",
] as const;

export type CertificationType = (typeof CERTIFICATION_TYPES)[number];

export const CERTIFICATION_REQUEST_STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "MINTED",
  "EXPIRED",
  "SUPERSEDED",
] as const;

export type CertificationRequestStatus = (typeof CERTIFICATION_REQUEST_STATUSES)[number];

export interface CertificationTypeInfo {
  type: CertificationType;
  displayName: string;
  description: string;
}

export interface CertificationRequest {
  id: string;
  certType: CertificationType;
  title: string;
  description?: string;
  artifactHash: string;
  artifactUri?: string;
  validFrom?: string;
  validUntil?: string;
  siteId: string;
  assetId?: string;
  metadata?: Record<string, unknown>;
  status: CertificationRequestStatus;
  requiredApprovals: number;
  currentApprovals: number;
  requestedBy: string;
  requestedAt: string;
  supersedes?: string;
  supersededBy?: string;
  tokenId?: string;
  txHash?: string;
  mintedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CertificationApproval {
  id: string;
  certificationRequestId: string;
  approverId: string;
  approverRole?: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  comment?: string;
  decidedAt?: string;
  signature?: string;
  createdAt: string;
}

export interface MintedCertification {
  id: string;
  certificationRequestId: string;
  tokenId: string;
  contractAddress: string;
  chain: string;
  txHash: string;
  blockNumber?: number;
  certType: CertificationType;
  artifactHash: string;
  validFrom: string;
  validUntil?: string;
  certifier: string;
  owner: string;
  isActive: boolean;
  supersededBy?: string;
  revokedAt?: string;
  revocationTxHash?: string;
  siteId: string;
  metadataUri?: string;
  mintedAt: string;
  createdAt: string;
}

export interface VerificationResult {
  isValid: boolean;
  reason: string;
  tokenId?: string;
  certType?: CertificationType;
  validFrom?: string;
  validUntil?: string;
  remainingDays?: number;
}

export interface CertificationStats {
  total: number;
  byType: Record<CertificationType, number>;
  byStatus: Record<CertificationRequestStatus, number>;
  activeCount: number;
  expiringSoonCount: number;
  expiredCount: number;
}

export const CERTIFICATION_TYPE_INFO: Record<CertificationType, { displayName: string; description: string; icon: string; color: string }> = {
  MACHINE_STATE: {
    displayName: "Machine State",
    description: "Certified snapshot of physical equipment state (twin checkpoint, PLC states, sensor readings)",
    icon: "⚙️",
    color: "blue",
  },
  SAFETY_CONDITION: {
    displayName: "Safety Condition",
    description: "Validated safety system state per functional safety standards (IEC 61511, IEC 62061)",
    icon: "🛡️",
    color: "red",
  },
  AGENT_CAPABILITY: {
    displayName: "Agent Capability",
    description: "Certified AI/agent operational capability and boundaries",
    icon: "🤖",
    color: "purple",
  },
  COMPLIANCE_SNAPSHOT: {
    displayName: "Compliance Snapshot",
    description: "Regulatory compliance evidence bundle (ISO, IEC, NIST audits)",
    icon: "📋",
    color: "green",
  },
  CALIBRATION_RECORD: {
    displayName: "Calibration Record",
    description: "Instrument calibration verification with traceability",
    icon: "📏",
    color: "orange",
  },
};

export const STATUS_COLORS: Record<CertificationRequestStatus, string> = {
  DRAFT: "gray",
  PENDING_APPROVAL: "yellow",
  APPROVED: "blue",
  REJECTED: "red",
  MINTED: "green",
  EXPIRED: "orange",
  SUPERSEDED: "purple",
};
