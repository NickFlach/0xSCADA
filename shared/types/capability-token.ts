/**
 * 0xSCADA Capability Token System
 * 
 * ADR-0008: Zero-Trust Agent Deployment Model
 * 
 * Agents receive capability tokens that grant specific, time-bounded
 * permissions. No agent is inherently trusted regardless of network
 * position or prior authentication.
 */

import { z } from "zod";

// =============================================================================
// CAPABILITY DEFINITIONS
// =============================================================================

export const CapabilityScope = {
  GLOBAL: "global",
  PER_SITE: "per_site",
  PER_ASSET: "per_asset",
} as const;

export type CapabilityScope = (typeof CapabilityScope)[keyof typeof CapabilityScope];

export const CapabilityName = {
  // Read capabilities
  READ_TELEMETRY: "read:telemetry",
  READ_ALARMS: "read:alarms",
  READ_EVENTS: "read:events",
  READ_BLUEPRINTS: "read:blueprints",
  READ_ASSETS: "read:assets",
  READ_SITES: "read:sites",

  // Write capabilities (bounded)
  WRITE_SETPOINT: "write:setpoint",
  WRITE_COMMAND: "write:command",
  WRITE_CONFIG: "write:config",

  // Execute capabilities
  EXECUTE_EMERGENCY_STOP: "execute:emergency_stop",
  EXECUTE_MODE_CHANGE: "execute:mode_change",

  // Propose capabilities
  PROPOSE_CONFIG_CHANGE: "propose:config_change",
  PROPOSE_DEPLOYMENT: "propose:deployment",

  // Anchor capabilities
  ANCHOR_BATCH: "anchor:batch",
  ANCHOR_EVENT: "anchor:event",

  // Admin capabilities
  ADMIN_AGENT_REGISTER: "admin:agent_register",
  ADMIN_AGENT_REVOKE: "admin:agent_revoke",
  ADMIN_CAPABILITY_GRANT: "admin:capability_grant",
} as const;

export type CapabilityName = (typeof CapabilityName)[keyof typeof CapabilityName];

// =============================================================================
// CAPABILITY TOKEN SCHEMA
// =============================================================================

export const capabilityTokenSchema = z.object({
  /** Unique token identifier */
  id: z.string().uuid(),

  /** Agent this token is issued to */
  agentId: z.string(),

  /** Capability granted */
  capability: z.string(),

  /** Scope of the capability */
  scope: z.enum(["global", "per_site", "per_asset"]),

  /** Scope target (site ID or asset ID, depending on scope) */
  scopeTarget: z.string().optional(),

  /** Token issued at (ISO8601) */
  issuedAt: z.string().datetime(),

  /** Token expires at (ISO8601) */
  expiresAt: z.string().datetime(),

  /** Whether auto-renewal is enabled */
  autoRenew: z.boolean().default(false),

  /** Issuer (system, admin user, or governance contract) */
  issuedBy: z.string(),

  /** Nonce for replay protection */
  nonce: z.number().int().nonnegative(),

  /** Cryptographic signature of the token */
  signature: z.string(),

  /** Whether this token has been revoked */
  revoked: z.boolean().default(false),

  /** Revocation reason (if revoked) */
  revokedReason: z.string().optional(),

  /** Revoked at timestamp */
  revokedAt: z.string().datetime().optional(),
});

export type CapabilityToken = z.infer<typeof capabilityTokenSchema>;

// =============================================================================
// CAPABILITY TOKEN TTL DEFAULTS (from ADR-0008)
// =============================================================================

export const CAPABILITY_TTL_DEFAULTS: Record<string, { ttlMinutes: number; autoRenew: boolean }> = {
  "read:telemetry": { ttlMinutes: 60, autoRenew: true },
  "read:alarms": { ttlMinutes: 60, autoRenew: true },
  "read:events": { ttlMinutes: 60, autoRenew: true },
  "read:blueprints": { ttlMinutes: 60, autoRenew: true },
  "read:assets": { ttlMinutes: 60, autoRenew: true },
  "read:sites": { ttlMinutes: 60, autoRenew: true },
  "write:setpoint": { ttlMinutes: 15, autoRenew: false },
  "write:command": { ttlMinutes: 15, autoRenew: false },
  "write:config": { ttlMinutes: 30, autoRenew: false },
  "execute:emergency_stop": { ttlMinutes: 0, autoRenew: false }, // Session-only, Guardian
  "execute:mode_change": { ttlMinutes: 30, autoRenew: false },
  "propose:config_change": { ttlMinutes: 30, autoRenew: false },
  "propose:deployment": { ttlMinutes: 30, autoRenew: false },
  "anchor:batch": { ttlMinutes: 60, autoRenew: true },
  "anchor:event": { ttlMinutes: 60, autoRenew: true },
  "admin:agent_register": { ttlMinutes: 15, autoRenew: false },
  "admin:agent_revoke": { ttlMinutes: 15, autoRenew: false },
  "admin:capability_grant": { ttlMinutes: 15, autoRenew: false },
};

// =============================================================================
// ATTESTATION CHAIN
// =============================================================================

export const attestationSchema = z.object({
  /** Agent performing the action */
  agent: z.string(),

  /** Action being performed */
  action: z.string(),

  /** Target of the action */
  target: z.string(),

  /** Capability token ID used */
  capabilityTokenId: z.string().uuid(),

  /** Nonce for replay protection */
  nonce: z.number().int().nonnegative(),

  /** Timestamp of the attestation */
  timestamp: z.string().datetime(),

  /** Cryptographic signature */
  signature: z.string(),

  /** Hash of the parent attestation (chain linkage) */
  parentAttestation: z.string().optional(),
});

export type Attestation = z.infer<typeof attestationSchema>;

// =============================================================================
// TOKEN REQUEST / GRANT
// =============================================================================

export const capabilityRequestSchema = z.object({
  /** Agent requesting the capability */
  agentId: z.string(),

  /** Requested capability */
  capability: z.string(),

  /** Requested scope */
  scope: z.enum(["global", "per_site", "per_asset"]),

  /** Scope target */
  scopeTarget: z.string().optional(),

  /** Justification for the request */
  justification: z.string().optional(),

  /** Requested TTL in minutes (may be reduced by policy) */
  requestedTtlMinutes: z.number().int().positive().optional(),
});

export type CapabilityRequest = z.infer<typeof capabilityRequestSchema>;

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

export function isCapabilityExpired(token: CapabilityToken): boolean {
  return new Date(token.expiresAt) < new Date();
}

export function isCapabilityValid(token: CapabilityToken): boolean {
  return !token.revoked && !isCapabilityExpired(token);
}

export function isWriteCapability(capability: string): boolean {
  return capability.startsWith("write:") || capability.startsWith("execute:");
}

export function isAdminCapability(capability: string): boolean {
  return capability.startsWith("admin:");
}
