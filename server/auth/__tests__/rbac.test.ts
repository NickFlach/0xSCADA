import { checkAccess, hasPermission, hasRole, getPermissionsForRoles, requirePermissions, requireRole } from '../rbac';
import { Role, Permission, RBACUser } from '../../../shared/types/rbac';

describe('RBAC', () => {
  const operator: RBACUser = { id: '1', username: 'op1', roles: [Role.OPERATOR], twoFactorEnabled: false };
  const admin: RBACUser = { id: '2', username: 'admin1', roles: [Role.ADMIN], twoFactorEnabled: true, twoFactorVerified: true };
  const auditor: RBACUser = { id: '3', username: 'aud1', roles: [Role.AUDITOR], twoFactorEnabled: false };

  it('should grant operator tag read/write', () => {
    expect(hasPermission(operator, Permission.TAG_READ)).toBe(true);
    expect(hasPermission(operator, Permission.TAG_WRITE)).toBe(true);
  });

  it('should deny operator user management', () => {
    expect(hasPermission(operator, Permission.USER_MANAGE)).toBe(false);
  });

  it('should grant admin all permissions', () => {
    expect(hasPermission(admin, Permission.USER_MANAGE)).toBe(true);
    expect(hasPermission(admin, Permission.SYSTEM_ADMIN)).toBe(true);
  });

  it('should grant auditor read-only access', () => {
    expect(hasPermission(auditor, Permission.AUDIT_VIEW)).toBe(true);
    expect(hasPermission(auditor, Permission.AUDIT_EXPORT)).toBe(true);
    expect(hasPermission(auditor, Permission.TAG_WRITE)).toBe(false);
  });

  it('should check access with requireAll=true', () => {
    const result = checkAccess(operator, [Permission.TAG_READ, Permission.USER_MANAGE], true);
    expect(result.allowed).toBe(false);
  });

  it('should check access with requireAll=false', () => {
    const result = checkAccess(operator, [Permission.TAG_READ, Permission.USER_MANAGE], false);
    expect(result.allowed).toBe(true);
  });

  it('should check role membership', () => {
    expect(hasRole(admin, Role.ADMIN)).toBe(true);
    expect(hasRole(operator, Role.ADMIN)).toBe(false);
  });

  describe('middleware', () => {
    const mockRes = () => {
      const res: any = {};
      res.status = jest.fn().mockReturnValue(res);
      res.json = jest.fn().mockReturnValue(res);
      return res;
    };

    it('should reject unauthenticated requests', () => {
      const middleware = requirePermissions([Permission.TAG_READ]);
      const req = {} as any;
      const res = mockRes();
      const next = jest.fn();
      middleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('should allow authorized requests', () => {
      const middleware = requirePermissions([Permission.TAG_READ]);
      const req = { user: operator } as any;
      const res = mockRes();
      const next = jest.fn();
      middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('should reject unauthorized requests', () => {
      const middleware = requirePermissions([Permission.SYSTEM_ADMIN]);
      const req = { user: operator } as any;
      const res = mockRes();
      const next = jest.fn();
      middleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });
});
