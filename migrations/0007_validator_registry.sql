-- Migration: 0007_validator_registry
-- Issue: #454 - [wave:2a] Cross-Node State Queries (per-validator /state/:key proxy)
-- Description: Validator node registry, registered verification public keys, and
--   the per-(node, key) anti-rollback high-water mark.
--
--   Backs GET /api/nodes/:id/state/:key: the server resolves a validator's RPC
--   endpoint (validator_nodes), verifies the validator's signed response against
--   a registered Ed25519 public key (validator_pubkeys), and refuses answers
--   that report a block height below the highest one already accepted for that
--   (validator, key) pair (validator_state_watermarks).
--
--   SEEDING: this migration deliberately inserts no rows. There is no safe
--   built-in validator set — a hard-coded RPC URL or public key would be a
--   silent trust decision baked into the schema. Registration is an explicit,
--   admin-authenticated operation: POST /api/nodes and POST /api/nodes/:id/pubkeys
--   (see docs/blockchain/cross-node-state-queries.md). An empty registry fails
--   closed: every /state/:key query answers 404 unknown-validator.
-- Date: 2026-07-27

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
  -- NOT NULL: the proxy resolves the exact key named by the validator response,
  -- so an unnamed key could never be selected and must not be registerable.
  key_id VARCHAR(128) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_validator_pubkeys_node_id ON validator_pubkeys(node_id);
CREATE INDEX IF NOT EXISTS idx_validator_pubkeys_node_active ON validator_pubkeys(node_id, active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_validator_pubkeys_node_key_id
  ON validator_pubkeys(node_id, key_id);

-- ─── State Freshness High-Water Marks ────────────────────────────────────────
-- Highest block height the server has ever accepted for a (validator, key)
-- pair. A later answer reporting a lower height is a rolled-back view of state
-- and is rejected with `state-rollback`. Persisted (not in-process) so the
-- check survives restarts and holds across replicas sharing this database.

CREATE TABLE IF NOT EXISTS validator_state_watermarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id VARCHAR(64) NOT NULL REFERENCES validator_nodes(id) ON DELETE CASCADE,
  state_key VARCHAR(512) NOT NULL,
  block_height BIGINT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_validator_state_watermarks_node_key
  ON validator_state_watermarks(node_id, state_key);
