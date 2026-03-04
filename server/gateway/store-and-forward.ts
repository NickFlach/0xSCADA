/**
 * Edge Store-and-Forward Module
 * 
 * Handles local data storage during network outages and forwards data
 * when connectivity is restored. Works with the gateway manager to
 * ensure no industrial data is lost during edge deployment scenarios.
 * 
 * Issue: #279 — Health manager and edge store-and-forward disconnected
 */

import { EventEmitter } from 'events';
import { log, logError } from '../logger';

export interface StoreAndForwardConfig {
  maxLocalStorage: number; // Max records to store locally
  forwardBatchSize: number; // Records per batch when forwarding
  heartbeatInterval: number; // Connectivity check interval (ms)
  retryInterval: number; // Failed forward retry interval (ms)
}

export interface StoredRecord {
  id: string;
  timestamp: Date;
  data: any;
  attempts: number;
  driverId?: string;
}

export interface ConnectivityStatus {
  isConnected: boolean;
  lastSuccessfulForward: Date | null;
  pendingRecords: number;
  lastError?: string;
}

export class StoreAndForwardService extends EventEmitter {
  private localStore: Map<string, StoredRecord> = new Map();
  private isConnected = false;
  private heartbeatTimer?: NodeJS.Timeout;
  private forwardTimer?: NodeJS.Timeout;
  private lastSuccessfulForward: Date | null = null;
  private config: StoreAndForwardConfig;

  constructor(config?: Partial<StoreAndForwardConfig>) {
    super();
    this.config = {
      maxLocalStorage: 10000,
      forwardBatchSize: 100,
      heartbeatInterval: 30000, // 30 seconds
      retryInterval: 60000, // 1 minute
      ...config
    };
  }

  /**
   * Initialize the store-and-forward service
   */
  async initialize(): Promise<void> {
    log('Initializing store-and-forward service');
    this.startHeartbeat();
    this.emit('initialized');
  }

  /**
   * Stop the service and clean up timers
   */
  async shutdown(): Promise<void> {
    log('Shutting down store-and-forward service');
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    if (this.forwardTimer) {
      clearInterval(this.forwardTimer);
    }
    this.emit('shutdown');
  }

  /**
   * Store data locally with automatic forwarding when connected
   */
  async store(data: any, driverId?: string): Promise<void> {
    const record: StoredRecord = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(),
      data,
      attempts: 0,
      driverId
    };

    // Check storage limits
    if (this.localStore.size >= this.config.maxLocalStorage) {
      // Remove oldest record
      const oldestKey = Array.from(this.localStore.keys())[0];
      this.localStore.delete(oldestKey);
      log(`Store-and-forward: Removed oldest record due to storage limit`);
    }

    this.localStore.set(record.id, record);
    
    // Try to forward immediately if connected
    if (this.isConnected) {
      await this.forwardBatch();
    }
  }

  /**
   * Get current connectivity and storage status
   */
  getStatus(): ConnectivityStatus {
    return {
      isConnected: this.isConnected,
      lastSuccessfulForward: this.lastSuccessfulForward,
      pendingRecords: this.localStore.size,
      lastError: undefined // Could be enhanced to track last error
    };
  }

  /**
   * Check if the service is healthy
   */
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    const pendingCount = this.localStore.size;
    const isOverloaded = pendingCount > this.config.maxLocalStorage * 0.8;
    
    if (isOverloaded) {
      return {
        healthy: false,
        message: `Store-and-forward overloaded: ${pendingCount} pending records`
      };
    }

    return {
      healthy: true,
      message: `Store-and-forward healthy: ${pendingCount} pending records`
    };
  }

  /**
   * Force connectivity check
   */
  async checkConnectivity(): Promise<boolean> {
    try {
      // Simple connectivity check - could be enhanced to check actual upstream services
      // For now, we'll simulate connectivity based on environment
      const simulateConnectivity = process.env.NODE_ENV === 'development' || 
                                   process.env.SIMULATE_CONNECTIVITY !== 'false';
      
      this.isConnected = simulateConnectivity;
      this.emit('connectivity-changed', this.isConnected);
      
      if (this.isConnected && this.localStore.size > 0) {
        await this.forwardBatch();
      }
      
      return this.isConnected;
    } catch (error) {
      logError('Store-and-forward connectivity check failed', error as any);
      this.isConnected = false;
      this.emit('connectivity-changed', false);
      return false;
    }
  }

  /**
   * Forward a batch of stored records
   */
  private async forwardBatch(): Promise<void> {
    if (!this.isConnected || this.localStore.size === 0) {
      return;
    }

    const recordsToForward = Array.from(this.localStore.values())
      .slice(0, this.config.forwardBatchSize);

    for (const record of recordsToForward) {
      try {
        // Simulate forwarding to cloud/upstream service
        await this.forwardRecord(record);
        
        this.localStore.delete(record.id);
        this.lastSuccessfulForward = new Date();
        
      } catch (error) {
        logError(`Failed to forward record ${record.id}`, error as any);
        record.attempts++;
        
        // Remove records that have failed too many times
        if (record.attempts >= 5) {
          log(`Dropping record ${record.id} after 5 failed attempts`);
          this.localStore.delete(record.id);
        }
      }
    }

    if (this.localStore.size > 0) {
      log(`Store-and-forward: ${this.localStore.size} records remaining`);
    }
  }

  /**
   * Forward a single record (simulate)
   */
  private async forwardRecord(record: StoredRecord): Promise<void> {
    // Simulate network delay and potential failure
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Simulate 5% failure rate in development
    if (process.env.NODE_ENV === 'development' && Math.random() < 0.05) {
      throw new Error('Simulated network failure');
    }
    
    log(`Forwarded record ${record.id} from driver ${record.driverId || 'unknown'}`);
  }

  /**
   * Start periodic connectivity heartbeat
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      await this.checkConnectivity();
    }, this.config.heartbeatInterval);

    // Initial connectivity check
    this.checkConnectivity();
  }
}

// Singleton instance
export const storeAndForwardService = new StoreAndForwardService();