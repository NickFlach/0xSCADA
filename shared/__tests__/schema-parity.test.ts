import { describe, it, expect } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import type { Table } from 'drizzle-orm';
import {
  alarms as pgAlarms,
  alarmHistory as pgAlarmHistory,
  validatorNodes as pgValidatorNodes,
  validatorPubkeys as pgValidatorPubkeys,
  validatorStateWatermarks as pgValidatorStateWatermarks,
  validatorLivenessObservations as pgValidatorLivenessObservations,
  blueprintSafeStateLog as pgBlueprintSafeStateLog,
  pidTuningAudit as pgPidTuningAudit,
  twinModels as pgTwinModels,
  twinCheckpoints as pgTwinCheckpoints,
  predictiveTagThresholds as pgPredictiveTagThresholds,
  predictiveAlerts as pgPredictiveAlerts,
} from '../schema';
import {
  alarms as sqliteAlarms,
  alarmHistory as sqliteAlarmHistory,
  validatorNodes as sqliteValidatorNodes,
  validatorPubkeys as sqliteValidatorPubkeys,
  validatorStateWatermarks as sqliteValidatorStateWatermarks,
  validatorLivenessObservations as sqliteValidatorLivenessObservations,
  blueprintSafeStateLog as sqliteBlueprintSafeStateLog,
  pidTuningAudit as sqlitePidTuningAudit,
  twinModels as sqliteTwinModels,
  twinCheckpoints as sqliteTwinCheckpoints,
  predictiveTagThresholds as sqlitePredictiveTagThresholds,
  predictiveAlerts as sqlitePredictiveAlerts,
} from '../schema-sqlite';

/**
 * Schema parity (issue #7): `shared/schema.ts` (Postgres, source of truth) and
 * `shared/schema-sqlite.ts` (dev-mode fallback) must define the same tables.
 * Column *types* legitimately differ per dialect (pgEnum → text, jsonb → text,
 * timestamptz → integer, bigint → integer), but the table names, property keys,
 * and SQL column names must match so the code that touches them behaves the
 * same in dev SQLite as in production Postgres. If either schema adds, drops,
 * or renames a column without the other, this suite fails instead of the
 * divergence surfacing as a silent no-op at runtime.
 *
 * Covers the alarm tables (#7), the validator registry backing the cross-node
 * state proxy (#454), and the PID tuning audit trail (#215).
 *
 * `blueprint_safe_state_log` (#459) is covered here because a safe-state audit
 * that silently vanishes on one dialect is a safety defect, not a dev-mode
 * inconvenience.
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
  { name: 'validator_nodes', pg: pgValidatorNodes, sqlite: sqliteValidatorNodes },
  { name: 'validator_pubkeys', pg: pgValidatorPubkeys, sqlite: sqliteValidatorPubkeys },
  {
    name: 'validator_state_watermarks',
    pg: pgValidatorStateWatermarks,
    sqlite: sqliteValidatorStateWatermarks,
  },
  // #456: the observed-liveness history the what-if slashing simulator replays
  // rules against. A column present on only one dialect would silently drop
  // part of an observation record — and an observation that cannot be audited
  // is indistinguishable from an invented one.
  {
    name: 'validator_liveness_observations',
    pg: pgValidatorLivenessObservations,
    sqlite: sqliteValidatorLivenessObservations,
  },
  {
    name: 'blueprint_safe_state_log',
    pg: pgBlueprintSafeStateLog,
    sqlite: sqliteBlueprintSafeStateLog,
  },
  // #215: the tuning audit trail is written through whichever backend is
  // configured, so a column that exists on only one of them would silently
  // drop part of a plant-change record.
  { name: 'pid_tuning_audit', pg: pgPidTuningAudit, sqlite: sqlitePidTuningAudit },
  // #550: the digital-twin model registry and its committed checkpoints. A
  // column present on only one dialect would drop part of a restored model or
  // checkpoint, and a twin that comes back with partial state is worse than
  // one that refuses to come back at all.
  { name: 'twin_models', pg: pgTwinModels, sqlite: sqliteTwinModels },
  { name: 'twin_checkpoints', pg: pgTwinCheckpoints, sqlite: sqliteTwinCheckpoints },
  // #546: predictive thresholds and alert acknowledgement state. A column
  // present on only one dialect would mean an operator's configuration — or
  // the record of who acknowledged an alert — silently vanishing on the other,
  // which is the exact defect this table was added to fix.
  {
    name: 'predictive_tag_thresholds',
    pg: pgPredictiveTagThresholds,
    sqlite: sqlitePredictiveTagThresholds,
  },
  { name: 'predictive_alerts', pg: pgPredictiveAlerts, sqlite: sqlitePredictiveAlerts },
] as const;

describe('schema parity (Postgres vs SQLite dev fallback)', () => {
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
