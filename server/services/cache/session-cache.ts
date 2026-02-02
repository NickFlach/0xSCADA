/**
 * Session Cache - User session and permission caching
 * 
 * Caches user session data and permissions for fast
 * authentication and authorization checks.
 */

import { cacheService, CACHE_KEYS, TTL } from './cache-service.js';

export interface UserSession {
  userId: string;
  username: string;
  email?: string;
  roles: string[];
  permissions: string[];
  sites: string[]; // Accessible site IDs
  loginAt: Date;
  expiresAt: Date;
  metadata?: Record<string, unknown>;
}

export interface UserPermissions {
  userId: string;
  permissions: Set<string>;
  roles: Set<string>;
  siteAccess: Map<string, string[]>; // siteId -> permitted actions
}

/**
 * Session cache with permission checking
 */
class SessionCache {
  /**
   * Store user session
   */
  async setSession(sessionId: string, session: UserSession): Promise<boolean> {
    const key = this.buildSessionKey(sessionId);

    // Also store user lookup
    await this.setUserSessionMapping(session.userId, sessionId);

    return cacheService.set(key, session, {
      ttl: TTL.USER_SESSION,
      tags: [`user:${session.userId}`, 'sessions'],
    });
  }

  /**
   * Get user session
   */
  async getSession(sessionId: string): Promise<UserSession | null> {
    const key = this.buildSessionKey(sessionId);
    const session = await cacheService.get<UserSession>(key);

    if (session && new Date(session.expiresAt) < new Date()) {
      // Session expired, remove it
      await this.deleteSession(sessionId);
      return null;
    }

    return session;
  }

  /**
   * Delete user session
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (session) {
      await this.removeUserSessionMapping(session.userId, sessionId);
    }

    const key = this.buildSessionKey(sessionId);
    return cacheService.delete(key);
  }

  /**
   * Get all sessions for a user
   */
  async getUserSessions(userId: string): Promise<string[]> {
    const key = `${CACHE_KEYS.USER}${userId}:sessions`;
    const sessions = await cacheService.get<string[]>(key);
    return sessions || [];
  }

  /**
   * Invalidate all sessions for a user
   */
  async invalidateUserSessions(userId: string): Promise<number> {
    const sessions = await this.getUserSessions(userId);

    const promises = sessions.map((sessionId) => this.deleteSession(sessionId));
    await Promise.all(promises);

    // Clear the mapping
    const key = `${CACHE_KEYS.USER}${userId}:sessions`;
    await cacheService.delete(key);

    return sessions.length;
  }

  /**
   * Extend session TTL
   */
  async touchSession(sessionId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) return false;

    // Extend expiry
    session.expiresAt = new Date(Date.now() + TTL.USER_SESSION * 1000);

    return this.setSession(sessionId, session);
  }

  /**
   * Check if user has permission
   */
  async hasPermission(sessionId: string, permission: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) return false;

    return session.permissions.includes(permission);
  }

  /**
   * Check if user has role
   */
  async hasRole(sessionId: string, role: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) return false;

    return session.roles.includes(role);
  }

  /**
   * Check if user can access site
   */
  async canAccessSite(sessionId: string, siteId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) return false;

    return session.sites.includes(siteId) || session.sites.includes('*');
  }

  /**
   * Get user's accessible sites
   */
  async getAccessibleSites(sessionId: string): Promise<string[]> {
    const session = await this.getSession(sessionId);
    return session?.sites || [];
  }

  /**
   * Store permission set for fast lookup
   */
  async setPermissions(userId: string, permissions: UserPermissions): Promise<boolean> {
    const key = `${CACHE_KEYS.USER}${userId}:permissions`;

    // Convert Sets and Maps to serializable format
    const serializable = {
      userId: permissions.userId,
      permissions: Array.from(permissions.permissions),
      roles: Array.from(permissions.roles),
      siteAccess: Object.fromEntries(permissions.siteAccess),
    };

    return cacheService.set(key, serializable, {
      ttl: TTL.USER_SESSION,
      tags: [`user:${userId}`],
    });
  }

  /**
   * Get permission set
   */
  async getPermissions(userId: string): Promise<UserPermissions | null> {
    const key = `${CACHE_KEYS.USER}${userId}:permissions`;
    const data = await cacheService.get<{
      userId: string;
      permissions: string[];
      roles: string[];
      siteAccess: Record<string, string[]>;
    }>(key);

    if (!data) return null;

    return {
      userId: data.userId,
      permissions: new Set(data.permissions),
      roles: new Set(data.roles),
      siteAccess: new Map(Object.entries(data.siteAccess)),
    };
  }

  /**
   * Map user to session ID
   */
  private async setUserSessionMapping(
    userId: string,
    sessionId: string
  ): Promise<void> {
    const key = `${CACHE_KEYS.USER}${userId}:sessions`;
    const sessions = await this.getUserSessions(userId);

    if (!sessions.includes(sessionId)) {
      sessions.push(sessionId);
      await cacheService.set(key, sessions, {
        ttl: TTL.USER_SESSION * 2, // Slightly longer than session TTL
        tags: [`user:${userId}`],
      });
    }
  }

  /**
   * Remove session from user mapping
   */
  private async removeUserSessionMapping(
    userId: string,
    sessionId: string
  ): Promise<void> {
    const key = `${CACHE_KEYS.USER}${userId}:sessions`;
    const sessions = await this.getUserSessions(userId);

    const filtered = sessions.filter((s) => s !== sessionId);
    if (filtered.length > 0) {
      await cacheService.set(key, filtered, {
        ttl: TTL.USER_SESSION * 2,
        tags: [`user:${userId}`],
      });
    } else {
      await cacheService.delete(key);
    }
  }

  /**
   * Build session cache key
   */
  private buildSessionKey(sessionId: string): string {
    return `${CACHE_KEYS.SESSION}${sessionId}`;
  }
}

export const sessionCache = new SessionCache();
export default sessionCache;
