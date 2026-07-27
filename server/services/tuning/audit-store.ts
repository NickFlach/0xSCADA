/**
 * Durable, append-only PID tuning audit store
 * ADR-0013 [13.4] — Issue #215
 *
 * Writing live PID gains is plant-affecting, so the record of who proposed a
 * change, who approved it, what the old and new gains were and how the safety
 * envelope (ADR-0009) was decided must outlive the process. Everything here is
 * real Drizzle against a real table (`pid_tuning_audit`, migration 0010) —
 * there is no in-memory fallback: if the store cannot append, the caller must
 * refuse the gain write.
 *
 * Two backends, matching how `server/storage.ts` chooses its own:
 *   - PostgreSQL (production) via drizzle-orm/node-postgres
 *   - SQLite (development/test fallback) via drizzle-orm/sqlite-proxy over the
 *     repo's `sqlite3` driver
 *
 * The store owns its own connection rather than borrowing the shared handle in
 * `server/storage.ts`. That handle serialises every caller behind one physical
 * connection and one application-level transaction mutex; an audit append must
 * not be able to be rolled back by an unrelated storage transaction, and must
 * not queue behind blueprint imports on the approval path.
 *
 * Append-only is enforced in the database (triggers in migration 0010 for
 * Postgres, the DDL below for SQLite). This module intentionally exposes no
 * update or delete operation.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { drizzle as drizzlePostgres, type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  drizzle as drizzleSqliteProxy,
  type SqliteRemoteDatabase,
} from "drizzle-orm/sqlite-proxy";
import { Client } from "pg";
import { Database } from "sqlite3";
import { pidTuningAudit as pgAudit } from "@shared/schema";
import { pidTuningAudit as sqliteAudit } from "@shared/schema-sqlite";
import type {
  TuningAuditAppend,
  TuningAuditDecision,
  TuningAuditRecord,
} from "@shared/types/tuning";

export interface TuningAuditFilter {
  proposalId?: string;
  controllerId?: string;
  decision?: TuningAuditDecision;
  limit?: number;
}

export interface TuningAuditStore {
  /** Open the connection and ensure the table exists. Safe to call repeatedly. */
  ready(): Promise<void>;
  /** Append one immutable record and return it as persisted. */
  append(record: TuningAuditAppend): Promise<TuningAuditRecord>;
  /** Read back the trail, newest first. */
  list(filter?: TuningAuditFilter): Promise<TuningAuditRecord[]>;
  /** Backend actually in use, for /status reporting. */
  backend(): "postgres" | "sqlite" | "unopened";
  close(): Promise<void>;
}

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;

/**
 * SQLite DDL. `migrations/0010_pid_tuning_audit.sql` is the Postgres source of
 * truth; this mirrors it for the dev/test fallback, including the append-only
 * triggers, so the immutability guarantee is identical on both backends.
 */
const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS pid_tuning_audit (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  controller_id TEXT NOT NULL,
  method TEXT NOT NULL,
  decision TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  decided_by TEXT,
  current_gains TEXT NOT NULL,
  proposed_gains TEXT NOT NULL,
  applied_gains TEXT,
  envelope TEXT NOT NULL,
  envelope_decision TEXT NOT NULL,
  reason_code TEXT,
  detail TEXT,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pid_tuning_audit_proposal
  ON pid_tuning_audit(proposal_id);
CREATE INDEX IF NOT EXISTS idx_pid_tuning_audit_controller
  ON pid_tuning_audit(controller_id);
CREATE INDEX IF NOT EXISTS idx_pid_tuning_audit_recorded_at
  ON pid_tuning_audit(recorded_at);
CREATE TRIGGER IF NOT EXISTS pid_tuning_audit_no_update
  BEFORE UPDATE ON pid_tuning_audit
BEGIN
  SELECT RAISE(ABORT, 'pid_tuning_audit is append-only: UPDATE is not permitted');
END;
CREATE TRIGGER IF NOT EXISTS pid_tuning_audit_no_delete
  BEFORE DELETE ON pid_tuning_audit
BEGIN
  SELECT RAISE(ABORT, 'pid_tuning_audit is append-only: DELETE is not permitted');
END;
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

export interface TuningAuditStoreOptions {
  /** Explicit PostgreSQL URL; defaults to the DATABASE_URL selection below. */
  postgresUrl?: string;
  /** Explicit SQLite file; defaults to TUNING_AUDIT_SQLITE_PATH/SQLITE_DATABASE_PATH. */
  sqlitePath?: string;
}

/**
 * Mirrors `server/storage.ts`: Postgres only when a URL is configured, the
 * Postgres override is not disabled, and the process is not in development
 * mode. Everything else falls back to the file-backed SQLite database.
 */
function resolvePostgresUrl(options: TuningAuditStoreOptions): string | undefined {
  if (options.postgresUrl) return options.postgresUrl;
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  if (process.env.FORCE_POSTGRES === "false") return undefined;
  if (process.env.NODE_ENV === "development") return undefined;
  return url;
}

function resolveSqlitePath(options: TuningAuditStoreOptions): string {
  return options.sqlitePath
    ?? process.env.TUNING_AUDIT_SQLITE_PATH
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
 * result-column order and every column of `pid_tuning_audit` has a distinct
 * snake_case name, so ordered values reconstruct the positional row exactly.
 */
function positionalRow(row: Record<string, unknown>): unknown[] {
  return Object.values(row);
}

export class DrizzleTuningAuditStore implements TuningAuditStore {
  private connection: Connection | undefined;
  private opening: Promise<Connection> | undefined;

  constructor(private readonly options: TuningAuditStoreOptions = {}) {}

  backend(): "postgres" | "sqlite" | "unopened" {
    return this.connection?.kind ?? "unopened";
  }

  async ready(): Promise<void> {
    await this.connect();
  }

  async append(record: TuningAuditAppend): Promise<TuningAuditRecord> {
    const connection = await this.connect();
    const id = randomUUID();
    const recordedAt = new Date();
    const values = {
      id,
      proposalId: record.proposalId,
      controllerId: record.controllerId,
      method: record.method,
      decision: record.decision,
      proposedBy: record.proposedBy,
      decidedBy: record.decidedBy,
      currentGains: record.currentGains,
      proposedGains: record.proposedGains,
      appliedGains: record.appliedGains,
      envelope: record.envelope,
      envelopeDecision: record.envelopeDecision,
      reasonCode: record.reasonCode,
      detail: record.detail,
      recordedAt,
    };

    if (connection.kind === "postgres") {
      await connection.db.insert(pgAudit).values(values);
    } else {
      await connection.db.insert(sqliteAudit).values(values);
    }

    return { ...record, id, recordedAt };
  }

  async list(filter: TuningAuditFilter = {}): Promise<TuningAuditRecord[]> {
    const connection = await this.connect();
    const limit = Math.min(Math.max(filter.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);

    if (connection.kind === "postgres") {
      const conditions = [
        filter.proposalId ? eq(pgAudit.proposalId, filter.proposalId) : undefined,
        filter.controllerId ? eq(pgAudit.controllerId, filter.controllerId) : undefined,
        filter.decision ? eq(pgAudit.decision, filter.decision) : undefined,
      ].filter((condition) => condition !== undefined);
      const rows = await connection.db
        .select()
        .from(pgAudit)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(pgAudit.recordedAt))
        .limit(limit);
      return rows.map((row) => this.toRecord(row));
    }

    const conditions = [
      filter.proposalId ? eq(sqliteAudit.proposalId, filter.proposalId) : undefined,
      filter.controllerId ? eq(sqliteAudit.controllerId, filter.controllerId) : undefined,
      filter.decision ? eq(sqliteAudit.decision, filter.decision) : undefined,
    ].filter((condition) => condition !== undefined);
    const rows = await connection.db
      .select()
      .from(sqliteAudit)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(sqliteAudit.recordedAt))
      .limit(limit);
    return rows.map((row) => this.toRecord(row));
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

  private toRecord(row: {
    id: string;
    proposalId: string;
    controllerId: string;
    method: string;
    decision: string;
    proposedBy: string;
    decidedBy: string | null;
    currentGains: TuningAuditRecord["currentGains"];
    proposedGains: TuningAuditRecord["proposedGains"];
    appliedGains: TuningAuditRecord["appliedGains"];
    envelope: TuningAuditRecord["envelope"];
    envelopeDecision: string;
    reasonCode: string | null;
    detail: string | null;
    recordedAt: Date;
  }): TuningAuditRecord {
    return {
      id: row.id,
      proposalId: row.proposalId,
      controllerId: row.controllerId,
      method: row.method as TuningAuditRecord["method"],
      decision: row.decision as TuningAuditDecision,
      proposedBy: row.proposedBy,
      decidedBy: row.decidedBy,
      currentGains: row.currentGains,
      proposedGains: row.proposedGains,
      appliedGains: row.appliedGains,
      envelope: row.envelope,
      envelopeDecision: row.envelopeDecision as TuningAuditRecord["envelopeDecision"],
      reasonCode: row.reasonCode,
      detail: row.detail,
      recordedAt: row.recordedAt,
    };
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
 * Process-wide audit store. Connects lazily on first append so importing the
 * tuning service never opens a database handle.
 */
export const tuningAuditStore: TuningAuditStore = new DrizzleTuningAuditStore();
