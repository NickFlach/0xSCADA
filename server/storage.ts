/**
 * Storage/Database module with SQLite fallback for development
 */
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { and, desc, eq } from 'drizzle-orm';
import { Client } from 'pg';
import { Database } from 'sqlite3';
import * as schema from '@shared/schema';
import * as sqliteSchema from '@shared/schema-sqlite';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'path';

const isDevelopment = process.env.NODE_ENV === 'development';
const usePostgres = process.env.DATABASE_URL && process.env.FORCE_POSTGRES !== 'false';

let pgClient: Client | null = null;
let sqliteClient: Database | null = null;
let db: any = null;
let dbType: 'postgres' | 'sqlite' = 'postgres';

// The module currently owns one physical database connection. Transactions
// therefore need an application-level exclusive section: without it, unrelated
// requests can interleave on that connection and be accidentally committed or
// rolled back with an import. AsyncLocalStorage makes the mutex re-entrant for
// storage calls made by the transaction callback itself.
interface StorageTransactionContext {
  active: boolean;
}

const transactionContext = new AsyncLocalStorage<StorageTransactionContext>();
let storageLockTail: Promise<void> = Promise.resolve();

async function withStorageLock<T>(operation: () => Promise<T>): Promise<T> {
  if (transactionContext.getStore()?.active) return operation();

  const previous = storageLockTail.catch(() => undefined);
  let release!: () => void;
  storageLockTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

type StorageTableName =
  | 'vendors'
  | 'template_packages'
  | 'control_module_types'
  | 'control_module_instances'
  | 'unit_types'
  | 'unit_instances'
  | 'phase_types'
  | 'phase_instances'
  | 'design_specifications'
  | 'generated_code'
  | 'data_type_mappings'
  | 'controllers'
  | 'plugin_registry'
  | 'plugin_installations';

const sqliteColumns: Record<StorageTableName, readonly string[]> = {
  vendors: ['id', 'name', 'displayName', 'description', 'platforms', 'languages', 'configSchema', 'isActive', 'createdAt', 'updatedAt'],
  template_packages: ['id', 'name', 'vendorId', 'version', 'description', 'templateType', 'language', 'templateContent', 'placeholders', 'requiredInputs', 'createdAt', 'updatedAt'],
  control_module_types: ['id', 'name', 'vendorId', 'version', 'description', 'inputs', 'outputs', 'inOuts', 'dataTypeMappings', 'templatePackageId', 'sourcePackage', 'classification', 'createdAt', 'updatedAt'],
  control_module_instances: ['id', 'name', 'instanceNumber', 'controlModuleTypeId', 'controllerId', 'unitInstanceId', 'pidDrawing', 'comment', 'configuration', 'currentState', 'siteId', 'assetId', 'createdAt', 'updatedAt'],
  unit_types: ['id', 'name', 'vendorId', 'version', 'description', 'variables', 'equipmentModules', 'templatePackageId', 'createdAt', 'updatedAt'],
  unit_instances: ['id', 'name', 'instanceNumber', 'unitTypeId', 'controllerId', 'pidDrawing', 'processCell', 'area', 'comment', 'siteId', 'createdAt', 'updatedAt'],
  phase_types: ['id', 'name', 'vendorId', 'version', 'description', 'linkedModules', 'inputs', 'outputs', 'inOuts', 'internalValues', 'hmiParameters', 'recipeParameters', 'reportParameters', 'sequences', 'templatePackageId', 'createdAt', 'updatedAt'],
  phase_instances: ['id', 'name', 'instanceNumber', 'phaseTypeId', 'unitInstanceId', 'controllerId', 'currentState', 'currentStep', 'linkedModuleInstances', 'siteId', 'createdAt', 'updatedAt'],
  design_specifications: ['id', 'name', 'version', 'description', 'contentHash', 'txHash', 'content', 'siteId', 'createdAt', 'anchoredAt'],
  generated_code: ['id', 'sourceType', 'sourceId', 'vendorId', 'templatePackageId', 'language', 'code', 'codeHash', 'txHash', 'metadata', 'status', 'generatedAt', 'approvedAt', 'approvedBy'],
  data_type_mappings: ['id', 'vendorId', 'canonicalType', 'vendorType', 'size', 'precision', 'metadata', 'createdAt'],
  controllers: ['id', 'name', 'vendorId', 'siteId', 'model', 'firmwareVersion', 'address', 'configuration', 'status', 'createdAt', 'updatedAt'],
  plugin_registry: ['id', 'version', 'manifest', 'publisher', 'installs', 'publishedAt', 'updatedAt'],
  plugin_installations: ['id', 'version', 'manifest', 'status', 'config', 'grantedCapabilities', 'installedBy', 'installedAt', 'updatedAt'],
};

const sqliteJsonColumns = new Set([
  'platforms', 'languages', 'configSchema', 'placeholders', 'requiredInputs',
  'inputs', 'outputs', 'inOuts', 'dataTypeMappings', 'configuration',
  'currentState', 'variables', 'equipmentModules', 'linkedModules',
  'internalValues', 'hmiParameters', 'recipeParameters', 'reportParameters',
  'sequences', 'linkedModuleInstances', 'content', 'metadata',
  // Agent marketplace (#217)
  'manifest', 'config', 'grantedCapabilities',
]);
const sqliteBooleanColumns = new Set(['isActive']);
const sqliteDateColumns = new Set([
  'createdAt', 'updatedAt', 'anchoredAt', 'generatedAt', 'approvedAt',
  // Agent marketplace (#217)
  'publishedAt', 'installedAt',
]);

const blueprintSqliteSchema = `
CREATE TABLE IF NOT EXISTS vendors (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  description TEXT, platforms TEXT NOT NULL DEFAULT '[]',
  languages TEXT NOT NULL DEFAULT '[]', config_schema TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS template_packages (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, vendor_id TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0', description TEXT,
  template_type TEXT NOT NULL, language TEXT NOT NULL,
  template_content TEXT NOT NULL, placeholders TEXT NOT NULL DEFAULT '[]',
  required_inputs TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS control_module_types (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, vendor_id TEXT,
  version TEXT NOT NULL DEFAULT '1.0.0', description TEXT,
  inputs TEXT NOT NULL DEFAULT '[]', outputs TEXT NOT NULL DEFAULT '[]',
  in_outs TEXT NOT NULL DEFAULT '[]', data_type_mappings TEXT NOT NULL DEFAULT '{}',
  template_package_id TEXT, source_package TEXT,
  classification TEXT DEFAULT 'control_module', created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS unit_types (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, vendor_id TEXT,
  version TEXT NOT NULL DEFAULT '1.0.0', description TEXT,
  variables TEXT NOT NULL DEFAULT '[]', equipment_modules TEXT NOT NULL DEFAULT '[]',
  template_package_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS phase_types (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, vendor_id TEXT,
  version TEXT NOT NULL DEFAULT '1.0.0', description TEXT,
  linked_modules TEXT NOT NULL DEFAULT '[]', inputs TEXT NOT NULL DEFAULT '[]',
  outputs TEXT NOT NULL DEFAULT '[]', in_outs TEXT NOT NULL DEFAULT '[]',
  internal_values TEXT NOT NULL DEFAULT '[]', hmi_parameters TEXT NOT NULL DEFAULT '[]',
  recipe_parameters TEXT NOT NULL DEFAULT '[]', report_parameters TEXT NOT NULL DEFAULT '[]',
  sequences TEXT NOT NULL DEFAULT '{}', template_package_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS unit_instances (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, instance_number INTEGER,
  unit_type_id TEXT NOT NULL, controller_id TEXT, pid_drawing TEXT,
  process_cell TEXT, area TEXT, comment TEXT, site_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(unit_type_id, name)
);
CREATE TABLE IF NOT EXISTS control_module_instances (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, instance_number INTEGER,
  control_module_type_id TEXT NOT NULL, controller_id TEXT, unit_instance_id TEXT,
  pid_drawing TEXT, comment TEXT, configuration TEXT NOT NULL DEFAULT '{}',
  current_state TEXT NOT NULL DEFAULT '{}', site_id TEXT, asset_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(control_module_type_id, name)
);
CREATE TABLE IF NOT EXISTS phase_instances (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, instance_number INTEGER,
  phase_type_id TEXT NOT NULL, unit_instance_id TEXT, controller_id TEXT,
  current_state TEXT DEFAULT 'IDLE', current_step INTEGER DEFAULT 0,
  linked_module_instances TEXT NOT NULL DEFAULT '{}', site_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS design_specifications (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL,
  description TEXT, content_hash TEXT NOT NULL, tx_hash TEXT,
  content TEXT NOT NULL DEFAULT '{}', site_id TEXT, created_at INTEGER NOT NULL,
  anchored_at INTEGER
);
CREATE TABLE IF NOT EXISTS generated_code (
  id TEXT PRIMARY KEY, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
  vendor_id TEXT NOT NULL, template_package_id TEXT, language TEXT NOT NULL,
  code TEXT NOT NULL, code_hash TEXT NOT NULL, tx_hash TEXT,
  metadata TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'draft',
  generated_at INTEGER NOT NULL, approved_at INTEGER, approved_by TEXT
);
CREATE TABLE IF NOT EXISTS data_type_mappings (
  id TEXT PRIMARY KEY, vendor_id TEXT NOT NULL, canonical_type TEXT NOT NULL,
  vendor_type TEXT NOT NULL, size INTEGER, precision INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL,
  UNIQUE(vendor_id, canonical_type)
);
CREATE TABLE IF NOT EXISTS controllers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, vendor_id TEXT NOT NULL, site_id TEXT,
  model TEXT NOT NULL, firmware_version TEXT, address TEXT,
  configuration TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'offline',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blueprint_safe_state_log (
  id TEXT PRIMARY KEY, blueprint_id TEXT NOT NULL, site_id TEXT,
  transition TEXT NOT NULL, safe_state TEXT NOT NULL,
  tick_budget_ms INTEGER NOT NULL, consecutive_misses INTEGER,
  operator TEXT, reason TEXT NOT NULL, anchor_hash TEXT NOT NULL,
  anchor_tx_hash TEXT, metadata TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_registry (
  id TEXT PRIMARY KEY, version TEXT NOT NULL, manifest TEXT NOT NULL,
  publisher TEXT NOT NULL, installs INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_installations (
  id TEXT PRIMARY KEY, version TEXT NOT NULL, manifest TEXT NOT NULL,
  status TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}',
  granted_capabilities TEXT NOT NULL DEFAULT '[]', installed_by TEXT NOT NULL,
  installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_unit_instances_type_name
  ON unit_instances(unit_type_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_control_module_instances_type_name
  ON control_module_instances(control_module_type_id, name);
CREATE INDEX IF NOT EXISTS idx_safe_state_log_blueprint_id
  ON blueprint_safe_state_log(blueprint_id);
CREATE INDEX IF NOT EXISTS idx_safe_state_log_transition
  ON blueprint_safe_state_log(transition);
CREATE INDEX IF NOT EXISTS idx_safe_state_log_created_at
  ON blueprint_safe_state_log(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_safe_state_log_anchor_hash
  ON blueprint_safe_state_log(anchor_hash);
CREATE INDEX IF NOT EXISTS idx_plugin_registry_publisher
  ON plugin_registry(publisher);
CREATE INDEX IF NOT EXISTS idx_plugin_installations_status
  ON plugin_installations(status);
`;

/**
 * Validator registry tables for the development SQLite database (#454).
 *
 * Mirrors `migrations/0007_validator_registry.sql`. Without this the cross-node
 * `/state/:key` proxy would only ever be usable against a hand-seeded Postgres,
 * which was the reason the first attempt at this feature was rejected.
 */
const validatorRegistrySqliteSchema = `
CREATE TABLE IF NOT EXISTS validator_nodes (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, rpc_url TEXT NOT NULL,
  operator_id TEXT, region TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS validator_pubkeys (
  id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES validator_nodes(id) ON DELETE CASCADE,
  algorithm TEXT NOT NULL DEFAULT 'ed25519', public_key_pem TEXT NOT NULL,
  key_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, retired_at INTEGER,
  UNIQUE(node_id, key_id)
);
CREATE TABLE IF NOT EXISTS validator_state_watermarks (
  id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES validator_nodes(id) ON DELETE CASCADE,
  state_key TEXT NOT NULL, block_height INTEGER NOT NULL,
  observed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(node_id, state_key)
);
CREATE INDEX IF NOT EXISTS idx_validator_pubkeys_node_active
  ON validator_pubkeys(node_id, active);
`;

function toSnakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function toCamelCase(value: string): string {
  return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function requireSqliteClient(): Database {
  if (!sqliteClient) {
    throw new Error('SQLite database is not initialized');
  }
  return sqliteClient;
}

function sqliteExec(sqlText: string): Promise<void> {
  return new Promise((resolve, reject) => {
    requireSqliteClient().exec(sqlText, (error) => error ? reject(error) : resolve());
  });
}

function sqliteRun(sqlText: string, parameters: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    requireSqliteClient().run(sqlText, parameters, (error) => error ? reject(error) : resolve());
  });
}

function sqliteAll(sqlText: string, parameters: unknown[] = []): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    requireSqliteClient().all(
      sqlText,
      parameters,
      (error, rows) => error
        ? reject(error)
        : resolve(rows as Record<string, unknown>[]),
    );
  });
}

function decodeSqliteRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([databaseKey, rawValue]) => {
    const key = toCamelCase(databaseKey);
    let value = rawValue;
    if (
      value !== null
      && sqliteJsonColumns.has(key)
      && typeof value === 'string'
      && /^[\[{]/.test(value)
    ) {
      value = JSON.parse(value);
    } else if (value !== null && sqliteBooleanColumns.has(key)) {
      value = Boolean(value);
    } else if (value !== null && sqliteDateColumns.has(key)) {
      value = new Date(Number(value));
    }
    return [key, value];
  }));
}

function encodeSqliteValue(key: string, value: unknown): unknown {
  if (value instanceof Date) return value.getTime();
  if (key === 'currentState' && typeof value === 'string') return value;
  if (sqliteJsonColumns.has(key)) return JSON.stringify(value);
  if (sqliteBooleanColumns.has(key)) return value ? 1 : 0;
  return value;
}

async function sqliteFind(
  table: StorageTableName,
  where: Record<string, unknown> = {},
  orderBy?: string,
): Promise<Record<string, unknown>[]> {
  const allowed = new Set(sqliteColumns[table]);
  const filters = Object.entries(where);
  for (const [key] of filters) {
    if (!allowed.has(key)) throw new Error(`Unsupported ${table} filter: ${key}`);
  }
  if (orderBy && !allowed.has(orderBy)) throw new Error(`Unsupported ${table} order: ${orderBy}`);

  const whereSql = filters.length
    ? ` WHERE ${filters.map(([key]) => `${toSnakeCase(key)} = ?`).join(' AND ')}`
    : '';
  const orderSql = orderBy ? ` ORDER BY ${toSnakeCase(orderBy)} DESC` : '';
  const rows = await sqliteAll(
    `SELECT * FROM ${table}${whereSql}${orderSql}`,
    filters.map(([key, value]) => encodeSqliteValue(key, value)),
  );
  return rows.map(decodeSqliteRow);
}

async function sqliteInsert(
  table: StorageTableName,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const now = new Date();
  const allowed = new Set(sqliteColumns[table]);
  const record: Record<string, unknown> = { id: randomUUID(), ...input };
  if (allowed.has('createdAt') && record.createdAt === undefined) record.createdAt = now;
  if (allowed.has('updatedAt') && record.updatedAt === undefined) record.updatedAt = now;
  if (allowed.has('generatedAt') && record.generatedAt === undefined) record.generatedAt = now;

  const entries = Object.entries(record).filter(([key, value]) => allowed.has(key) && value !== undefined);
  const columns = entries.map(([key]) => toSnakeCase(key));
  const placeholders = entries.map(() => '?');
  await sqliteRun(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
    entries.map(([key, value]) => encodeSqliteValue(key, value)),
  );
  const [created] = await sqliteFind(table, { id: record.id });
  return created;
}

async function sqliteUpdate(
  table: StorageTableName,
  id: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const allowed = new Set(sqliteColumns[table]);
  const record = { ...input };
  if (allowed.has('updatedAt')) record.updatedAt = new Date();
  const entries = Object.entries(record).filter(([key, value]) =>
    key !== 'id' && allowed.has(key) && value !== undefined,
  );
  if (entries.length > 0) {
    await sqliteRun(
      `UPDATE ${table} SET ${entries.map(([key]) => `${toSnakeCase(key)} = ?`).join(', ')} WHERE id = ?`,
      [...entries.map(([key, value]) => encodeSqliteValue(key, value)), id],
    );
  }
  const [updated] = await sqliteFind(table, { id });
  return updated;
}

async function openSqliteDatabase(databasePath: string): Promise<void> {
  sqliteClient = await new Promise<Database>((resolve, reject) => {
    const client = new Database(databasePath, (error) => error ? reject(error) : resolve(client));
  });
  await sqliteExec(blueprintSqliteSchema);
  await sqliteExec(validatorRegistrySqliteSchema);
}

export const initializeDatabase = async () => {
  if (db) return db;

  try {
    if (usePostgres && !isDevelopment) {
      // Use PostgreSQL in production
      console.log('🗄️  Initializing PostgreSQL database...');
      pgClient = new Client({
        connectionString: process.env.DATABASE_URL
      });
      await pgClient.connect();
      db = drizzlePostgres(pgClient, { schema });
      dbType = 'postgres';
      console.log('✅ PostgreSQL database connected');
    } else {
      // Use SQLite for development/fallback
      console.log('🗄️  Initializing SQLite database (development mode)...');
      const dbPath = process.env.SQLITE_DATABASE_PATH || path.join(process.cwd(), 'dev-database.sqlite');
      await openSqliteDatabase(dbPath);
      
      // Create a simple drizzle-compatible wrapper
      db = {
        // Simplified interface for development
        select: () => ({ from: () => Promise.resolve([]) }),
        insert: () => ({ values: () => Promise.resolve({ insertId: 1 }) }),
        update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
        delete: () => ({ where: () => Promise.resolve() }),
        // Add schema references
        query: {
          sites: { findMany: () => Promise.resolve([]) },
          assets: { findMany: () => Promise.resolve([]) },
          users: { findMany: () => Promise.resolve([]) }
        }
      };
      
      dbType = 'sqlite';
      console.log(`✅ SQLite database initialized at ${dbPath}`);
    }
  } catch (error) {
    if (usePostgres) {
      console.warn('⚠️  PostgreSQL connection failed, falling back to SQLite...');
      console.error('PostgreSQL error:', error);
      
      // Fallback to SQLite
      const dbPath = process.env.SQLITE_DATABASE_PATH || path.join(process.cwd(), 'dev-database.sqlite');
      await openSqliteDatabase(dbPath);
      
      db = {
        select: () => ({ from: () => Promise.resolve([]) }),
        insert: () => ({ values: () => Promise.resolve({ insertId: 1 }) }),
        update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
        delete: () => ({ where: () => Promise.resolve() }),
        query: {
          sites: { findMany: () => Promise.resolve([]) },
          assets: { findMany: () => Promise.resolve([]) },
          users: { findMany: () => Promise.resolve([]) }
        }
      };
      
      dbType = 'sqlite';
      console.log(`✅ SQLite fallback database initialized at ${dbPath}`);
    } else {
      throw error;
    }
  }

  return db;
};

export const getDatabase = () => {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return db;
};

export const getDatabaseType = () => dbType;

export const closeDatabase = async () => {
  if (pgClient) {
    await pgClient.end();
    pgClient = null;
  }
  if (sqliteClient) {
    await new Promise<void>((resolve, reject) => {
      sqliteClient!.close((error) => error ? reject(error) : resolve());
    });
    sqliteClient = null;
  }
  db = null;
};

function requireDatabase(): any {
  return getDatabase();
}

/**
 * Run a raw Drizzle operation behind the same re-entrant lock used by storage
 * helpers. Modules that need a table not represented by the CRUD facade must
 * use this seam instead of retaining the shared single-connection handle.
 */
export async function withLockedDatabase<T>(
  operation: (database: any) => Promise<T>,
): Promise<T> {
  return withStorageLock(() => operation(requireDatabase()));
}

async function createRecord<T>(
  pgTable: any,
  sqliteTable: StorageTableName,
  input: Record<string, unknown>,
): Promise<T> {
  return withStorageLock(async () => {
    if (dbType === 'sqlite') {
      return await sqliteInsert(sqliteTable, input) as T;
    }
    const [created] = await requireDatabase().insert(pgTable).values(input).returning();
    return created as T;
  });
}

async function listRecords<T>(
  pgTable: any,
  sqliteTable: StorageTableName,
  options: {
    pgWhere?: unknown;
    sqliteWhere?: Record<string, unknown>;
    pgOrder?: unknown;
    sqliteOrder?: string;
  } = {},
): Promise<T[]> {
  return withStorageLock(async () => {
    if (dbType === 'sqlite') {
      return await sqliteFind(sqliteTable, options.sqliteWhere, options.sqliteOrder) as T[];
    }
    let query = requireDatabase().select().from(pgTable);
    if (options.pgWhere) query = query.where(options.pgWhere);
    if (options.pgOrder) query = query.orderBy(options.pgOrder);
    return await query as T[];
  });
}

async function firstRecord<T>(
  pgTable: any,
  sqliteTable: StorageTableName,
  pgWhere: unknown,
  sqliteWhere: Record<string, unknown>,
): Promise<T | undefined> {
  const records = await listRecords<T>(pgTable, sqliteTable, { pgWhere, sqliteWhere });
  return records[0];
}

async function updateRecord<T>(
  pgTable: any,
  sqliteTable: StorageTableName,
  id: string,
  input: Record<string, unknown>,
): Promise<T> {
  return withStorageLock(async () => {
    if (dbType === 'sqlite') {
      return await sqliteUpdate(sqliteTable, id, input) as T;
    }
    const [updated] = await requireDatabase()
      .update(pgTable)
      .set(input)
      .where(eq(pgTable.id, id))
      .returning();
    return updated as T;
  });
}

async function upsertRecord<T>(
  pgTable: any,
  sqliteTable: StorageTableName,
  insertInput: Record<string, unknown>,
  updateInput: Record<string, unknown>,
  pgWhere: unknown,
  sqliteWhere: Record<string, unknown>,
  conflictTarget: unknown[],
): Promise<T> {
  return withStorageLock(async () => {
    if (dbType === 'sqlite') {
      const [existing] = await sqliteFind(sqliteTable, sqliteWhere);
      if (existing) {
        return await sqliteUpdate(
          sqliteTable,
          existing.id as string,
          updateInput,
        ) as T;
      }
      try {
        return await sqliteInsert(sqliteTable, insertInput) as T;
      } catch (error) {
        // Another process sharing the SQLite file may have won the unique-key
        // race. Update and read back the canonical row; rethrow non-conflict
        // failures. This also makes corrected imports converge on one value.
        const [raced] = await sqliteFind(sqliteTable, sqliteWhere);
        if (raced) {
          return await sqliteUpdate(
            sqliteTable,
            raced.id as string,
            updateInput,
          ) as T;
        }
        throw error;
      }
    }

    const database = requireDatabase();
    const [upserted] = await database
      .insert(pgTable)
      .values(insertInput)
      .onConflictDoUpdate({
        target: conflictTarget,
        set: updateInput,
      })
      .returning();
    if (upserted) return upserted as T;

    // PostgreSQL INSERT ... ON CONFLICT ... RETURNING should always return one
    // row. Retain a defensive read-back so a driver anomaly fails explicitly.
    const [existing] = await database
      .select()
      .from(pgTable)
      .where(pgWhere)
      .limit(1);
    if (!existing) {
      throw new Error(`Instance upsert conflict for ${sqliteTable} returned no row`);
    }
    return existing as T;
  });
}

async function deleteRecord(
  pgTable: any,
  sqliteTable: StorageTableName,
  id: string,
): Promise<void> {
  await withStorageLock(async () => {
    if (dbType === 'sqlite') {
      await sqliteRun(`DELETE FROM ${sqliteTable} WHERE id = ?`, [id]);
      return;
    }
    await requireDatabase().delete(pgTable).where(eq(pgTable.id, id));
  });
}

async function runStorageTransaction<T>(operation: () => Promise<T>): Promise<T> {
  if (transactionContext.getStore()?.active) {
    throw new Error('Nested storage transactions are not supported');
  }

  return withStorageLock(() => {
    const context: StorageTransactionContext = { active: true };
    return transactionContext.run(context, async () => {
      try {
        requireDatabase();

        if (dbType === 'postgres') {
          if (!pgClient) throw new Error('PostgreSQL client is not initialized');
          await pgClient.query('BEGIN');
          try {
            const result = await operation();
            await pgClient.query('COMMIT');
            return result;
          } catch (error) {
            await pgClient.query('ROLLBACK');
            throw error;
          }
        }

        await sqliteExec('BEGIN IMMEDIATE');
        try {
          const result = await operation();
          await sqliteExec('COMMIT');
          return result;
        } catch (error) {
          await sqliteExec('ROLLBACK');
          throw error;
        }
      } finally {
        context.active = false;
      }
    });
  });
}

// ─── Validator Registry Access (#454: Cross-Node State Queries) ────────────────
// DB access goes through this module per repo conventions. These helpers back the
// per-validator `/state/:key` proxy in `server/routes/nodes.ts`:
//   * `validator_nodes`             — which validators exist and where their RPC is
//   * `validator_pubkeys`           — the Ed25519 keys their responses are verified against
//   * `validator_state_watermarks`  — per-(node, key) highest accepted block height
//
// Both the Postgres and the SQLite development database are implemented, so the
// feature is usable without hand-seeding a Postgres instance. Every lookup is
// fail-closed by construction: an unregistered node or an unregistered key
// resolves to `null` and the route refuses to return validator data.

export interface ValidatorNodeRecord {
  id: string;
  name: string;
  rpcUrl: string;
  operatorId?: string | null;
  region?: string | null;
  enabled: boolean;
}

export interface ValidatorPubkeyRecord {
  nodeId: string;
  algorithm: string;
  publicKeyPem: string;
  keyId: string;
  active: boolean;
}

export interface ValidatorStateWatermarkRecord {
  nodeId: string;
  stateKey: string;
  blockHeight: number;
  observedAt: Date;
}

export interface UpsertValidatorNodeInput {
  id: string;
  name: string;
  rpcUrl: string;
  operatorId?: string | null;
  region?: string | null;
  enabled?: boolean;
}

export interface UpsertValidatorPubkeyInput {
  nodeId: string;
  keyId: string;
  publicKeyPem: string;
  algorithm?: string;
  active?: boolean;
}

function toValidatorNodeRecord(row: Record<string, unknown>): ValidatorNodeRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    rpcUrl: String(row.rpcUrl),
    operatorId: (row.operatorId as string | null | undefined) ?? null,
    region: (row.region as string | null | undefined) ?? null,
    enabled: Boolean(row.enabled),
  };
}

function toValidatorPubkeyRecord(row: Record<string, unknown>): ValidatorPubkeyRecord {
  return {
    nodeId: String(row.nodeId),
    algorithm: String(row.algorithm),
    publicKeyPem: String(row.publicKeyPem),
    keyId: String(row.keyId),
    active: Boolean(row.active),
  };
}

/** Resolve a validator node by its registry id, or null if unknown. */
export const getValidatorNode = async (id: string): Promise<ValidatorNodeRecord | null> => {
  return withStorageLock(async () => {
    if (dbType !== 'postgres') {
      const rows = await sqliteAll(
        'SELECT * FROM validator_nodes WHERE id = ? LIMIT 1',
        [id],
      );
      const row = rows[0];
      return row ? toValidatorNodeRecord(decodeSqliteRow(row)) : null;
    }
    const rows = await requireDatabase()
      .select()
      .from(schema.validatorNodes)
      .where(eq(schema.validatorNodes.id, id))
      .limit(1);
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? toValidatorNodeRecord(row) : null;
  });
};

/** List every registered validator node (admin surface). */
export const listValidatorNodes = async (): Promise<ValidatorNodeRecord[]> => {
  return withStorageLock(async () => {
    if (dbType !== 'postgres') {
      const rows = await sqliteAll('SELECT * FROM validator_nodes ORDER BY id');
      return rows.map((row) => toValidatorNodeRecord(decodeSqliteRow(row)));
    }
    const rows = await requireDatabase()
      .select()
      .from(schema.validatorNodes)
      .orderBy(schema.validatorNodes.id);
    return (rows as Record<string, unknown>[]).map(toValidatorNodeRecord);
  });
};

/**
 * Register (or update) a validator node. This is the seeding path for the
 * cross-node state proxy — see `POST /api/nodes` in `server/routes/nodes.ts`.
 */
export const upsertValidatorNode = async (
  input: UpsertValidatorNodeInput,
): Promise<ValidatorNodeRecord> => {
  const enabled = input.enabled ?? true;
  const operatorId = input.operatorId ?? null;
  const region = input.region ?? null;

  return withStorageLock(async () => {
    if (dbType !== 'postgres') {
      const now = Date.now();
      await sqliteRun(
        `INSERT INTO validator_nodes (id, name, rpc_url, operator_id, region, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           rpc_url = excluded.rpc_url,
           operator_id = excluded.operator_id,
           region = excluded.region,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
        [input.id, input.name, input.rpcUrl, operatorId, region, enabled ? 1 : 0, now, now],
      );
      const rows = await sqliteAll('SELECT * FROM validator_nodes WHERE id = ?', [input.id]);
      return toValidatorNodeRecord(decodeSqliteRow(rows[0]));
    }

    const [row] = await requireDatabase()
      .insert(schema.validatorNodes)
      .values({
        id: input.id,
        name: input.name,
        rpcUrl: input.rpcUrl,
        operatorId,
        region,
        enabled,
      })
      .onConflictDoUpdate({
        target: schema.validatorNodes.id,
        set: {
          name: input.name,
          rpcUrl: input.rpcUrl,
          operatorId,
          region,
          enabled,
          updatedAt: new Date(),
        },
      })
      .returning();
    return toValidatorNodeRecord(row as Record<string, unknown>);
  });
};

/**
 * Resolve the active Ed25519 verification key a validator named in its response.
 * Returns null when the (node, keyId) pair is unregistered, retired, or is not
 * an Ed25519 key — all of which the route treats as "do not trust this answer".
 */
export const getActiveValidatorPubkey = async (
  nodeId: string,
  keyId: string,
): Promise<ValidatorPubkeyRecord | null> => {
  return withStorageLock(async () => {
    if (dbType !== 'postgres') {
      const rows = await sqliteAll(
        `SELECT * FROM validator_pubkeys
         WHERE node_id = ? AND key_id = ? AND active = 1 AND algorithm = 'ed25519'
         LIMIT 1`,
        [nodeId, keyId],
      );
      const row = rows[0];
      return row ? toValidatorPubkeyRecord(decodeSqliteRow(row)) : null;
    }
    const rows = await requireDatabase()
      .select()
      .from(schema.validatorPubkeys)
      .where(and(
        eq(schema.validatorPubkeys.nodeId, nodeId),
        eq(schema.validatorPubkeys.keyId, keyId),
        eq(schema.validatorPubkeys.active, true),
        eq(schema.validatorPubkeys.algorithm, 'ed25519'),
      ))
      .limit(1);
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? toValidatorPubkeyRecord(row) : null;
  });
};

/** Register (or rotate) a validator verification key. */
export const upsertValidatorPubkey = async (
  input: UpsertValidatorPubkeyInput,
): Promise<ValidatorPubkeyRecord> => {
  const algorithm = input.algorithm ?? 'ed25519';
  const active = input.active ?? true;

  return withStorageLock(async () => {
    if (dbType !== 'postgres') {
      await sqliteRun(
        `INSERT INTO validator_pubkeys (id, node_id, algorithm, public_key_pem, key_id, active, created_at, retired_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(node_id, key_id) DO UPDATE SET
           algorithm = excluded.algorithm,
           public_key_pem = excluded.public_key_pem,
           active = excluded.active,
           retired_at = NULL`,
        [randomUUID(), input.nodeId, algorithm, input.publicKeyPem, input.keyId, active ? 1 : 0, Date.now()],
      );
      const rows = await sqliteAll(
        'SELECT * FROM validator_pubkeys WHERE node_id = ? AND key_id = ?',
        [input.nodeId, input.keyId],
      );
      return toValidatorPubkeyRecord(decodeSqliteRow(rows[0]));
    }

    const [row] = await requireDatabase()
      .insert(schema.validatorPubkeys)
      .values({
        nodeId: input.nodeId,
        algorithm,
        publicKeyPem: input.publicKeyPem,
        keyId: input.keyId,
        active,
      })
      .onConflictDoUpdate({
        target: [schema.validatorPubkeys.nodeId, schema.validatorPubkeys.keyId],
        set: {
          algorithm,
          publicKeyPem: input.publicKeyPem,
          active,
          retiredAt: null,
        },
      })
      .returning();
    return toValidatorPubkeyRecord(row as Record<string, unknown>);
  });
};

/** Retire a validator key so its signatures stop being accepted. */
export const retireValidatorPubkey = async (
  nodeId: string,
  keyId: string,
): Promise<boolean> => {
  return withStorageLock(async () => {
    if (dbType !== 'postgres') {
      const rows = await sqliteAll(
        'SELECT id FROM validator_pubkeys WHERE node_id = ? AND key_id = ? AND active = 1',
        [nodeId, keyId],
      );
      if (rows.length === 0) return false;
      await sqliteRun(
        'UPDATE validator_pubkeys SET active = 0, retired_at = ? WHERE node_id = ? AND key_id = ?',
        [Date.now(), nodeId, keyId],
      );
      return true;
    }
    const updated = await requireDatabase()
      .update(schema.validatorPubkeys)
      .set({ active: false, retiredAt: new Date() })
      .where(and(
        eq(schema.validatorPubkeys.nodeId, nodeId),
        eq(schema.validatorPubkeys.keyId, keyId),
        eq(schema.validatorPubkeys.active, true),
      ))
      .returning();
    return (updated as unknown[]).length > 0;
  });
};

/**
 * Highest block height already accepted for `(nodeId, stateKey)`, or null when
 * this pair has never been queried. Used as the anti-rollback high-water mark.
 */
export const getValidatorStateWatermark = async (
  nodeId: string,
  stateKey: string,
): Promise<ValidatorStateWatermarkRecord | null> => {
  return withStorageLock(async () => {
    if (dbType !== 'postgres') {
      const rows = await sqliteAll(
        'SELECT * FROM validator_state_watermarks WHERE node_id = ? AND state_key = ? LIMIT 1',
        [nodeId, stateKey],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        nodeId: String(row.node_id),
        stateKey: String(row.state_key),
        blockHeight: Number(row.block_height),
        observedAt: new Date(Number(row.observed_at)),
      };
    }
    const rows = await requireDatabase()
      .select()
      .from(schema.validatorStateWatermarks)
      .where(and(
        eq(schema.validatorStateWatermarks.nodeId, nodeId),
        eq(schema.validatorStateWatermarks.stateKey, stateKey),
      ))
      .limit(1);
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      nodeId: String(row.nodeId),
      stateKey: String(row.stateKey),
      blockHeight: Number(row.blockHeight),
      observedAt: new Date(row.observedAt as string | number | Date),
    };
  });
};

/**
 * Advance the `(nodeId, stateKey)` high-water mark to `blockHeight`, but never
 * lower it. The conditional `ON CONFLICT ... WHERE` makes the compare-and-set
 * atomic in the database, so concurrent server replicas sharing one database
 * cannot race the mark backwards. Returns the mark in force after the write.
 */
export const recordValidatorStateWatermark = async (
  nodeId: string,
  stateKey: string,
  blockHeight: number,
  observedAt: Date,
): Promise<ValidatorStateWatermarkRecord> => {
  await withStorageLock(async () => {
    if (dbType !== 'postgres') {
      await sqliteRun(
        `INSERT INTO validator_state_watermarks (id, node_id, state_key, block_height, observed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id, state_key) DO UPDATE SET
           block_height = excluded.block_height,
           observed_at = excluded.observed_at,
           updated_at = excluded.updated_at
         WHERE validator_state_watermarks.block_height < excluded.block_height`,
        [randomUUID(), nodeId, stateKey, blockHeight, observedAt.getTime(), Date.now()],
      );
      return;
    }
    if (!pgClient) throw new Error('PostgreSQL client is not initialized');
    await pgClient.query(
      `INSERT INTO validator_state_watermarks (node_id, state_key, block_height, observed_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (node_id, state_key) DO UPDATE SET
         block_height = EXCLUDED.block_height,
         observed_at = EXCLUDED.observed_at,
         updated_at = NOW()
       WHERE validator_state_watermarks.block_height < EXCLUDED.block_height`,
      [nodeId, stateKey, blockHeight, observedAt.toISOString()],
    );
  });

  const current = await getValidatorStateWatermark(nodeId, stateKey);
  if (!current) {
    throw new Error(
      `Watermark for ${nodeId}/${stateKey} disappeared immediately after being written`,
    );
  }
  return current;
};
// ─── Blueprint safe-state audit trail (#459) ────────────────────────────────
// The watchdog's safe-state transitions must be durable on BOTH dialects. The
// generic CRUD facade above cannot be reused here: `safe_state` may serialise
// to a bare JSON string ("hold-last"), which the shared SQLite JSON decoder
// (which only parses values starting with `[` or `{`) would hand back
// double-encoded. These two functions therefore own their own encoding.
//
// Postgres schema: migrations/0009_blueprint_safe_state_log.sql
// SQLite schema:   `blueprintSqliteSchema` above, applied on every open.

/** A safe-state transition as written to `blueprint_safe_state_log`. */
export interface SafeStateLogInsert {
  blueprintId: string;
  siteId?: string;
  transition: string;
  /** Serialised SafeStateAction. */
  safeState: unknown;
  tickBudgetMs: number;
  consecutiveMisses?: number;
  operator?: string;
  reason: string;
  anchorHash: string;
  anchorTxHash?: string;
  createdAt: Date;
}

/** A safe-state transition as read back from `blueprint_safe_state_log`. */
export interface SafeStateLogRecord extends SafeStateLogInsert {
  id: string;
}

function toSafeStateLogRecord(row: Record<string, unknown>): SafeStateLogRecord {
  const rawSafeState = row.safe_state ?? row.safeState;
  const safeState = typeof rawSafeState === 'string'
    ? JSON.parse(rawSafeState) as unknown
    : rawSafeState;
  const rawCreatedAt = row.created_at ?? row.createdAt;
  const createdAt = rawCreatedAt instanceof Date
    ? rawCreatedAt
    : new Date(Number(rawCreatedAt));
  const optional = (value: unknown): string | undefined =>
    value === null || value === undefined ? undefined : String(value);
  const optionalNumber = (value: unknown): number | undefined =>
    value === null || value === undefined ? undefined : Number(value);

  return {
    id: String(row.id),
    blueprintId: String(row.blueprint_id ?? row.blueprintId),
    siteId: optional(row.site_id ?? row.siteId),
    transition: String(row.transition),
    safeState,
    tickBudgetMs: Number(row.tick_budget_ms ?? row.tickBudgetMs),
    consecutiveMisses: optionalNumber(row.consecutive_misses ?? row.consecutiveMisses),
    operator: optional(row.operator),
    reason: String(row.reason),
    anchorHash: String(row.anchor_hash ?? row.anchorHash),
    anchorTxHash: optional(row.anchor_tx_hash ?? row.anchorTxHash),
    createdAt,
  };
}

/**
 * Durably record one safe-state transition. Idempotent on `anchor_hash` so a
 * retried write (the controller retries an entry whose durability was
 * ambiguous) cannot duplicate the audit row.
 *
 * Throws if the write did not land — callers must never treat a discarded
 * audit as a successful one.
 */
export async function insertBlueprintSafeStateLog(
  entry: SafeStateLogInsert,
): Promise<void> {
  await withStorageLock(async () => {
    if (dbType === 'sqlite') {
      await sqliteRun(
        `INSERT OR IGNORE INTO blueprint_safe_state_log
           (id, blueprint_id, site_id, transition, safe_state, tick_budget_ms,
            consecutive_misses, operator, reason, anchor_hash, anchor_tx_hash,
            created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          entry.blueprintId,
          entry.siteId ?? null,
          entry.transition,
          JSON.stringify(entry.safeState),
          entry.tickBudgetMs,
          entry.consecutiveMisses ?? null,
          entry.operator ?? null,
          entry.reason,
          entry.anchorHash,
          entry.anchorTxHash ?? null,
          entry.createdAt.getTime(),
        ],
      );
      return;
    }

    await requireDatabase()
      .insert(schema.blueprintSafeStateLog)
      .values({
        blueprintId: entry.blueprintId,
        siteId: entry.siteId,
        transition: entry.transition,
        safeState: entry.safeState as Record<string, unknown>,
        tickBudgetMs: entry.tickBudgetMs,
        consecutiveMisses: entry.consecutiveMisses,
        operator: entry.operator,
        reason: entry.reason,
        anchorHash: entry.anchorHash,
        anchorTxHash: entry.anchorTxHash,
        createdAt: entry.createdAt,
      })
      .onConflictDoNothing({ target: schema.blueprintSafeStateLog.anchorHash });
  });
}

/** Read back safe-state transitions, newest first. */
export async function listBlueprintSafeStateLog(
  blueprintId?: string,
): Promise<SafeStateLogRecord[]> {
  return withStorageLock(async () => {
    if (dbType === 'sqlite') {
      const rows = blueprintId
        ? await sqliteAll(
          'SELECT * FROM blueprint_safe_state_log WHERE blueprint_id = ? ORDER BY created_at DESC',
          [blueprintId],
        )
        : await sqliteAll(
          'SELECT * FROM blueprint_safe_state_log ORDER BY created_at DESC',
        );
      return rows.map(toSafeStateLogRecord);
    }

    const table = schema.blueprintSafeStateLog;
    let query = requireDatabase().select().from(table);
    if (blueprintId) query = query.where(eq(table.blueprintId, blueprintId));
    const rows = await query.orderBy(desc(table.createdAt)) as Record<string, unknown>[];
    return rows.map(toSafeStateLogRecord);
  });
}

// Export storage object as expected by health/index.ts
export const storage = {
  transaction: runStorageTransaction,
  isConnected: () => db !== null,
  getHealth: () => ({
    connected: db !== null,
    type: dbType,
    database: dbType === 'postgres'
      ? (process.env.DATABASE_URL ? 'PostgreSQL configured' : 'not configured')
      : 'SQLite (development mode)'
  }),
  /**
   * Active connectivity probe used by the health endpoints. Runs a lightweight
   * query against Postgres; the file-backed SQLite dev database is considered
   * connected once initialized.
   */
  healthCheck: async (): Promise<{ connected: boolean; type: string; error?: string }> => {
    if (!db) {
      return { connected: false, type: dbType, error: 'Database not initialized' };
    }
    try {
      if (dbType === 'postgres' && pgClient) {
        await pgClient.query('SELECT 1');
      }
      return { connected: true, type: dbType };
    } catch (err) {
      return { connected: false, type: dbType, error: (err as Error).message };
    }
  },

  createControlModuleType: (input: schema.InsertControlModuleType) =>
    createRecord<schema.ControlModuleType>(schema.controlModuleTypes, 'control_module_types', input),
  getControlModuleTypes: () =>
    listRecords<schema.ControlModuleType>(schema.controlModuleTypes, 'control_module_types'),
  getControlModuleTypeByName: (name: string) =>
    firstRecord<schema.ControlModuleType>(
      schema.controlModuleTypes,
      'control_module_types',
      eq(schema.controlModuleTypes.name, name),
      { name },
    ),
  upsertControlModuleType: async (input: schema.InsertControlModuleType) => {
    return upsertRecord<schema.ControlModuleType>(
      schema.controlModuleTypes,
      'control_module_types',
      input,
      { ...input, updatedAt: new Date() },
      eq(schema.controlModuleTypes.name, input.name),
      { name: input.name },
      [schema.controlModuleTypes.name],
    );
  },

  createControlModuleInstance: (input: schema.InsertControlModuleInstance) =>
    createRecord<schema.ControlModuleInstance>(schema.controlModuleInstances, 'control_module_instances', input),
  upsertControlModuleInstance: (input: schema.InsertControlModuleInstance) =>
    upsertRecord<schema.ControlModuleInstance>(
      schema.controlModuleInstances,
      'control_module_instances',
      input,
      { ...input, updatedAt: new Date() },
      and(
        eq(schema.controlModuleInstances.controlModuleTypeId, input.controlModuleTypeId),
        eq(schema.controlModuleInstances.name, input.name),
      ),
      {
        controlModuleTypeId: input.controlModuleTypeId,
        name: input.name,
      },
      [
        schema.controlModuleInstances.controlModuleTypeId,
        schema.controlModuleInstances.name,
      ],
    ),
  getControlModuleInstances: () =>
    listRecords<schema.ControlModuleInstance>(schema.controlModuleInstances, 'control_module_instances'),
  getControlModuleInstancesByTypeId: (typeId: string) =>
    listRecords<schema.ControlModuleInstance>(
      schema.controlModuleInstances,
      'control_module_instances',
      {
        pgWhere: eq(schema.controlModuleInstances.controlModuleTypeId, typeId),
        sqliteWhere: { controlModuleTypeId: typeId },
      },
    ),

  createUnitType: (input: schema.InsertUnitType) =>
    createRecord<schema.UnitType>(schema.unitTypes, 'unit_types', input),
  getUnitTypes: () => listRecords<schema.UnitType>(schema.unitTypes, 'unit_types'),
  getUnitTypeByName: (name: string) =>
    firstRecord<schema.UnitType>(
      schema.unitTypes,
      'unit_types',
      eq(schema.unitTypes.name, name),
      { name },
    ),
  upsertUnitType: async (input: schema.InsertUnitType) => {
    return upsertRecord<schema.UnitType>(
      schema.unitTypes,
      'unit_types',
      input,
      { ...input, updatedAt: new Date() },
      eq(schema.unitTypes.name, input.name),
      { name: input.name },
      [schema.unitTypes.name],
    );
  },

  createUnitInstance: (input: schema.InsertUnitInstance) =>
    createRecord<schema.UnitInstance>(schema.unitInstances, 'unit_instances', input),
  upsertUnitInstance: (input: schema.InsertUnitInstance) =>
    upsertRecord<schema.UnitInstance>(
      schema.unitInstances,
      'unit_instances',
      input,
      { ...input, updatedAt: new Date() },
      and(
        eq(schema.unitInstances.unitTypeId, input.unitTypeId),
        eq(schema.unitInstances.name, input.name),
      ),
      { unitTypeId: input.unitTypeId, name: input.name },
      [schema.unitInstances.unitTypeId, schema.unitInstances.name],
    ),
  getUnitInstances: () => listRecords<schema.UnitInstance>(schema.unitInstances, 'unit_instances'),
  getUnitInstancesByTypeId: (typeId: string) =>
    listRecords<schema.UnitInstance>(
      schema.unitInstances,
      'unit_instances',
      {
        pgWhere: eq(schema.unitInstances.unitTypeId, typeId),
        sqliteWhere: { unitTypeId: typeId },
      },
    ),

  createPhaseType: (input: schema.InsertPhaseType) =>
    createRecord<schema.PhaseType>(schema.phaseTypes, 'phase_types', input),
  getPhaseTypes: () => listRecords<schema.PhaseType>(schema.phaseTypes, 'phase_types'),
  getPhaseTypeByName: (name: string) =>
    firstRecord<schema.PhaseType>(
      schema.phaseTypes,
      'phase_types',
      eq(schema.phaseTypes.name, name),
      { name },
    ),
  upsertPhaseType: async (input: schema.InsertPhaseType) => {
    return upsertRecord<schema.PhaseType>(
      schema.phaseTypes,
      'phase_types',
      input,
      { ...input, updatedAt: new Date() },
      eq(schema.phaseTypes.name, input.name),
      { name: input.name },
      [schema.phaseTypes.name],
    );
  },

  createPhaseInstance: (input: schema.InsertPhaseInstance) =>
    createRecord<schema.PhaseInstance>(schema.phaseInstances, 'phase_instances', input),
  getPhaseInstances: () => listRecords<schema.PhaseInstance>(schema.phaseInstances, 'phase_instances'),

  createDesignSpecification: (input: schema.InsertDesignSpecification) =>
    createRecord<schema.DesignSpecification>(schema.designSpecifications, 'design_specifications', input),
  getDesignSpecifications: () =>
    listRecords<schema.DesignSpecification>(
      schema.designSpecifications,
      'design_specifications',
      {
        pgOrder: desc(schema.designSpecifications.createdAt),
        sqliteOrder: 'createdAt',
      },
    ),

  createVendor: (input: schema.InsertVendor) =>
    createRecord<schema.Vendor>(schema.vendors, 'vendors', input),
  getVendors: () =>
    listRecords<schema.Vendor>(
      schema.vendors,
      'vendors',
      {
        pgWhere: eq(schema.vendors.isActive, true),
        sqliteWhere: { isActive: true },
      },
    ),
  getVendorByName: (name: string) =>
    firstRecord<schema.Vendor>(
      schema.vendors,
      'vendors',
      eq(schema.vendors.name, name),
      { name },
    ),
  getVendorById: (id: string) =>
    firstRecord<schema.Vendor>(
      schema.vendors,
      'vendors',
      eq(schema.vendors.id, id),
      { id },
    ),
  upsertVendor: async (input: schema.InsertVendor) => {
    return upsertRecord<schema.Vendor>(
      schema.vendors,
      'vendors',
      input,
      { ...input, updatedAt: new Date() },
      eq(schema.vendors.name, input.name),
      { name: input.name },
      [schema.vendors.name],
    );
  },

  createTemplatePackage: (input: schema.InsertTemplatePackage) =>
    createRecord<schema.TemplatePackage>(schema.templatePackages, 'template_packages', input),
  getTemplatePackages: () =>
    listRecords<schema.TemplatePackage>(schema.templatePackages, 'template_packages'),
  getTemplatePackagesByVendor: (vendorId: string) =>
    listRecords<schema.TemplatePackage>(
      schema.templatePackages,
      'template_packages',
      {
        pgWhere: eq(schema.templatePackages.vendorId, vendorId),
        sqliteWhere: { vendorId },
      },
    ),

  createGeneratedCode: (input: schema.InsertGeneratedCode) =>
    createRecord<schema.GeneratedCode>(schema.generatedCode, 'generated_code', input),
  getGeneratedCode: () =>
    listRecords<schema.GeneratedCode>(
      schema.generatedCode,
      'generated_code',
      {
        pgOrder: desc(schema.generatedCode.generatedAt),
        sqliteOrder: 'generatedAt',
      },
    ),
  getGeneratedCodeBySource: (sourceType: string, sourceId: string) =>
    listRecords<schema.GeneratedCode>(
      schema.generatedCode,
      'generated_code',
      {
        pgWhere: and(
          eq(schema.generatedCode.sourceType, sourceType),
          eq(schema.generatedCode.sourceId, sourceId),
        ),
        sqliteWhere: { sourceType, sourceId },
        pgOrder: desc(schema.generatedCode.generatedAt),
        sqliteOrder: 'generatedAt',
      },
    ),
  updateGeneratedCodeTxHash: (id: string, txHash: string) =>
    updateRecord<schema.GeneratedCode>(
      schema.generatedCode,
      'generated_code',
      id,
      { txHash },
    ),

  createDataTypeMapping: (input: schema.InsertDataTypeMapping) =>
    createRecord<schema.DataTypeMapping>(schema.dataTypeMappings, 'data_type_mappings', input),
  getDataTypeMappingsByVendor: (vendorId: string) =>
    listRecords<schema.DataTypeMapping>(
      schema.dataTypeMappings,
      'data_type_mappings',
      {
        pgWhere: eq(schema.dataTypeMappings.vendorId, vendorId),
        sqliteWhere: { vendorId },
      },
    ),
  upsertDataTypeMapping: async (input: schema.InsertDataTypeMapping) => {
    return upsertRecord<schema.DataTypeMapping>(
      schema.dataTypeMappings,
      'data_type_mappings',
      input,
      input,
      and(
        eq(schema.dataTypeMappings.vendorId, input.vendorId),
        eq(schema.dataTypeMappings.canonicalType, input.canonicalType),
      ),
      {
        vendorId: input.vendorId,
        canonicalType: input.canonicalType,
      },
      [
        schema.dataTypeMappings.vendorId,
        schema.dataTypeMappings.canonicalType,
      ],
    );
  },

  createController: (input: schema.InsertController) =>
    createRecord<schema.Controller>(schema.controllers, 'controllers', input),
  getControllers: () => listRecords<schema.Controller>(schema.controllers, 'controllers'),
  getControllersByVendor: (vendorId: string) =>
    listRecords<schema.Controller>(
      schema.controllers,
      'controllers',
      {
        pgWhere: eq(schema.controllers.vendorId, vendorId),
        sqliteWhere: { vendorId },
      },
    ),
  getControllersBySite: (siteId: string) =>
    listRecords<schema.Controller>(
      schema.controllers,
      'controllers',
      {
        pgWhere: eq(schema.controllers.siteId, siteId),
        sqliteWhere: { siteId },
      },
    ),

  // ── Agent marketplace (#217) ───────────────────────────────────────────
  // The registry row carries the durable plugin-ownership record; the
  // installation row carries the durable capability grants. Both must
  // survive a restart or neither is a security control.

  getPluginRegistryEntries: () =>
    listRecords<schema.PluginRegistryRow>(schema.pluginRegistry, 'plugin_registry'),
  upsertPluginRegistryEntry: (input: schema.InsertPluginRegistryRow) =>
    upsertRecord<schema.PluginRegistryRow>(
      schema.pluginRegistry,
      'plugin_registry',
      input,
      {
        version: input.version,
        manifest: input.manifest,
        publisher: input.publisher,
        installs: input.installs,
        updatedAt: input.updatedAt ?? new Date(),
      },
      eq(schema.pluginRegistry.id, input.id),
      { id: input.id },
      [schema.pluginRegistry.id],
    ),

  getPluginInstallations: () =>
    listRecords<schema.PluginInstallationRow>(
      schema.pluginInstallations,
      'plugin_installations',
    ),
  upsertPluginInstallation: (input: schema.InsertPluginInstallationRow) =>
    upsertRecord<schema.PluginInstallationRow>(
      schema.pluginInstallations,
      'plugin_installations',
      input,
      {
        version: input.version,
        manifest: input.manifest,
        status: input.status,
        config: input.config,
        grantedCapabilities: input.grantedCapabilities,
        installedBy: input.installedBy,
        updatedAt: input.updatedAt ?? new Date(),
      },
      eq(schema.pluginInstallations.id, input.id),
      { id: input.id },
      [schema.pluginInstallations.id],
    ),
  deletePluginInstallation: (pluginId: string) =>
    deleteRecord(schema.pluginInstallations, 'plugin_installations', pluginId),
};
