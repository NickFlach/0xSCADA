import { describe, it, expect } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import type { Table } from 'drizzle-orm';
import { alarms as pgAlarms, alarmHistory as pgAlarmHistory } from '../schema';
import {
  alarms as sqliteAlarms,
  alarmHistory as sqliteAlarmHistory,
} from '../schema-sqlite';

/**
 * Schema parity (issue #7): `shared/schema.ts` (Postgres, source of truth) and
 * `shared/schema-sqlite.ts` (dev-mode fallback) must define the same alarm
 * tables. Column *types* legitimately differ per dialect (pgEnum → text,
 * jsonb → text, timestamptz → integer), but the table names, property keys,
 * and SQL column names must match so alarm-touching code behaves the same in
 * dev SQLite as in production Postgres. If either schema adds, drops, or
 * renames an alarm column without the other, this suite fails instead of the
 * divergence surfacing as a silent no-op at runtime.
 */

const sqlColumnNames = (table: Table): string[] =>
  Object.values(getTableColumns(table))
    .map((column) => column.name)
    .sort();

const propertyKeys = (table: Table): string[] =>
  Object.keys(getTableColumns(table)).sort();

const cases = [
  { name: 'alarms', pg: pgAlarms, sqlite: sqliteAlarms },
  { name: 'alarm_history', pg: pgAlarmHistory, sqlite: sqliteAlarmHistory },
] as const;

describe('alarm schema parity (Postgres vs SQLite dev fallback)', () => {
  for (const { name, pg, sqlite } of cases) {
    describe(name, () => {
      it('uses the same SQL table name', () => {
        expect(getTableName(sqlite)).toBe(name);
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
