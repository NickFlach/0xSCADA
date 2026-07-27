-- Migration: 0008_modbus_register_map
-- Issue: #462 - Modbus TCP Server Mode
-- Description: Persist per-site Modbus register mappings declared in shared/schema.ts
-- Date: 2026-07-23
--
-- SAFETY: `writable` defaults to FALSE. Modbus TCP carries no authentication, so
-- a mapped address is readable only. Letting a master actuate it is a deliberate
-- per-address opt-in that additionally requires the listener to have been armed
-- with MODBUS_SERVER_ALLOW_WRITES=true.

CREATE TABLE IF NOT EXISTS modbus_register_map (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id VARCHAR(64) NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  unit_id INTEGER NOT NULL DEFAULT 1,
  area VARCHAR(32) NOT NULL,
  address INTEGER NOT NULL,
  tag_id VARCHAR(255) NOT NULL,
  data_type VARCHAR(16) NOT NULL,
  scale REAL,
  word_order VARCHAR(8),
  writable BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_modbus_register_map_site_area_address
  ON modbus_register_map(site_id, unit_id, area, address);

CREATE INDEX IF NOT EXISTS idx_modbus_register_map_site_id
  ON modbus_register_map(site_id);
