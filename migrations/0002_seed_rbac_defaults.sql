-- Migration: 0002_seed_rbac_defaults
-- Issue: #205 - Database Migrations & Schema (ADR-0012 Wave 1)
-- Description: Seed default RBAC roles and permissions
-- Date: 2026-02-17

-- ─── Default Roles ───────────────────────────────────────────────────────────

INSERT INTO roles (name, description, is_system) VALUES
  ('admin',    'Full system administrator',                    true),
  ('operator', 'Plant operator — can acknowledge alarms, execute recipes', true),
  ('engineer', 'Process engineer — can configure alarms, edit recipes',    true),
  ('viewer',   'Read-only dashboard access',                   true),
  ('auditor',  'Read-only access including audit logs',        true)
ON CONFLICT (name) DO NOTHING;

-- ─── Default Permissions ─────────────────────────────────────────────────────

INSERT INTO permissions (resource, action, description) VALUES
  -- Sites
  ('sites', 'read',   'View sites'),
  ('sites', 'create', 'Create sites'),
  ('sites', 'update', 'Update sites'),
  ('sites', 'delete', 'Delete sites'),
  -- Assets
  ('assets', 'read',   'View assets'),
  ('assets', 'create', 'Create assets'),
  ('assets', 'update', 'Update assets'),
  ('assets', 'delete', 'Delete assets'),
  -- Alarms
  ('alarms', 'read',        'View alarms'),
  ('alarms', 'create',      'Create alarm definitions'),
  ('alarms', 'update',      'Update alarm definitions'),
  ('alarms', 'delete',      'Delete alarm definitions'),
  ('alarms', 'acknowledge', 'Acknowledge active alarms'),
  -- Recipes
  ('recipes', 'read',    'View recipes'),
  ('recipes', 'create',  'Create recipes'),
  ('recipes', 'update',  'Update recipes'),
  ('recipes', 'delete',  'Delete recipes'),
  ('recipes', 'execute', 'Execute/apply recipes'),
  ('recipes', 'approve', 'Approve recipe versions'),
  -- Historian
  ('historian', 'read',  'Query historian data'),
  ('historian', 'write', 'Write historian data'),
  -- Audit
  ('audit_logs', 'read', 'View audit logs'),
  -- Users & RBAC
  ('users', 'read',   'View users'),
  ('users', 'create', 'Create users'),
  ('users', 'update', 'Update users'),
  ('users', 'delete', 'Delete users'),
  ('roles', 'read',   'View roles'),
  ('roles', 'manage', 'Create/update/delete roles and assign permissions'),
  -- Certifications
  ('certifications', 'read',    'View certifications'),
  ('certifications', 'create',  'Create certification requests'),
  ('certifications', 'approve', 'Approve certifications'),
  -- Events
  ('events', 'read',  'View event anchors'),
  ('events', 'write', 'Create event anchors'),
  -- Maintenance
  ('maintenance', 'read',   'View maintenance records'),
  ('maintenance', 'create', 'Create maintenance records'),
  ('maintenance', 'update', 'Update maintenance records')
ON CONFLICT (resource, action) DO NOTHING;

-- ─── Admin gets all permissions ──────────────────────────────────────────────

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;

-- ─── Operator permissions ────────────────────────────────────────────────────

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'operator'
  AND (p.resource, p.action) IN (
    ('sites', 'read'), ('assets', 'read'),
    ('alarms', 'read'), ('alarms', 'acknowledge'),
    ('recipes', 'read'), ('recipes', 'execute'),
    ('historian', 'read'),
    ('events', 'read'),
    ('maintenance', 'read'), ('maintenance', 'create'),
    ('certifications', 'read')
  )
ON CONFLICT DO NOTHING;

-- ─── Engineer permissions ────────────────────────────────────────────────────

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'engineer'
  AND (p.resource, p.action) IN (
    ('sites', 'read'), ('assets', 'read'), ('assets', 'create'), ('assets', 'update'),
    ('alarms', 'read'), ('alarms', 'create'), ('alarms', 'update'), ('alarms', 'delete'),
    ('recipes', 'read'), ('recipes', 'create'), ('recipes', 'update'), ('recipes', 'approve'),
    ('historian', 'read'), ('historian', 'write'),
    ('events', 'read'), ('events', 'write'),
    ('maintenance', 'read'), ('maintenance', 'create'), ('maintenance', 'update'),
    ('certifications', 'read'), ('certifications', 'create')
  )
ON CONFLICT DO NOTHING;

-- ─── Viewer permissions ──────────────────────────────────────────────────────

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'viewer'
  AND p.action = 'read'
  AND p.resource NOT IN ('audit_logs', 'users', 'roles')
ON CONFLICT DO NOTHING;

-- ─── Auditor permissions ─────────────────────────────────────────────────────

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'auditor'
  AND p.action = 'read'
ON CONFLICT DO NOTHING;
