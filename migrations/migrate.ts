/**
 * 0xSCADA Migration Runner
 *
 * Issue #205: Database Migrations & Schema (ADR-0012 Wave 1)
 *
 * Runs numbered SQL migration files in order, tracking applied migrations
 * in a `_migrations` table. Idempotent — safe to run repeatedly.
 *
 * Usage:
 *   npx tsx migrations/migrate.ts              # Run pending migrations
 *   npx tsx migrations/migrate.ts --status     # Show migration status
 *   npx tsx migrations/migrate.ts --dry-run    # Show what would run
 *
 * Requires DATABASE_URL environment variable.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL environment variable is required");
  process.exit(1);
}

const MIGRATIONS_DIR = join(import.meta.dirname ?? __dirname, ".");
const MIGRATIONS_TABLE = "_migrations";

async function ensureMigrationsTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checksum VARCHAR(64)
    );
  `);
}

async function getAppliedMigrations(client: pg.Client): Promise<Set<string>> {
  const result = await client.query(`SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id`);
  return new Set(result.rows.map((r: { name: string }) => r.name));
}

async function getMigrationFiles(): Promise<string[]> {
  const files = await readdir(MIGRATIONS_DIR);
  return files
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

async function hashContent(content: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const statusOnly = args.includes("--status");
  const dryRun = args.includes("--dry-run");

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);
    const files = await getMigrationFiles();

    if (statusOnly) {
      console.log("Migration Status:");
      console.log("─".repeat(60));
      for (const file of files) {
        const status = applied.has(file) ? "✓ applied" : "○ pending";
        console.log(`  ${status}  ${file}`);
      }
      console.log(`\n${applied.size} applied, ${files.length - applied.size} pending`);
      return;
    }

    const pending = files.filter((f) => !applied.has(f));
    if (pending.length === 0) {
      console.log("All migrations are up to date.");
      return;
    }

    console.log(`Found ${pending.length} pending migration(s):`);
    for (const file of pending) {
      console.log(`  → ${file}`);
    }

    if (dryRun) {
      console.log("\n(dry run — no changes applied)");
      return;
    }

    for (const file of pending) {
      const filePath = join(MIGRATIONS_DIR, file);
      const sql = await readFile(filePath, "utf-8");
      const checksum = await hashContent(sql);

      console.log(`\nApplying ${file}...`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO ${MIGRATIONS_TABLE} (name, checksum) VALUES ($1, $2)`,
          [file, checksum]
        );
        await client.query("COMMIT");
        console.log(`  ✓ ${file} applied successfully`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`  ✗ ${file} failed:`, err);
        process.exit(1);
      }
    }

    console.log(`\nDone. ${pending.length} migration(s) applied.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Migration runner failed:", err);
  process.exit(1);
});
