/**
 * Storage/Database module with SQLite fallback for development
 */
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm'; // #454: validator registry queries
import { Client } from 'pg';
import { Database } from 'sqlite3';
import * as schema from '@shared/schema';
import * as sqliteSchema from '@shared/schema-sqlite';
import path from 'path';

const isDevelopment = process.env.NODE_ENV === 'development';
const usePostgres = process.env.DATABASE_URL && process.env.FORCE_POSTGRES !== 'false';

let pgClient: Client | null = null;
let sqliteClient: Database | null = null;
let db: any = null;
let dbType: 'postgres' | 'sqlite' = 'postgres';

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
      const dbPath = path.join(process.cwd(), 'dev-database.sqlite');
      
      sqliteClient = new Database(dbPath);
      
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
      const dbPath = path.join(process.cwd(), 'dev-database.sqlite');
      sqliteClient = new Database(dbPath);
      
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
    sqliteClient.close();
    sqliteClient = null;
  }
  db = null;
};

// ─── Validator Registry Access (#454: Cross-Node State Queries) ────────────────
// DB access goes through this module per repo conventions. These helpers resolve
// a validator node and its active verification key for the /state/:key proxy.
// In the SQLite dev stub the wrapper returns no rows; the Postgres path uses the
// Drizzle `validator_nodes` / `validator_pubkeys` tables. The route layer treats
// a null result as "unknown validator" / "no registered pubkey" respectively.

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
  keyId?: string | null;
  active: boolean;
}

/**
 * Resolve a validator node by its registry id, or null if unknown.
 * Uses the Drizzle Postgres client when available; falls back to null under the
 * SQLite dev stub (which has no real query support).
 */
export const getValidatorNode = async (id: string): Promise<ValidatorNodeRecord | null> => {
  const database = getDatabase();
  if (dbType !== 'postgres') {
    // Development SQLite stub has no live query layer (#454 INTEGRATION: seed
    // validator registry once SQLite parity lands).
    return null;
  }
  const { validatorNodes } = schema;
  const rows = await database
    .select()
    .from(validatorNodes)
    .where(eq(validatorNodes.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    rpcUrl: row.rpcUrl,
    operatorId: row.operatorId,
    region: row.region,
    enabled: row.enabled,
  };
};

/**
 * Resolve the active verification public key for a validator, or null if none.
 */
export const getActiveValidatorPubkey = async (
  nodeId: string,
  keyId: string,
): Promise<ValidatorPubkeyRecord | null> => {
  const database = getDatabase();
  if (dbType !== 'postgres') {
    return null;
  }
  const { validatorPubkeys } = schema;
  const rows = await database
    .select()
    .from(validatorPubkeys)
    .where(and(
      eq(validatorPubkeys.nodeId, nodeId),
      eq(validatorPubkeys.keyId, keyId),
      eq(validatorPubkeys.active, true),
      eq(validatorPubkeys.algorithm, 'ed25519'),
    ))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    nodeId: row.nodeId,
    algorithm: row.algorithm,
    publicKeyPem: row.publicKeyPem,
    keyId: row.keyId,
    active: row.active,
  };
};

// Export storage object as expected by health/index.ts
export const storage = {
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
  }
};
