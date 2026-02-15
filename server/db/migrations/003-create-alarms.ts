/**
 * Migration 003: Create alarms tables
 */
import { MigrationFn } from '../migration-runner';

export const up: MigrationFn = async (db) => {
  await db.query(`
    CREATE TYPE alarm_severity AS ENUM ('critical', 'high', 'medium', 'low', 'info');
    CREATE TYPE alarm_state AS ENUM ('active', 'acknowledged', 'cleared', 'shelved');

    CREATE TABLE IF NOT EXISTS alarm_definitions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tag_name VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      severity alarm_severity NOT NULL DEFAULT 'medium',
      condition_type VARCHAR(50) NOT NULL,
      condition_value JSONB NOT NULL,
      deadband DOUBLE PRECISION DEFAULT 0,
      delay_ms INTEGER DEFAULT 0,
      enabled BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS alarm_events (
      id BIGSERIAL PRIMARY KEY,
      alarm_def_id UUID REFERENCES alarm_definitions(id),
      state alarm_state NOT NULL DEFAULT 'active',
      tag_value DOUBLE PRECISION,
      triggered_at TIMESTAMPTZ DEFAULT NOW(),
      acknowledged_at TIMESTAMPTZ,
      acknowledged_by UUID,
      cleared_at TIMESTAMPTZ,
      notes TEXT
    );

    CREATE INDEX idx_alarm_events_state ON alarm_events (state, triggered_at DESC);
    CREATE INDEX idx_alarm_events_def ON alarm_events (alarm_def_id, triggered_at DESC);
  `);
};

export const down: MigrationFn = async (db) => {
  await db.query(`
    DROP TABLE IF EXISTS alarm_events CASCADE;
    DROP TABLE IF EXISTS alarm_definitions CASCADE;
    DROP TYPE IF EXISTS alarm_state;
    DROP TYPE IF EXISTS alarm_severity;
  `);
};
