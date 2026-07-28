-- Migration: 0011_agent_marketplace
-- Issue: #217 — Agent Marketplace & Plugin System (ADR-0013 [13.6])
--
-- Two durable tables replace the previous in-memory Maps:
--
--   plugin_registry      published manifests plus the ownership record.
--                        `publisher` is the authenticated control-plane
--                        principal that FIRST published the id. Publishing a
--                        later version of an existing id is refused unless
--                        the requesting principal matches this row. That check
--                        is only a security control while the row is durable:
--                        an ownership table that resets on restart would let a
--                        restart re-open every plugin id to hijack.
--
--   plugin_installations one row per installed plugin, carrying the manifest
--                        version pinned at install time, the validated config,
--                        and the capabilities actually granted. Grants are
--                        security state, so they are durable too.
--
-- Runtime health counters (invocations, failures, uptime) are deliberately NOT
-- persisted: they are transient operational telemetry for the current process,
-- not authorization state, and a restart legitimately resets them.

CREATE TABLE IF NOT EXISTS plugin_registry (
  id VARCHAR(64) PRIMARY KEY,
  version VARCHAR(32) NOT NULL,
  manifest JSONB NOT NULL,
  publisher VARCHAR(255) NOT NULL,
  installs INTEGER NOT NULL DEFAULT 0,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plugin_registry_publisher
  ON plugin_registry(publisher);

CREATE TABLE IF NOT EXISTS plugin_installations (
  id VARCHAR(64) PRIMARY KEY REFERENCES plugin_registry(id),
  version VARCHAR(32) NOT NULL,
  manifest JSONB NOT NULL,
  status VARCHAR(32) NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  granted_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  installed_by VARCHAR(255) NOT NULL,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plugin_installations_status
  ON plugin_installations(status);
