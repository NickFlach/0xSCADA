/**
 * Migration 001: Create RBAC tables
 */
import { MigrationFn } from '../migration-runner';

export const up: MigrationFn = async (db) => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS roles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) NOT NULL UNIQUE,
      description TEXT,
      is_system BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS permissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      resource VARCHAR(100) NOT NULL,
      action VARCHAR(50) NOT NULL,
      description TEXT,
      UNIQUE(resource, action)
    );

    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
      permission_id UUID REFERENCES permissions(id) ON DELETE CASCADE,
      PRIMARY KEY (role_id, permission_id)
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      user_id UUID NOT NULL,
      role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
      assigned_by UUID,
      assigned_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, role_id)
    );

    -- Seed default roles
    INSERT INTO roles (name, description, is_system) VALUES
      ('admin', 'Full system access', TRUE),
      ('operator', 'Plant operator - read/write process data', TRUE),
      ('viewer', 'Read-only access to dashboards and data', TRUE),
      ('engineer', 'Configuration and recipe management', TRUE)
    ON CONFLICT (name) DO NOTHING;

    -- Seed default permissions
    INSERT INTO permissions (resource, action) VALUES
      ('tags', 'read'), ('tags', 'write'), ('tags', 'configure'),
      ('alarms', 'read'), ('alarms', 'acknowledge'), ('alarms', 'configure'),
      ('recipes', 'read'), ('recipes', 'execute'), ('recipes', 'configure'),
      ('users', 'read'), ('users', 'manage'),
      ('system', 'configure'), ('system', 'audit')
    ON CONFLICT (resource, action) DO NOTHING;
  `);
};

export const down: MigrationFn = async (db) => {
  await db.query(`
    DROP TABLE IF EXISTS user_roles CASCADE;
    DROP TABLE IF EXISTS role_permissions CASCADE;
    DROP TABLE IF EXISTS permissions CASCADE;
    DROP TABLE IF EXISTS roles CASCADE;
  `);
};
