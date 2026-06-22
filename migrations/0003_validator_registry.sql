-- Migration: 0003_validator_registry
-- Issue: #454 - [wave:2a] Cross-Node State Queries (per-validator /state/:key proxy)
-- Description: Validator node registry + registered verification public keys.
--   Backs GET /api/nodes/:id/state/:key: the server resolves a validator's RPC
--   endpoint (validator_nodes) and verifies the validator's signed response
--   against a registered Ed25519 public key (validator_pubkeys) before returning
--   it to the operator.
-- Date: 2026-06-22

-- ─── Validator Nodes ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS validator_nodes (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  rpc_url VARCHAR(512) NOT NULL,
  operator_id VARCHAR(255),
  region VARCHAR(64),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_validator_nodes_operator_id ON validator_nodes(operator_id);
CREATE INDEX IF NOT EXISTS idx_validator_nodes_enabled ON validator_nodes(enabled);

-- ─── Validator Public Keys ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS validator_pubkeys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id VARCHAR(64) NOT NULL REFERENCES validator_nodes(id) ON DELETE CASCADE,
  algorithm VARCHAR(32) NOT NULL DEFAULT 'ed25519',
  public_key_pem TEXT NOT NULL,
  key_id VARCHAR(128),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_validator_pubkeys_node_id ON validator_pubkeys(node_id);
CREATE INDEX IF NOT EXISTS idx_validator_pubkeys_node_active ON validator_pubkeys(node_id, active);
