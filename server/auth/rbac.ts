/**
 * Role-Based Access Control (RBAC) Service
 *
 * Implements route protection middleware, permission checking, and role management.
 * Issues: #36
 */

import {
  Role,
  Permission,
  ROLE_PERMISSIONS,
  RBACUser,
  AccessCheckResult,
  ProtectedRoute,
} from '../../shared/types/rbac';

/**
 * Get all permissions for a set of roles (union of all role permissions).
 */
export function getPermissionsForRoles(roles: Role[]): Permission[] {
  const permSet = new Set<Permission>();
  for (const role of roles) {
    const perms = ROLE_PERMISSIONS[role];
    if (perms) {
      for (const p of perms) permSet.add(p);
    }
  }
  return Array.from(permSet);
}

/**
 * Check if a user has the required permissions.
 */
export function checkAccess(
  user: RBACUser,
  requiredPermissions: Permission[],
  requireAll = true
): AccessCheckResult {
  const userPermissions = getPermissionsForRoles(user.roles);

  if (requiredPermissions.length === 0) {
    return { allowed: true };
  }

  const allowed = requireAll
    ? requiredPermissions.every((p) => userPermissions.includes(p))
    : requiredPermissions.some((p) => userPermissions.includes(p));

  return {
    allowed,
    reason: allowed ? undefined : 'Insufficient permissions',
    requiredPermissions,
    userPermissions,
  };
}

/**
 * Check if a user has a specific role.
 */
export function hasRole(user: RBACUser, role: Role): boolean {
  return user.roles.includes(role);
}

/**
 * Check if a user has a specific permission.
 */
export function hasPermission(user: RBACUser, permission: Permission): boolean {
  return getPermissionsForRoles(user.roles).includes(permission);
}

/**
 * Express-style middleware factory for route protection.
 *
 * Usage:
 *   app.get('/api/tags', requirePermissions([Permission.TAG_READ]), handler);
 *   app.post('/api/recipes', requirePermissions([Permission.RECIPE_EDIT], { require2FA: true }), handler);
 */
export function requirePermissions(
  permissions: Permission[],
  options: { requireAll?: boolean; require2FA?: boolean } = {}
) {
  const { requireAll = true, require2FA = false } = options;

  return (req: any, res: any, next: any) => {
    const user: RBACUser | undefined = req.user;

    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (require2FA && user.twoFactorEnabled && !user.twoFactorVerified) {
      return res.status(403).json({ error: '2FA verification required' });
    }

    const result = checkAccess(user, permissions, requireAll);

    if (!result.allowed) {
      return res.status(403).json({
        error: 'Access denied',
        reason: result.reason,
        required: result.requiredPermissions,
      });
    }

    next();
  };
}

/**
 * Express-style middleware factory for role-based protection.
 */
export function requireRole(...roles: Role[]) {
  return (req: any, res: any, next: any) => {
    const user: RBACUser | undefined = req.user;

    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const hasRequiredRole = roles.some((role) => user.roles.includes(role));

    if (!hasRequiredRole) {
      return res.status(403).json({
        error: 'Access denied',
        reason: `Requires one of: ${roles.join(', ')}`,
      });
    }

    next();
  };
}

/**
 * Register protected routes and return a validation function.
 */
export function createRouteProtector(routes: ProtectedRoute[]) {
  const routeMap = new Map<string, ProtectedRoute>();

  for (const route of routes) {
    routeMap.set(`${route.method}:${route.path}`, route);
  }

  return {
    getRouteConfig(method: string, path: string): ProtectedRoute | undefined {
      return routeMap.get(`${method}:${path}`);
    },

    /**
     * Middleware that checks all registered routes.
     */
    middleware() {
      return (req: any, res: any, next: any) => {
        const config = routeMap.get(`${req.method}:${req.path}`);
        if (!config) {
          return next(); // Unprotected route
        }

        const handler = requirePermissions(config.permissions, {
          requireAll: config.requireAll,
          require2FA: config.require2FA,
        });

        return handler(req, res, next);
      };
    },
  };
}
