/**
 * 0xSCADA Capability Token Manager
 * 
 * ADR-0008: Zero-Trust Agent Deployment Model
 * 
 * Manages the lifecycle of capability tokens:
 * - Grant / revoke / renew tokens
 * - Validate tokens against agent identity
 * - Build and verify attestation chains
 * - Enforce least-privilege and time-bounded access
 */

import { randomUUID } from "crypto";
import { sha256, signWithHmac, verifyHmacSignature, canonicalize } from "../crypto";
import type {
  CapabilityToken,
  CapabilityRequest,
  Attestation,
} from "@shared/types/capability-token";
import {
  CAPABILITY_TTL_DEFAULTS,
  isCapabilityValid,
  isWriteCapability,
  isAdminCapability,
} from "@shared/types/capability-token";
import { log, logError } from "../logger";

// =============================================================================
// CAPABILITY MANAGER
// =============================================================================

export class CapabilityManager {
  /** Active tokens indexed by token ID */
  private tokens: Map<string, CapabilityToken> = new Map();

  /** Tokens indexed by agent ID for fast lookup */
  private agentTokens: Map<string, Set<string>> = new Map();

  /** Attestation chain indexed by agent ID (most recent) */
  private attestations: Map<string, Attestation> = new Map();

  /** Nonce counters per agent for replay protection */
  private nonces: Map<string, number> = new Map();

  /** System signing key (in production: HSM-backed) */
  private systemSigningKey: string;

  constructor(systemSigningKey: string) {
    this.systemSigningKey = systemSigningKey;
  }

  // ==========================================================================
  // TOKEN LIFECYCLE
  // ==========================================================================

  /**
   * Grant a capability token to an agent
   */
  grantCapability(request: CapabilityRequest, issuedBy: string = "SYSTEM"): CapabilityToken {
    const defaults = CAPABILITY_TTL_DEFAULTS[request.capability];
    const ttlMinutes = request.requestedTtlMinutes
      ? Math.min(request.requestedTtlMinutes, defaults?.ttlMinutes || 60)
      : defaults?.ttlMinutes || 60;

    const now = new Date();
    const expiresAt = ttlMinutes === 0
      ? new Date(now.getTime() + 24 * 60 * 60 * 1000) // Session: 24h max
      : new Date(now.getTime() + ttlMinutes * 60 * 1000);

    const nonce = this.getNextNonce(request.agentId);

    const tokenData = {
      id: randomUUID(),
      agentId: request.agentId,
      capability: request.capability,
      scope: request.scope,
      scopeTarget: request.scopeTarget,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      autoRenew: defaults?.autoRenew ?? false,
      issuedBy,
      nonce,
      revoked: false,
    };

    // Sign the token
    const tokenHash = sha256(canonicalize(tokenData));
    const signature = signWithHmac(tokenHash, this.systemSigningKey);

    const token: CapabilityToken = {
      ...tokenData,
      signature,
    };

    // Store the token
    this.tokens.set(token.id, token);
    if (!this.agentTokens.has(request.agentId)) {
      this.agentTokens.set(request.agentId, new Set());
    }
    this.agentTokens.get(request.agentId)!.add(token.id);

    log(
      `🔑 Capability granted: ${request.capability} → ${request.agentId} (expires: ${ttlMinutes}m)`,
      "zero-trust"
    );

    return token;
  }

  /**
   * Revoke a capability token
   */
  revokeCapability(tokenId: string, reason: string): boolean {
    const token = this.tokens.get(tokenId);
    if (!token) {
      return false;
    }

    token.revoked = true;
    token.revokedReason = reason;
    token.revokedAt = new Date().toISOString();
    this.tokens.set(tokenId, token);

    log(`🚫 Capability revoked: ${token.capability} for ${token.agentId} — ${reason}`, "zero-trust");

    return true;
  }

  /**
   * Revoke all capabilities for an agent
   */
  revokeAllForAgent(agentId: string, reason: string): number {
    const tokenIds = this.agentTokens.get(agentId);
    if (!tokenIds) return 0;

    let revoked = 0;
    for (const tokenId of tokenIds) {
      if (this.revokeCapability(tokenId, reason)) {
        revoked++;
      }
    }

    log(`🚫 All capabilities revoked for ${agentId}: ${revoked} tokens — ${reason}`, "zero-trust");
    return revoked;
  }

  /**
   * Renew a capability token (if auto-renew is enabled)
   */
  renewCapability(tokenId: string): CapabilityToken | null {
    const token = this.tokens.get(tokenId);
    if (!token || token.revoked || !token.autoRenew) {
      return null;
    }

    // Revoke old token
    this.revokeCapability(tokenId, "Renewed");

    // Issue new token with same parameters
    return this.grantCapability(
      {
        agentId: token.agentId,
        capability: token.capability,
        scope: token.scope as "global" | "per_site" | "per_asset",
        scopeTarget: token.scopeTarget,
      },
      token.issuedBy
    );
  }

  // ==========================================================================
  // TOKEN VALIDATION
  // ==========================================================================

  /**
   * Validate that an agent has a specific capability
   */
  validateCapability(
    agentId: string,
    capability: string,
    scopeTarget?: string
  ): { valid: boolean; token?: CapabilityToken; reason?: string } {
    const tokenIds = this.agentTokens.get(agentId);
    if (!tokenIds || tokenIds.size === 0) {
      return { valid: false, reason: "No capability tokens found for agent" };
    }

    for (const tokenId of tokenIds) {
      const token = this.tokens.get(tokenId);
      if (!token) continue;

      // Check capability match
      if (token.capability !== capability) continue;

      // Check validity (not expired, not revoked)
      if (!isCapabilityValid(token)) continue;

      // Check scope
      if (scopeTarget && token.scope !== "global") {
        if (token.scopeTarget !== scopeTarget) continue;
      }

      // Verify signature
      const tokenDataForVerify = { ...token };
      delete (tokenDataForVerify as any).signature;
      delete (tokenDataForVerify as any).revoked;
      delete (tokenDataForVerify as any).revokedReason;
      delete (tokenDataForVerify as any).revokedAt;
      const tokenHash = sha256(canonicalize(tokenDataForVerify));
      if (!verifyHmacSignature(tokenHash, token.signature, this.systemSigningKey)) {
        continue;
      }

      // Auto-renew if close to expiry (within 20% of TTL)
      if (token.autoRenew) {
        const ttlMs = new Date(token.expiresAt).getTime() - new Date(token.issuedAt).getTime();
        const remainingMs = new Date(token.expiresAt).getTime() - Date.now();
        if (remainingMs < ttlMs * 0.2) {
          const renewed = this.renewCapability(token.id);
          if (renewed) {
            return { valid: true, token: renewed };
          }
        }
      }

      return { valid: true, token };
    }

    return { valid: false, reason: `No valid ${capability} token found for agent ${agentId}` };
  }

  // ==========================================================================
  // ATTESTATION CHAIN
  // ==========================================================================

  /**
   * Create an attestation for an agent action
   */
  createAttestation(
    agentId: string,
    action: string,
    target: string,
    capabilityTokenId: string,
    agentSigningKey: string
  ): Attestation | null {
    // Validate the capability token
    const token = this.tokens.get(capabilityTokenId);
    if (!token || !isCapabilityValid(token)) {
      logError(`Attestation failed: invalid capability token ${capabilityTokenId}`, null, "zero-trust");
      return null;
    }

    if (token.agentId !== agentId) {
      logError(`Attestation failed: token ${capabilityTokenId} not issued to ${agentId}`, null, "zero-trust");
      return null;
    }

    const nonce = this.getNextNonce(agentId);
    const parentAttestation = this.attestations.get(agentId);

    const attestationData = {
      agent: agentId,
      action,
      target,
      capabilityTokenId,
      nonce,
      timestamp: new Date().toISOString(),
      parentAttestation: parentAttestation
        ? sha256(canonicalize(parentAttestation))
        : undefined,
    };

    const attestationHash = sha256(canonicalize(attestationData));
    const signature = signWithHmac(attestationHash, agentSigningKey);

    const attestation: Attestation = {
      ...attestationData,
      signature,
    };

    // Store as most recent attestation for this agent
    this.attestations.set(agentId, attestation);

    log(`📝 Attestation: ${agentId} → ${action} → ${target}`, "zero-trust");

    return attestation;
  }

  /**
   * Verify an attestation signature
   */
  verifyAttestation(attestation: Attestation, agentPublicKey: string): boolean {
    const attestationData = { ...attestation };
    delete (attestationData as any).signature;
    const attestationHash = sha256(canonicalize(attestationData));
    return verifyHmacSignature(attestationHash, attestation.signature, agentPublicKey);
  }

  // ==========================================================================
  // NONCE MANAGEMENT
  // ==========================================================================

  private getNextNonce(agentId: string): number {
    const current = this.nonces.get(agentId) || 0;
    const next = current + 1;
    this.nonces.set(agentId, next);
    return next;
  }

  // ==========================================================================
  // QUERY
  // ==========================================================================

  /**
   * Get all active tokens for an agent
   */
  getAgentCapabilities(agentId: string): CapabilityToken[] {
    const tokenIds = this.agentTokens.get(agentId);
    if (!tokenIds) return [];

    return Array.from(tokenIds)
      .map((id) => this.tokens.get(id))
      .filter((t): t is CapabilityToken => t !== undefined && isCapabilityValid(t));
  }

  /**
   * Get the most recent attestation for an agent
   */
  getLastAttestation(agentId: string): Attestation | undefined {
    return this.attestations.get(agentId);
  }

  /**
   * Get token by ID
   */
  getToken(tokenId: string): CapabilityToken | undefined {
    return this.tokens.get(tokenId);
  }

  /**
   * Cleanup expired tokens
   */
  cleanupExpired(): number {
    let cleaned = 0;
    for (const [id, token] of this.tokens) {
      if (!isCapabilityValid(token)) {
        this.tokens.delete(id);
        const agentSet = this.agentTokens.get(token.agentId);
        if (agentSet) {
          agentSet.delete(id);
        }
        cleaned++;
      }
    }
    return cleaned;
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalTokens: number;
    activeTokens: number;
    revokedTokens: number;
    expiredTokens: number;
    agentsWithTokens: number;
  } {
    let active = 0;
    let revoked = 0;
    let expired = 0;
    for (const token of this.tokens.values()) {
      if (token.revoked) revoked++;
      else if (new Date(token.expiresAt) < new Date()) expired++;
      else active++;
    }
    return {
      totalTokens: this.tokens.size,
      activeTokens: active,
      revokedTokens: revoked,
      expiredTokens: expired,
      agentsWithTokens: this.agentTokens.size,
    };
  }
}

// =============================================================================
// SINGLETON
// =============================================================================

let capabilityManagerInstance: CapabilityManager | null = null;

export function getCapabilityManager(): CapabilityManager {
  if (!capabilityManagerInstance) {
    // In production, this key comes from HSM or secure env var
    const systemKey = process.env.ZERO_TRUST_SYSTEM_KEY || sha256("0xSCADA-zero-trust-dev-key");
    capabilityManagerInstance = new CapabilityManager(systemKey);
  }
  return capabilityManagerInstance;
}

export function initCapabilityManager(systemSigningKey: string): CapabilityManager {
  capabilityManagerInstance = new CapabilityManager(systemSigningKey);
  return capabilityManagerInstance;
}
