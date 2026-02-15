/**
 * Role-Based Access Control (RBAC) Types
 *
 * Defines roles, permissions, and access control types for 0xSCADA.
 * Implements issue #36.
 */

/** System roles with hierarchical trust levels */
export enum Role {
  OPERATOR = 'operator',
  ENGINEER = 'engineer',
  ADMIN = 'admin',
  AUDITOR = 'auditor',
}

/** Granular permissions for system resources */
export enum Permission {
  // Tag operations
  TAG_READ = 'tag:read',
  TAG_WRITE = 'tag:write',
  TAG_CONFIGURE = 'tag:configure',

  // Alarm operations
  ALARM_VIEW = 'alarm:view',
  ALARM_ACKNOWLEDGE = 'alarm:acknowledge',
  ALARM_CONFIGURE = 'alarm:configure',

  // Recipe operations
  RECIPE_VIEW = 'recipe:view',
  RECIPE_EXECUTE = 'recipe:execute',
  RECIPE_EDIT = 'recipe:edit',
  RECIPE_APPROVE = 'recipe:approve',

  // Configuration
  CONFIG_VIEW = 'config:view',
  CONFIG_EDIT = 'config:edit',

  // User management
  USER_VIEW = 'user:view',
  USER_MANAGE = 'user:manage',

  // Audit
  AUDIT_VIEW = 'audit:view',
  AUDIT_EXPORT = 'audit:export',

  // System
  SYSTEM_STATUS = 'system:status',
  SYSTEM_ADMIN = 'system:admin',

  // Gateway
  GATEWAY_VIEW = 'gateway:view',
  GATEWAY_CONFIGURE = 'gateway:configure',
}

/** Permission matrix mapping roles to their allowed permissions */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  [Role.OPERATOR]: [
    Permission.TAG_READ,
    Permission.TAG_WRITE,
    Permission.ALARM_VIEW,
    Permission.ALARM_ACKNOWLEDGE,
    Permission.RECIPE_VIEW,
    Permission.RECIPE_EXECUTE,
    Permission.CONFIG_VIEW,
    Permission.SYSTEM_STATUS,
    Permission.GATEWAY_VIEW,
  ],
  [Role.ENGINEER]: [
    Permission.TAG_READ,
    Permission.TAG_WRITE,
    Permission.TAG_CONFIGURE,
    Permission.ALARM_VIEW,
    Permission.ALARM_ACKNOWLEDGE,
    Permission.ALARM_CONFIGURE,
    Permission.RECIPE_VIEW,
    Permission.RECIPE_EXECUTE,
    Permission.RECIPE_EDIT,
    Permission.CONFIG_VIEW,
    Permission.CONFIG_EDIT,
    Permission.SYSTEM_STATUS,
    Permission.GATEWAY_VIEW,
    Permission.GATEWAY_CONFIGURE,
  ],
  [Role.ADMIN]: [
    // Admin has all permissions
    ...Object.values(Permission),
  ],
  [Role.AUDITOR]: [
    Permission.TAG_READ,
    Permission.ALARM_VIEW,
    Permission.RECIPE_VIEW,
    Permission.CONFIG_VIEW,
    Permission.USER_VIEW,
    Permission.AUDIT_VIEW,
    Permission.AUDIT_EXPORT,
    Permission.SYSTEM_STATUS,
    Permission.GATEWAY_VIEW,
  ],
};

/** User with RBAC information */
export interface RBACUser {
  id: string;
  username: string;
  roles: Role[];
  /** Whether 2FA is enabled */
  twoFactorEnabled: boolean;
  /** Whether the current session has verified 2FA */
  twoFactorVerified?: boolean;
}

/** Access check result */
export interface AccessCheckResult {
  allowed: boolean;
  reason?: string;
  requiredPermissions?: Permission[];
  userPermissions?: Permission[];
}

/** Route protection configuration */
export interface ProtectedRoute {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  permissions: Permission[];
  /** Require all permissions (AND) vs any permission (OR). Default: all */
  requireAll?: boolean;
  /** Require 2FA verification for this route */
  require2FA?: boolean;
}
