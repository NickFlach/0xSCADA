/**
 * Enhanced PostgreSQL Connection Pool
 *
 * Issue #21 — [Optix/Database] Implement PostgreSQL connection patterns
 *
 * Features:
 * - Configurable pool sizing via environment variables
 * - Health checking with periodic validation
 * - Graceful shutdown with connection draining
 * - Connection metrics for monitoring
 */

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";

const { Pool } = pg;

// =============================================================================
// CONFIGURATION
// =============================================================================

export interface PoolConfig {
  connectionString: string;
  min: number;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  statementTimeout: number;
}

function loadConfig(): PoolConfig {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  return {
    connectionString,
    min: parseInt(process.env.DB_POOL_MIN || "2", 10),
    max: parseInt(process.env.DB_POOL_MAX || "10", 10),
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || "30000", 10),
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT || "5000", 10),
    statementTimeout: parseInt(process.env.DB_STATEMENT_TIMEOUT || "30000", 10),
  };
}

// =============================================================================
// METRICS
// =============================================================================

export interface PoolMetrics {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  queryCount: number;
  errorCount: number;
  lastHealthCheck: Date | null;
  healthy: boolean;
}

// =============================================================================
// ENHANCED POOL
// =============================================================================

export class EnhancedConnectionPool {
  private pool: pg.Pool;
  private config: PoolConfig;
  private queryCount = 0;
  private errorCount = 0;
  private lastHealthCheck: Date | null = null;
  private healthy = false;
  private healthInterval: NodeJS.Timeout | null = null;

  public db: ReturnType<typeof drizzle>;

  constructor(config?: Partial<PoolConfig>) {
    const defaults = loadConfig();
    this.config = { ...defaults, ...config };

    this.pool = new Pool({
      connectionString: this.config.connectionString,
      min: this.config.min,
      max: this.config.max,
      idleTimeoutMillis: this.config.idleTimeoutMillis,
      connectionTimeoutMillis: this.config.connectionTimeoutMillis,
      statement_timeout: this.config.statementTimeout,
    });

    this.pool.on("error", (err) => {
      this.errorCount++;
      this.healthy = false;
      console.error("Unexpected pool error:", err.message);
    });

    this.pool.on("connect", () => {
      this.queryCount++;
    });

    this.db = drizzle(this.pool, { schema });
  }

  async healthCheck(): Promise<{ connected: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      const client = await this.pool.connect();
      await client.query("SELECT 1");
      client.release();
      this.lastHealthCheck = new Date();
      this.healthy = true;
      return { connected: true, latencyMs: Date.now() - start };
    } catch {
      this.healthy = false;
      return { connected: false, latencyMs: Date.now() - start };
    }
  }

  startHealthChecks(intervalMs = 30000): void {
    this.healthInterval = setInterval(async () => {
      const result = await this.healthCheck();
      if (!result.connected) {
        console.warn(`Database health check failed (latency: ${result.latencyMs}ms)`);
      }
    }, intervalMs);
  }

  getMetrics(): PoolMetrics {
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
      queryCount: this.queryCount,
      errorCount: this.errorCount,
      lastHealthCheck: this.lastHealthCheck,
      healthy: this.healthy,
    };
  }

  async shutdown(): Promise<void> {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
    await this.pool.end();
    console.log("Database connection pool shut down");
  }

  get rawPool(): pg.Pool {
    return this.pool;
  }
}

// =============================================================================
// SINGLETON
// =============================================================================

let instance: EnhancedConnectionPool | null = null;

export function getConnectionPool(): EnhancedConnectionPool {
  if (!instance) {
    instance = new EnhancedConnectionPool();
  }
  return instance;
}

export function getDb() {
  return getConnectionPool().db;
}
