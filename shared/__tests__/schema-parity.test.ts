import { describe, it, expect } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import type { Table } from 'drizzle-orm';
import * as pgSchema from '../schema';
import * as sqliteSchema from '../schema-sqlite';

/**
 * Schema parity (issues #7 → #26 → #55): `shared/schema.ts` (Postgres, source
 * of truth) and `shared/schema-sqlite.ts` (dev-mode fallback) must define the
 * same tables. Column *types* legitimately differ per dialect (pgEnum → text,
 * jsonb → text(json), timestamptz → integer(timestamp)), but table names,
 * property keys, and SQL column names must match so code touching them behaves
 * the same in dev SQLite as in production Postgres. A dev-mode-only gap dies
 * at runtime while working in production — the inverse of the usual failure
 * and the harder one to catch.
 *
 * #55 widened the net from a hand-maintained table list to programmatic
 * enumeration of EVERY Postgres table: a new pg table must either be mirrored
 * or added to the explicit exemption list below — it can no longer skip the
 * decision silently. (#26 built the original per-table pattern; the narrative
 * for why individual tables matter — alarm audit trails #7, validator
 * registry #454, safe-state log #459, twin persistence #550, correlation
 * state #573, marketplace durability #217 — lives in those issues.)
 */

/**
 * Postgres tables deliberately NOT mirrored in the SQLite dev schema.
 * Every entry must state why dev mode never touches the table. An entry whose
 * table IS mirrored fails the suite (stale exemption); a pg table neither
 * mirrored nor listed here fails the suite (undecided).
 */
const EXEMPT_FROM_SQLITE_MIRROR: Record<string, string> = {
  // (empty — as of #55 every Postgres table is mirrored)
};

function tablesOf(mod: Record<string, unknown>): Map<string, Table> {
  const out = new Map<string, Table>();
  for (const value of Object.values(mod)) {
    try {
      const name = getTableName(value as Table);
      if (typeof name === 'string' && name.length > 0) out.set(name, value as Table);
    } catch {
      // Not a drizzle table export (type helper, enum, relation) — skip.
    }
  }
  return out;
}

const sqlColumnNames = (table: Table): string[] =>
  Object.values(getTableColumns(table))
    .map((column) => column.name)
    .sort();

const propertyKeys = (table: Table): string[] =>
  Object.keys(getTableColumns(table)).sort();

const pgTables = tablesOf(pgSchema);
const sqliteTables = tablesOf(sqliteSchema);

describe('schema parity (Postgres vs SQLite dev fallback, #55 widened net)', () => {
  it('enumerates a sane number of Postgres tables (guard against a broken scan)', () => {
    // If a refactor of schema.ts made this scan return almost nothing, every
    // per-table assertion below would vacuously pass — pin a floor instead.
    expect(pgTables.size).toBeGreaterThanOrEqual(40);
  });

  it('every Postgres table is either mirrored or explicitly exempted', () => {
    const undecided = [...pgTables.keys()]
      .filter((name) => !sqliteTables.has(name) && !(name in EXEMPT_FROM_SQLITE_MIRROR))
      .sort();
    expect(undecided, 'pg tables neither mirrored in schema-sqlite.ts nor listed in EXEMPT_FROM_SQLITE_MIRROR').toEqual([]);
  });

  it('no exemption is stale (an exempt table must not be mirrored)', () => {
    const stale = Object.keys(EXEMPT_FROM_SQLITE_MIRROR).filter((name) => sqliteTables.has(name));
    expect(stale, 'exempt tables that are actually mirrored — delete the exemption').toEqual([]);
  });

  it('no exemption is dangling (an exempt table must exist in the pg schema)', () => {
    const dangling = Object.keys(EXEMPT_FROM_SQLITE_MIRROR).filter((name) => !pgTables.has(name));
    expect(dangling, 'exempt tables that no longer exist in schema.ts').toEqual([]);
  });

  it('the SQLite mirror has no orphan tables absent from Postgres', () => {
    const orphans = [...sqliteTables.keys()].filter((name) => !pgTables.has(name)).sort();
    expect(orphans, 'sqlite tables with no Postgres counterpart').toEqual([]);
  });

  for (const [name, pg] of [...pgTables.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sqlite = sqliteTables.get(name);
    if (!sqlite) continue; // covered by the mirrored-or-exempted assertion above

    describe(name, () => {
      it('uses the same SQL table name', () => {
        expect(getTableName(sqlite)).toBe(getTableName(pg));
      });

      it('defines the same property keys', () => {
        expect(propertyKeys(sqlite)).toEqual(propertyKeys(pg));
      });

      it('defines the same SQL column names', () => {
        expect(sqlColumnNames(sqlite)).toEqual(sqlColumnNames(pg));
      });
    });
  }
});
