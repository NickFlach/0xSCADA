/**
 * Tests for ADR-0010: Agent Certification Framework
 * 
 * Covers:
 * - Certification lifecycle (initiate → check → finalize)
 * - Level requirements validation
 * - Certifier sign-off
 * - Revocation and recertification triggers
 * - Level comparison (isAgentCertified)
 * - Progress tracking
 */

import { describe, it, expect, beforeEach } from "vitest";
import { CertificationManager } from "../agents/certification-manager";
import {
  CertificationLevel,
  CERTIFICATION_LEVEL_ORDER,
  CERTIFICATION_LEVEL_META,
  REQUIREMENTS_BY_LEVEL,
  RecertificationTrigger,
} from "@shared/types/agent-certification";

describe("CertificationManager", () => {
  let mgr: CertificationManager;
  const AGENT_ID = "ops-agent-001";
  const AGENT_VERSION = "1.2.0";

  beforeEach(() => {
    mgr = new CertificationManager();
  });

  describe("initiateCertification", () => {
    it("should create a certification with all checks in PENDING state", () => {
      const cert = mgr.initiateCertification(AGENT_ID, AGENT_VERSION, CertificationLevel.AC1_OBSERVER);

      expect(cert.id).toBeDefined();
      expect(cert.agentId).toBe(AGENT_ID);
      expect(cert.level).toBe("AC1_OBSERVER");
      expect(cert.status).toBe("IN_PROGRESS");
      expect(cert.checks.length).toBe(REQUIREMENTS_BY_LEVEL[CertificationLevel.AC1_OBSERVER].length);
      expect(cert.checks.every((c) => c.status === "PENDING")).toBe(true);
    });

    it("should include inherited requirements for higher levels", () => {
      const cert = mgr.initiateCertification(AGENT_ID, AGENT_VERSION, CertificationLevel.AC3_OPERATOR);

      // AC-3 includes AC-1 and AC-2 requirements plus its own
      const ac3Reqs = REQUIREMENTS_BY_LEVEL[CertificationLevel.AC3_OPERATOR];
      expect(cert.checks.length).toBe(ac3Reqs.length);

      // Should include AC-1 check IDs
      const checkIds = cert.checks.map((c) => c.id);
      expect(checkIds).toContain("ac1-identity");
      expect(checkIds).toContain("ac3-envelope");
    });
  });

  describe("updateCheck", () => {
    it("should update a check status with evidence", () => {
      const cert = mgr.initiateCertification(AGENT_ID, AGENT_VERSION, CertificationLevel.AC1_OBSERVER);

      const updated = mgr.updateCheck(cert.id, "ac1-identity", "PASSED", {
        evidenceHash: "abc123",
        verifiedBy: "admin-001",
        notes: "On-chain registration confirmed",
      });

      expect(updated).not.toBeNull();
      const check = updated!.checks.find((c) => c.id === "ac1-identity");
      expect(check?.status).toBe("PASSED");
      expect(check?.evidenceHash).toBe("abc123");
      expect(check?.verifiedBy).toBe("admin-001");
    });

    it("should return null for non-existent certification", () => {
      const result = mgr.updateCheck("fake-id", "ac1-identity", "PASSED");
      expect(result).toBeNull();
    });

    it("should return null for non-existent check", () => {
      const cert = mgr.initiateCertification(AGENT_ID, AGENT_VERSION, CertificationLevel.AC1_OBSERVER);
      const result = mgr.updateCheck(cert.id, "nonexistent-check", "PASSED");
      expect(result).toBeNull();
    });
  });

  describe("finalizeCertification", () => {
    it("should certify when all checks pass", () => {
      const cert = mgr.initiateCertification(AGENT_ID, AGENT_VERSION, CertificationLevel.AC1_OBSERVER);

      // Pass all checks
      for (const check of cert.checks) {
        mgr.updateCheck(cert.id, check.id, "PASSED", { verifiedBy: "tester" });
      }

      // Submit test results
      mgr.submitTestResults(cert.id, { coverage: 97, passed: 150, failed: 0 });

      // Add certifier
      mgr.addCertifierSignOff(cert.id, {
        id: "certifier-001",
        name: "Jane Engineer",
        role: "Safety Lead",
        signature: "sig-abc",
      });

      const result = mgr.finalizeCertification(cert.id);
      expect(result.success).toBe(true);
      expect(result.record?.status).toBe("CERTIFIED");
      expect(result.record?.issuedAt).toBeDefined();
      expect(result.record?.expiresAt).toBeDefined();
    });

    it("should reject when checks are still pending", () => {
      const cert = mgr.initiateCertification(AGENT_ID, AGENT_VERSION, CertificationLevel.AC1_OBSERVER);

      mgr.submitTestResults(cert.id, { coverage: 97 });
      mgr.addCertifierSignOff(cert.id, {
        id: "c1", name: "Test", role: "Lead", signature: "sig",
      });

      const result = mgr.finalizeCertification(cert.id);
      expect(result.success).toBe(false);
      expect(result.failedChecks).toBeDefined();
      expect(result.failedChecks!.length).toBeGreaterThan(0);
    });

    it("should reject when no test suite hash", () => {
      const cert = mgr.initiateCertification(AGENT_ID, AGENT_VERSION, CertificationLevel.AC1_OBSERVER);

      for (const check of cert.checks) {
        mgr.updateCheck(cert.id, check.id, "PASSED");
      }

      mgr.addCertifierSignOff(cert.id, {
        id: "c1", name: "Test", role: "Lead", signature: "sig",
      });

      const result = mgr.finalizeCertification(cert.id);
      expect(result.success).toBe(false);
      expect(result.reason).toContain("Test suite");
    });

    it("should reject when no certifier sign-off", () => {
      const cert = mgr.initiateCertification(AGENT_ID, AGENT_VERSION, CertificationLevel.AC1_OBSERVER);

      for (const check of cert.checks) {
        mgr.updateCheck(cert.id, check.id, "PASSED");
      }
      mgr.submitTestResults(cert.id, { ok: true });

      const result = mgr.finalizeCertification(cert.id);
      expect(result.success).toBe(false);
      expect(result.reason).toContain("certifier");
    });

    it("should require audit report for AC-3", () => {
      const cert = mgr.initiateCertification(AGENT_ID, AGENT_VERSION, CertificationLevel.AC3_OPERATOR);

      for (const check of cert.checks) {
        mgr.updateCheck(cert.id, check.id, "PASSED");
      }
      mgr.submitTestResults(cert.id, { ok: true });
      mgr.addCertifierSignOff(cert.id, {
        id: "c1", name: "Test", role: "Lead", signature: "sig",
      });
      // No audit report submitted

      const result = mgr.finalizeCertification(cert.id);
      expect(result.success).toBe(false);
      expect(result.reason).toContain("Audit report");
    });
  });

  describe("revocation", () => {
    it("should revoke an active certification", () => {
      const cert = mgr.initiateCertification(AGENT_ID, AGENT_VERSION, CertificationLevel.AC1_OBSERVER);
      for (const check of cert.checks) {
        mgr.updateCheck(cert.id, check.id, "PASSED");
      }
      mgr.submitTestResults(cert.id, { ok: true });
      mgr.addCertifierSignOff(cert.id, {
        id: "c1", name: "Test", role: "Lead", signature: "sig",
      });
      mgr.finalizeCertification(cert.id);

      const revoked = mgr.revokeCertification(cert.id, "Security vulnerability discovered");
      expect(revoked).toBe(true);

      const record = mgr.getCertification(cert.id);
      expect(record?.status).toBe("REVOKED");
      expect(record?.revokedReason).toBe("Security vulnerability discovered");
    });
  });

  describe("recertification triggers", () => {
    it("should expire certifications when recertification is triggered", () => {
      // Certify first
      const cert = mgr.initiateCertification(AGENT_ID, AGENT_VERSION, CertificationLevel.AC1_OBSERVER);
      for (const check of cert.checks) {
        mgr.updateCheck(cert.id, check.id, "PASSED");
      }
      mgr.submitTestResults(cert.id, { ok: true });
      mgr.addCertifierSignOff(cert.id, {
        id: "c1", name: "Test", role: "Lead", signature: "sig",
      });
      mgr.finalizeCertification(cert.id);

      // Trigger recertification
      mgr.triggerRecertification(AGENT_ID, RecertificationTrigger.CODE_UPDATE);

      const active = mgr.getActiveCertification(AGENT_ID);
      expect(active).toBeNull(); // Should be expired

      const pending = mgr.getPendingRecertifications(AGENT_ID);
      expect(pending.length).toBe(1);
      expect(pending[0].trigger).toBe("CODE_UPDATE");
    });
  });

  describe("isAgentCertified", () => {
    it("should return true when certified at the required level", () => {
      const cert = mgr.initiateCertification(AGENT_ID, AGENT_VERSION, CertificationLevel.AC2_ADVISOR);
      for (const check of cert.checks) {
        mgr.updateCheck(cert.id, check.id, "PASSED");
      }
      mgr.submitTestResults(cert.id, { ok: true });
      mgr.addCertifierSignOff(cert.id, {
        id: "c1", name: "Test", role: "Lead", signature: "sig",
      });
      mgr.finalizeCertification(cert.id);

      expect(mgr.isAgentCertified(AGENT_ID, CertificationLevel.AC1_OBSERVER)).toBe(true);
      expect(mgr.isAgentCertified(AGENT_ID, CertificationLevel.AC2_ADVISOR)).toBe(true);
      expect(mgr.isAgentCertified(AGENT_ID, CertificationLevel.AC3_OPERATOR)).toBe(false);
    });

    it("should return false when no certification exists", () => {
      expect(mgr.isAgentCertified("unknown-agent", CertificationLevel.AC1_OBSERVER)).toBe(false);
    });
  });

  describe("progress tracking", () => {
    it("should track certification progress", () => {
      const cert = mgr.initiateCertification(AGENT_ID, AGENT_VERSION, CertificationLevel.AC1_OBSERVER);
      const total = cert.checks.length;

      let progress = mgr.getCertificationProgress(cert.id);
      expect(progress?.total).toBe(total);
      expect(progress?.pending).toBe(total);
      expect(progress?.percentComplete).toBe(0);

      // Pass half the checks
      const half = Math.floor(total / 2);
      for (let i = 0; i < half; i++) {
        mgr.updateCheck(cert.id, cert.checks[i].id, "PASSED");
      }

      progress = mgr.getCertificationProgress(cert.id);
      expect(progress?.passed).toBe(half);
      expect(progress?.percentComplete).toBeGreaterThan(0);
    });
  });

  describe("constants", () => {
    it("should have metadata for all certification levels", () => {
      for (const level of CERTIFICATION_LEVEL_ORDER) {
        expect(CERTIFICATION_LEVEL_META[level]).toBeDefined();
        expect(CERTIFICATION_LEVEL_META[level].name).toBeTruthy();
        expect(CERTIFICATION_LEVEL_META[level].analogousSIL).toBeTruthy();
      }
    });

    it("should have requirements for all certification levels", () => {
      for (const level of CERTIFICATION_LEVEL_ORDER) {
        expect(REQUIREMENTS_BY_LEVEL[level]).toBeDefined();
        expect(REQUIREMENTS_BY_LEVEL[level].length).toBeGreaterThan(0);
      }
    });

    it("should have increasing requirements as level increases", () => {
      let prevCount = 0;
      for (const level of CERTIFICATION_LEVEL_ORDER) {
        const count = REQUIREMENTS_BY_LEVEL[level].length;
        expect(count).toBeGreaterThanOrEqual(prevCount);
        prevCount = count;
      }
    });
  });
});
