-- Migration: 0009_blueprint_safe_state_log
-- Issue: #459 - Durable audit trail for watchdog safe-state transitions
--
-- The SQLite development fallback creates the same table from
-- `blueprintSqliteSchema` in server/storage.ts on every database open, so the
-- safe-state audit is durable on both dialects.

CREATE TABLE IF NOT EXISTS blueprint_safe_state_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blueprint_id VARCHAR(64) NOT NULL,
  site_id VARCHAR(64) REFERENCES sites(id),
  transition VARCHAR(16) NOT NULL,
  safe_state JSONB NOT NULL,
  tick_budget_ms INTEGER NOT NULL,
  consecutive_misses INTEGER,
  operator VARCHAR(255),
  reason TEXT NOT NULL,
  anchor_hash VARCHAR(255) NOT NULL,
  anchor_tx_hash VARCHAR(255),
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_safe_state_log_blueprint_id
  ON blueprint_safe_state_log(blueprint_id);
CREATE INDEX IF NOT EXISTS idx_safe_state_log_transition
  ON blueprint_safe_state_log(transition);
CREATE INDEX IF NOT EXISTS idx_safe_state_log_created_at
  ON blueprint_safe_state_log(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_safe_state_log_anchor_hash
  ON blueprint_safe_state_log(anchor_hash);
