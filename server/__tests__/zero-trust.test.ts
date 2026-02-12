/**
 * Tests for ADR-0008: Zero-Trust Agent Deployment Model
 * 
 * Covers:
 * - Capability token grant / revoke / renew
 * - Capability validation and expiry
 * - Attestation chain creation and verification
 * - Zero-trust guard enforcement
 * - Rate limiting
 * - Network zone policies
 */

import { describe, it, expect, beforeEach } from "vitest";
import { CapabilityManager } from "../agents/capability-manager";
import { ZeroTrustGuard, NetworkZone } from "../agents/zero-trust-guard";
import {
  CapabilityName,
  CapabilityScope,
  isCapabilityValid,
  isCapabilityExpired,
  isWriteCapability,
  isAdminCapability,
  CAPABILITY_TTL_DEFAULTS,
} from "@shared/types/capability-token";

// =============================================================================
// CAPABILITY MANAGER TESTS
// =============================================================================

describe("CapabilityManager", () => {
  let mgr: CapabilityManager;
  const SYSTEM_KEY = "test-system-signing-key-32bytes!!";
  const AGENT_ID = "ops-agent-001";

  beforeEach(() => {
    mgr = new CapabilityManager(SYSTEM_KEY);
  });

  describe("grantCapability", () => {
    it("should grant a read capability with default TTL", () => {
      const token = mgr.grantCapability({
        agentId: AGENT_ID,
        capability: CapabilityName.READ_TELEMETRY,
        scope: CapabilityScope.PER_SITE,
        scopeTarget: "site-001",
      });

      expect(token.id).toBeDefined();
      expect(token.agentId).toBe(AGENT_ID);
      expect(token.capability).toBe("read:telemetry");
      expect(token.scope).toBe("per_site");
      expect(token.scopeTarget).toBe("site-001");
      expect(token.signature).toBeDefined();
      expect(token.revoked).toBe(false);
      expect(token.autoRenew).toBe(true); // read:telemetry defaults to autoRenew
    });

    it("should grant a write capability with shorter TTL", () => {
      const token = mgr.grantCapability({
        agentId: AGENT_ID,
        capability: CapabilityName.WRITE_SETPOINT,
        scope: CapabilityScope.PER_ASSET,
        scopeTarget: "pump-001",
      });

      expect(token.capability).toBe("write:setpoint");
      expect(token.autoRenew).toBe(false);

      // TTL should be 15 minutes for write:setpoint
      const issuedMs = new Date(token.issuedAt).getTime();
      const expiresMs = new Date(token.expiresAt).getTime();
      const ttlMinutes = (expiresMs - issuedMs) / 60000;
      expect(ttlMinutes).toBe(15);
    });

    it("should cap requested TTL to the default maximum", () => {
      const token = mgr.grantCapability({
        agentId: AGENT_ID,
        capability: CapabilityName.WRITE_SETPOINT,
        scope: CapabilityScope.PER_ASSET,
        requestedTtlMinutes: 9999, // Way too high
      });

      const issuedMs = new Date(token.issuedAt).getTime();
      const expiresMs = new Date(token.expiresAt).getTime();
      const ttlMinutes = (expiresMs - issuedMs) / 60000;
      expect(ttlMinutes).toBe(15); // Capped to default
    });
  });

  describe("revokeCapability", () => {
    it("should revoke a token", () => {
      const token = mgr.grantCapability({
        agentId: AGENT_ID,
        capability: CapabilityName.READ_TELEMETRY,
        scope: CapabilityScope.GLOBAL,
      });

      const revoked = mgr.revokeCapability(token.id, "Security incident");
      expect(revoked).toBe(true);

      const retrieved = mgr.getToken(token.id);
      expect(retrieved?.revoked).toBe(true);
      expect(retrieved?.revokedReason).toBe("Security incident");
    });

    it("should revoke all tokens for an agent", () => {
      mgr.grantCapability({ agentId: AGENT_ID, capability: "read:telemetry", scope: "global" });
      mgr.grantCapability({ agentId: AGENT_ID, capability: "read:alarms", scope: "global" });
      mgr.grantCapability({ agentId: AGENT_ID, capability: "read:events", scope: "global" });

      const count = mgr.revokeAllForAgent(AGENT_ID, "Agent compromised");
      expect(count).toBe(3);

      const active = mgr.getAgentCapabilities(AGENT_ID);
      expect(active).toHaveLength(0);
    });
  });

  describe("validateCapability", () => {
    it("should validate an active token", () => {
      mgr.grantCapability({
        agentId: AGENT_ID,
        capability: CapabilityName.READ_TELEMETRY,
        scope: CapabilityScope.GLOBAL,
      });

      const result = mgr.validateCapability(AGENT_ID, "read:telemetry");
      expect(result.valid).toBe(true);
      expect(result.token).toBeDefined();
    });

    it("should reject when no token exists", () => {
      const result = mgr.validateCapability("unknown-agent", "read:telemetry");
      expect(result.valid).toBe(false);
    });

    it("should reject a revoked token", () => {
      const token = mgr.grantCapability({
        agentId: AGENT_ID,
        capability: CapabilityName.READ_TELEMETRY,
        scope: CapabilityScope.GLOBAL,
      });

      mgr.revokeCapability(token.id, "Test revocation");
      const result = mgr.validateCapability(AGENT_ID, "read:telemetry");
      expect(result.valid).toBe(false);
    });

    it("should reject wrong capability", () => {
      mgr.grantCapability({
        agentId: AGENT_ID,
        capability: CapabilityName.READ_TELEMETRY,
        scope: CapabilityScope.GLOBAL,
      });

      const result = mgr.validateCapability(AGENT_ID, "write:setpoint");
      expect(result.valid).toBe(false);
    });

    it("should check scope target for per-site tokens", () => {
      mgr.grantCapability({
        agentId: AGENT_ID,
        capability: CapabilityName.READ_TELEMETRY,
        scope: CapabilityScope.PER_SITE,
        scopeTarget: "site-001",
      });

      const valid = mgr.validateCapability(AGENT_ID, "read:telemetry", "site-001");
      expect(valid.valid).toBe(true);

      const invalid = mgr.validateCapability(AGENT_ID, "read:telemetry", "site-999");
      expect(invalid.valid).toBe(false);
    });
  });

  describe("attestation chain", () => {
    it("should create an attestation for a valid action", () => {
      const token = mgr.grantCapability({
        agentId: AGENT_ID,
        capability: CapabilityName.READ_TELEMETRY,
        scope: CapabilityScope.GLOBAL,
      });

      const attestation = mgr.createAttestation(
        AGENT_ID,
        "read:telemetry",
        "site-001",
        token.id,
        "agent-signing-key"
      );

      expect(attestation).not.toBeNull();
      expect(attestation!.agent).toBe(AGENT_ID);
      expect(attestation!.action).toBe("read:telemetry");
      expect(attestation!.target).toBe("site-001");
      expect(attestation!.signature).toBeDefined();
      expect(attestation!.nonce).toBeGreaterThan(0);
    });

    it("should chain attestations via parentAttestation", () => {
      const token = mgr.grantCapability({
        agentId: AGENT_ID,
        capability: CapabilityName.READ_TELEMETRY,
        scope: CapabilityScope.GLOBAL,
      });

      const att1 = mgr.createAttestation(AGENT_ID, "read:telemetry", "site-001", token.id, "key");
      expect(att1!.parentAttestation).toBeUndefined(); // First in chain

      const att2 = mgr.createAttestation(AGENT_ID, "read:telemetry", "site-002", token.id, "key");
      expect(att2!.parentAttestation).toBeDefined(); // Links to att1
      expect(att2!.nonce).toBeGreaterThan(att1!.nonce); // Monotonic nonce
    });

    it("should reject attestation for invalid token", () => {
      const attestation = mgr.createAttestation(
        AGENT_ID,
        "read:telemetry",
        "site-001",
        "nonexistent-token-id",
        "agent-key"
      );

      expect(attestation).toBeNull();
    });

    it("should reject attestation for wrong agent", () => {
      const token = mgr.grantCapability({
        agentId: AGENT_ID,
        capability: CapabilityName.READ_TELEMETRY,
        scope: CapabilityScope.GLOBAL,
      });

      const attestation = mgr.createAttestation(
        "different-agent",
        "read:telemetry",
        "site-001",
        token.id,
        "key"
      );

      expect(attestation).toBeNull();
    });
  });

  describe("statistics and cleanup", () => {
    it("should report accurate statistics", () => {
      mgr.grantCapability({ agentId: AGENT_ID, capability: "read:telemetry", scope: "global" });
      mgr.grantCapability({ agentId: AGENT_ID, capability: "read:alarms", scope: "global" });
      const toRevoke = mgr.grantCapability({ agentId: "other-agent", capability: "read:events", scope: "global" });
      mgr.revokeCapability(toRevoke.id, "test");

      const stats = mgr.getStats();
      expect(stats.totalTokens).toBe(3);
      expect(stats.activeTokens).toBe(2);
      expect(stats.revokedTokens).toBe(1);
      expect(stats.agentsWithTokens).toBe(2);
    });
  });
});

// =============================================================================
// ZERO-TRUST GUARD TESTS
// =============================================================================

describe("ZeroTrustGuard", () => {
  let guard: ZeroTrustGuard;
  let mgr: CapabilityManager;
  const SYSTEM_KEY = "test-system-signing-key-32bytes!!";
  const AGENT_ID = "ops-agent-001";
  const AGENT_KEY = "agent-signing-key-for-testing!!__";

  beforeEach(() => {
    // Re-initialize for isolation
    mgr = new CapabilityManager(SYSTEM_KEY);
    guard = new ZeroTrustGuard({ maxActionsPerMinute: 10 });

    // We need to inject our manager; use module-level init
    // For testing, we grant capabilities directly on the manager
  });

  describe("network zone policies", () => {
    it("should deny IT→OT direct access", () => {
      // Grant a token first (even though zone check should deny)
      mgr.grantCapability({
        agentId: AGENT_ID,
        capability: CapabilityName.READ_TELEMETRY,
        scope: CapabilityScope.GLOBAL,
      });

      const result = guard.check({
        agentId: AGENT_ID,
        capability: "read:telemetry",
        target: "plc-001",
        sourceZone: NetworkZone.IT_SERVICES,
        targetZone: NetworkZone.FIELD_OT,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Zone policy denies");
    });

    it("should allow same-zone access", () => {
      // Same zone always allowed at zone level
      // (capability check may still deny)
      const result = guard.check({
        agentId: AGENT_ID,
        capability: "read:telemetry",
        target: "sensor-001",
        sourceZone: NetworkZone.AGENT_DMZ,
        targetZone: NetworkZone.AGENT_DMZ,
      });

      // Will fail on capability check (no token), but NOT on zone check
      expect(result.reason).not.toContain("Zone policy");
    });
  });

  describe("rate limiting", () => {
    it("should enforce rate limits", () => {
      // With limit of 10, 11th action should be blocked
      for (let i = 0; i < 10; i++) {
        const result = guard.check({
          agentId: AGENT_ID,
          capability: "read:telemetry",
          target: `target-${i}`,
        });
        // Will fail on capability (no token) but NOT on rate limit
        expect(result.reason).not.toContain("Rate limited");
      }

      // 11th should be rate limited
      const result = guard.check({
        agentId: AGENT_ID,
        capability: "read:telemetry",
        target: "target-overflow",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Rate limited");
    });
  });
});

// =============================================================================
// SHARED TYPE HELPER TESTS
// =============================================================================

describe("Capability type helpers", () => {
  it("should identify write capabilities", () => {
    expect(isWriteCapability("write:setpoint")).toBe(true);
    expect(isWriteCapability("execute:emergency_stop")).toBe(true);
    expect(isWriteCapability("read:telemetry")).toBe(false);
    expect(isWriteCapability("propose:config_change")).toBe(false);
  });

  it("should identify admin capabilities", () => {
    expect(isAdminCapability("admin:agent_register")).toBe(true);
    expect(isAdminCapability("admin:capability_grant")).toBe(true);
    expect(isAdminCapability("write:setpoint")).toBe(false);
  });

  it("should have TTL defaults for all defined capabilities", () => {
    for (const cap of Object.values(CapabilityName)) {
      expect(CAPABILITY_TTL_DEFAULTS[cap]).toBeDefined();
    }
  });
});
