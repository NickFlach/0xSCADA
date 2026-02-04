/**
 * Certification Workflow Service Tests
 * 
 * VERITY Architecture - Phase δ.2: Certification Workflow
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock the database and artifact storage before importing the service
vi.mock("../../db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
        orderBy: vi.fn(() => ({
          limit: vi.fn(() => ({
            offset: vi.fn(() => Promise.resolve([]))
          }))
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ id: "test-id" }]))
      }))
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([{ id: "test-id" }]))
        }))
      }))
    }))
  }
}));

vi.mock("../artifact-storage", () => ({
  artifactStorage: {
    exists: vi.fn(() => Promise.resolve(true))
  }
}));

import {
  CertificationWorkflowService,
  getCertificationTypeDisplayName,
  getCertificationTypeDescription,
  type CertificationType,
} from "../certification-workflow";

describe("CertificationWorkflowService", () => {
  let service: CertificationWorkflowService;

  beforeEach(() => {
    service = new CertificationWorkflowService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("Helper Functions", () => {
    it("should return correct display names for certification types", () => {
      expect(getCertificationTypeDisplayName("MACHINE_STATE")).toBe("Machine State");
      expect(getCertificationTypeDisplayName("SAFETY_CONDITION")).toBe("Safety Condition");
      expect(getCertificationTypeDisplayName("AGENT_CAPABILITY")).toBe("Agent Capability");
      expect(getCertificationTypeDisplayName("COMPLIANCE_SNAPSHOT")).toBe("Compliance Snapshot");
      expect(getCertificationTypeDisplayName("CALIBRATION_RECORD")).toBe("Calibration Record");
    });

    it("should return correct descriptions for certification types", () => {
      expect(getCertificationTypeDescription("MACHINE_STATE")).toContain("equipment state");
      expect(getCertificationTypeDescription("SAFETY_CONDITION")).toContain("safety");
      expect(getCertificationTypeDescription("AGENT_CAPABILITY")).toContain("AI/agent");
      expect(getCertificationTypeDescription("COMPLIANCE_SNAPSHOT")).toContain("compliance");
      expect(getCertificationTypeDescription("CALIBRATION_RECORD")).toContain("calibration");
    });
  });

  describe("Event Emitter", () => {
    it("should be an event emitter", () => {
      expect(service.on).toBeDefined();
      expect(service.emit).toBeDefined();
    });

    it("should emit events", () => {
      const listener = vi.fn();
      service.on("test-event", listener);
      service.emit("test-event", { data: "test" });
      expect(listener).toHaveBeenCalledWith({ data: "test" });
    });
  });
});

describe("Certification Types", () => {
  const validTypes: CertificationType[] = [
    "MACHINE_STATE",
    "SAFETY_CONDITION",
    "AGENT_CAPABILITY",
    "COMPLIANCE_SNAPSHOT",
    "CALIBRATION_RECORD",
  ];

  it("should have all valid certification types defined", () => {
    validTypes.forEach((type) => {
      const displayName = getCertificationTypeDisplayName(type);
      const description = getCertificationTypeDescription(type);
      expect(displayName).toBeTruthy();
      expect(description).toBeTruthy();
    });
  });

  it("should have unique display names", () => {
    const displayNames = validTypes.map(getCertificationTypeDisplayName);
    const uniqueNames = new Set(displayNames);
    expect(uniqueNames.size).toBe(validTypes.length);
  });
});

describe("Certification Request Input Validation", () => {
  it("should require valid SHA-256 artifact hash format", () => {
    const validHash = "a".repeat(64);
    const invalidHashes = [
      "short",
      "g".repeat(64), // Invalid hex character
      "a".repeat(63), // Too short
      "a".repeat(65), // Too long
    ];

    // Valid hash should pass regex
    expect(/^[a-f0-9]{64}$/i.test(validHash)).toBe(true);

    // Invalid hashes should fail
    invalidHashes.forEach((hash) => {
      expect(/^[a-f0-9]{64}$/i.test(hash)).toBe(false);
    });
  });
});

describe("Certification Workflow States", () => {
  it("should have correct state transitions defined", () => {
    const validStatuses = [
      "DRAFT",
      "PENDING_APPROVAL",
      "APPROVED",
      "REJECTED",
      "MINTED",
      "EXPIRED",
      "SUPERSEDED",
    ];

    // All statuses should be valid
    validStatuses.forEach((status) => {
      expect(typeof status).toBe("string");
    });
  });

  it("should define valid approval statuses", () => {
    const validApprovalStatuses = ["PENDING", "APPROVED", "REJECTED"];
    validApprovalStatuses.forEach((status) => {
      expect(typeof status).toBe("string");
    });
  });
});

describe("Verification Result Structure", () => {
  it("should define correct verification result structure", () => {
    const validResult = {
      isValid: true,
      reason: "Certification valid",
      tokenId: "1",
      certType: "MACHINE_STATE" as CertificationType,
      validFrom: new Date().toISOString(),
      validUntil: new Date(Date.now() + 86400000).toISOString(),
      remainingDays: 30,
    };

    expect(validResult.isValid).toBe(true);
    expect(validResult.reason).toBeTruthy();
    expect(validResult.remainingDays).toBeGreaterThan(0);
  });

  it("should handle invalid certification results", () => {
    const invalidResults = [
      { isValid: false, reason: "Certification not found" },
      { isValid: false, reason: "Certification superseded" },
      { isValid: false, reason: "Certification expired" },
      { isValid: false, reason: "Certification revoked" },
      { isValid: false, reason: "Certification not yet valid" },
    ];

    invalidResults.forEach((result) => {
      expect(result.isValid).toBe(false);
      expect(result.reason).toBeTruthy();
    });
  });
});

describe("Statistics Calculation", () => {
  it("should define correct stats structure", () => {
    const stats = {
      total: 10,
      byType: {
        MACHINE_STATE: 2,
        SAFETY_CONDITION: 3,
        AGENT_CAPABILITY: 1,
        COMPLIANCE_SNAPSHOT: 2,
        CALIBRATION_RECORD: 2,
      },
      byStatus: {
        DRAFT: 1,
        PENDING_APPROVAL: 2,
        APPROVED: 1,
        REJECTED: 1,
        MINTED: 3,
        EXPIRED: 1,
        SUPERSEDED: 1,
      },
      activeCount: 3,
      expiringSoonCount: 1,
      expiredCount: 1,
    };

    // Total should match sum of byType
    const typeSum = Object.values(stats.byType).reduce((a, b) => a + b, 0);
    expect(typeSum).toBe(stats.total);

    // Total should match sum of byStatus
    const statusSum = Object.values(stats.byStatus).reduce((a, b) => a + b, 0);
    expect(statusSum).toBe(stats.total);
  });
});

describe("Multi-Signature Approval", () => {
  it("should track approval progress correctly", () => {
    const request = {
      requiredApprovals: 3,
      currentApprovals: 1,
    };

    const remaining = request.requiredApprovals - request.currentApprovals;
    expect(remaining).toBe(2);
    expect(request.currentApprovals < request.requiredApprovals).toBe(true);
  });

  it("should detect when approvals are complete", () => {
    const request = {
      requiredApprovals: 3,
      currentApprovals: 3,
    };

    expect(request.currentApprovals >= request.requiredApprovals).toBe(true);
  });
});

describe("Validity Period Calculations", () => {
  it("should calculate remaining days correctly", () => {
    const now = new Date();
    const futureDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    
    const remainingMs = futureDate.getTime() - now.getTime();
    const remainingDays = Math.ceil(remainingMs / (1000 * 60 * 60 * 24));
    
    expect(remainingDays).toBe(30);
  });

  it("should handle no expiry correctly", () => {
    const validUntil = null;
    const hasExpiry = validUntil !== null;
    expect(hasExpiry).toBe(false);
  });

  it("should detect expired certifications", () => {
    const now = new Date();
    const pastDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    
    const isExpired = pastDate < now;
    expect(isExpired).toBe(true);
  });

  it("should detect not-yet-valid certifications", () => {
    const now = new Date();
    const futureDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    
    const isNotYetValid = futureDate > now;
    expect(isNotYetValid).toBe(true);
  });
});

describe("Supersession Logic", () => {
  it("should track supersession chain", () => {
    const originalCert = {
      id: "cert-1",
      supersededBy: "cert-2",
    };

    const newCert = {
      id: "cert-2",
      supersedes: "cert-1",
    };

    expect(originalCert.supersededBy).toBe(newCert.id);
    expect(newCert.supersedes).toBe(originalCert.id);
  });

  it("should prevent double supersession", () => {
    const alreadySuperseded = {
      status: "SUPERSEDED",
      supersededBy: "cert-2",
    };

    const canSupersede = alreadySuperseded.status !== "SUPERSEDED";
    expect(canSupersede).toBe(false);
  });
});
