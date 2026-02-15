/**
 * Migration 004: Create historian tables (time-series optimized)
 */
import { MigrationFn } from '../migration-runner';

export const up: MigrationFn = async (db) => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS historian_data (
      time TIMESTAMPTZ NOT NULL,
      tag_name VARCHAR(255) NOT NULL,
      value_numeric DOUBLE PRECISION,
      value_text TEXT,
      value_bool BOOLEAN,
      quality VARCHAR(20) DEFAULT 'good',
      source VARCHAR(50),
      batch_id VARCHAR(255)
    );

    -- Partition by time if TimescaleDB is available, otherwise use BRIN index
    CREATE INDEX idx_historian_time_tag ON historian_data (tag_name, time DESC);
    CREATE INDEX idx_historian_time_brin ON historian_data USING BRIN (time);

    CREATE TABLE IF NOT EXISTS historian_tags (
      tag_name VARCHAR(255) PRIMARY KEY,
      description TEXT,
      unit VARCHAR(50),
      data_type VARCHAR(20) NOT NULL DEFAULT 'numeric',
      source VARCHAR(50),
      min_value DOUBLE PRECISION,
      max_value DOUBLE PRECISION,
      deadband DOUBLE PRECISION DEFAULT 0,
      scan_rate_ms INTEGER DEFAULT 1000,
      enabled BOOLEAN DEFAULT TRUE,
      metadata JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
};

export const down: MigrationFn = async (db) => {
  await db.query(`
    DROP TABLE IF EXISTS historian_data CASCADE;
    DROP TABLE IF EXISTS historian_tags CASCADE;
  `);
};
