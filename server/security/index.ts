/**
 * Zero Trust Security Infrastructure
 * 
 * Phase 5: Zero Trust Security
 * 
 * Features:
 * - Identity & key management (users/devices/agents)
 * - RBAC (Role-Based Access Control)
 * - Crypto key rotation
 * - Audit logs with cryptographic proof
 */

import { randomBytes, createHash, createHmac } from "crypto";
import { db } from "../db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";

// =============================================================================
// TYPES
// =============================================================================

export type Role = "ADMIN" | "ENGINEER" | "OPERATOR" | "MAINTENANCE" | "AUDITOR" | "READONLY";

export type Permission = 
  | "READ_SITES"
  | "WRITE_SITES"
  | "READ_ASSETS"
  | "WRITE_ASSETS"
  | "READ_EVENTS"
  | "WRITE_EVENTS"
  | "READ_BLUEPRINTS"
  | "WRITE_BLUEPRINTS"
  | "READ_AGENTS"
  | "MANAGE_AGENTS"
  | "APPROVE_PROPOSALS"
  | "READ_AUDIT"
  | "MANAGE_USERS"
  | "MANAGE_KEYS"
  | "DEPLOY_CODE";

export interface Identity {
  id: string;
  type: "USER" | "DEVICE" | "AGENT" | "GATEWAY";
  name: string;
  publicKey?: string;
  keyAlgorithm?: string;
  ethereumAddress?: string;
  roles: Role[];
  permissions: Permission[];
  siteIds?: string[];
  active: boolean;
  createdAt: Date;
  lastActiveAt?: Date;
}

export interface KeyPair {
  publicKey: string;
  privateKey: string;
  algorithm: string;
  createdAt: Date;
  expiresAt?: Date;
  rotatedFrom?: string;
}

export interface AuditLogEntry {
  id: string;
  timestamp: Date;
  actorId: string;
  actorType: "USER" | "DEVICE" | "AGENT" | "GATEWAY" | "SYSTEM";
  action: string;
  resource: string;
  resourceId?: string;
  details: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  signature: string;
  previousEntryHash?: string;
}

export interface Session {
  id: string;
  userId: string;
  token: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  ipAddress?: string;
  userAgent?: string;
  mfaVerified: boolean;
}

// =============================================================================
// ROLE PERMISSIONS
// =============================================================================

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  ADMIN: [
    "READ_SITES", "WRITE_SITES",
    "READ_ASSETS", "WRITE_ASSETS",
    "READ_EVENTS", "WRITE_EVENTS",
    "READ_BLUEPRINTS", "WRITE_BLUEPRINTS",
    "READ_AGENTS", "MANAGE_AGENTS",
    "APPROVE_PROPOSALS",
    "READ_AUDIT",
    "MANAGE_USERS",
    "MANAGE_KEYS",
    "DEPLOY_CODE",
  ],
  ENGINEER: [
    "READ_SITES",
    "READ_ASSETS", "WRITE_ASSETS",
    "READ_EVENTS", "WRITE_EVENTS",
    "READ_BLUEPRINTS", "WRITE_BLUEPRINTS",
    "READ_AGENTS",
    "APPROVE_PROPOSALS",
    "READ_AUDIT",
    "DEPLOY_CODE",
  ],
  OPERATOR: [
    "READ_SITES",
    "READ_ASSETS",
    "READ_EVENTS", "WRITE_EVENTS",
    "READ_BLUEPRINTS",
    "READ_AGENTS",
    "APPROVE_PROPOSALS",
  ],
  MAINTENANCE: [
    "READ_SITES",
    "READ_ASSETS", "WRITE_ASSETS",
    "READ_EVENTS", "WRITE_EVENTS",
    "READ_BLUEPRINTS",
  ],
  AUDITOR: [
    "READ_SITES",
    "READ_ASSETS",
    "READ_EVENTS",
    "READ_BLUEPRINTS",
    "READ_AGENTS",
    "READ_AUDIT",
  ],
  READONLY: [
    "READ_SITES",
    "READ_ASSETS",
    "READ_EVENTS",
    "READ_BLUEPRINTS",
  ],
};

// =============================================================================
// KEY MANAGEMENT
// =============================================================================

export class KeyManager {
  private keys: Map<string, KeyPair> = new Map();
  private rotationHistory: Map<string, string[]> = new Map();

  /**
   * Generate a new key pair
   */
  generateKeyPair(algorithm: string = "hmac-sha256"): KeyPair {
    const privateKey = randomBytes(32).toString("hex");
    const publicKey = createHash("sha256").update(privateKey).digest("hex");

    return {
      publicKey,
      privateKey,
      algorithm,
      createdAt: new Date(),
    };
  }

  /**
   * Store a key pair
   */
  storeKey(id: string, keyPair: KeyPair): void {
    this.keys.set(id, keyPair);
  }

  /**
   * Get a key pair
   */
  getKey(id: string): KeyPair | undefined {
    return this.keys.get(id);
  }

  /**
   * Rotate a key
   */
  rotateKey(id: string): KeyPair {
    const oldKey = this.keys.get(id);
    const newKey = this.generateKeyPair(oldKey?.algorithm);
    
    if (oldKey) {
      newKey.rotatedFrom = oldKey.publicKey;
      
      // Track rotation history
      const history = this.rotationHistory.get(id) || [];
      history.push(oldKey.publicKey);
      this.rotationHistory.set(id, history);
    }

    this.keys.set(id, newKey);
    return newKey;
  }

  /**
   * Check if a key is expired
   */
  isKeyExpired(id: string): boolean {
    const key = this.keys.get(id);
    if (!key || !key.expiresAt) return false;
    return new Date() > key.expiresAt;
  }

  /**
   * Get rotation history
   */
  getRotationHistory(id: string): string[] {
    return this.rotationHistory.get(id) || [];
  }
}

// =============================================================================
// RBAC SERVICE
// =============================================================================

export class RBACService {
  /**
   * Get permissions for a role
   */
  getPermissionsForRole(role: Role): Permission[] {
    return ROLE_PERMISSIONS[role] || [];
  }

  /**
   * Get all permissions for multiple roles
   */
  getPermissionsForRoles(roles: Role[]): Permission[] {
    const permissions = new Set<Permission>();
    for (const role of roles) {
      for (const perm of this.getPermissionsForRole(role)) {
        permissions.add(perm);
      }
    }
    return Array.from(permissions);
  }

  /**
   * Check if identity has permission
   */
  hasPermission(identity: Identity, permission: Permission): boolean {
    // Check direct permissions
    if (identity.permissions.includes(permission)) {
      return true;
    }

    // Check role-based permissions
    for (const role of identity.roles) {
      if (ROLE_PERMISSIONS[role]?.includes(permission)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if identity has access to a site
   */
  hasSiteAccess(identity: Identity, siteId: string): boolean {
    // Admins have access to all sites
    if (identity.roles.includes("ADMIN")) {
      return true;
    }

    // Check site scope
    if (!identity.siteIds || identity.siteIds.length === 0) {
      return true; // No site restriction
    }

    return identity.siteIds.includes(siteId);
  }

  /**
   * Authorize an action
   */
  authorize(
    identity: Identity,
    permission: Permission,
    siteId?: string
  ): { authorized: boolean; reason?: string } {
    if (!identity.active) {
      return { authorized: false, reason: "Identity is inactive" };
    }

    if (!this.hasPermission(identity, permission)) {
      return { authorized: false, reason: `Missing permission: ${permission}` };
    }

    if (siteId && !this.hasSiteAccess(identity, siteId)) {
      return { authorized: false, reason: `No access to site: ${siteId}` };
    }

    return { authorized: true };
  }
}

// =============================================================================
// AUDIT SERVICE
// =============================================================================

export class AuditService {
  private entries: AuditLogEntry[] = [];
  private lastEntryHash: string = "";
  private signingKey: string;

  constructor(signingKey: string) {
    this.signingKey = signingKey;
  }

  /**
   * Log an action
   */
  log(entry: Omit<AuditLogEntry, "id" | "timestamp" | "signature" | "previousEntryHash">): AuditLogEntry {
    const id = `audit_${Date.now()}_${randomBytes(4).toString("hex")}`;
    const timestamp = new Date();

    // Create entry content for signing
    const content = JSON.stringify({
      id,
      timestamp: timestamp.toISOString(),
      ...entry,
      previousEntryHash: this.lastEntryHash,
    });

    // Sign the entry
    const signature = createHmac("sha256", this.signingKey)
      .update(content)
      .digest("hex");

    const auditEntry: AuditLogEntry = {
      id,
      timestamp,
      ...entry,
      signature,
      previousEntryHash: this.lastEntryHash || undefined,
    };

    // Update chain
    this.lastEntryHash = createHash("sha256")
      .update(content + signature)
      .digest("hex");

    this.entries.push(auditEntry);

    // Trim if too large
    if (this.entries.length > 100000) {
      this.entries = this.entries.slice(-50000);
    }

    return auditEntry;
  }

  /**
   * Verify audit log integrity
   */
  verifyIntegrity(): { valid: boolean; brokenAt?: number } {
    let previousHash = "";

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];

      // Check chain
      if (entry.previousEntryHash !== (previousHash || undefined)) {
        return { valid: false, brokenAt: i };
      }

      // Verify signature
      const content = JSON.stringify({
        id: entry.id,
        timestamp: entry.timestamp.toISOString(),
        actorId: entry.actorId,
        actorType: entry.actorType,
        action: entry.action,
        resource: entry.resource,
        resourceId: entry.resourceId,
        details: entry.details,
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent,
        previousEntryHash: entry.previousEntryHash,
      });

      const expectedSignature = createHmac("sha256", this.signingKey)
        .update(content)
        .digest("hex");

      if (entry.signature !== expectedSignature) {
        return { valid: false, brokenAt: i };
      }

      previousHash = createHash("sha256")
        .update(content + entry.signature)
        .digest("hex");
    }

    return { valid: true };
  }

  /**
   * Query audit log
   */
  query(filters: {
    actorId?: string;
    actorType?: string;
    action?: string;
    resource?: string;
    startTime?: Date;
    endTime?: Date;
    limit?: number;
  }): AuditLogEntry[] {
    let results = this.entries;

    if (filters.actorId) {
      results = results.filter(e => e.actorId === filters.actorId);
    }
    if (filters.actorType) {
      results = results.filter(e => e.actorType === filters.actorType);
    }
    if (filters.action) {
      results = results.filter(e => e.action === filters.action);
    }
    if (filters.resource) {
      results = results.filter(e => e.resource === filters.resource);
    }
    if (filters.startTime) {
      results = results.filter(e => e.timestamp >= filters.startTime!);
    }
    if (filters.endTime) {
      results = results.filter(e => e.timestamp <= filters.endTime!);
    }

    if (filters.limit) {
      results = results.slice(-filters.limit);
    }

    return results;
  }

  /**
   * Get audit log stats
   */
  getStats(): Record<string, unknown> {
    const byAction: Record<string, number> = {};
    const byActor: Record<string, number> = {};
    const byResource: Record<string, number> = {};

    for (const entry of this.entries) {
      byAction[entry.action] = (byAction[entry.action] || 0) + 1;
      byActor[entry.actorId] = (byActor[entry.actorId] || 0) + 1;
      byResource[entry.resource] = (byResource[entry.resource] || 0) + 1;
    }

    return {
      totalEntries: this.entries.length,
      byAction,
      byActor,
      byResource,
      integrityValid: this.verifyIntegrity().valid,
    };
  }
}

// =============================================================================
// SESSION MANAGEMENT
// =============================================================================

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private sessionsByUser: Map<string, Set<string>> = new Map();

  /**
   * Create a new session
   */
  createSession(
    userId: string,
    options: {
      expiresIn?: number;
      ipAddress?: string;
      userAgent?: string;
    } = {}
  ): Session {
    const token = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresIn = options.expiresIn || 24 * 60 * 60 * 1000; // 24 hours

    const session: Session = {
      id: `session_${Date.now()}_${randomBytes(4).toString("hex")}`,
      userId,
      token,
      tokenHash,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + expiresIn),
      ipAddress: options.ipAddress,
      userAgent: options.userAgent,
      mfaVerified: false,
    };

    this.sessions.set(session.id, session);

    // Track by user
    if (!this.sessionsByUser.has(userId)) {
      this.sessionsByUser.set(userId, new Set());
    }
    this.sessionsByUser.get(userId)!.add(session.id);

    return session;
  }

  /**
   * Validate a session token
   */
  validateToken(token: string): Session | null {
    const tokenHash = createHash("sha256").update(token).digest("hex");

    for (const session of this.sessions.values()) {
      if (session.tokenHash === tokenHash) {
        if (new Date() > session.expiresAt) {
          this.destroySession(session.id);
          return null;
        }
        return session;
      }
    }

    return null;
  }

  /**
   * Mark session as MFA verified
   */
  verifyMFA(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.mfaVerified = true;
    return true;
  }

  /**
   * Destroy a session
   */
  destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessionsByUser.get(session.userId)?.delete(sessionId);
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Destroy all sessions for a user
   */
  destroyUserSessions(userId: string): void {
    const sessionIds = this.sessionsByUser.get(userId);
    if (sessionIds) {
      for (const id of sessionIds) {
        this.sessions.delete(id);
      }
      this.sessionsByUser.delete(userId);
    }
  }

  /**
   * Get active sessions for a user
   */
  getUserSessions(userId: string): Session[] {
    const sessionIds = this.sessionsByUser.get(userId);
    if (!sessionIds) return [];

    const sessions: Session[] = [];
    for (const id of sessionIds) {
      const session = this.sessions.get(id);
      if (session && new Date() < session.expiresAt) {
        sessions.push(session);
      }
    }

    return sessions;
  }

  /**
   * Clean up expired sessions
   */
  cleanupExpired(): number {
    let cleaned = 0;
    const now = new Date();

    for (const [id, session] of this.sessions) {
      if (now > session.expiresAt) {
        this.destroySession(id);
        cleaned++;
      }
    }

    return cleaned;
  }
}

// =============================================================================
// SECURITY SERVICE (FACADE)
// =============================================================================

export class SecurityService {
  public keyManager: KeyManager;
  public rbac: RBACService;
  public audit: AuditService;
  public sessions: SessionManager;

  constructor(auditSigningKey: string) {
    this.keyManager = new KeyManager();
    this.rbac = new RBACService();
    this.audit = new AuditService(auditSigningKey);
    this.sessions = new SessionManager();
  }

  /**
   * Authenticate and authorize a request
   */
  async authenticateRequest(
    token: string,
    requiredPermission: Permission,
    siteId?: string
  ): Promise<{ success: boolean; identity?: Identity; error?: string }> {
    // Validate session
    const session = this.sessions.validateToken(token);
    if (!session) {
      return { success: false, error: "Invalid or expired session" };
    }

    // Get user identity
    const [user] = await db.select().from(users).where(eq(users.id, session.userId));
    if (!user) {
      return { success: false, error: "User not found" };
    }

    const identity: Identity = {
      id: user.id,
      type: "USER",
      name: user.displayName,
      publicKey: user.publicKey || undefined,
      keyAlgorithm: user.keyAlgorithm || undefined,
      ethereumAddress: user.ethereumAddress || undefined,
      roles: [user.role as Role],
      permissions: (user.permissions as Permission[]) || [],
      siteIds: (user.siteIds as string[]) || [],
      active: user.active,
      createdAt: new Date(user.createdAt),
      lastActiveAt: user.lastLoginAt ? new Date(user.lastLoginAt) : undefined,
    };

    // Authorize
    const authResult = this.rbac.authorize(identity, requiredPermission, siteId);
    if (!authResult.authorized) {
      this.audit.log({
        actorId: identity.id,
        actorType: "USER",
        action: "AUTHORIZATION_FAILED",
        resource: requiredPermission,
        resourceId: siteId,
        details: { reason: authResult.reason },
      });
      return { success: false, error: authResult.reason };
    }

    return { success: true, identity };
  }

  /**
   * Log a security event
   */
  logSecurityEvent(
    actorId: string,
    actorType: "USER" | "DEVICE" | "AGENT" | "GATEWAY" | "SYSTEM",
    action: string,
    resource: string,
    details: Record<string, unknown> = {},
    ipAddress?: string
  ): void {
    this.audit.log({
      actorId,
      actorType,
      action,
      resource,
      details,
      ipAddress,
    });
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

let securityServiceInstance: SecurityService | null = null;

export function getSecurityService(): SecurityService {
  if (!securityServiceInstance) {
    const auditKey = process.env.AUDIT_SIGNING_KEY || "development-audit-key";
    securityServiceInstance = new SecurityService(auditKey);
  }
  return securityServiceInstance;
}

export function initSecurityService(auditSigningKey: string): SecurityService {
  securityServiceInstance = new SecurityService(auditSigningKey);
  return securityServiceInstance;
}
