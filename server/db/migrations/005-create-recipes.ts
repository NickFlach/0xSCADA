/**
 * Migration 005: Create recipe management tables (CFR 21 Part 11 compliant)
 */
import { MigrationFn } from '../migration-runner';

export const up: MigrationFn = async (db) => {
  await db.query(`
    CREATE TYPE recipe_status AS ENUM ('draft', 'review', 'approved', 'active', 'retired');

    CREATE TABLE IF NOT EXISTS recipes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      status recipe_status NOT NULL DEFAULT 'draft',
      description TEXT,
      parameters JSONB NOT NULL DEFAULT '[]',
      steps JSONB NOT NULL DEFAULT '[]',
      created_by UUID NOT NULL,
      approved_by UUID,
      approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(name, version)
    );

    CREATE TABLE IF NOT EXISTS recipe_executions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      recipe_id UUID REFERENCES recipes(id),
      recipe_version INTEGER NOT NULL,
      started_by UUID NOT NULL,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      status VARCHAR(50) NOT NULL DEFAULT 'running',
      parameters JSONB,
      result JSONB,
      batch_id VARCHAR(255),
      electronic_signature TEXT
    );

    CREATE INDEX idx_recipe_exec_recipe ON recipe_executions (recipe_id, started_at DESC);
    CREATE INDEX idx_recipe_exec_batch ON recipe_executions (batch_id);
  `);
};

export const down: MigrationFn = async (db) => {
  await db.query(`
    DROP TABLE IF EXISTS recipe_executions CASCADE;
    DROP TABLE IF EXISTS recipes CASCADE;
    DROP TYPE IF EXISTS recipe_status;
  `);
};
