/**
 * Durable predictive-maintenance state store
 * ADR-0013 [13.1] — Issues #212 / #493, made durable by #546
 *
 * The persistence boundary for the two kinds of predictive state that must
 * outlive a process:
 *
 *   1. operator-configured per-tag thresholds (`predictive_tag_thresholds`)
 *   2. generated alerts and their acknowledgement audit
 *      (`predictive_alerts`)
 *
 * Raw prediction history is deliberately NOT in this boundary. It is a
 * recomputable in-process sliding window with its own, separate retention
 * (`PredictiveMaintenanceEngine.maxHistorySize` / `maxTrackedTags`); see the
 * rationale in `migrations/0013_predictive_durable_state.sql`.
 *
 * Everything here is real Drizzle against real tables — there is no in-memory
 * fallback. If the store cannot be reached, callers get a
 * `PredictiveStoreUnavailableError` and the mutation is refused, because a
 * threshold change or an acknowledgement that is only in RAM is exactly the
 * defect this module exists to remove.
 *
 * Two backends, matching how `server/storage.ts` and
 * `server/services/tuning/audit-store.ts` choose theirs:
 *   - PostgreSQL (production) via drizzle-orm/node-postgres, tables from
 *     migration 0013
 *   - SQLite (development/test fallback) via drizzle-orm/sqlite-proxy over the
 *     repo's `sqlite3` driver, tables from the DDL below
 *
 * The store owns its own connection rather than borrowing the shared handle in
 * `server/storage.ts`, which serialises every caller behind one physical
 * connection and one application-level transaction mutex. An acknowledgement
 * must not queue behind a blueprint import.
 *
 * MULTI-REPLICA. Nothing here assumes a single writer:
 *   - alert inserts are idempotent (`ON CONFLICT DO NOTHING`) against a
 *     content-derived primary key, so two replicas that observe the same
 *     anomaly converge on one row instead of writing two;
 *   - acknowledgement is a conditional UPDATE guarded on `acknowledged =
 *     false`, so the first acknowledgement wins and a concurrent second one is
 *     reported as `already-acknowledged` rather than silently overwriting the
 *     original attribution.
 */

import path from "node:path";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { drizzle as drizzlePostgres, type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  drizzle as drizzleSqliteProxy,
  type SqliteRemoteDatabase,
} from "drizzle-orm/sqlite-proxy";
import { Client } from "pg";
import { Database } from "sqlite3";
import {
  predictiveAlerts as pgAlerts,
  predictiveTagThresholds as pgThresholds,
} from "@shared/schema";
import {
  predictiveAlerts as sqliteAlerts,
  predictiveTagThresholds as sqliteThresholds,
} from "@shared/schema-sqlite";
import type {
  AcknowledgeStatus,
  FailureLimits,
  PredictiveAlert,
  SeverityLevel,
  SeverityThresholds,
  TagThresholds,
} from "@shared/types/predictive";

/**
 * Raised whenever durable state could not be read or written. Every caller
 * treats this as fail-closed: the route returns 503 and no in-memory state is
 * mutated, so the process never reports success for something that was not
 * recorded.
 */
export class PredictiveStoreUnavailableError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "PredictiveStoreUnavailableError";
    this.cause = cause;
  }
}

export interface StoredThresholds {
  tagId: string;
  thresholds: TagThresholds;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AlertFilter {
  severity?: SeverityLevel;
  acknowledged?: boolean;
  tagId?: string;
  limit?: number;
}

export interface AlertCounts {
  total: number;
  unacknowledged: number;
}

export interface PruneRequest {
  /** Acknowledged alerts created before this instant are removed. */
  acknowledgedBefore: Date;
  /** Any alert created before this instant is removed, acknowledged or not. */
  anyBefore: Date;
  /** Hard row cap; excess rows are evicted acknowledged-first, oldest-first. */
  maxRows: number;
}

export interface PruneResult {
  /** Acknowledged rows removed by the retention window. */
  retired: number;
  /** Rows removed by the absolute max-age cut-off, regardless of state. */
  expired: number;
  /** Rows removed to hold the row cap. */
  overflow: number;
  /** Ids removed by the row cap that had never been acknowledged. */
  unacknowledgedEvicted: string[];
}

export interface PredictiveStore {
  /** Open the connection and ensure the schema exists. Safe to call repeatedly. */
  ready(): Promise<void>;
  /** Backend actually in use, for /status reporting. */
  backend(): "postgres" | "sqlite" | "unopened";
  getThresholds(tagId: string): Promise<StoredThresholds | null>;
  listThresholds(): Promise<StoredThresholds[]>;
  upsertThresholds(input: {
    thresholds: TagThresholds;
    updatedBy: string;
    at: Date;
  }): Promise<StoredThresholds>;
  countThresholds(): Promise<number>;
  /**
   * Insert an alert. Returns false when the content-derived id already exists,
   * which is how alert suppression works across restarts and replicas.
   */
  insertAlert(alert: PredictiveAlert): Promise<boolean>;
  getAlert(alertId: string): Promise<PredictiveAlert | null>;
  listAlerts(filter?: AlertFilter): Promise<PredictiveAlert[]>;
  countAlerts(): Promise<AlertCounts>;
  /** Conditional, first-writer-wins acknowledgement. */
  acknowledgeAlert(
    alertId: string,
    acknowledgedBy: string,
    at: Date,
  ): Promise<{ status: AcknowledgeStatus; alert: PredictiveAlert | null }>;
  prune(request: PruneRequest): Promise<PruneResult>;
  close(): Promise<void>;
}

const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1000;

/**
 * SQLite DDL. `migrations/0013_predictive_durable_state.sql` is the Postgres
 * source of truth; this mirrors it for the dev/test fallback, including the
 * acknowledgement-attribution CHECK, so "acknowledged with no acknowledger" is
 * impossible on both backends.
 *
 * Column order matches both Drizzle declarations — drizzle's sqlite-proxy
 * driver maps result columns positionally.
 *
 * `busy_timeout` is set because `server/storage.ts` and
 * `server/services/tuning/audit-store.ts` open their own handles onto the same
 * development file; a concurrent writer should block briefly rather than fail
 * a threshold write with SQLITE_BUSY.
 */
const SQLITE_DDL = `
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS predictive_tag_thresholds (
  tag_id TEXT PRIMARY KEY,
  min_samples INTEGER NOT NULL,
  z_score_threshold REAL NOT NULL,
  ewma_alpha REAL NOT NULL,
  ewma_l REAL NOT NULL,
  iqr_multiplier REAL NOT NULL,
  ensemble_weights TEXT NOT NULL,
  severity_thresholds TEXT NOT NULL,
  failure_limits TEXT,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_predictive_thresholds_updated_at
  ON predictive_tag_thresholds(updated_at);
CREATE TABLE IF NOT EXISTS predictive_alerts (
  id TEXT PRIMARY KEY,
  tag_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  score REAL NOT NULL,
  message TEXT NOT NULL,
  detectors TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  acknowledged_by TEXT,
  acknowledged_at INTEGER,
  CONSTRAINT predictive_alerts_severity_check
    CHECK (severity IN ('info', 'warning', 'critical', 'emergency')),
  CONSTRAINT predictive_alerts_ack_attribution_check
    CHECK (
      (acknowledged = 0 AND acknowledged_by IS NULL AND acknowledged_at IS NULL)
      OR (acknowledged = 1 AND acknowledged_by IS NOT NULL AND acknowledged_at IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS idx_predictive_alerts_tag
  ON predictive_alerts(tag_id);
CREATE INDEX IF NOT EXISTS idx_predictive_alerts_severity
  ON predictive_alerts(severity);
CREATE INDEX IF NOT EXISTS idx_predictive_alerts_acknowledged
  ON predictive_alerts(acknowledged);
CREATE INDEX IF NOT EXISTS idx_predictive_alerts_created_at
  ON predictive_alerts(created_at);
`;

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

export interface PredictiveStoreOptions {
  /** Explicit PostgreSQL URL; defaults to the DATABASE_URL selection below. */
  postgresUrl?: string;
  /** Explicit SQLite file; defaults to PREDICTIVE_SQLITE_PATH/SQLITE_DATABASE_PATH. */
  sqlitePath?: string;
}

/**
 * Mirrors `server/storage.ts`: Postgres only when a URL is configured, the
 * Postgres override is not disabled, and the process is not in development
 * mode. Everything else falls back to the file-backed SQLite database.
 */
function resolvePostgresUrl(options: PredictiveStoreOptions): string | undefined {
  if (options.postgresUrl) return options.postgresUrl;
  // An explicit SQLite path is an explicit backend choice and must not be
  // overridden by an ambient DATABASE_URL — otherwise a test (or a tool) that
  // names its own database file would silently write to production.
  if (options.sqlitePath) return undefined;
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  if (process.env.FORCE_POSTGRES === "false") return undefined;
  if (process.env.NODE_ENV === "development") return undefined;
  return url;
}

function resolveSqlitePath(options: PredictiveStoreOptions): string {
  return options.sqlitePath
    ?? process.env.PREDICTIVE_SQLITE_PATH
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
      error ? reject(error) : resolve(rows as Record<string, unknown>[]));
  });
}

/**
 * drizzle-orm's SQLite proxy driver maps result columns positionally, while
 * node-sqlite3 hands back objects. node-sqlite3 materialises those objects in
 * result-column order and every column of both tables has a distinct
 * snake_case name, so ordered values reconstruct the positional row exactly.
 */
function positionalRow(row: Record<string, unknown>): unknown[] {
  return Object.values(row);
}

/** Shape shared by the Postgres and SQLite threshold rows. */
interface ThresholdRowShape {
  tagId: string;
  minSamples: number;
  zScoreThreshold: number;
  ewmaAlpha: number;
  ewmaL: number;
  iqrMultiplier: number;
  ensembleWeights: Record<string, number>;
  severityThresholds: SeverityThresholds;
  failureLimits: FailureLimits | null;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Shape shared by the Postgres and SQLite alert rows. */
interface AlertRowShape {
  id: string;
  tagId: string;
  severity: string;
  score: number;
  message: string;
  detectors: string[];
  recommendation: string;
  observedAt: Date;
  createdAt: Date;
  acknowledged: boolean;
  acknowledgedBy: string | null;
  acknowledgedAt: Date | null;
}

function toStoredThresholds(row: ThresholdRowShape): StoredThresholds {
  const thresholds: TagThresholds = {
    tagId: row.tagId,
    minSamples: row.minSamples,
    zScoreThreshold: row.zScoreThreshold,
    ewmaAlpha: row.ewmaAlpha,
    ewmaL: row.ewmaL,
    iqrMultiplier: row.iqrMultiplier,
    ensembleWeights: row.ensembleWeights,
    severityThresholds: row.severityThresholds,
  };
  // A stored NULL means "no engineering limits configured"; keep the key
  // absent so it round-trips to exactly the shape the engine produces.
  if (row.failureLimits) thresholds.failureLimits = row.failureLimits;
  return {
    tagId: row.tagId,
    thresholds,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toAlert(row: AlertRowShape): PredictiveAlert {
  return {
    id: row.id,
    tagId: row.tagId,
    severity: row.severity as SeverityLevel,
    score: row.score,
    message: row.message,
    timestamp: row.observedAt.getTime(),
    detectors: row.detectors,
    acknowledged: row.acknowledged,
    recommendation: row.recommendation,
    createdAt: row.createdAt.getTime(),
    acknowledgedBy: row.acknowledgedBy,
    acknowledgedAt: row.acknowledgedAt ? row.acknowledgedAt.getTime() : null,
  };
}

function boundedLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
}

export class DrizzlePredictiveStore implements PredictiveStore {
  private connection: Connection | undefined;
  private opening: Promise<Connection> | undefined;

  constructor(private readonly options: PredictiveStoreOptions = {}) {}

  backend(): "postgres" | "sqlite" | "unopened" {
    return this.connection?.kind ?? "unopened";
  }

  async ready(): Promise<void> {
    await this.connect();
  }

  async getThresholds(tagId: string): Promise<StoredThresholds | null> {
    const connection = await this.connect();
    const rows = await this.guard("read thresholds", async () =>
      connection.kind === "postgres"
        ? connection.db.select().from(pgThresholds).where(eq(pgThresholds.tagId, tagId)).limit(1)
        : connection.db
          .select()
          .from(sqliteThresholds)
          .where(eq(sqliteThresholds.tagId, tagId))
          .limit(1));
    const [row] = rows as ThresholdRowShape[];
    return row ? toStoredThresholds(row) : null;
  }

  async listThresholds(): Promise<StoredThresholds[]> {
    const connection = await this.connect();
    const rows = await this.guard("list thresholds", async () =>
      connection.kind === "postgres"
        ? connection.db.select().from(pgThresholds).orderBy(asc(pgThresholds.tagId))
        : connection.db.select().from(sqliteThresholds).orderBy(asc(sqliteThresholds.tagId)));
    return (rows as ThresholdRowShape[]).map(toStoredThresholds);
  }

  async upsertThresholds(input: {
    thresholds: TagThresholds;
    updatedBy: string;
    at: Date;
  }): Promise<StoredThresholds> {
    const connection = await this.connect();
    const { thresholds, updatedBy, at } = input;
    const values = {
      tagId: thresholds.tagId,
      minSamples: thresholds.minSamples,
      zScoreThreshold: thresholds.zScoreThreshold,
      ewmaAlpha: thresholds.ewmaAlpha,
      ewmaL: thresholds.ewmaL,
      iqrMultiplier: thresholds.iqrMultiplier,
      ensembleWeights: thresholds.ensembleWeights,
      severityThresholds: thresholds.severityThresholds,
      failureLimits: thresholds.failureLimits ?? null,
      updatedBy,
      createdAt: at,
      updatedAt: at,
    };
    // `created_at` is intentionally excluded from the update set: it records
    // when the tag was first configured and must not be rewritten by an edit.
    const updateSet = {
      minSamples: values.minSamples,
      zScoreThreshold: values.zScoreThreshold,
      ewmaAlpha: values.ewmaAlpha,
      ewmaL: values.ewmaL,
      iqrMultiplier: values.iqrMultiplier,
      ensembleWeights: values.ensembleWeights,
      severityThresholds: values.severityThresholds,
      failureLimits: values.failureLimits,
      updatedBy,
      updatedAt: at,
    };

    await this.guard("persist thresholds", async () => {
      if (connection.kind === "postgres") {
        await connection.db
          .insert(pgThresholds)
          .values(values)
          .onConflictDoUpdate({ target: pgThresholds.tagId, set: updateSet });
        return;
      }
      await connection.db
        .insert(sqliteThresholds)
        .values(values)
        .onConflictDoUpdate({ target: sqliteThresholds.tagId, set: updateSet });
    });

    const stored = await this.getThresholds(thresholds.tagId);
    if (!stored) {
      // The row was written and immediately not readable — treat it as a store
      // failure rather than returning a value the caller cannot re-read.
      throw new PredictiveStoreUnavailableError(
        `Thresholds for "${thresholds.tagId}" were written but could not be read back`,
      );
    }
    return stored;
  }

  async countThresholds(): Promise<number> {
    const connection = await this.connect();
    const rows = await this.guard("count thresholds", async () =>
      connection.kind === "postgres"
        ? connection.db.select({ value: sql<number>`count(*)` }).from(pgThresholds)
        : connection.db.select({ value: sql<number>`count(*)` }).from(sqliteThresholds));
    return Number((rows as Array<{ value: number | string }>)[0]?.value ?? 0);
  }

  async insertAlert(alert: PredictiveAlert): Promise<boolean> {
    const connection = await this.connect();
    const values = {
      id: alert.id,
      tagId: alert.tagId,
      severity: alert.severity,
      score: alert.score,
      message: alert.message,
      detectors: alert.detectors,
      recommendation: alert.recommendation,
      observedAt: new Date(alert.timestamp),
      createdAt: new Date(alert.createdAt),
      acknowledged: alert.acknowledged,
      acknowledgedBy: alert.acknowledgedBy,
      acknowledgedAt: alert.acknowledgedAt ? new Date(alert.acknowledgedAt) : null,
    };
    const inserted = await this.guard("persist alert", async () =>
      connection.kind === "postgres"
        ? connection.db
          .insert(pgAlerts)
          .values(values)
          .onConflictDoNothing()
          .returning({ id: pgAlerts.id })
        : connection.db
          .insert(sqliteAlerts)
          .values(values)
          .onConflictDoNothing()
          .returning({ id: sqliteAlerts.id }));
    return (inserted as Array<{ id: string }>).length > 0;
  }

  async getAlert(alertId: string): Promise<PredictiveAlert | null> {
    const connection = await this.connect();
    const rows = await this.guard("read alert", async () =>
      connection.kind === "postgres"
        ? connection.db.select().from(pgAlerts).where(eq(pgAlerts.id, alertId)).limit(1)
        : connection.db.select().from(sqliteAlerts).where(eq(sqliteAlerts.id, alertId)).limit(1));
    const [row] = rows as AlertRowShape[];
    return row ? toAlert(row) : null;
  }

  /**
   * Alerts matching `filter`, returned oldest-first.
   *
   * The LIMIT is applied to the NEWEST rows (descending select, re-ordered
   * ascending before returning). Truncating from the old end is a safety
   * requirement, not a preference: this is an alarm list, and an ascending
   * `LIMIT` would return the oldest N rows, so once a backlog of N alerts
   * exists a freshly raised emergency would be absent from the default
   * response and from `?acknowledged=false`. The caller still sees a stable
   * oldest-first ordering within the window it was given.
   */
  async listAlerts(filter: AlertFilter = {}): Promise<PredictiveAlert[]> {
    const connection = await this.connect();
    const limit = boundedLimit(filter.limit);
    const rows = await this.guard("list alerts", async () => {
      if (connection.kind === "postgres") {
        const conditions = [
          filter.severity ? eq(pgAlerts.severity, filter.severity) : undefined,
          filter.tagId ? eq(pgAlerts.tagId, filter.tagId) : undefined,
          filter.acknowledged !== undefined
            ? eq(pgAlerts.acknowledged, filter.acknowledged)
            : undefined,
        ].filter((condition) => condition !== undefined);
        return connection.db
          .select()
          .from(pgAlerts)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(pgAlerts.createdAt), desc(pgAlerts.id))
          .limit(limit);
      }
      const conditions = [
        filter.severity ? eq(sqliteAlerts.severity, filter.severity) : undefined,
        filter.tagId ? eq(sqliteAlerts.tagId, filter.tagId) : undefined,
        filter.acknowledged !== undefined
          ? eq(sqliteAlerts.acknowledged, filter.acknowledged)
          : undefined,
      ].filter((condition) => condition !== undefined);
      return connection.db
        .select()
        .from(sqliteAlerts)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(sqliteAlerts.createdAt), desc(sqliteAlerts.id))
        .limit(limit);
    });
    return (rows as AlertRowShape[]).map(toAlert).reverse();
  }

  async countAlerts(): Promise<AlertCounts> {
    const connection = await this.connect();
    const rows = await this.guard("count alerts", async () =>
      connection.kind === "postgres"
        ? connection.db
          .select({
            total: sql<number>`count(*)`,
            unacknowledged: sql<number>`count(*) filter (where ${pgAlerts.acknowledged} = false)`,
          })
          .from(pgAlerts)
        : connection.db
          .select({
            total: sql<number>`count(*)`,
            unacknowledged: sql<number>`sum(case when ${sqliteAlerts.acknowledged} = 0 then 1 else 0 end)`,
          })
          .from(sqliteAlerts));
    const [row] = rows as Array<{ total: number | string; unacknowledged: number | string | null }>;
    return {
      total: Number(row?.total ?? 0),
      unacknowledged: Number(row?.unacknowledged ?? 0),
    };
  }

  async acknowledgeAlert(
    alertId: string,
    acknowledgedBy: string,
    at: Date,
  ): Promise<{ status: AcknowledgeStatus; alert: PredictiveAlert | null }> {
    const connection = await this.connect();
    // Conditional update: the `acknowledged = false` predicate is what makes
    // this first-writer-wins across replicas. A second acknowledgement matches
    // no rows, so the original attribution is preserved rather than clobbered.
    const updated = await this.guard("acknowledge alert", async () =>
      connection.kind === "postgres"
        ? connection.db
          .update(pgAlerts)
          .set({ acknowledged: true, acknowledgedBy, acknowledgedAt: at })
          .where(and(eq(pgAlerts.id, alertId), eq(pgAlerts.acknowledged, false)))
          .returning({ id: pgAlerts.id })
        : connection.db
          .update(sqliteAlerts)
          .set({ acknowledged: true, acknowledgedBy, acknowledgedAt: at })
          .where(and(eq(sqliteAlerts.id, alertId), eq(sqliteAlerts.acknowledged, false)))
          .returning({ id: sqliteAlerts.id }));

    const alert = await this.getAlert(alertId);
    if (!alert) return { status: "not-found", alert: null };
    return {
      status: (updated as Array<{ id: string }>).length > 0
        ? "acknowledged"
        : "already-acknowledged",
      alert,
    };
  }

  async prune(request: PruneRequest): Promise<PruneResult> {
    const connection = await this.connect();
    const retired = await this.deleteAlerts({
      acknowledgedBefore: request.acknowledgedBefore,
    });
    const expired = await this.deleteAlerts({ anyBefore: request.anyBefore });

    // Row cap: evict acknowledged rows before unacknowledged ones, oldest
    // first inside each group, so an operator's outstanding work queue is the
    // last thing to go.
    const total = (await this.countAlerts()).total;
    const overflow = Math.max(0, total - Math.max(1, request.maxRows));
    let unacknowledgedEvicted: string[] = [];
    if (overflow > 0) {
      const victims = await this.guard("select overflow alerts", async () =>
        connection.kind === "postgres"
          ? connection.db
            .select({ id: pgAlerts.id, acknowledged: pgAlerts.acknowledged })
            .from(pgAlerts)
            .orderBy(desc(pgAlerts.acknowledged), asc(pgAlerts.createdAt), asc(pgAlerts.id))
            .limit(overflow)
          : connection.db
            .select({ id: sqliteAlerts.id, acknowledged: sqliteAlerts.acknowledged })
            .from(sqliteAlerts)
            .orderBy(
              desc(sqliteAlerts.acknowledged),
              asc(sqliteAlerts.createdAt),
              asc(sqliteAlerts.id),
            )
            .limit(overflow));
      const rows = victims as Array<{ id: string; acknowledged: boolean }>;
      unacknowledgedEvicted = rows.filter((row) => !row.acknowledged).map((row) => row.id);
      if (rows.length > 0) {
        const ids = rows.map((row) => row.id);
        await this.guard("evict overflow alerts", async () => {
          if (connection.kind === "postgres") {
            await connection.db.delete(pgAlerts).where(inArray(pgAlerts.id, ids));
            return;
          }
          await connection.db.delete(sqliteAlerts).where(inArray(sqliteAlerts.id, ids));
        });
      }
    }

    return { retired, expired, overflow, unacknowledgedEvicted };
  }

  async close(): Promise<void> {
    // Settle any in-flight connect() FIRST. `connect()` assigns `this.connection`
    // from a `.then()` callback, so a close() that raced an open would clear an
    // still-undefined field and then have the pending open write a live handle
    // straight back — leaving the file descriptor (and, on Postgres, the
    // server-side session) open forever with no reference left to close it.
    if (this.opening) await this.opening.catch(() => undefined);
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

  /**
   * Delete alerts matching one retention rule and report how many went. The
   * ids are selected first so the caller can report exactly what was removed
   * — a retention pass that cannot say what it deleted is not observable.
   */
  private async deleteAlerts(
    rule: { acknowledgedBefore?: Date; anyBefore?: Date },
  ): Promise<number> {
    const connection = await this.connect();
    const rows = await this.guard("select expired alerts", async () => {
      if (connection.kind === "postgres") {
        const where = rule.acknowledgedBefore
          ? and(
            eq(pgAlerts.acknowledged, true),
            lt(pgAlerts.createdAt, rule.acknowledgedBefore),
          )
          : lt(pgAlerts.createdAt, rule.anyBefore as Date);
        return connection.db.select({ id: pgAlerts.id }).from(pgAlerts).where(where);
      }
      const where = rule.acknowledgedBefore
        ? and(
          eq(sqliteAlerts.acknowledged, true),
          lt(sqliteAlerts.createdAt, rule.acknowledgedBefore),
        )
        : lt(sqliteAlerts.createdAt, rule.anyBefore as Date);
      return connection.db.select({ id: sqliteAlerts.id }).from(sqliteAlerts).where(where);
    });
    const ids = (rows as Array<{ id: string }>).map((row) => row.id);
    if (ids.length === 0) return 0;
    await this.guard("delete expired alerts", async () => {
      if (connection.kind === "postgres") {
        await connection.db.delete(pgAlerts).where(inArray(pgAlerts.id, ids));
        return;
      }
      await connection.db.delete(sqliteAlerts).where(inArray(sqliteAlerts.id, ids));
    });
    return ids.length;
  }

  /**
   * Translate any driver-level failure into the fail-closed error type. The
   * original error is attached as `cause` so the operator sees the real reason
   * in logs and in `/api/predictive/status`.
   */
  private async guard<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof PredictiveStoreUnavailableError) throw error;
      throw new PredictiveStoreUnavailableError(
        `Predictive store failed to ${operation}: `
        + (error instanceof Error ? error.message : String(error)),
        error,
      );
    }
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
        throw new PredictiveStoreUnavailableError(
          "Predictive store is unreachable: "
          + (error instanceof Error ? error.message : String(error)),
          error,
        );
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
        error ? reject(error) : resolve(opened));
    });
    await sqliteExec(client, SQLITE_DDL);

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

/**
 * Process-wide predictive store. Connects lazily on first use so importing the
 * predictive service never opens a database handle.
 */
export const predictiveStore: PredictiveStore = new DrizzlePredictiveStore();
