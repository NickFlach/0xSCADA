/**
 * Database Migration Runner
 * 
 * Executes numbered migrations in order, tracks applied migrations.
 */

import path from 'path';
import fs from 'fs';

export interface DatabaseClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export type MigrationFn = (db: DatabaseClient) => Promise<void>;

export interface Migration {
  id: string;
  name: string;
  up: MigrationFn;
  down: MigrationFn;
}

export class MigrationRunner {
  constructor(
    private db: DatabaseClient,
    private migrationsDir: string = path.join(__dirname, 'migrations'),
  ) {}

  /** Ensure migrations tracking table exists */
  async init(): Promise<void> {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
  }

  /** Get list of applied migration IDs */
  async getApplied(): Promise<Set<string>> {
    const result = await this.db.query('SELECT id FROM _migrations ORDER BY id');
    return new Set((result.rows as { id: string }[]).map((r) => r.id));
  }

  /** Discover migration files */
  async discover(): Promise<Migration[]> {
    const files = fs.readdirSync(this.migrationsDir)
      .filter((f) => f.endsWith('.ts') || f.endsWith('.js'))
      .sort();

    const migrations: Migration[] = [];
    for (const file of files) {
      const mod = await import(path.join(this.migrationsDir, file));
      const id = file.replace(/\.(ts|js)$/, '');
      migrations.push({
        id,
        name: id,
        up: mod.up,
        down: mod.down,
      });
    }
    return migrations;
  }

  /** Run all pending migrations */
  async up(): Promise<string[]> {
    await this.init();
    const applied = await this.getApplied();
    const migrations = await this.discover();
    const ran: string[] = [];

    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;

      console.log(`[migrate] Running: ${migration.id}`);
      try {
        await migration.up(this.db);
        await this.db.query(
          'INSERT INTO _migrations (id, name) VALUES ($1, $2)',
          [migration.id, migration.name],
        );
        ran.push(migration.id);
        console.log(`[migrate] Applied: ${migration.id}`);
      } catch (err) {
        console.error(`[migrate] Failed: ${migration.id}`, err);
        throw err;
      }
    }

    if (ran.length === 0) console.log('[migrate] No pending migrations');
    return ran;
  }

  /** Rollback last N migrations */
  async down(count = 1): Promise<string[]> {
    await this.init();
    const result = await this.db.query(
      'SELECT id FROM _migrations ORDER BY id DESC LIMIT $1',
      [count],
    );
    const toRollback = (result.rows as { id: string }[]).map((r) => r.id);
    const migrations = await this.discover();
    const rolled: string[] = [];

    for (const id of toRollback) {
      const migration = migrations.find((m) => m.id === id);
      if (!migration) continue;

      console.log(`[migrate] Rolling back: ${id}`);
      await migration.down(this.db);
      await this.db.query('DELETE FROM _migrations WHERE id = $1', [id]);
      rolled.push(id);
      console.log(`[migrate] Rolled back: ${id}`);
    }

    return rolled;
  }

  /** Get migration status */
  async status(): Promise<{ id: string; applied: boolean }[]> {
    await this.init();
    const applied = await this.getApplied();
    const migrations = await this.discover();
    return migrations.map((m) => ({ id: m.id, applied: applied.has(m.id) }));
  }
}

export default MigrationRunner;
