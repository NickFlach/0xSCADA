/**
 * Redis Client Configuration and Connection
 * 
 * Provides a configured Redis client with connection pooling,
 * retry logic, and cluster support for high availability.
 */

import Redis, { Cluster, ClusterNode, ClusterOptions, RedisOptions } from 'ioredis';

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
  maxRetriesPerRequest?: number;
  retryDelayMs?: number;
  enableCluster?: boolean;
  clusterNodes?: ClusterNode[];
  tls?: boolean;
}

const defaultConfig: RedisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD,
  db: parseInt(process.env.REDIS_DB || '0', 10),
  keyPrefix: process.env.REDIS_KEY_PREFIX || '0xscada:',
  maxRetriesPerRequest: 3,
  retryDelayMs: 100,
  enableCluster: process.env.REDIS_CLUSTER === 'true',
  tls: process.env.REDIS_TLS === 'true',
};

/**
 * Redis client singleton with lazy initialization
 */
class RedisClientManager {
  private static instance: RedisClientManager;
  private client: Redis | Cluster | null = null;
  private config: RedisConfig;
  private isConnected: boolean = false;
  private connectionPromise: Promise<void> | null = null;

  private constructor(config: RedisConfig = defaultConfig) {
    this.config = config;
  }

  static getInstance(config?: RedisConfig): RedisClientManager {
    if (!RedisClientManager.instance) {
      RedisClientManager.instance = new RedisClientManager(config);
    }
    return RedisClientManager.instance;
  }

  /**
   * Get or create Redis client with connection
   */
  async getClient(): Promise<Redis | Cluster> {
    if (this.client && this.isConnected) {
      return this.client;
    }

    if (this.connectionPromise) {
      await this.connectionPromise;
      return this.client!;
    }

    this.connectionPromise = this.connect();
    await this.connectionPromise;
    return this.client!;
  }

  /**
   * Establish Redis connection
   */
  private async connect(): Promise<void> {
    const options: RedisOptions = {
      host: this.config.host,
      port: this.config.port,
      password: this.config.password,
      db: this.config.db,
      keyPrefix: this.config.keyPrefix,
      maxRetriesPerRequest: this.config.maxRetriesPerRequest,
      retryStrategy: (times: number) => {
        if (times > 10) {
          console.error('[Redis] Max retry attempts exceeded');
          return null; // Stop retrying
        }
        const delay = Math.min(times * this.config.retryDelayMs!, 3000);
        console.log(`[Redis] Retrying connection in ${delay}ms (attempt ${times})`);
        return delay;
      },
      lazyConnect: true,
      enableReadyCheck: true,
      ...(this.config.tls && { tls: {} }),
    };

    if (this.config.enableCluster && this.config.clusterNodes) {
      const clusterOptions: ClusterOptions = {
        redisOptions: options,
        clusterRetryStrategy: (times: number) => {
          if (times > 10) return null;
          return Math.min(times * 100, 3000);
        },
      };
      this.client = new Redis.Cluster(this.config.clusterNodes, clusterOptions);
    } else {
      this.client = new Redis(options);
    }

    this.setupEventHandlers();

    try {
      await this.client.connect();
      this.isConnected = true;
      console.log('[Redis] Connected successfully');
    } catch (error) {
      console.error('[Redis] Connection failed:', error);
      throw error;
    }
  }

  /**
   * Setup event handlers for connection management
   */
  private setupEventHandlers(): void {
    if (!this.client) return;

    this.client.on('connect', () => {
      console.log('[Redis] Connection established');
    });

    this.client.on('ready', () => {
      this.isConnected = true;
      console.log('[Redis] Ready to accept commands');
    });

    this.client.on('error', (error) => {
      console.error('[Redis] Error:', error.message);
    });

    this.client.on('close', () => {
      this.isConnected = false;
      console.log('[Redis] Connection closed');
    });

    this.client.on('reconnecting', () => {
      console.log('[Redis] Reconnecting...');
    });
  }

  /**
   * Check if Redis is connected
   */
  isHealthy(): boolean {
    return this.isConnected && this.client !== null;
  }

  /**
   * Get connection status details
   */
  getStatus(): { connected: boolean; host: string; port: number } {
    return {
      connected: this.isConnected,
      host: this.config.host,
      port: this.config.port,
    };
  }

  /**
   * Gracefully close Redis connection
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      this.isConnected = false;
      this.connectionPromise = null;
      console.log('[Redis] Disconnected');
    }
  }
}

// Export singleton instance getter
export const getRedisClient = () => RedisClientManager.getInstance().getClient();
export const isRedisHealthy = () => RedisClientManager.getInstance().isHealthy();
export const getRedisStatus = () => RedisClientManager.getInstance().getStatus();
export const disconnectRedis = () => RedisClientManager.getInstance().disconnect();

export default RedisClientManager;
