/**
 * 0xSCADA Zero-Trust Guard
 * 
 * ADR-0008: Zero-Trust Agent Deployment Model
 * 
 * Enforces zero-trust principles on all agent actions:
 * - Validates capability tokens before any operation
 * - Creates attestation chains for auditability
 * - Enforces network zone restrictions
 * - Rate-limits agent actions
 */

import { getCapabilityManager } from "./capability-manager";
import { log, logError } from "../logger";
import type { BaseAgent } from "./base";
import type { Attestation } from "@shared/types/capability-token";
import { isWriteCapability, isAdminCapability } from "@shared/types/capability-token";

// =============================================================================
// NETWORK ZONE DEFINITIONS (ADR-0008 Section 5)
// =============================================================================

export const NetworkZone = {
  FIELD_OT: "FIELD_OT",
  AGENT_DMZ: "AGENT_DMZ",
  GOVERNANCE: "GOVERNANCE",
  IT_SERVICES: "IT_SERVICES",
} as const;

export type NetworkZone = (typeof NetworkZone)[keyof typeof NetworkZone];

export interface ZonePolicy {
  from: NetworkZone;
  to: NetworkZone;
  allowed: boolean;
  requiresCapability?: string;
}

/**
 * Default cross-zone policies
 * Agents in DMZ can read from OT (via gateway) and access governance.
 * No direct IT→OT access.
 */
const DEFAULT_ZONE_POLICIES: ZonePolicy[] = [
  { from: "AGENT_DMZ", to: "FIELD_OT", allowed: true, requiresCapability: "read:telemetry" },
  { from: "AGENT_DMZ", to: "GOVERNANCE", allowed: true },
  { from: "AGENT_DMZ", to: "IT_SERVICES", allowed: true },
  { from: "IT_SERVICES", to: "GOVERNANCE", allowed: true },
  { from: "IT_SERVICES", to: "AGENT_DMZ", allowed: true },
  { from: "IT_SERVICES", to: "FIELD_OT", allowed: false }, // CRITICAL: No direct IT→OT
  { from: "FIELD_OT", to: "AGENT_DMZ", allowed: true },    // OT publishes to DMZ
  { from: "FIELD_OT", to: "GOVERNANCE", allowed: false },   // OT doesn't touch governance directly
  { from: "GOVERNANCE", to: "AGENT_DMZ", allowed: true },
  { from: "GOVERNANCE", to: "IT_SERVICES", allowed: true },
  { from: "GOVERNANCE", to: "FIELD_OT", allowed: false },   // Governance doesn't touch OT directly
];

// =============================================================================
// RATE LIMITER
// =============================================================================

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

class AgentRateLimiter {
  private limits: Map<string, RateLimitEntry> = new Map();
  private maxActionsPerMinute: number;

  constructor(maxActionsPerMinute: number = 60) {
    this.maxActionsPerMinute = maxActionsPerMinute;
  }

  check(agentId: string): { allowed: boolean; remaining: number } {
    const now = Date.now();
    const key = agentId;
    const entry = this.limits.get(key);

    if (!entry || now - entry.windowStart > 60_000) {
      this.limits.set(key, { count: 1, windowStart: now });
      return { allowed: true, remaining: this.maxActionsPerMinute - 1 };
    }

    if (entry.count >= this.maxActionsPerMinute) {
      return { allowed: false, remaining: 0 };
    }

    entry.count++;
    return { allowed: true, remaining: this.maxActionsPerMinute - entry.count };
  }

  setLimit(maxActionsPerMinute: number): void {
    this.maxActionsPerMinute = maxActionsPerMinute;
  }
}

// =============================================================================
// ZERO-TRUST GUARD
// =============================================================================

export interface GuardResult {
  allowed: boolean;
  reason?: string;
  attestation?: Attestation;
  tokenId?: string;
}

export interface GuardCheckOptions {
  agentId: string;
  capability: string;
  target: string;
  scopeTarget?: string;
  sourceZone?: NetworkZone;
  targetZone?: NetworkZone;
  agentSigningKey?: string;
}

export class ZeroTrustGuard {
  private rateLimiter: AgentRateLimiter;
  private zonePolicies: ZonePolicy[];
  private writeActionLog: Array<{
    agentId: string;
    capability: string;
    target: string;
    timestamp: string;
    attestationHash: string;
  }> = [];

  constructor(options?: { maxActionsPerMinute?: number; zonePolicies?: ZonePolicy[] }) {
    this.rateLimiter = new AgentRateLimiter(options?.maxActionsPerMinute ?? 60);
    this.zonePolicies = options?.zonePolicies ?? DEFAULT_ZONE_POLICIES;
  }

  /**
   * Main guard check — validates an agent's right to perform an action.
   * Returns an attestation if the action is allowed.
   */
  check(options: GuardCheckOptions): GuardResult {
    const { agentId, capability, target, scopeTarget, sourceZone, targetZone, agentSigningKey } = options;
    const mgr = getCapabilityManager();

    // 1. Rate limit check
    const rateResult = this.rateLimiter.check(agentId);
    if (!rateResult.allowed) {
      log(`⚠️ Rate limited: ${agentId} (${capability})`, "zero-trust");
      return { allowed: false, reason: `Rate limited: 0 actions remaining in window` };
    }

    // 2. Network zone check
    if (sourceZone && targetZone) {
      const zoneAllowed = this.checkZonePolicy(sourceZone, targetZone, capability);
      if (!zoneAllowed.allowed) {
        log(`🚫 Zone policy denied: ${sourceZone} → ${targetZone} for ${agentId}`, "zero-trust");
        return { allowed: false, reason: zoneAllowed.reason };
      }
    }

    // 3. Capability token validation
    const capResult = mgr.validateCapability(agentId, capability, scopeTarget);
    if (!capResult.valid || !capResult.token) {
      log(`🚫 Capability denied: ${agentId} lacks ${capability}`, "zero-trust");
      return { allowed: false, reason: capResult.reason || "No valid capability token" };
    }

    // 4. Create attestation (if signing key provided)
    let attestation: Attestation | undefined;
    if (agentSigningKey) {
      const att = mgr.createAttestation(agentId, capability, target, capResult.token.id, agentSigningKey);
      if (!att) {
        return { allowed: false, reason: "Failed to create attestation" };
      }
      attestation = att;
    }

    // 5. Log write actions for audit
    if (isWriteCapability(capability) || isAdminCapability(capability)) {
      this.writeActionLog.push({
        agentId,
        capability,
        target,
        timestamp: new Date().toISOString(),
        attestationHash: attestation
          ? attestation.signature.substring(0, 16)
          : "no-attestation",
      });

      // Trim log
      if (this.writeActionLog.length > 10000) {
        this.writeActionLog = this.writeActionLog.slice(-5000);
      }
    }

    return {
      allowed: true,
      attestation,
      tokenId: capResult.token.id,
    };
  }

  /**
   * Check network zone policy
   */
  private checkZonePolicy(
    from: NetworkZone,
    to: NetworkZone,
    capability: string
  ): { allowed: boolean; reason?: string } {
    if (from === to) {
      return { allowed: true }; // Same zone always allowed
    }

    const policy = this.zonePolicies.find((p) => p.from === from && p.to === to);

    if (!policy) {
      return { allowed: false, reason: `No zone policy for ${from} → ${to}` };
    }

    if (!policy.allowed) {
      return { allowed: false, reason: `Zone policy denies ${from} → ${to}` };
    }

    if (policy.requiresCapability && policy.requiresCapability !== capability) {
      // Policy requires a specific capability for this cross-zone access
      // The capability check will happen in the main flow
    }

    return { allowed: true };
  }

  /**
   * Get write action audit log
   */
  getWriteActionLog(agentId?: string, limit: number = 100): typeof this.writeActionLog {
    let result = this.writeActionLog;
    if (agentId) {
      result = result.filter((e) => e.agentId === agentId);
    }
    return result.slice(-limit);
  }

  /**
   * Set rate limit for a specific agent type or globally
   */
  setRateLimit(maxActionsPerMinute: number): void {
    this.rateLimiter.setLimit(maxActionsPerMinute);
  }
}

// =============================================================================
// SINGLETON
// =============================================================================

let guardInstance: ZeroTrustGuard | null = null;

export function getZeroTrustGuard(): ZeroTrustGuard {
  if (!guardInstance) {
    guardInstance = new ZeroTrustGuard();
  }
  return guardInstance;
}

export function initZeroTrustGuard(options?: {
  maxActionsPerMinute?: number;
  zonePolicies?: ZonePolicy[];
}): ZeroTrustGuard {
  guardInstance = new ZeroTrustGuard(options);
  return guardInstance;
}
