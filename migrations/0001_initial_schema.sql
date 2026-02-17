-- Migration: 0001_initial_schema
-- Issue: #205 - Database Migrations & Schema (ADR-0012 Wave 1)
-- Description: Create all core tables for 0xSCADA platform
-- Date: 2026-02-17

-- ─── Enums ───────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE site_status AS ENUM ('ONLINE', 'OFFLINE', 'MAINTENANCE');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE asset_status AS ENUM ('OK', 'WARNING', 'CRITICAL');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE asset_type AS ENUM ('TRANSFORMER', 'BREAKER', 'MCC', 'FEEDER', 'INVERTER', 'PLC', 'SENSOR', 'PUMP', 'VALVE');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE alarm_severity AS ENUM ('INFO', 'WARNING', 'CRITICAL', 'EMERGENCY');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE alarm_state AS ENUM ('ACTIVE', 'ACKNOWLEDGED', 'CLEARED', 'SHELVED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE cert_status AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'MINTED', 'EXPIRED', 'SUPERSEDED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE cert_type AS ENUM ('MACHINE_STATE', 'SAFETY_CONDITION', 'AGENT_CAPABILITY', 'COMPLIANCE_SNAPSHOT', 'CALIBRATION_RECORD');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE audit_action AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'ACKNOWLEDGE', 'OVERRIDE', 'EXECUTE', 'APPROVE', 'REJECT');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ─── Sites ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sites (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  location VARCHAR(255),
  owner VARCHAR(255),
  status site_status NOT NULL DEFAULT 'ONLINE',
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Assets ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS assets (
  id VARCHAR(64) PRIMARY KEY,
  site_id VARCHAR(64) NOT NULL REFERENCES sites(id),
  asset_type asset_type NOT NULL,
  name_or_tag VARCHAR(255) NOT NULL,
  critical BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB,
  status asset_status NOT NULL DEFAULT 'OK',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_assets_site_id ON assets(site_id);

-- ─── RBAC: Roles ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_name ON roles(name);

-- ─── RBAC: Permissions ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource VARCHAR(100) NOT NULL,
  action VARCHAR(100) NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_permissions_resource_action ON permissions(resource, action);

-- ─── RBAC: Role-Permission mapping ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (role_id, permission_id)
);

-- ─── Users ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(100) NOT NULL,
  email VARCHAR(255),
  password_hash VARCHAR(255),
  wallet_address VARCHAR(255),
  display_name VARCHAR(255),
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ─── RBAC: User-Role mapping ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_roles (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  site_id VARCHAR(64) REFERENCES sites(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, role_id)
);

-- ─── Audit Logs ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  action audit_action NOT NULL,
  resource VARCHAR(100) NOT NULL,
  resource_id VARCHAR(255),
  details JSONB,
  ip_address VARCHAR(45),
  user_agent TEXT,
  site_id VARCHAR(64) REFERENCES sites(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);

-- ─── Recipes ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  site_id VARCHAR(64) REFERENCES sites(id),
  asset_id VARCHAR(64) REFERENCES assets(id),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recipes_site_id ON recipes(site_id);

-- ─── Recipe Versions ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS recipe_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  parameters JSONB NOT NULL,
  setpoints JSONB,
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  comment TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_recipe_versions_recipe_version ON recipe_versions(recipe_id, version);

-- ─── Alarms ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS alarms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  site_id VARCHAR(64) REFERENCES sites(id),
  asset_id VARCHAR(64) REFERENCES assets(id),
  tag_id VARCHAR(255),
  severity alarm_severity NOT NULL,
  condition JSONB NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  deadband REAL,
  delay_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alarms_site_id ON alarms(site_id);
CREATE INDEX IF NOT EXISTS idx_alarms_asset_id ON alarms(asset_id);

-- ─── Alarm History ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS alarm_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alarm_id UUID NOT NULL REFERENCES alarms(id),
  state alarm_state NOT NULL,
  trigger_value REAL,
  message TEXT,
  acknowledged_by UUID REFERENCES users(id),
  acknowledged_at TIMESTAMPTZ,
  cleared_at TIMESTAMPTZ,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alarm_history_alarm_id ON alarm_history(alarm_id);
CREATE INDEX IF NOT EXISTS idx_alarm_history_state ON alarm_history(state);
CREATE INDEX IF NOT EXISTS idx_alarm_history_created_at ON alarm_history(created_at);

-- ─── Historian Data ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS historian_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tag_id VARCHAR(255) NOT NULL,
  site_id VARCHAR(64) REFERENCES sites(id),
  value REAL,
  string_value TEXT,
  quality INTEGER DEFAULT 192,
  timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_historian_tag_timestamp ON historian_data(tag_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_historian_site_timestamp ON historian_data(site_id, timestamp);

-- ─── Event Anchors ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_anchors (
  id VARCHAR(64) PRIMARY KEY,
  asset_id VARCHAR(64) REFERENCES assets(id),
  event_type VARCHAR(100) NOT NULL,
  payload_hash VARCHAR(255) NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  recorded_by VARCHAR(255),
  tx_hash VARCHAR(255),
  block_number INTEGER,
  details TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_anchors_asset_id ON event_anchors(asset_id);
CREATE INDEX IF NOT EXISTS idx_event_anchors_timestamp ON event_anchors(timestamp);
CREATE INDEX IF NOT EXISTS idx_event_anchors_tx_hash ON event_anchors(tx_hash);

-- ─── Maintenance Records ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS maintenance_records (
  id VARCHAR(64) PRIMARY KEY,
  asset_id VARCHAR(64) NOT NULL REFERENCES assets(id),
  work_order_id VARCHAR(100),
  performed_by VARCHAR(255),
  maintenance_type VARCHAR(100) NOT NULL,
  performed_at TIMESTAMPTZ NOT NULL,
  next_due_at TIMESTAMPTZ,
  notes TEXT,
  attachment_hash VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_maintenance_asset_id ON maintenance_records(asset_id);

-- ─── Certifications ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS certifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cert_type cert_type NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  artifact_hash VARCHAR(255) NOT NULL,
  artifact_uri TEXT,
  valid_from TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  site_id VARCHAR(64) REFERENCES sites(id),
  asset_id VARCHAR(64) REFERENCES assets(id),
  metadata JSONB,
  status cert_status NOT NULL DEFAULT 'DRAFT',
  required_approvals INTEGER NOT NULL DEFAULT 1,
  current_approvals INTEGER NOT NULL DEFAULT 0,
  requested_by VARCHAR(255) NOT NULL,
  supersedes UUID,
  superseded_by UUID,
  token_id VARCHAR(255),
  tx_hash VARCHAR(255),
  minted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_certifications_site_id ON certifications(site_id);
CREATE INDEX IF NOT EXISTS idx_certifications_status ON certifications(status);

-- ─── Certification Approvals ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS certification_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  certification_id UUID NOT NULL REFERENCES certifications(id) ON DELETE CASCADE,
  approver_id VARCHAR(255) NOT NULL,
  approver_role VARCHAR(100),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  comment TEXT,
  decided_at TIMESTAMPTZ,
  signature TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cert_approvals_cert_id ON certification_approvals(certification_id);
