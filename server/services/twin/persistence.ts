/**
 * Durable digital-twin model registry and simulation checkpoints
 * ADR-0013 [13.3] — Issue #550
 *
 * The twin runtime (`./engine.ts`) keeps its model registry and simulation
 * state in process memory. This module is the durable half: it stores the
 * registered `ProcessModel` definitions and, per model, the LAST EXPLICITLY
 * COMMITTED simulation checkpoint, so both survive a restart.
 *
 * What is deliberately NOT stored is the run status. A restored simulation
 * always comes back idle; nothing here can express "resume stepping on boot"
 * (see `TwinRuntime.restoreModel`). The twin stays advisory and read-only
 * toward the plant (ADR-0009), so no row here is or can become a control
 * write.
 *
 * Two backends, matching `server/services/tuning/audit-store.ts`:
 *   - PostgreSQL (production) via drizzle-orm/node-postgres
 *   - SQLite (development/test fallback) via drizzle-orm/sqlite-proxy over the
 *     repo's `sqlite3` driver
 *
 * The store owns its own connection rather than borrowing the shared handle in
 * `server/storage.ts`, which serialises every caller behind one connection and
 * one application-level transaction mutex: a twin registry write must not be
 * rolled back by an unrelated storage transaction.
 *
 * Every registry mutation runs inside a real database transaction, and the
 * caller mutates the in-memory registry inside that same transaction (see
 * `./registry.ts`), so storage and runtime cannot diverge.
 */

import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { drizzle as drizzlePostgres, type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  drizzle as drizzleSqliteProxy,
  type SqliteRemoteDatabase,
} from "drizzle-orm/sqlite-proxy";
import { Client } from "pg";
import { Database } from "sqlite3";
import { z } from "zod";
import {
  twinCheckpoints as pgCheckpoints,
  twinModels as pgModels,
} from "@shared/schema";
import {
  twinCheckpoints as sqliteCheckpoints,
  twinModels as sqliteModels,
} from "@shared/schema-sqlite";
import {
  TWIN_CHECKPOINT_SCHEMA_VERSION,
  TWIN_MODEL_SCHEMA_VERSION,
  type ProcessModel,
  type TwinRestoreFailure,
} from "@shared/types/digital-twin";
import type { TwinCheckpointState } from "./engine";

export type TwinStoreBackend = "postgres" | "sqlite" | "unopened";

/**
 * Raised when the database itself refused or failed a twin operation, as
 * opposed to the runtime refusing the model or the payload exceeding the
 * persistence cap. Callers use it to tell "this request is wrong" from "the
 * twin could not durably hold this, try again" — a distinction that matters
 * because the twin refuses to register anything it cannot store.
 */
export class TwinPersistenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TwinPersistenceError";
  }
}

async function asStoreFailure<T>(label: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof TwinPersistenceError) throw error;
    throw new TwinPersistenceError(`${label}: ${describe(error)}`, { cause: error });
  }
}

/** One stored model together with the checkpoint written alongside it. */
export interface TwinStoredRecord {
  model: ProcessModel;
  checkpoint: TwinCheckpointState;
}

/**
 * Outcome of reading the whole store. Rows that could not be decoded are
 * reported, never repaired: they stay in storage untouched for an operator to
 * inspect, and they never stop the remaining rows from loading.
 */
export interface TwinLoadResult {
  /** Model rows examined */
  scanned: number;
  records: TwinStoredRecord[];
  failures: TwinRestoreFailure[];
}

/** Mutations available inside one store transaction. */
export interface TwinStoreTransaction {
  /** Upsert a model and its checkpoint together — never one without the other. */
  putModel(
    model: ProcessModel,
    checkpoint: TwinCheckpointState,
    committedAt: number,
  ): Promise<void>;
  /** Replace the committed checkpoint of an already-stored model. */
  putCheckpoint(
    modelId: string,
    checkpoint: TwinCheckpointState,
    committedAt: number,
  ): Promise<void>;
  /** Remove a model and its checkpoint. Resolves false when no row existed. */
  deleteModel(modelId: string): Promise<boolean>;
}

export interface TwinPersistence {
  /** Open the connection and ensure the tables exist. Safe to call repeatedly. */
  ready(): Promise<void>;
  /**
   * Read every stored model and checkpoint.
   *
   * NOT serialised against mutations on its own: the rows it returns are a
   * snapshot of the moment the read ran, and a transaction can commit while
   * that result is still in flight. A caller that then ACTS on those rows —
   * the restore pass rebuilding the in-memory registry — must run the read and
   * whatever it does with the result inside `exclusive()`. Otherwise it can
   * apply a stale snapshot over a newer committed write and leave storage and
   * the runtime describing different models (#550).
   */
  load(): Promise<TwinLoadResult>;
  /**
   * Run `work` inside one database transaction. Everything `work` does is
   * committed together or rolled back together; a throw from `work` rolls the
   * transaction back and propagates.
   */
  transaction<T>(work: (tx: TwinStoreTransaction) => Promise<T>): Promise<T>;
  /**
   * Run `operation` with exclusive access to the store: no `transaction()`
   * begins while it is in flight, and it begins only once every transaction
   * queued ahead of it has finished.
   *
   * Unlike `transaction()` it opens no database transaction — it is the mutual
   * exclusion alone, for a caller that must read the store and then act on
   * what it read without a mutation slipping into the gap.
   *
   * Not reentrant: `operation` must not call `exclusive()` or `transaction()`
   * on the same store, which would wait on a lock it already holds. `load()`
   * takes no lock and is safe to call inside it.
   */
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
  backend(): TwinStoreBackend;
  close(): Promise<void>;
}

/**
 * Byte cap for one stored JSON payload.
 *
 * Chosen to sit above what the runtime's own structural limits can produce, so
 * a model the runtime accepts is a model the store can hold: 500 components ×
 * (128 config + 128 initial-state fields) × ~72 bytes for a maximum-length
 * (64-char) parameter name and value is roughly 9 MB, plus component names,
 * connections and tag bindings. Anything larger is refused outright — a
 * checkpoint is never truncated, because a silently shortened state record is
 * indistinguishable from a fabricated one.
 */
export const MAX_PERSISTED_PAYLOAD_BYTES = 16 * 1024 * 1024;

// ── Stored-payload decoders ────────────────────────────────────────────────
//
// These check the JS shape of a decoded row: that it is an object of the right
// kind with the right primitive types, that `type` is a component type this
// build knows, and that the string fields are bounded. Domain validation
// (connection targets, solver support, parameter counts, finiteness of every
// state value, the checkpoint matching the model's components) is the
// runtime's job and runs afterwards in `TwinRuntime.restoreModel`, which is
// the same validation a freshly registered model goes through. A row that
// fails either layer is refused; neither layer repairs it.

const parameterRecordSchema = z.record(z.string(), z.number());

const componentSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.enum(["tank", "pipe", "valve", "pump", "controller", "sensor", "heater", "mixer"]),
  name: z.string().min(1).max(256),
  config: parameterRecordSchema,
  initialState: parameterRecordSchema,
  connections: z.array(z.string().min(1)),
  pvSource: z.string().min(1).optional(),
});

const storedModelSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  description: z.string().max(2000).optional(),
  components: z.array(componentSchema).min(1),
  tagBindings: z.array(
    z.object({
      tagId: z.string().min(1).max(256),
      componentId: z.string().min(1),
      parameter: z.string().min(1).max(64),
    }),
  ),
  stepFunction: z.string().min(1),
  timeStepMs: z.number(),
});

const storedComponentStatesSchema = z.record(z.string(), parameterRecordSchema);

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

function assertWithinPayloadCap(label: string, payload: unknown): string {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) {
    throw new Error(`${label} is not JSON-serialisable`);
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_PERSISTED_PAYLOAD_BYTES) {
    throw new Error(
      `${label} is ${bytes} bytes, over the ${MAX_PERSISTED_PAYLOAD_BYTES}-byte persistence limit`,
    );
  }
  return serialized;
}

/**
 * JSON columns come back already parsed on Postgres (jsonb) and as text on
 * SQLite, so both are normalised here. Invalid JSON is a per-row failure, not
 * a failure of the whole load.
 */
function decodeJsonColumn(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return JSON.parse(value) as unknown;
}

// ── Connection plumbing ────────────────────────────────────────────────────

/**
 * SQLite DDL. `migrations/0014_twin_persistence.sql` is the Postgres source of
 * truth; this mirrors it for the dev/test fallback, including the cascade from
 * model to checkpoint, so deletion is atomic on both backends.
 */
const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS twin_models (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  definition TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS twin_checkpoints (
  model_id TEXT PRIMARY KEY REFERENCES twin_models(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL,
  tick INTEGER NOT NULL CHECK (tick >= 0),
  time_ms REAL NOT NULL,
  component_states TEXT NOT NULL,
  last_sync_at INTEGER,
  committed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_twin_checkpoints_committed_at
  ON twin_checkpoints(committed_at);
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

export interface TwinStoreOptions {
  /** Explicit PostgreSQL URL; defaults to the DATABASE_URL selection below. */
  postgresUrl?: string;
  /** Explicit SQLite file; defaults to TWIN_STATE_SQLITE_PATH/SQLITE_DATABASE_PATH. */
  sqlitePath?: string;
}

/**
 * Mirrors `server/storage.ts` and the tuning audit store: Postgres only when a
 * URL is configured, the Postgres override is not disabled, and the process is
 * not in development mode. Everything else falls back to the file-backed
 * SQLite database.
 */
function resolvePostgresUrl(options: TwinStoreOptions): string | undefined {
  if (options.postgresUrl) return options.postgresUrl;
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  if (process.env.FORCE_POSTGRES === "false") return undefined;
  if (process.env.NODE_ENV === "development") return undefined;
  return url;
}

function resolveSqlitePath(options: TwinStoreOptions): string {
  return options.sqlitePath
    ?? process.env.TWIN_STATE_SQLITE_PATH
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
 * node-sqlite3 hands back objects in result-column order. Every selection this
 * module issues names distinct columns, so ordered values reconstruct the
 * positional row exactly.
 */
function positionalRow(row: Record<string, unknown>): unknown[] {
  return Object.values(row);
}

interface RawModelRow {
  id: unknown;
  schemaVersion: unknown;
  definition: unknown;
}

interface RawCheckpointRow {
  modelId: unknown;
  schemaVersion: unknown;
  tick: unknown;
  timeMs: unknown;
  componentStates: unknown;
  lastSyncAt: unknown;
}

export class DrizzleTwinStore implements TwinPersistence {
  private connection: Connection | undefined;
  private opening: Promise<Connection> | undefined;
  /**
   * The store owns a single physical connection, so transactions must not
   * interleave on it: without this, a concurrent caller's statements could be
   * committed or rolled back by someone else's transaction.
   */
  private lockTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: TwinStoreOptions = {}) {}

  backend(): TwinStoreBackend {
    return this.connection?.kind ?? "unopened";
  }

  async ready(): Promise<void> {
    await this.connect();
  }

  async load(): Promise<TwinLoadResult> {
    const connection = await this.connect();
    const modelRows = await asStoreFailure(
      "reading stored twin models",
      () => this.selectModelRows(connection),
    );
    const checkpointRows = await asStoreFailure(
      "reading stored twin checkpoints",
      () => this.selectCheckpointRows(connection),
    );

    const checkpointsByModel = new Map<string, RawCheckpointRow>();
    for (const row of checkpointRows) {
      if (typeof row.modelId === "string") checkpointsByModel.set(row.modelId, row);
    }

    const records: TwinStoredRecord[] = [];
    const failures: TwinRestoreFailure[] = [];

    for (const modelRow of modelRows) {
      const modelId = typeof modelRow.id === "string" ? modelRow.id : "(unreadable id)";
      let model: ProcessModel;
      try {
        model = this.decodeModel(modelRow);
      } catch (error) {
        failures.push({ modelId, stage: "model", reason: describe(error) });
        continue;
      }
      if (model.id !== modelId) {
        failures.push({
          modelId,
          stage: "model",
          reason: `stored definition declares id "${model.id}", row key is "${modelId}"`,
        });
        continue;
      }

      const checkpointRow = checkpointsByModel.get(modelId);
      if (!checkpointRow) {
        // Models and checkpoints are always written in one transaction, so a
        // model without a checkpoint is a torn write. Seeding it from authored
        // initial conditions would substitute invented state for real state.
        failures.push({
          modelId,
          stage: "checkpoint",
          reason: "no committed checkpoint stored for this model (torn write)",
        });
        continue;
      }
      try {
        records.push({ model, checkpoint: this.decodeCheckpoint(checkpointRow) });
      } catch (error) {
        failures.push({ modelId, stage: "checkpoint", reason: describe(error) });
      }
    }

    return { scanned: modelRows.length, records, failures };
  }

  async transaction<T>(work: (tx: TwinStoreTransaction) => Promise<T>): Promise<T> {
    const connection = await this.connect();
    return this.withLock(async () => {
      await asStoreFailure("opening a twin store transaction", () => this.begin(connection));
      let result: T;
      try {
        result = await work(this.transactionApi(connection));
      } catch (error) {
        await this.rollbackQuietly(connection);
        throw error;
      }
      try {
        await asStoreFailure(
          "committing a twin store transaction",
          () => this.exec(connection, "COMMIT"),
        );
      } catch (error) {
        await this.rollbackQuietly(connection);
        throw error;
      }
      return result;
    });
  }

  /**
   * The transaction mutex without a transaction. `load()` takes no lock, so a
   * caller may read inside `operation` without deadlocking this non-reentrant
   * lock; opening a nested transaction or a nested `exclusive` would deadlock.
   */
  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.withLock(operation);
  }

  async close(): Promise<void> {
    const opening = this.opening;
    const connection = this.connection;
    // Cleared before any await, so a second close() cannot reach the same
    // handle and close it twice.
    this.connection = undefined;
    this.opening = undefined;
    if (connection) {
      await this.closeConnection(connection);
      return;
    }
    if (!opening) return;
    // close() raced the first connect(): returning now would leave the handle
    // that open is about to produce owned by nobody and never released. Wait
    // for it and close that instead. A failed open has no handle to release,
    // and its error belongs to the caller that asked for the connection.
    const opened = await opening.catch(() => undefined);
    // `connect()` publishes the connection as it resolves, so undo that too.
    if (this.connection === opened) this.connection = undefined;
    if (opened) await this.closeConnection(opened);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async closeConnection(connection: Connection): Promise<void> {
    if (connection.kind === "postgres") {
      await connection.client.end();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      connection.client.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private transactionApi(connection: Connection): TwinStoreTransaction {
    return {
      putModel: async (model, checkpoint, committedAt) => {
        // Cap breaches are the caller's problem, not the database's, so they
        // stay plain errors and are raised before anything is written.
        assertWithinPayloadCap(`model "${model.id}" definition`, model);
        assertWithinPayloadCap(`checkpoint for model "${model.id}"`, checkpoint.componentStates);
        const now = new Date(committedAt);
        await asStoreFailure(`storing twin model "${model.id}"`, async () => {
          if (connection.kind === "postgres") {
            await connection.db
              .insert(pgModels)
              .values({
                id: model.id,
                schemaVersion: TWIN_MODEL_SCHEMA_VERSION,
                definition: model,
                createdAt: now,
                updatedAt: now,
              })
              .onConflictDoUpdate({
                target: pgModels.id,
                // created_at deliberately untouched: it records first registration.
                set: {
                  schemaVersion: TWIN_MODEL_SCHEMA_VERSION,
                  definition: model,
                  updatedAt: now,
                },
              });
          } else {
            await connection.db
              .insert(sqliteModels)
              .values({
                id: model.id,
                schemaVersion: TWIN_MODEL_SCHEMA_VERSION,
                definition: model,
                createdAt: now,
                updatedAt: now,
              })
              .onConflictDoUpdate({
                target: sqliteModels.id,
                set: {
                  schemaVersion: TWIN_MODEL_SCHEMA_VERSION,
                  definition: model,
                  updatedAt: now,
                },
              });
          }
        });
        await this.writeCheckpoint(connection, model.id, checkpoint, committedAt);
      },

      putCheckpoint: async (modelId, checkpoint, committedAt) => {
        assertWithinPayloadCap(`checkpoint for model "${modelId}"`, checkpoint.componentStates);
        await this.writeCheckpoint(connection, modelId, checkpoint, committedAt);
      },

      deleteModel: (modelId) => asStoreFailure(
        `deleting twin model "${modelId}"`,
        async () => {
          if (connection.kind === "postgres") {
            const existing = await connection.db
              .select({ id: pgModels.id })
              .from(pgModels)
              .where(eq(pgModels.id, modelId));
            if (existing.length === 0) return false;
            await connection.db.delete(pgCheckpoints).where(eq(pgCheckpoints.modelId, modelId));
            await connection.db.delete(pgModels).where(eq(pgModels.id, modelId));
            return true;
          }
          const existing = await connection.db
            .select({ id: sqliteModels.id })
            .from(sqliteModels)
            .where(eq(sqliteModels.id, modelId));
          if (existing.length === 0) return false;
          await connection.db
            .delete(sqliteCheckpoints)
            .where(eq(sqliteCheckpoints.modelId, modelId));
          await connection.db.delete(sqliteModels).where(eq(sqliteModels.id, modelId));
          return true;
        },
      ),
    };
  }

  private async writeCheckpoint(
    connection: Connection,
    modelId: string,
    checkpoint: TwinCheckpointState,
    committedAt: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(checkpoint.tick) || checkpoint.tick < 0) {
      throw new Error(`checkpoint for model "${modelId}" has a non-integer tick`);
    }
    if (!Number.isFinite(checkpoint.timeMs)) {
      throw new Error(`checkpoint for model "${modelId}" has a non-finite clock`);
    }
    const values = {
      modelId,
      schemaVersion: TWIN_CHECKPOINT_SCHEMA_VERSION,
      tick: checkpoint.tick,
      timeMs: checkpoint.timeMs,
      componentStates: checkpoint.componentStates,
      lastSyncAt: checkpoint.lastSyncAt ?? null,
      committedAt: new Date(committedAt),
    };
    const set = {
      schemaVersion: values.schemaVersion,
      tick: values.tick,
      timeMs: values.timeMs,
      componentStates: values.componentStates,
      lastSyncAt: values.lastSyncAt,
      committedAt: values.committedAt,
    };
    await asStoreFailure(`storing checkpoint for twin model "${modelId}"`, async () => {
      if (connection.kind === "postgres") {
        await connection.db
          .insert(pgCheckpoints)
          .values(values)
          .onConflictDoUpdate({ target: pgCheckpoints.modelId, set });
      } else {
        await connection.db
          .insert(sqliteCheckpoints)
          .values(values)
          .onConflictDoUpdate({ target: sqliteCheckpoints.modelId, set });
      }
    });
  }

  private decodeModel(row: RawModelRow): ProcessModel {
    if (row.schemaVersion !== TWIN_MODEL_SCHEMA_VERSION) {
      throw new Error(
        `unsupported model schema version ${String(row.schemaVersion)} `
        + `(this build stores version ${TWIN_MODEL_SCHEMA_VERSION})`,
      );
    }
    const decoded = storedModelSchema.safeParse(decodeJsonColumn(row.definition));
    if (!decoded.success) {
      throw new Error(`stored definition is not a process model: ${decoded.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`);
    }
    return decoded.data as ProcessModel;
  }

  private decodeCheckpoint(row: RawCheckpointRow): TwinCheckpointState {
    if (row.schemaVersion !== TWIN_CHECKPOINT_SCHEMA_VERSION) {
      throw new Error(
        `unsupported checkpoint schema version ${String(row.schemaVersion)} `
        + `(this build stores version ${TWIN_CHECKPOINT_SCHEMA_VERSION})`,
      );
    }
    if (typeof row.tick !== "number" || !Number.isSafeInteger(row.tick) || row.tick < 0) {
      throw new Error(`stored tick ${String(row.tick)} is not a non-negative integer`);
    }
    if (typeof row.timeMs !== "number" || !Number.isFinite(row.timeMs)) {
      throw new Error(`stored clock ${String(row.timeMs)} is not finite`);
    }
    if (
      row.lastSyncAt !== null
      && row.lastSyncAt !== undefined
      && (typeof row.lastSyncAt !== "number" || !Number.isFinite(row.lastSyncAt))
    ) {
      throw new Error(`stored lastSyncAt ${String(row.lastSyncAt)} is not finite`);
    }
    const decoded = storedComponentStatesSchema.safeParse(
      decodeJsonColumn(row.componentStates),
    );
    if (!decoded.success) {
      throw new Error(`stored component states are malformed: ${decoded.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`);
    }
    return {
      tick: row.tick,
      timeMs: row.timeMs,
      componentStates: decoded.data,
      ...(typeof row.lastSyncAt === "number" ? { lastSyncAt: row.lastSyncAt } : {}),
    };
  }

  private async selectModelRows(connection: Connection): Promise<RawModelRow[]> {
    if (connection.kind === "postgres") {
      return connection.db
        .select({
          id: pgModels.id,
          schemaVersion: pgModels.schemaVersion,
          // Read the payload as text on both dialects so a row whose JSON is
          // unreadable fails on its own instead of aborting the whole load.
          definition: sql<string>`${pgModels.definition}::text`,
        })
        .from(pgModels);
    }
    return connection.db
      .select({
        id: sqliteModels.id,
        schemaVersion: sqliteModels.schemaVersion,
        definition: sql<string>`${sqliteModels.definition}`,
      })
      .from(sqliteModels);
  }

  private async selectCheckpointRows(connection: Connection): Promise<RawCheckpointRow[]> {
    if (connection.kind === "postgres") {
      return connection.db
        .select({
          modelId: pgCheckpoints.modelId,
          schemaVersion: pgCheckpoints.schemaVersion,
          tick: pgCheckpoints.tick,
          timeMs: pgCheckpoints.timeMs,
          componentStates: sql<string>`${pgCheckpoints.componentStates}::text`,
          lastSyncAt: pgCheckpoints.lastSyncAt,
        })
        .from(pgCheckpoints);
    }
    return connection.db
      .select({
        modelId: sqliteCheckpoints.modelId,
        schemaVersion: sqliteCheckpoints.schemaVersion,
        tick: sqliteCheckpoints.tick,
        timeMs: sqliteCheckpoints.timeMs,
        componentStates: sql<string>`${sqliteCheckpoints.componentStates}`,
        lastSyncAt: sqliteCheckpoints.lastSyncAt,
      })
      .from(sqliteCheckpoints);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lockTail.catch(() => undefined);
    let release!: () => void;
    this.lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private begin(connection: Connection): Promise<void> {
    // BEGIN IMMEDIATE takes the SQLite write lock up front, so a concurrent
    // writer fails at BEGIN rather than half-way through the transaction.
    return this.exec(connection, connection.kind === "sqlite" ? "BEGIN IMMEDIATE" : "BEGIN");
  }

  private async exec(connection: Connection, statement: string): Promise<void> {
    if (connection.kind === "postgres") {
      await connection.client.query(statement);
      return;
    }
    await sqliteRun(connection.client, statement, []);
  }

  private async rollbackQuietly(connection: Connection): Promise<void> {
    try {
      await this.exec(connection, "ROLLBACK");
    } catch {
      // A ROLLBACK that itself fails leaves the connection unusable rather
      // than the data half-written; the original error is the one that
      // matters and is rethrown by the caller.
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
        throw new TwinPersistenceError(
          `opening the twin store: ${describe(error)}`,
          { cause: error },
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
    // Per-connection, and must be set outside a transaction: without it SQLite
    // parses the model→checkpoint foreign key but does not enforce it.
    await sqliteExec(client, "PRAGMA foreign_keys = ON;");
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
 * Process-wide twin store. Connects lazily on first use so importing the twin
 * service never opens a database handle.
 */
export const twinStore: TwinPersistence = new DrizzleTwinStore();
