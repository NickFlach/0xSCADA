/**
 * Migration 0013 tests — Issue #546
 *
 * Two things have to be true of a schema change in this repository:
 *
 *   1. it works on a FRESH database — nothing exists, the tables appear, and
 *      durable predictive state can immediately be written and read;
 *   2. it works as an UPGRADE from current main — a database that already
 *      carries main's tables and rows gains the new tables without disturbing
 *      anything that was already there.
 *
 * Both are executed here, not asserted about — but read the next paragraph for
 * exactly WHAT is executed, because it is not the same artefact on both
 * dialects.
 *
 * `migrations/0013_predictive_durable_state.sql` is PostgreSQL DDL (JSONB,
 * TIMESTAMPTZ, DEFAULT NOW()) and CANNOT be executed by SQLite. It is run
 * verbatim against a real PostgreSQL server — fresh schema and upgrade — only
 * when DATABASE_URL is configured; without one that suite is skipped rather
 * than faked, and the file is instead checked statically for alignment with
 * the Drizzle table definitions.
 *
 * The SQLite suites below therefore exercise the equivalent SQLite DDL that
 * `server/services/predictive/store.ts` applies for the development back-end,
 * NOT the 0013 file. They prove the dev-fallback schema is created, is
 * idempotent, and leaves a populated database intact; they do not and cannot
 * prove anything about the Postgres migration text.
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { Client } from 'pg';
import { Database } from 'sqlite3';
import { predictiveAlerts, predictiveTagThresholds } from '@shared/schema';
import { DrizzlePredictiveStore } from '../store';

const MIGRATION_SQL = readFileSync(
  new URL('../../../../migrations/0013_predictive_durable_state.sql', import.meta.url),
  'utf8',
);

const OPERATOR = 'migration-test-operator';

function run(client: Database, sqlText: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    client.run(sqlText, params, (error) => (error ? reject(error) : resolve()));
  });
}

function all(client: Database, sqlText: string): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    client.all(sqlText, (error, rows) =>
      error ? reject(error) : resolve(rows as Array<Record<string, unknown>>));
  });
}

function close(client: Database): Promise<void> {
  return new Promise((resolve, reject) => {
    client.close((error) => (error ? reject(error) : resolve()));
  });
}

let directory: string;
const open: DrizzlePredictiveStore[] = [];

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'predictive-migration-'));
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((store) => store.close()));
  await rm(directory, { recursive: true, force: true });
});

describe('SQLite dev-fallback schema (store DDL, not the 0013 file) — fresh database', () => {
  it('creates both tables and round-trips durable state', async () => {
    const file = path.join(directory, 'fresh.sqlite');
    const store = new DrizzlePredictiveStore({ sqlitePath: file });
    open.push(store);
    await store.ready();

    const client = new Database(file);
    try {
      const tables = await all(
        client,
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      );
      expect(tables.map((row) => row.name)).toEqual([
        'predictive_alerts',
        'predictive_tag_thresholds',
      ]);
      const indexes = await all(
        client,
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name",
      );
      expect(indexes.map((row) => row.name)).toEqual([
        'idx_predictive_alerts_acknowledged',
        'idx_predictive_alerts_created_at',
        'idx_predictive_alerts_severity',
        'idx_predictive_alerts_tag',
        'idx_predictive_thresholds_updated_at',
      ]);
    } finally {
      await close(client);
    }

    const written = await store.upsertThresholds({
      thresholds: {
        tagId: 'fresh-tag',
        minSamples: 10,
        zScoreThreshold: 3,
        ewmaAlpha: 0.3,
        ewmaL: 3,
        iqrMultiplier: 1.5,
        ensembleWeights: { 'z-score': 1 },
        severityThresholds: { warning: 0.4, critical: 0.7, emergency: 0.9 },
      },
      updatedBy: OPERATOR,
      at: new Date(),
    });
    expect(written.updatedBy).toBe(OPERATOR);
    expect(await store.countThresholds()).toBe(1);
  });

  it('is idempotent — opening an already-migrated database changes nothing', async () => {
    const file = path.join(directory, 'twice.sqlite');
    const first = new DrizzlePredictiveStore({ sqlitePath: file });
    open.push(first);
    await first.upsertThresholds({
      thresholds: {
        tagId: 'kept',
        minSamples: 11,
        zScoreThreshold: 3,
        ewmaAlpha: 0.3,
        ewmaL: 3,
        iqrMultiplier: 1.5,
        ensembleWeights: { 'z-score': 1 },
        severityThresholds: { warning: 0.4, critical: 0.7, emergency: 0.9 },
      },
      updatedBy: OPERATOR,
      at: new Date(),
    });
    await first.close();

    // Re-running the DDL must not drop the row that is already there.
    const second = new DrizzlePredictiveStore({ sqlitePath: file });
    open.push(second);
    await second.ready();
    expect(await second.countThresholds()).toBe(1);
    expect((await second.getThresholds('kept'))?.thresholds.minSamples).toBe(11);
  });
});

describe('SQLite dev-fallback schema (store DDL, not the 0013 file) — upgrade', () => {
  it('adds the tables to a populated pre-0013 database without touching it', async () => {
    const file = path.join(directory, 'upgrade.sqlite');

    // A stand-in for a database that already carries an earlier migration's
    // table and rows. This is a reduced `pid_tuning_audit` (migration 0010),
    // NOT that table's full 15-column shape from shared/schema-sqlite.ts — it
    // is here to prove the new DDL leaves a pre-existing populated table
    // alone, not to reproduce main's schema.
    const legacy = new Database(file);
    await run(legacy, `
      CREATE TABLE pid_tuning_audit (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        controller_id TEXT NOT NULL,
        recorded_at INTEGER NOT NULL
      )
    `);
    await run(
      legacy,
      'INSERT INTO pid_tuning_audit(id, proposal_id, controller_id, recorded_at) VALUES (?,?,?,?)',
      ['audit-1', 'TUNE-1', 'FIC-101', 1_700_000_000_000],
    );
    await close(legacy);

    // Upgrade.
    const store = new DrizzlePredictiveStore({ sqlitePath: file });
    open.push(store);
    await store.ready();

    const client = new Database(file);
    try {
      const tables = await all(
        client,
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      );
      expect(tables.map((row) => row.name)).toEqual([
        'pid_tuning_audit',
        'predictive_alerts',
        'predictive_tag_thresholds',
      ]);
      // The pre-existing data is untouched — an upgrade that silently drops
      // rows is exactly the failure mode this test exists for.
      const preserved = await all(client, 'SELECT id, proposal_id FROM pid_tuning_audit');
      expect(preserved).toEqual([{ id: 'audit-1', proposal_id: 'TUNE-1' }]);
    } finally {
      await close(client);
    }

    // And the upgraded database is immediately usable.
    await store.insertAlert({
      id: 'PMA-upgrade-check',
      tagId: 'upgraded-tag',
      severity: 'critical',
      score: 0.8,
      message: 'upgraded',
      timestamp: 1_700_000_000_000,
      detectors: ['z-score'],
      acknowledged: false,
      recommendation: 'inspect',
      createdAt: 1_700_000_000_000,
      acknowledgedBy: null,
      acknowledgedAt: null,
    });
    expect(await store.countAlerts()).toEqual({ total: 1, unacknowledged: 1 });
  });
});

describe('migration 0013 SQL matches the Drizzle tables', () => {
  it('creates every column the Postgres schema declares', () => {
    for (const table of [predictiveTagThresholds, predictiveAlerts]) {
      for (const column of Object.values(getTableColumns(table))) {
        expect(MIGRATION_SQL, `column ${column.name}`).toMatch(
          new RegExp(`^\\s*${column.name}\\s`, 'm'),
        );
      }
    }
  });

  it('creates every index the Postgres schema declares, and the attribution guard', () => {
    for (const index of [
      'idx_predictive_thresholds_updated_at',
      'idx_predictive_alerts_tag',
      'idx_predictive_alerts_severity',
      'idx_predictive_alerts_acknowledged',
      'idx_predictive_alerts_created_at',
    ]) {
      expect(MIGRATION_SQL).toContain(index);
    }
    expect(MIGRATION_SQL).toContain('predictive_alerts_ack_attribution_check');
    expect(MIGRATION_SQL).toContain('predictive_alerts_severity_check');
  });

  it('is re-runnable against an already-upgraded database', () => {
    // `migrations/migrate.ts` tracks applied files, but an operator running the
    // file by hand must not be punished for it.
    const creates = MIGRATION_SQL.match(/CREATE (TABLE|INDEX)/g) ?? [];
    const guarded = MIGRATION_SQL.match(/CREATE (TABLE|INDEX) IF NOT EXISTS/g) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    expect(guarded.length).toBe(creates.length);
  });
});

/**
 * The production dialect. Runs the real migration file against a real
 * PostgreSQL server when one is configured, on both a fresh schema and a
 * schema that already contains a table from an earlier migration. Skipped —
 * not stubbed — when DATABASE_URL is absent.
 */
const postgresUrl = process.env.DATABASE_URL;
describe.skipIf(!postgresUrl)('migration 0013 on PostgreSQL', () => {
  let client: Client;
  let schema: string;

  beforeEach(async () => {
    schema = `predictive_migration_${Date.now().toString(36)}`;
    client = new Client({ connectionString: postgresUrl });
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
  });

  afterEach(async () => {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  });

  async function columnsOf(table: string): Promise<string[]> {
    const result = await client.query<{ column_name: string }>(
      'SELECT column_name FROM information_schema.columns '
      + 'WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name',
      [schema, table],
    );
    return result.rows.map((row) => row.column_name);
  }

  it('applies to a fresh schema and enforces the attribution constraint', async () => {
    await client.query(MIGRATION_SQL);

    expect(await columnsOf('predictive_tag_thresholds')).toEqual(
      Object.values(getTableColumns(predictiveTagThresholds)).map((c) => c.name).sort(),
    );
    expect(await columnsOf('predictive_alerts')).toEqual(
      Object.values(getTableColumns(predictiveAlerts)).map((c) => c.name).sort(),
    );

    await client.query(
      'INSERT INTO predictive_alerts '
      + '(id, tag_id, severity, score, message, detectors, recommendation, observed_at) '
      + "VALUES ('PMA-pg', 't', 'critical', 0.8, 'm', '[\"z-score\"]'::jsonb, 'r', NOW())",
    );
    await expect(
      client.query("UPDATE predictive_alerts SET acknowledged = TRUE WHERE id = 'PMA-pg'"),
    ).rejects.toThrow(/predictive_alerts_ack_attribution_check/);
  });

  it('upgrades a schema that already holds an earlier migration table', async () => {
    await client.query(
      'CREATE TABLE pid_tuning_audit (id UUID PRIMARY KEY, proposal_id VARCHAR(128) NOT NULL)',
    );
    await client.query(
      "INSERT INTO pid_tuning_audit (id, proposal_id) VALUES (gen_random_uuid(), 'TUNE-1')",
    );

    await client.query(MIGRATION_SQL);
    // Re-running must be safe, which is what an operator re-applying a
    // partially-failed migration actually does.
    await client.query(MIGRATION_SQL);

    const preserved = await client.query('SELECT proposal_id FROM pid_tuning_audit');
    expect(preserved.rows).toEqual([{ proposal_id: 'TUNE-1' }]);
    expect((await columnsOf('predictive_alerts')).length).toBeGreaterThan(0);
  });
});
