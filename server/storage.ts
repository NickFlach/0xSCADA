/**
 * Storage/Database module
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import * as schema from '@shared/schema';

let client: Client | null = null;
let db: ReturnType<typeof drizzle> | null = null;

export const initializeDatabase = async () => {
  if (!client) {
    client = new Client({
      connectionString: process.env.DATABASE_URL
    });
    await client.connect();
    db = drizzle(client, { schema });
  }
  return db!;
};

export const getDatabase = () => {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return db;
};

export const closeDatabase = async () => {
  if (client) {
    await client.end();
    client = null;
    db = null;
  }
};

// Export storage object as expected by health/index.ts
export const storage = {
  isConnected: () => client !== null,
  getHealth: () => ({
    connected: client !== null,
    database: process.env.DATABASE_URL ? 'configured' : 'not configured'
  })
};