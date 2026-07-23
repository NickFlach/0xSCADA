-- Migration: 0003_blueprint_persistence
-- Issue: #511 - Restore blueprint schema, CRUD, imports, and seeding

CREATE TABLE IF NOT EXISTS vendors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  description TEXT,
  platforms JSONB NOT NULL DEFAULT '[]'::jsonb,
  languages JSONB NOT NULL DEFAULT '[]'::jsonb,
  config_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS template_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  vendor_id UUID NOT NULL REFERENCES vendors(id),
  version VARCHAR(50) NOT NULL DEFAULT '1.0.0',
  description TEXT,
  template_type VARCHAR(100) NOT NULL,
  language VARCHAR(50) NOT NULL,
  template_content TEXT NOT NULL,
  placeholders JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_inputs JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS control_module_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  vendor_id UUID REFERENCES vendors(id),
  version VARCHAR(50) NOT NULL DEFAULT '1.0.0',
  description TEXT,
  inputs JSONB NOT NULL DEFAULT '[]'::jsonb,
  outputs JSONB NOT NULL DEFAULT '[]'::jsonb,
  in_outs JSONB NOT NULL DEFAULT '[]'::jsonb,
  data_type_mappings JSONB NOT NULL DEFAULT '{}'::jsonb,
  template_package_id UUID REFERENCES template_packages(id),
  source_package TEXT,
  classification VARCHAR(100) DEFAULT 'control_module',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS unit_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  vendor_id UUID REFERENCES vendors(id),
  version VARCHAR(50) NOT NULL DEFAULT '1.0.0',
  description TEXT,
  variables JSONB NOT NULL DEFAULT '[]'::jsonb,
  equipment_modules JSONB NOT NULL DEFAULT '[]'::jsonb,
  template_package_id UUID REFERENCES template_packages(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS phase_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  vendor_id UUID REFERENCES vendors(id),
  version VARCHAR(50) NOT NULL DEFAULT '1.0.0',
  description TEXT,
  linked_modules JSONB NOT NULL DEFAULT '[]'::jsonb,
  inputs JSONB NOT NULL DEFAULT '[]'::jsonb,
  outputs JSONB NOT NULL DEFAULT '[]'::jsonb,
  in_outs JSONB NOT NULL DEFAULT '[]'::jsonb,
  internal_values JSONB NOT NULL DEFAULT '[]'::jsonb,
  hmi_parameters JSONB NOT NULL DEFAULT '[]'::jsonb,
  recipe_parameters JSONB NOT NULL DEFAULT '[]'::jsonb,
  report_parameters JSONB NOT NULL DEFAULT '[]'::jsonb,
  sequences JSONB NOT NULL DEFAULT '{}'::jsonb,
  template_package_id UUID REFERENCES template_packages(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS unit_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  instance_number INTEGER,
  unit_type_id UUID NOT NULL REFERENCES unit_types(id),
  controller_id VARCHAR(255),
  pid_drawing TEXT,
  process_cell TEXT,
  area TEXT,
  comment TEXT,
  site_id VARCHAR(64) REFERENCES sites(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS control_module_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  instance_number INTEGER,
  control_module_type_id UUID NOT NULL REFERENCES control_module_types(id),
  controller_id VARCHAR(255),
  unit_instance_id UUID REFERENCES unit_instances(id),
  pid_drawing TEXT,
  comment TEXT,
  configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
  current_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  site_id VARCHAR(64) REFERENCES sites(id),
  asset_id VARCHAR(64) REFERENCES assets(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS phase_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  instance_number INTEGER,
  phase_type_id UUID NOT NULL REFERENCES phase_types(id),
  unit_instance_id UUID REFERENCES unit_instances(id),
  controller_id VARCHAR(255),
  current_state VARCHAR(100) DEFAULT 'IDLE',
  current_step INTEGER DEFAULT 0,
  linked_module_instances JSONB NOT NULL DEFAULT '{}'::jsonb,
  site_id VARCHAR(64) REFERENCES sites(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS design_specifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  version VARCHAR(50) NOT NULL,
  description TEXT,
  content_hash VARCHAR(255) NOT NULL,
  tx_hash VARCHAR(255),
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  site_id VARCHAR(64) REFERENCES sites(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  anchored_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS generated_code (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type VARCHAR(100) NOT NULL,
  source_id VARCHAR(255) NOT NULL,
  vendor_id UUID NOT NULL REFERENCES vendors(id),
  template_package_id UUID REFERENCES template_packages(id),
  language VARCHAR(50) NOT NULL,
  code TEXT NOT NULL,
  code_hash VARCHAR(255) NOT NULL,
  tx_hash VARCHAR(255),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(50) NOT NULL DEFAULT 'draft',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  approved_by VARCHAR(255)
);

CREATE TABLE IF NOT EXISTS data_type_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES vendors(id),
  canonical_type VARCHAR(100) NOT NULL,
  vendor_type VARCHAR(100) NOT NULL,
  size INTEGER,
  precision INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS controllers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  vendor_id UUID NOT NULL REFERENCES vendors(id),
  site_id VARCHAR(64) REFERENCES sites(id),
  model VARCHAR(255) NOT NULL,
  firmware_version VARCHAR(100),
  address VARCHAR(255),
  configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(50) NOT NULL DEFAULT 'offline',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_name ON vendors(name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_control_module_types_name ON control_module_types(name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_unit_types_name ON unit_types(name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_phase_types_name ON phase_types(name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_data_type_mappings_vendor_canonical
  ON data_type_mappings(vendor_id, canonical_type);
CREATE INDEX IF NOT EXISTS idx_template_packages_vendor ON template_packages(vendor_id);
CREATE INDEX IF NOT EXISTS idx_control_module_instances_type ON control_module_instances(control_module_type_id);
CREATE INDEX IF NOT EXISTS idx_unit_instances_type ON unit_instances(unit_type_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_control_module_instances_type_name
  ON control_module_instances(control_module_type_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_unit_instances_type_name
  ON unit_instances(unit_type_id, name);
CREATE INDEX IF NOT EXISTS idx_phase_instances_type ON phase_instances(phase_type_id);
CREATE INDEX IF NOT EXISTS idx_generated_code_source ON generated_code(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_controllers_vendor ON controllers(vendor_id);
