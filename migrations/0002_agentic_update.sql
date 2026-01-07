-- 0xSCADA Agentic Update Migration
-- PRD: Agentic-First Industrial Control Platform
-- Version: 2.0.0

-- =============================================================================
-- SITES TABLE UPDATES (PRD Section 7.1)
-- =============================================================================

ALTER TABLE sites ADD COLUMN IF NOT EXISTS ethereum_address TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS authorized_gateways JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS authorized_signers JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();

-- =============================================================================
-- EVENT BATCHES (PRD Section 7.2: Merkle roots)
-- =============================================================================

CREATE TABLE IF NOT EXISTS event_batches (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id TEXT REFERENCES sites(id),
  event_count INTEGER NOT NULL,
  merkle_root TEXT NOT NULL,
  first_event_at TIMESTAMP NOT NULL,
  last_event_at TIMESTAMP NOT NULL,
  anchor_status TEXT NOT NULL DEFAULT 'PENDING',
  tx_hash TEXT,
  block_number INTEGER,
  anchored_at TIMESTAMP,
  metadata_hash TEXT,
  metadata_uri TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- EVENTS TABLE (PRD Section 6.1: Event Model)
-- =============================================================================

CREATE TABLE IF NOT EXISTS events (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  asset_id TEXT REFERENCES assets(id),
  source_timestamp TIMESTAMP NOT NULL,
  receipt_timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
  origin_type TEXT NOT NULL,
  origin_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  details TEXT,
  signature TEXT NOT NULL,
  hash TEXT NOT NULL,
  anchor_status TEXT NOT NULL DEFAULT 'PENDING',
  batch_id TEXT REFERENCES event_batches(id),
  merkle_index INTEGER,
  merkle_proof JSONB,
  anchor_tx_hash TEXT,
  anchored_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_site_id ON events(site_id);
CREATE INDEX IF NOT EXISTS idx_events_asset_id ON events(asset_id);
CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_anchor_status ON events(anchor_status);
CREATE INDEX IF NOT EXISTS idx_events_source_timestamp ON events(source_timestamp);

-- =============================================================================
-- GATEWAYS (PRD Section 6.2: Edge Gateway)
-- =============================================================================

CREATE TABLE IF NOT EXISTS gateways (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  public_key TEXT NOT NULL,
  key_algorithm TEXT NOT NULL DEFAULT 'ed25519',
  ethereum_address TEXT,
  protocols JSONB NOT NULL DEFAULT '["OPC_UA"]'::jsonb,
  endpoint TEXT,
  last_heartbeat TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'OFFLINE',
  error_message TEXT,
  events_processed INTEGER NOT NULL DEFAULT 0,
  last_event_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gateways_site_id ON gateways(site_id);
CREATE INDEX IF NOT EXISTS idx_gateways_status ON gateways(status);

-- =============================================================================
-- AGENTS (PRD Section 6.3: Agent Framework)
-- =============================================================================

CREATE TABLE IF NOT EXISTS agents (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  agent_type TEXT NOT NULL,
  public_key TEXT NOT NULL,
  key_algorithm TEXT NOT NULL DEFAULT 'ed25519',
  ethereum_address TEXT,
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  scope JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'INACTIVE',
  version TEXT NOT NULL DEFAULT '1.0.0',
  last_active_at TIMESTAMP,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agents_agent_type ON agents(agent_type);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);

-- =============================================================================
-- AGENT STATE (PRD: Scoped memory)
-- =============================================================================

CREATE TABLE IF NOT EXISTS agent_state (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  expires_at TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_state_agent_id ON agent_state(agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_state_agent_key ON agent_state(agent_id, key);

-- =============================================================================
-- AGENT OUTPUTS (PRD: Signed outputs)
-- =============================================================================

CREATE TABLE IF NOT EXISTS agent_outputs (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  output_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content JSONB NOT NULL,
  site_id TEXT REFERENCES sites(id),
  asset_ids JSONB DEFAULT '[]'::jsonb,
  event_ids JSONB DEFAULT '[]'::jsonb,
  hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  confidence INTEGER,
  reasoning TEXT,
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  approval_status TEXT,
  approved_by TEXT,
  approved_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_outputs_agent_id ON agent_outputs(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_outputs_output_type ON agent_outputs(output_type);
CREATE INDEX IF NOT EXISTS idx_agent_outputs_requires_approval ON agent_outputs(requires_approval);

-- =============================================================================
-- AGENT PROPOSALS (PRD: All proposals require human approval)
-- =============================================================================

CREATE TABLE IF NOT EXISTS agent_proposals (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  proposal_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  action JSONB NOT NULL,
  reasoning TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  supporting_event_ids JSONB DEFAULT '[]'::jsonb,
  risk_level TEXT NOT NULL,
  risk_factors JSONB DEFAULT '[]'::jsonb,
  hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  required_approvals INTEGER NOT NULL DEFAULT 1,
  approvals JSONB DEFAULT '[]'::jsonb,
  expires_at TIMESTAMP,
  executed_at TIMESTAMP,
  execution_result JSONB,
  execution_error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_proposals_agent_id ON agent_proposals(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_proposals_status ON agent_proposals(status);
CREATE INDEX IF NOT EXISTS idx_agent_proposals_proposal_type ON agent_proposals(proposal_type);

-- =============================================================================
-- USERS (PRD Section 4.1: Primary Users with roles)
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  public_key TEXT,
  key_algorithm TEXT,
  ethereum_address TEXT,
  role TEXT NOT NULL DEFAULT 'OPERATOR',
  permissions JSONB DEFAULT '[]'::jsonb,
  site_ids JSONB DEFAULT '[]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- =============================================================================
-- CHANGE INTENTS (PRD Section 7.3: Change Intent Contract)
-- =============================================================================

CREATE TABLE IF NOT EXISTS change_intents (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  blueprint_id TEXT NOT NULL,
  blueprint_name TEXT NOT NULL,
  blueprint_hash TEXT NOT NULL,
  codegen_id TEXT,
  code_hash TEXT,
  target_controller_id TEXT REFERENCES controllers(id),
  target_controller_name TEXT,
  change_package JSONB NOT NULL DEFAULT '{}'::jsonb,
  required_approvals INTEGER NOT NULL DEFAULT 1,
  approvals JSONB DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  intent_hash TEXT NOT NULL,
  anchor_tx_hash TEXT,
  anchored_at TIMESTAMP,
  deployed_at TIMESTAMP,
  deployed_by TEXT,
  rolled_back_at TIMESTAMP,
  rolled_back_by TEXT,
  rollback_reason TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_change_intents_blueprint_id ON change_intents(blueprint_id);
CREATE INDEX IF NOT EXISTS idx_change_intents_status ON change_intents(status);
CREATE INDEX IF NOT EXISTS idx_change_intents_target_controller ON change_intents(target_controller_id);

-- =============================================================================
-- MIGRATION COMPLETE
-- =============================================================================

COMMENT ON TABLE events IS 'PRD Section 6.1: Event Model - deterministic, signed, hashable, anchorable events';
COMMENT ON TABLE event_batches IS 'PRD Section 7.2: Merkle batched event anchoring';
COMMENT ON TABLE gateways IS 'PRD Section 6.2: Edge Gateway with device identity';
COMMENT ON TABLE agents IS 'PRD Section 6.3: Agent Framework - first-class system actors';
COMMENT ON TABLE agent_proposals IS 'PRD Section 6.3: All proposals require human approval';
COMMENT ON TABLE change_intents IS 'PRD Section 7.3: Change Intent Contract - finality before deployment';
