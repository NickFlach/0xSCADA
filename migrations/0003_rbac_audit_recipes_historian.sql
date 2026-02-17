-- 0xSCADA ADR-0012 Wave 1 Migration
-- RBAC roles/permissions, audit logs, recipes, alarm management, historian
-- Version: 3.0.0

-- =============================================================================
-- RBAC ROLES & PERMISSIONS
-- =============================================================================

CREATE TABLE IF NOT EXISTS roles (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_roles (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR NOT NULL REFERENCES users(id),
  role_id VARCHAR NOT NULL REFERENCES roles(id),
  site_id VARCHAR REFERENCES sites(id),
  granted_by VARCHAR REFERENCES users(id),
  granted_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role_id ON user_roles(role_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_site_id ON user_roles(site_id);

-- Seed default system roles
INSERT INTO roles (name, description, priority, permissions, system) VALUES
  ('ADMIN', 'Full system administrator', 1, '["*"]'::jsonb, true),
  ('ENGINEER', 'Process engineer with config access', 10, '["sites:read","assets:*","events:*","blueprints:*","recipes:*","alarms:*","historian:read"]'::jsonb, true),
  ('OPERATOR', 'Plant operator', 20, '["sites:read","assets:read","events:read","events:create","alarms:acknowledge","historian:read"]'::jsonb, true),
  ('VIEWER', 'Read-only dashboard viewer', 50, '["sites:read","assets:read","events:read","alarms:read","historian:read"]'::jsonb, true),
  ('AUDITOR', 'Audit and compliance reviewer', 30, '["sites:read","assets:read","events:read","audit:read","historian:read"]'::jsonb, true)
ON CONFLICT (name) DO NOTHING;

-- =============================================================================
-- AUDIT LOGS
-- =============================================================================

CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'user',
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  before JSONB,
  after JSONB,
  metadata JSONB DEFAULT '{}'::jsonb,
  ip_address TEXT,
  user_agent TEXT,
  request_id TEXT,
  site_id VARCHAR REFERENCES sites(id),
  timestamp TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_site ON audit_logs(site_id);

-- =============================================================================
-- RECIPES (ISA-88 Batch)
-- =============================================================================

CREATE TABLE IF NOT EXISTS recipes (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  recipe_type TEXT NOT NULL DEFAULT 'master',
  unit_type_id VARCHAR REFERENCES unit_types(id),
  site_id VARCHAR REFERENCES sites(id),
  procedure JSONB NOT NULL DEFAULT '{}'::jsonb,
  parameters JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft',
  approved_by VARCHAR REFERENCES users(id),
  approved_at TIMESTAMP,
  content_hash TEXT,
  tx_hash TEXT,
  created_by VARCHAR REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recipes_status ON recipes(status);
CREATE INDEX IF NOT EXISTS idx_recipes_site ON recipes(site_id);

CREATE TABLE IF NOT EXISTS recipe_batches (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id VARCHAR NOT NULL REFERENCES recipes(id),
  batch_number TEXT NOT NULL,
  unit_instance_id VARCHAR REFERENCES unit_instances(id),
  parameter_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  state TEXT NOT NULL DEFAULT 'idle',
  current_phase TEXT,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  started_by VARCHAR REFERENCES users(id),
  site_id VARCHAR REFERENCES sites(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recipe_batches_state ON recipe_batches(state);
CREATE INDEX IF NOT EXISTS idx_recipe_batches_recipe ON recipe_batches(recipe_id);

-- =============================================================================
-- ALARM MANAGEMENT (ISA-18.2)
-- =============================================================================

CREATE TABLE IF NOT EXISTS alarm_definitions (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tag TEXT NOT NULL,
  asset_id VARCHAR REFERENCES assets(id),
  site_id VARCHAR REFERENCES sites(id),
  priority INTEGER NOT NULL DEFAULT 3,
  alarm_class TEXT NOT NULL DEFAULT 'process',
  description TEXT,
  condition TEXT NOT NULL,
  setpoint_high TEXT,
  setpoint_low TEXT,
  deadband TEXT,
  on_delay_ms INTEGER DEFAULT 0,
  off_delay_ms INTEGER DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT true,
  shelved_until TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alarm_defs_tag ON alarm_definitions(tag);
CREATE INDEX IF NOT EXISTS idx_alarm_defs_site ON alarm_definitions(site_id);
CREATE INDEX IF NOT EXISTS idx_alarm_defs_priority ON alarm_definitions(priority);

CREATE TABLE IF NOT EXISTS alarm_events (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  alarm_definition_id VARCHAR NOT NULL REFERENCES alarm_definitions(id),
  state TEXT NOT NULL DEFAULT 'active_unack',
  value TEXT,
  message TEXT,
  activated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMP,
  acknowledged_by VARCHAR REFERENCES users(id),
  cleared_at TIMESTAMP,
  returned_to_normal_at TIMESTAMP,
  site_id VARCHAR REFERENCES sites(id)
);

CREATE INDEX IF NOT EXISTS idx_alarm_events_state ON alarm_events(state);
CREATE INDEX IF NOT EXISTS idx_alarm_events_activated ON alarm_events(activated_at DESC);
CREATE INDEX IF NOT EXISTS idx_alarm_events_def ON alarm_events(alarm_definition_id);

-- =============================================================================
-- HISTORIAN DATA
-- =============================================================================

CREATE TABLE IF NOT EXISTS historian_tags (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tag TEXT NOT NULL UNIQUE,
  description TEXT,
  asset_id VARCHAR REFERENCES assets(id),
  site_id VARCHAR REFERENCES sites(id),
  data_type TEXT NOT NULL DEFAULT 'float',
  eng_units TEXT,
  compression_deviation TEXT,
  compression_timeout INTEGER,
  scan_rate_ms INTEGER DEFAULT 1000,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_historian_tags_tag ON historian_tags(tag);
CREATE INDEX IF NOT EXISTS idx_historian_tags_site ON historian_tags(site_id);

CREATE TABLE IF NOT EXISTS historian_data (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tag_id VARCHAR NOT NULL REFERENCES historian_tags(id),
  value TEXT NOT NULL,
  quality INTEGER NOT NULL DEFAULT 192,
  timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
  batch_id VARCHAR REFERENCES event_batches(id)
);

CREATE INDEX IF NOT EXISTS idx_historian_data_tag_time ON historian_data(tag_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_historian_data_batch ON historian_data(batch_id);
