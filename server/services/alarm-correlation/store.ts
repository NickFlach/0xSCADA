/**
 * Durable alarm-correlation store
 * ADR-0026 / ADR-0013 [13.2] — Issue #573
 *
 * The persistence half of replica-coordinated alarm correlation. It owns two
 * things:
 *
 *   1. `alarm_correlation_journal` — a single, totally-ordered, append-only log
 *      of every correlation-affecting operation. The database allocates `seq`;
 *      appends are serialised (Postgres advisory lock, SQLite BEGIN IMMEDIATE)
 *      so commit order equals `seq` order. Without that serialisation an
 *      identity value can commit after a larger one, and a reader polling for
 *      "everything above my watermark" would step over an entry that had not
 *      become visible yet — permanently losing an operator's acknowledge.
 *
 *   2. The materialised projection — groups, alarms, rules, topology, the
 *      suppression policy, and the watermark of how far the projection has got.
 *      Each entry's row changes are written in one transaction that first
 *      advances the watermark with a conditional UPDATE, so the projection is
 *      always the result of applying entries strictly in `seq` order no matter
 *      which replica does the writing.
 *
 * Two backends, chosen exactly the way `server/services/tuning/audit-store.ts`
 * and `server/storage.ts` choose theirs: PostgreSQL in production, a file-backed
 * SQLite database in development and test. There is no in-memory fallback,
 * because a correlation store that silently forgets is precisely the failure
 * this issue exists to prevent — if the store cannot be reached, the caller
 * must fail safe (disable suppression), not pretend it persisted.
 *
 * Everything here is real SQL against real tables (migration 0015). Nothing is
 * simulated, cached-and-hoped, or returned as a placeholder.
 */

import path from "node:path";
import { and, asc, eq, gt, inArray, lt } from "drizzle-orm";
import { drizzle as drizzlePostgres, type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  drizzle as drizzleSqliteProxy,
  type SqliteRemoteDatabase,
} from "drizzle-orm/sqlite-proxy";
import { Client } from "pg";
import { Database } from "sqlite3";
import {
  alarmCorrelationAlarms as pgAlarms,
  alarmCorrelationEquipment as pgEquipment,
  alarmCorrelationGroups as pgGroups,
  alarmCorrelationJournal as pgJournal,
  alarmCorrelationRules as pgRules,
  alarmCorrelationState as pgState,
} from "@shared/schema";
import {
  alarmCorrelationAlarms as sqliteAlarms,
  alarmCorrelationEquipment as sqliteEquipment,
  alarmCorrelationGroups as sqliteGroups,
  alarmCorrelationJournal as sqliteJournal,
  alarmCorrelationRules as sqliteRules,
  alarmCorrelationState as sqliteState,
} from "@shared/schema-sqlite";
import type {
  AlarmGroup,
  AlarmGroupState,
  AlarmLifecycleState,
  AlarmSeverity,
  CorrelatedAlarm,
  CorrelationJournalEntry,
  CorrelationJournalOp,
  CorrelationRule,
  CorrelationRuleType,
  EquipmentNode,
  SuppressionPolicy,
} from "@shared/types/alarm-correlation";

/** Single-row primary key of `alarm_correlation_state`. */
const STATE_ROW_ID = "default";

/**
 * Postgres advisory-lock key for journal appends. Any constant works as long as
 * every replica uses the same one; 573 is the issue number so the lock is
 * traceable in `pg_locks` without a lookup table.
 */
const JOURNAL_APPEND_LOCK_KEY = 573;

const DEFAULT_JOURNAL_PAGE = 500;

export interface JournalAppend {
  idempotencyKey: string;
  op: CorrelationJournalOp;
  payload: Record<string, unknown>;
  principal: string;
  originInstance: string;
}

export interface JournalAppendResult {
  seq: number;
  /** False when the key was already present — a duplicate delivery. */
  created: boolean;
}

/** Cumulative engine counters, persisted so a restart does not reset them. */
export interface DurableMetrics {
  alarmsIngested: number;
  groupsCreated: number;
  groupsClosed: number;
  alarmsSuppressed: number;
  alarmsUnsuppressed: number;
}

/** An alarm row plus the correlation facts that make it restorable. */
export interface PersistedAlarm {
  alarm: CorrelatedAlarm;
  groupId: string | null;
  suppressed: boolean;
  isRootCause: boolean;
  joinedViaRuleId: string | null;
  ingestSeq: number;
}

/** Row changes produced by applying one journal entry. */
export interface ProjectionChanges {
  groups: AlarmGroup[];
  alarms: PersistedAlarm[];
  deletedGroupIds: string[];
  deletedAlarmIds: string[];
  upsertRules: CorrelationRule[];
  removedRuleIds: string[];
  upsertEquipment: EquipmentNode[];
  removedEquipmentIds: string[];
  policy: SuppressionPolicy | null;
  metrics: DurableMetrics;
  principal: string;
}

export function emptyProjectionChanges(
  metrics: DurableMetrics,
  principal: string,
): ProjectionChanges {
  return {
    groups: [],
    alarms: [],
    deletedGroupIds: [],
    deletedAlarmIds: [],
    upsertRules: [],
    removedRuleIds: [],
    upsertEquipment: [],
    removedEquipmentIds: [],
    policy: null,
    metrics,
    principal,
  };
}

/** Everything a starting replica needs to reconstitute correlation state. */
export interface DurableSnapshot {
  appliedSeq: number;
  policy: SuppressionPolicy;
  metrics: DurableMetrics;
  rules: CorrelationRule[];
  equipment: EquipmentNode[];
  groups: AlarmGroup[];
  /** Tracked alarms with no group — the engine's pending set. */
  pending: CorrelatedAlarm[];
  /** alarmId → journal seq of its latest persisted state change. */
  alarmSeq: Map<string, number>;
}

export type StoreBackend = "postgres" | "sqlite" | "unopened";

export interface CorrelationStore {
  ready(): Promise<void>;
  backend(): StoreBackend;
  /** Append one operation. Idempotent on `idempotencyKey`. */
  append(entry: JournalAppend): Promise<JournalAppendResult>;
  /** Journal entries with seq strictly greater than `afterSeq`, in seq order. */
  read(afterSeq: number, limit?: number): Promise<CorrelationJournalEntry[]>;
  /** Load the materialised projection and its watermark. */
  load(): Promise<DurableSnapshot>;
  /**
   * Advance the watermark to `seq` and write that entry's row changes in one
   * transaction. Resolves false when another replica already projected `seq`,
   * in which case nothing is written.
   */
  project(seq: number, changes: ProjectionChanges): Promise<boolean>;
  /**
   * Delete journal entries strictly below the watermark and older than
   * `olderThanMs`, and closed groups (with their alarms) whose last event is
   * older than `closedOlderThanMs`. Returns what was removed.
   */
  prune(options: {
    journalOlderThanMs: number;
    closedGroupsOlderThanMs: number;
    now: number;
  }): Promise<{ journalEntries: number; groups: number; alarms: number }>;
  close(): Promise<void>;
}

// ── SQLite DDL ───────────────────────────────────────────────────────────────
//
// `migrations/0015_alarm_correlation_coordination.sql` is the Postgres source
// of truth; this mirrors it for the development/test backend, including the
// append-only trigger on the journal, so the immutability guarantee is the same
// on both. AUTOINCREMENT is required, not decorative: plain rowid assignment
// reuses the largest deleted id, and retention deletes journal rows — a reused
// `seq` would let a new group be named after a group that already existed.

const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS alarm_correlation_journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  op TEXT NOT NULL,
  payload TEXT NOT NULL,
  principal TEXT NOT NULL,
  origin_instance TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  CHECK (op IN (
    'ingest','acknowledge','clear','rule-upsert','rule-remove','rule-enabled',
    'topology-upsert','topology-remove','policy-set','sweep'
  ))
);
CREATE INDEX IF NOT EXISTS idx_alarm_corr_journal_recorded_at
  ON alarm_correlation_journal(recorded_at);
CREATE INDEX IF NOT EXISTS idx_alarm_corr_journal_op
  ON alarm_correlation_journal(op);
CREATE TRIGGER IF NOT EXISTS alarm_correlation_journal_no_update
  BEFORE UPDATE ON alarm_correlation_journal
BEGIN
  SELECT RAISE(ABORT, 'alarm_correlation_journal is append-only: UPDATE is not permitted');
END;

CREATE TABLE IF NOT EXISTS alarm_correlation_groups (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  root_cause_alarm_id TEXT NOT NULL,
  formed_by_rule_id TEXT NOT NULL,
  joined_via TEXT NOT NULL,
  max_severity TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  last_alarm_at_ms INTEGER NOT NULL,
  closed_at_ms INTEGER,
  close_reason TEXT,
  updated_seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (state IN ('open','closed'))
);
CREATE INDEX IF NOT EXISTS idx_alarm_corr_groups_state
  ON alarm_correlation_groups(state);
CREATE INDEX IF NOT EXISTS idx_alarm_corr_groups_last_alarm
  ON alarm_correlation_groups(last_alarm_at_ms);

CREATE TABLE IF NOT EXISTS alarm_correlation_alarms (
  id TEXT PRIMARY KEY,
  group_id TEXT,
  name TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  equipment_id TEXT,
  site_id TEXT,
  process_area TEXT,
  severity TEXT NOT NULL,
  state TEXT NOT NULL,
  message TEXT NOT NULL,
  event_time_ms INTEGER NOT NULL,
  alarm_value TEXT,
  alarm_limit TEXT,
  source TEXT,
  acknowledged_by TEXT,
  cleared_by TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0,
  is_root_cause INTEGER NOT NULL DEFAULT 0,
  joined_via_rule_id TEXT,
  ingest_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (severity IN ('critical','high','medium','low','info')),
  CHECK (state IN ('active','acknowledged','cleared','shelved','suppressed'))
);
CREATE INDEX IF NOT EXISTS idx_alarm_corr_alarms_group
  ON alarm_correlation_alarms(group_id);
CREATE INDEX IF NOT EXISTS idx_alarm_corr_alarms_state
  ON alarm_correlation_alarms(state);
CREATE INDEX IF NOT EXISTS idx_alarm_corr_alarms_event_time
  ON alarm_correlation_alarms(event_time_ms);

CREATE TABLE IF NOT EXISTS alarm_correlation_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL,
  config TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (type IN ('causal','hierarchy','temporal'))
);

CREATE TABLE IF NOT EXISTS alarm_correlation_equipment (
  equipment_id TEXT PRIMARY KEY,
  name TEXT,
  parent_id TEXT,
  causal_downstream TEXT NOT NULL,
  site_id TEXT,
  process_area TEXT,
  updated_by TEXT NOT NULL,
  updated_seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alarm_correlation_state (
  id TEXT PRIMARY KEY,
  applied_seq INTEGER NOT NULL DEFAULT 0,
  suppression_enabled INTEGER NOT NULL DEFAULT 0,
  never_suppress_at_or_above TEXT NOT NULL DEFAULT 'critical',
  unsuppress_on_root_clear INTEGER NOT NULL DEFAULT 1,
  alarms_ingested INTEGER NOT NULL DEFAULT 0,
  groups_created INTEGER NOT NULL DEFAULT 0,
  groups_closed INTEGER NOT NULL DEFAULT 0,
  alarms_suppressed INTEGER NOT NULL DEFAULT 0,
  alarms_unsuppressed INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT NOT NULL DEFAULT 'system',
  updated_at INTEGER NOT NULL,
  CHECK (id = 'default'),
  CHECK (unsuppress_on_root_clear = 1),
  CHECK (never_suppress_at_or_above IN ('critical','high','medium','low','info'))
);
`;

// ── Connection plumbing (mirrors server/services/tuning/audit-store.ts) ───────

type SqliteDrizzle = SqliteRemoteDatabase<Record<string, never>>;
type PostgresDrizzle = NodePgDatabase<Record<string, never>>;

interface PostgresConnection {
  kind: "postgres";
  client: Client;
  db: PostgresDrizzle;
}

interface SqliteConnection {
  kind: "sqlite";
  client: Database;
  db: SqliteDrizzle;
}

type Connection = PostgresConnection | SqliteConnection;

export interface CorrelationStoreOptions {
  postgresUrl?: string;
  sqlitePath?: string;
}

function resolvePostgresUrl(options: CorrelationStoreOptions): string | undefined {
  if (options.postgresUrl) return options.postgresUrl;
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  if (process.env.FORCE_POSTGRES === "false") return undefined;
  if (process.env.NODE_ENV === "development") return undefined;
  return url;
}

function resolveSqlitePath(options: CorrelationStoreOptions): string {
  return options.sqlitePath
    ?? process.env.ALARM_CORRELATION_SQLITE_PATH
    ?? process.env.SQLITE_DATABASE_PATH
    ?? path.join(process.cwd(), "dev-database.sqlite");
}

function sqliteExec(client: Database, sqlText: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.exec(sqlText, (error) => (error ? reject(error) : resolve()));
  });
}

function sqliteRun(client: Database, sqlText: string, params: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    client.run(sqlText, params, (error) => (error ? reject(error) : resolve()));
  });
}

function sqliteAll(
  client: Database,
  sqlText: string,
  params: unknown[],
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    client.all(sqlText, params, (error, rows) =>
      (error ? reject(error) : resolve(rows as Record<string, unknown>[])));
  });
}

/**
 * drizzle-orm's SQLite proxy driver maps result columns positionally while
 * node-sqlite3 hands back objects, materialised in result-column order. Every
 * column of every table here has a distinct name within its own table and no
 * query in this module joins tables, so ordered values reconstruct the
 * positional row exactly.
 */
function positionalRow(row: Record<string, unknown>): unknown[] {
  return Object.values(row);
}

// ── Row ⇆ domain conversion ──────────────────────────────────────────────────

type JsonScalar = number | string | null | undefined;

function toWireValue(raw: unknown): number | string | undefined {
  if (typeof raw === "number" || typeof raw === "string") return raw;
  return undefined;
}

interface AlarmRowShape {
  id: string;
  groupId: string | null;
  name: string;
  tagId: string;
  equipmentId: string | null;
  siteId: string | null;
  processArea: string | null;
  severity: string;
  state: string;
  message: string;
  eventTimeMs: number;
  alarmValue: unknown;
  alarmLimit: unknown;
  source: string | null;
  acknowledgedBy: string | null;
  clearedBy: string | null;
  suppressed: boolean;
  isRootCause: boolean;
  joinedViaRuleId: string | null;
  ingestSeq: number;
  updatedSeq: number;
}

function rowToAlarm(row: AlarmRowShape): CorrelatedAlarm {
  return {
    id: row.id,
    name: row.name,
    tagId: row.tagId,
    equipmentId: row.equipmentId ?? undefined,
    siteId: row.siteId ?? undefined,
    processArea: row.processArea ?? undefined,
    severity: row.severity as AlarmSeverity,
    state: row.state as AlarmLifecycleState,
    message: row.message,
    timestamp: Number(row.eventTimeMs),
    value: toWireValue(row.alarmValue),
    limit: toWireValue(row.alarmLimit),
    source: row.source ?? undefined,
    acknowledgedBy: row.acknowledgedBy ?? undefined,
    clearedBy: row.clearedBy ?? undefined,
  };
}

function alarmValues(entry: PersistedAlarm, seq: number, now: Date) {
  const { alarm } = entry;
  return {
    id: alarm.id,
    groupId: entry.groupId,
    name: alarm.name,
    tagId: alarm.tagId,
    equipmentId: alarm.equipmentId ?? null,
    siteId: alarm.siteId ?? null,
    processArea: alarm.processArea ?? null,
    severity: alarm.severity,
    state: alarm.state,
    message: alarm.message,
    eventTimeMs: alarm.timestamp,
    alarmValue: (alarm.value ?? null) as JsonScalar,
    alarmLimit: (alarm.limit ?? null) as JsonScalar,
    source: alarm.source ?? null,
    acknowledgedBy: alarm.acknowledgedBy ?? null,
    clearedBy: alarm.clearedBy ?? null,
    suppressed: entry.suppressed,
    isRootCause: entry.isRootCause,
    joinedViaRuleId: entry.joinedViaRuleId,
    ingestSeq: entry.ingestSeq,
    updatedSeq: seq,
    updatedAt: now,
  };
}

function groupValues(group: AlarmGroup, seq: number, now: Date) {
  return {
    id: group.id,
    state: group.state,
    rootCauseAlarmId: group.rootCauseAlarmId,
    formedByRuleId: group.formedByRuleId,
    joinedVia: group.joinedVia,
    maxSeverity: group.maxSeverity,
    createdAtMs: group.createdAt,
    lastAlarmAtMs: group.lastAlarmAt,
    closedAtMs: group.closedAt ?? null,
    closeReason: group.closeReason ?? null,
    updatedSeq: seq,
    updatedAt: now,
  };
}

function ruleValues(rule: CorrelationRule, seq: number, principal: string, now: Date) {
  return {
    id: rule.id,
    name: rule.name,
    type: rule.type,
    enabled: rule.enabled,
    priority: rule.priority,
    config: rule.config,
    updatedBy: principal,
    updatedSeq: seq,
    updatedAt: now,
  };
}

function equipmentValues(
  node: EquipmentNode,
  seq: number,
  principal: string,
  now: Date,
) {
  return {
    equipmentId: node.equipmentId,
    name: node.name ?? null,
    parentId: node.parentId ?? null,
    causalDownstream: node.causalDownstream,
    siteId: node.siteId ?? null,
    processArea: node.processArea ?? null,
    updatedBy: principal,
    updatedSeq: seq,
    updatedAt: now,
  };
}

/** Chunked so a burst never builds a statement with too many bind parameters. */
const UPSERT_CHUNK = 100;

function chunk<T>(items: T[], size = UPSERT_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class DrizzleCorrelationStore implements CorrelationStore {
  private connection: Connection | undefined;
  private opening: Promise<Connection> | undefined;
  /**
   * In-process serialisation. Both backends here own a single physical
   * connection, so overlapping transactions on it would interleave `BEGIN` and
   * `COMMIT` from different logical operations. Cross-process serialisation is
   * the database's job (advisory lock / BEGIN IMMEDIATE); this only prevents
   * this process from fighting itself.
   */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: CorrelationStoreOptions = {}) {}

  backend(): StoreBackend {
    return this.connection?.kind ?? "unopened";
  }

  async ready(): Promise<void> {
    await this.connect();
  }

  async append(entry: JournalAppend): Promise<JournalAppendResult> {
    return this.serialize(async () => {
      const connection = await this.connect();
      return this.inTransaction(connection, async () => {
        const existing = await this.seqForKey(connection, entry.idempotencyKey);
        if (existing !== null) return { seq: existing, created: false };

        const now = new Date();
        if (connection.kind === "postgres") {
          await connection.db.insert(pgJournal).values({
            idempotencyKey: entry.idempotencyKey,
            op: entry.op,
            payload: entry.payload,
            principal: entry.principal,
            originInstance: entry.originInstance,
            recordedAt: now,
          });
        } else {
          await connection.db.insert(sqliteJournal).values({
            idempotencyKey: entry.idempotencyKey,
            op: entry.op,
            payload: entry.payload,
            principal: entry.principal,
            originInstance: entry.originInstance,
            recordedAt: now,
          });
        }

        const seq = await this.seqForKey(connection, entry.idempotencyKey);
        if (seq === null) {
          throw new Error(
            `alarm correlation journal append for "${entry.idempotencyKey}" did not persist`,
          );
        }
        return { seq, created: true };
      });
    });
  }

  async read(afterSeq: number, limit = DEFAULT_JOURNAL_PAGE): Promise<CorrelationJournalEntry[]> {
    const connection = await this.connect();
    if (connection.kind === "postgres") {
      const rows = await connection.db
        .select()
        .from(pgJournal)
        .where(gt(pgJournal.seq, afterSeq))
        .orderBy(asc(pgJournal.seq))
        .limit(limit);
      return rows.map((row) => ({
        seq: Number(row.seq),
        idempotencyKey: row.idempotencyKey,
        op: row.op as CorrelationJournalOp,
        payload: row.payload as Record<string, unknown>,
        principal: row.principal,
        originInstance: row.originInstance,
        recordedAt: row.recordedAt.getTime(),
      }));
    }
    const rows = await connection.db
      .select()
      .from(sqliteJournal)
      .where(gt(sqliteJournal.seq, afterSeq))
      .orderBy(asc(sqliteJournal.seq))
      .limit(limit);
    return rows.map((row) => ({
      seq: Number(row.seq),
      idempotencyKey: row.idempotencyKey,
      op: row.op as CorrelationJournalOp,
      payload: row.payload as Record<string, unknown>,
      principal: row.principal,
      originInstance: row.originInstance,
      recordedAt: row.recordedAt.getTime(),
    }));
  }

  async load(): Promise<DurableSnapshot> {
    const connection = await this.connect();
    const stateRow = await this.readStateRow(connection);

    const ruleRows = connection.kind === "postgres"
      ? await connection.db.select().from(pgRules)
      : await connection.db.select().from(sqliteRules);
    const rules: CorrelationRule[] = ruleRows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type as CorrelationRuleType,
      enabled: Boolean(row.enabled),
      priority: Number(row.priority),
      config: row.config as CorrelationRule["config"],
    }));

    const equipmentRows = connection.kind === "postgres"
      ? await connection.db.select().from(pgEquipment)
      : await connection.db.select().from(sqliteEquipment);
    const equipment: EquipmentNode[] = equipmentRows.map((row) => ({
      equipmentId: row.equipmentId,
      name: row.name ?? undefined,
      parentId: row.parentId ?? undefined,
      causalDownstream: Array.isArray(row.causalDownstream)
        ? (row.causalDownstream as string[])
        : [],
      siteId: row.siteId ?? undefined,
      processArea: row.processArea ?? undefined,
    }));

    const groupRows = connection.kind === "postgres"
      ? await connection.db.select().from(pgGroups)
      : await connection.db.select().from(sqliteGroups);
    const alarmRows = (connection.kind === "postgres"
      ? await connection.db.select().from(pgAlarms).orderBy(asc(pgAlarms.ingestSeq))
      : await connection.db
        .select()
        .from(sqliteAlarms)
        .orderBy(asc(sqliteAlarms.ingestSeq))) as unknown as AlarmRowShape[];

    const alarmSeq = new Map<string, number>();
    const byGroup = new Map<string, AlarmRowShape[]>();
    const pending: CorrelatedAlarm[] = [];
    for (const row of alarmRows) {
      alarmSeq.set(row.id, Number(row.updatedSeq));
      if (row.groupId === null) {
        pending.push(rowToAlarm(row));
        continue;
      }
      const bucket = byGroup.get(row.groupId);
      if (bucket) bucket.push(row);
      else byGroup.set(row.groupId, [row]);
    }

    const groups: AlarmGroup[] = [];
    for (const row of groupRows) {
      const members = byGroup.get(row.id) ?? [];
      // Ingestion order is the engine's member order; ingest_seq is exactly
      // that order and is stable across replicas.
      members.sort((a, b) => Number(a.ingestSeq) - Number(b.ingestSeq));
      const joinedVia: Record<string, string> = {
        ...(row.joinedVia as Record<string, string> | null ?? {}),
      };
      for (const member of members) {
        if (member.joinedViaRuleId) joinedVia[member.id] = member.joinedViaRuleId;
      }
      groups.push({
        id: row.id,
        state: row.state as AlarmGroupState,
        alarms: members.map(rowToAlarm),
        alarmIds: members.map((member) => member.id),
        rootCauseAlarmId: row.rootCauseAlarmId,
        formedByRuleId: row.formedByRuleId,
        joinedVia,
        suppressedAlarmIds: members
          .filter((member) => Boolean(member.suppressed))
          .map((member) => member.id),
        maxSeverity: row.maxSeverity as AlarmSeverity,
        createdAt: Number(row.createdAtMs),
        lastAlarmAt: Number(row.lastAlarmAtMs),
        closedAt: row.closedAtMs === null ? undefined : Number(row.closedAtMs),
        closeReason: (row.closeReason ?? undefined) as AlarmGroup["closeReason"],
      });
    }

    return {
      appliedSeq: stateRow.appliedSeq,
      policy: stateRow.policy,
      metrics: stateRow.metrics,
      rules,
      equipment,
      groups,
      pending,
      alarmSeq,
    };
  }

  async project(seq: number, changes: ProjectionChanges): Promise<boolean> {
    return this.serialize(async () => {
      const connection = await this.connect();
      return this.inTransaction(connection, async () => {
        const advanced = await this.advanceWatermark(connection, seq, changes);
        // Losing the race is normal and not an error: another replica already
        // projected this entry, and it wrote the same deterministic result.
        if (!advanced) return false;

        const now = new Date();
        await this.writeRows(connection, seq, changes, now);
        return true;
      });
    });
  }

  async prune(options: {
    journalOlderThanMs: number;
    closedGroupsOlderThanMs: number;
    now: number;
  }): Promise<{ journalEntries: number; groups: number; alarms: number }> {
    return this.serialize(async () => {
      const connection = await this.connect();
      return this.inTransaction(connection, async () => {
        const state = await this.readStateRow(connection);
        const journalCutoff = new Date(options.now - options.journalOlderThanMs);
        const groupCutoff = options.now - options.closedGroupsOlderThanMs;

        // Never at or above the watermark: an unprojected entry is the only
        // record of an operator's acknowledge or clear.
        let journalEntries = 0;
        if (state.appliedSeq > 0) {
          journalEntries = connection.kind === "postgres"
            ? await this.deleteCount(
              connection,
              connection.db
                .delete(pgJournal)
                .where(and(
                  lt(pgJournal.seq, state.appliedSeq),
                  lt(pgJournal.recordedAt, journalCutoff),
                )),
            )
            : await this.deleteCount(
              connection,
              connection.db
                .delete(sqliteJournal)
                .where(and(
                  lt(sqliteJournal.seq, state.appliedSeq),
                  lt(sqliteJournal.recordedAt, journalCutoff),
                )),
            );
        }

        // Only CLOSED groups age out. An open group, or any alarm still
        // suppressed, is live safety state and is never pruned by age.
        const staleGroupIds = connection.kind === "postgres"
          ? (await connection.db
            .select({ id: pgGroups.id })
            .from(pgGroups)
            .where(and(
              eq(pgGroups.state, "closed"),
              lt(pgGroups.lastAlarmAtMs, groupCutoff),
            ))).map((row) => row.id)
          : (await connection.db
            .select({ id: sqliteGroups.id })
            .from(sqliteGroups)
            .where(and(
              eq(sqliteGroups.state, "closed"),
              lt(sqliteGroups.lastAlarmAtMs, groupCutoff),
            ))).map((row) => row.id);

        let alarms = 0;
        let groups = 0;
        for (const ids of chunk(staleGroupIds)) {
          if (connection.kind === "postgres") {
            alarms += await this.deleteCount(
              connection,
              connection.db.delete(pgAlarms).where(inArray(pgAlarms.groupId, ids)),
            );
            groups += await this.deleteCount(
              connection,
              connection.db.delete(pgGroups).where(inArray(pgGroups.id, ids)),
            );
          } else {
            alarms += await this.deleteCount(
              connection,
              connection.db.delete(sqliteAlarms).where(inArray(sqliteAlarms.groupId, ids)),
            );
            groups += await this.deleteCount(
              connection,
              connection.db.delete(sqliteGroups).where(inArray(sqliteGroups.id, ids)),
            );
          }
        }

        return { journalEntries, groups, alarms };
      });
    });
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.opening = undefined;
    if (!connection) return;
    if (connection.kind === "postgres") {
      await connection.client.end();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      connection.client.close((error) => (error ? reject(error) : resolve()));
    });
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    // Keep the chain alive after a rejection so one failed operation does not
    // wedge every later one.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async inTransaction<T>(
    connection: Connection,
    work: () => Promise<T>,
  ): Promise<T> {
    if (connection.kind === "postgres") {
      await connection.client.query("BEGIN");
      try {
        // Serialises appends across replicas so identity allocation order
        // equals commit order, and serialises projection races so the
        // conditional watermark update is decisive.
        await connection.client.query("SELECT pg_advisory_xact_lock($1)", [
          JOURNAL_APPEND_LOCK_KEY,
        ]);
        const result = await work();
        await connection.client.query("COMMIT");
        return result;
      } catch (error) {
        await connection.client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }

    // BEGIN IMMEDIATE takes SQLite's write lock up front, giving the same
    // "one writer at a time across processes" property as the advisory lock.
    await sqliteRun(connection.client, "BEGIN IMMEDIATE", []);
    try {
      const result = await work();
      await sqliteRun(connection.client, "COMMIT", []);
      return result;
    } catch (error) {
      await sqliteRun(connection.client, "ROLLBACK", []).catch(() => undefined);
      throw error;
    }
  }

  private async seqForKey(
    connection: Connection,
    idempotencyKey: string,
  ): Promise<number | null> {
    if (connection.kind === "postgres") {
      const rows = await connection.db
        .select({ seq: pgJournal.seq })
        .from(pgJournal)
        .where(eq(pgJournal.idempotencyKey, idempotencyKey))
        .limit(1);
      return rows.length > 0 ? Number(rows[0].seq) : null;
    }
    const rows = await connection.db
      .select({ seq: sqliteJournal.seq })
      .from(sqliteJournal)
      .where(eq(sqliteJournal.idempotencyKey, idempotencyKey))
      .limit(1);
    return rows.length > 0 ? Number(rows[0].seq) : null;
  }

  private async readStateRow(connection: Connection): Promise<{
    appliedSeq: number;
    policy: SuppressionPolicy;
    metrics: DurableMetrics;
  }> {
    const rows = connection.kind === "postgres"
      ? await connection.db.select().from(pgState).where(eq(pgState.id, STATE_ROW_ID)).limit(1)
      : await connection.db
        .select()
        .from(sqliteState)
        .where(eq(sqliteState.id, STATE_ROW_ID))
        .limit(1);

    if (rows.length === 0) {
      return {
        appliedSeq: 0,
        // Suppression off is the only safe default for a store that has never
        // been written: nothing is known about what an operator intended.
        policy: {
          enabled: false,
          neverSuppressAtOrAbove: "critical",
          unsuppressOnRootClear: true,
        },
        metrics: {
          alarmsIngested: 0,
          groupsCreated: 0,
          groupsClosed: 0,
          alarmsSuppressed: 0,
          alarmsUnsuppressed: 0,
        },
      };
    }

    const row = rows[0];
    return {
      appliedSeq: Number(row.appliedSeq),
      policy: {
        enabled: Boolean(row.suppressionEnabled),
        neverSuppressAtOrAbove: row.neverSuppressAtOrAbove as AlarmSeverity,
        unsuppressOnRootClear: true,
      },
      metrics: {
        alarmsIngested: Number(row.alarmsIngested),
        groupsCreated: Number(row.groupsCreated),
        groupsClosed: Number(row.groupsClosed),
        alarmsSuppressed: Number(row.alarmsSuppressed),
        alarmsUnsuppressed: Number(row.alarmsUnsuppressed),
      },
    };
  }

  /**
   * Conditional watermark advance. Returns false — writing nothing — when the
   * stored watermark is already at or past `seq`, which is how two replicas
   * projecting concurrently still produce a strictly seq-ordered projection.
   */
  private async advanceWatermark(
    connection: Connection,
    seq: number,
    changes: ProjectionChanges,
  ): Promise<boolean> {
    const now = new Date();
    const policy = changes.policy;
    const base = {
      appliedSeq: seq,
      alarmsIngested: changes.metrics.alarmsIngested,
      groupsCreated: changes.metrics.groupsCreated,
      groupsClosed: changes.metrics.groupsClosed,
      alarmsSuppressed: changes.metrics.alarmsSuppressed,
      alarmsUnsuppressed: changes.metrics.alarmsUnsuppressed,
      updatedBy: changes.principal,
      updatedAt: now,
      ...(policy
        ? {
          suppressionEnabled: policy.enabled,
          neverSuppressAtOrAbove: policy.neverSuppressAtOrAbove,
          unsuppressOnRootClear: true,
        }
        : {}),
    };

    if (connection.kind === "postgres") {
      const inserted = await connection.db
        .insert(pgState)
        .values({ id: STATE_ROW_ID, ...base })
        .onConflictDoUpdate({
          target: pgState.id,
          set: base,
          where: lt(pgState.appliedSeq, seq),
        })
        .returning({ appliedSeq: pgState.appliedSeq });
      return inserted.length > 0;
    }

    await connection.db
      .insert(sqliteState)
      .values({ id: STATE_ROW_ID, ...base })
      .onConflictDoUpdate({
        target: sqliteState.id,
        set: base,
        where: lt(sqliteState.appliedSeq, seq),
      });
    // sqlite-proxy does not surface affected-row counts, so confirm by reading
    // the watermark back inside the same transaction.
    const after = await this.readStateRow(connection);
    return after.appliedSeq === seq;
  }

  private async writeRows(
    connection: Connection,
    seq: number,
    changes: ProjectionChanges,
    now: Date,
  ): Promise<void> {
    if (connection.kind === "postgres") {
      // One statement per row, with the row itself as the conflict SET. Batched
      // upserts would need `excluded.<col>` expressions built from column names,
      // and a hand-built SET is exactly where a column silently stops being
      // written. Row counts per journal entry are bounded by maxAlarmsPerGroup.
      for (const group of changes.groups) {
        const values = groupValues(group, seq, now);
        await connection.db.insert(pgGroups).values(values)
          .onConflictDoUpdate({ target: pgGroups.id, set: values });
      }
      for (const entry of changes.alarms) {
        const values = alarmValues(entry, seq, now);
        await connection.db.insert(pgAlarms).values(values)
          .onConflictDoUpdate({ target: pgAlarms.id, set: values });
      }
      for (const rule of changes.upsertRules) {
        const values = ruleValues(rule, seq, changes.principal, now);
        await connection.db.insert(pgRules).values(values)
          .onConflictDoUpdate({ target: pgRules.id, set: values });
      }
      for (const node of changes.upsertEquipment) {
        const values = equipmentValues(node, seq, changes.principal, now);
        await connection.db.insert(pgEquipment).values(values)
          .onConflictDoUpdate({ target: pgEquipment.equipmentId, set: values });
      }
      for (const ids of chunk(changes.deletedAlarmIds)) {
        await connection.db.delete(pgAlarms).where(inArray(pgAlarms.id, ids));
      }
      for (const ids of chunk(changes.deletedGroupIds)) {
        await connection.db.delete(pgGroups).where(inArray(pgGroups.id, ids));
      }
      for (const ids of chunk(changes.removedRuleIds)) {
        await connection.db.delete(pgRules).where(inArray(pgRules.id, ids));
      }
      for (const ids of chunk(changes.removedEquipmentIds)) {
        await connection.db
          .delete(pgEquipment)
          .where(inArray(pgEquipment.equipmentId, ids));
      }
      return;
    }

    for (const group of changes.groups) {
      const values = groupValues(group, seq, now);
      await connection.db.insert(sqliteGroups).values(values)
        .onConflictDoUpdate({ target: sqliteGroups.id, set: values });
    }
    for (const entry of changes.alarms) {
      const values = alarmValues(entry, seq, now);
      await connection.db.insert(sqliteAlarms).values(values)
        .onConflictDoUpdate({ target: sqliteAlarms.id, set: values });
    }
    for (const rule of changes.upsertRules) {
      const values = ruleValues(rule, seq, changes.principal, now);
      await connection.db.insert(sqliteRules).values(values)
        .onConflictDoUpdate({ target: sqliteRules.id, set: values });
    }
    for (const node of changes.upsertEquipment) {
      const values = equipmentValues(node, seq, changes.principal, now);
      await connection.db.insert(sqliteEquipment).values(values)
        .onConflictDoUpdate({ target: sqliteEquipment.equipmentId, set: values });
    }
    for (const ids of chunk(changes.deletedAlarmIds)) {
      await connection.db.delete(sqliteAlarms).where(inArray(sqliteAlarms.id, ids));
    }
    for (const ids of chunk(changes.deletedGroupIds)) {
      await connection.db.delete(sqliteGroups).where(inArray(sqliteGroups.id, ids));
    }
    for (const ids of chunk(changes.removedRuleIds)) {
      await connection.db.delete(sqliteRules).where(inArray(sqliteRules.id, ids));
    }
    for (const ids of chunk(changes.removedEquipmentIds)) {
      await connection.db
        .delete(sqliteEquipment)
        .where(inArray(sqliteEquipment.equipmentId, ids));
    }
  }

  private async deleteCount(
    connection: Connection,
    query: { toSQL(): { sql: string; params: unknown[] } },
  ): Promise<number> {
    const compiled = query.toSQL();
    if (connection.kind === "postgres") {
      const result = await connection.client.query(compiled.sql, compiled.params);
      return result.rowCount ?? 0;
    }
    return new Promise<number>((resolve, reject) => {
      connection.client.run(
        compiled.sql,
        compiled.params,
        function onDone(this: { changes: number }, error: Error | null) {
          if (error) reject(error);
          else resolve(this.changes);
        },
      );
    });
  }

  private connect(): Promise<Connection> {
    if (this.connection) return Promise.resolve(this.connection);
    if (this.opening) return this.opening;

    this.opening = this.openConnection()
      .then((connection) => {
        this.connection = connection;
        return connection;
      })
      .catch((error: unknown) => {
        // Let the next caller retry rather than caching a failed connection.
        this.opening = undefined;
        throw error;
      });
    return this.opening;
  }

  private async openConnection(): Promise<Connection> {
    const postgresUrl = resolvePostgresUrl(this.options);
    if (postgresUrl) {
      const client = new Client({ connectionString: postgresUrl });
      await client.connect();
      return { kind: "postgres", client, db: drizzlePostgres(client) };
    }

    const filePath = resolveSqlitePath(this.options);
    const client = await new Promise<Database>((resolve, reject) => {
      const opened: Database = new Database(filePath, (error) =>
        (error ? reject(error) : resolve(opened)));
    });
    // node-sqlite3 dispatches statements in parallel by default, which would
    // let a BEGIN IMMEDIATE and the statements inside that transaction
    // interleave with another logical operation on the same handle.
    client.serialize();
    // WAL lets a second replica read while one writes, and `busy_timeout` makes
    // BEGIN IMMEDIATE wait for the write lock instead of failing immediately —
    // which is what "one writer at a time across processes" actually requires.
    // `synchronous=FULL` is kept: this store exists so alarm state survives, and
    // trading durability for commit latency here would defeat the whole issue.
    await sqliteExec(
      client,
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
    );
    await sqliteExec(client, SQLITE_DDL);
    // Idempotent seed of the singleton row; matches the migration's INSERT.
    await sqliteRun(
      client,
      "INSERT OR IGNORE INTO alarm_correlation_state (id, updated_at) VALUES ('default', ?)",
      [Date.now()],
    );

    const db = drizzleSqliteProxy(async (sqlText, params, method) => {
      if (method === "run") {
        await sqliteRun(client, sqlText, params);
        return { rows: [] };
      }
      const rows = await sqliteAll(client, sqlText, params);
      if (method === "get") {
        return { rows: rows.length > 0 ? positionalRow(rows[0]) : [] };
      }
      return { rows: rows.map(positionalRow) };
    });

    return { kind: "sqlite", client, db };
  }
}
