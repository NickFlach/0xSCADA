/**
 * Migration 002: Create audit log table
 */
import { MigrationFn } from '../migration-runner';

export const up: MigrationFn = async (db) => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      user_id UUID,
      action VARCHAR(100) NOT NULL,
      resource VARCHAR(100) NOT NULL,
      resource_id VARCHAR(255),
      details JSONB,
      ip_address INET,
      request_id VARCHAR(255),
      success BOOLEAN DEFAULT TRUE
    );

    CREATE INDEX idx_audit_log_timestamp ON audit_log (timestamp DESC);
    CREATE INDEX idx_audit_log_user ON audit_log (user_id, timestamp DESC);
    CREATE INDEX idx_audit_log_resource ON audit_log (resource, resource_id);
    CREATE INDEX idx_audit_log_action ON audit_log (action);
  `);
};

export const down: MigrationFn = async (db) => {
  await db.query('DROP TABLE IF EXISTS audit_log CASCADE;');
};
