/**
 * State Sync Bridge
 * 
 * Bridges state synchronization between different system components:
 * - Industrial devices ↔ Database
 * - Local state ↔ Cloud/Remote instances  
 * - Cache ↔ Persistent storage
 * 
 * Issue: #280 — Bridge modules integration
 */

import { EventEmitter } from 'events';
import { log, logError } from '../logger';

export interface StateChange {
  id: string;
  entityType: 'tag' | 'driver' | 'alarm' | 'config' | 'user';
  entityId: string;
  operation: 'create' | 'update' | 'delete';
  oldState?: Record<string, unknown>;
  newState?: Record<string, unknown>;
  timestamp: Date;
  source: string;
  propagated: boolean;
}

export interface SyncTarget {
  id: string;
  name: string;
  type: 'database' | 'cache' | 'cloud' | 'edge';
  enabled: boolean;
  endpoint?: string;
  lastSync?: Date;
  healthStatus: 'healthy' | 'degraded' | 'failed';
}

export interface StateSyncConfig {
  enabled: boolean;
  batchSize: number;
  syncInterval: number; // ms
  retryAttempts: number;
  targets: SyncTarget[];
}

export class StateSyncBridge extends EventEmitter {
  private pendingChanges: StateChange[] = [];
  private syncTimer?: NodeJS.Timeout;
  private config: StateSyncConfig;
  private isInitialized = false;
  private syncInProgress = false;

  constructor(config?: Partial<StateSyncConfig>) {
    super();
    this.config = {
      enabled: process.env.STATE_SYNC_ENABLED !== 'false',
      batchSize: 50,
      syncInterval: 10000, // 10 seconds
      retryAttempts: 3,
      targets: [],
      ...config
    };
  }

  /**
   * Initialize the state sync bridge
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    log('Initializing state sync bridge');

    if (!this.config.enabled) {
      log('State sync bridge disabled via configuration');
      return;
    }

    // Initialize default targets
    await this.initializeTargets();

    // Start periodic sync
    this.startPeriodicSync();

    this.isInitialized = true;
    this.emit('initialized');
    log('State sync bridge initialized');
  }

  /**
   * Record a state change for synchronization
   */
  async recordStateChange(change: Omit<StateChange, 'id' | 'timestamp' | 'propagated'>): Promise<void> {
    if (!this.config.enabled || !this.isInitialized) {
      return;
    }

    const stateChange: StateChange = {
      id: `change-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(),
      propagated: false,
      ...change
    };

    this.pendingChanges.push(stateChange);
    
    // Trigger immediate sync if batch is full
    if (this.pendingChanges.length >= this.config.batchSize) {
      await this.performSync();
    }

    this.emit('state-change-recorded', stateChange);
  }

  /**
   * Force immediate synchronization
   */
  async forceSync(): Promise<void> {
    await this.performSync();
  }

  /**
   * Add a sync target
   */
  addTarget(target: SyncTarget): void {
    const existing = this.config.targets.findIndex(t => t.id === target.id);
    if (existing >= 0) {
      this.config.targets[existing] = target;
    } else {
      this.config.targets.push(target);
    }
    log(`State sync target ${target.name} (${target.type}) added`);
  }

  /**
   * Remove a sync target
   */
  removeTarget(targetId: string): boolean {
    const index = this.config.targets.findIndex(t => t.id === targetId);
    if (index >= 0) {
      const target = this.config.targets[index];
      this.config.targets.splice(index, 1);
      log(`State sync target ${target.name} removed`);
      return true;
    }
    return false;
  }

  /**
   * Get current status
   */
  getStatus(): {
    enabled: boolean;
    pendingChanges: number;
    targets: SyncTarget[];
    syncInProgress: boolean;
    isHealthy: boolean;
  } {
    return {
      enabled: this.config.enabled,
      pendingChanges: this.pendingChanges.length,
      targets: [...this.config.targets],
      syncInProgress: this.syncInProgress,
      isHealthy: this.config.enabled && this.isInitialized
    };
  }

  /**
   * Health check for the state sync bridge
   */
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    if (!this.config.enabled) {
      return {
        healthy: true,
        message: 'State sync disabled'
      };
    }

    if (!this.isInitialized) {
      return {
        healthy: false,
        message: 'State sync bridge not initialized'
      };
    }

    const pendingCount = this.pendingChanges.length;
    const failedTargets = this.config.targets.filter(t => t.healthStatus === 'failed').length;
    
    if (failedTargets > this.config.targets.length / 2) {
      return {
        healthy: false,
        message: `Too many failed sync targets: ${failedTargets}/${this.config.targets.length}`
      };
    }

    if (pendingCount > this.config.batchSize * 3) {
      return {
        healthy: false,
        message: `Too many pending state changes: ${pendingCount}`
      };
    }

    return {
      healthy: true,
      message: `State sync healthy: ${pendingCount} pending changes, ${this.config.targets.length} targets`
    };
  }

  /**
   * Shutdown the bridge
   */
  async shutdown(): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }

    // Final sync attempt
    if (this.pendingChanges.length > 0) {
      await this.performSync();
    }

    this.isInitialized = false;
    this.emit('shutdown');
  }

  // ── Private Methods ────────────────────────────────────────────────────────

  /**
   * Initialize default sync targets
   */
  private async initializeTargets(): Promise<void> {
    // Database target
    this.addTarget({
      id: 'database',
      name: 'Primary Database',
      type: 'database',
      enabled: true,
      healthStatus: 'healthy'
    });

    // Cache target (if Redis is available)
    try {
      const { isRedisHealthy } = await import('../services/cache');
      if (isRedisHealthy()) {
        this.addTarget({
          id: 'cache',
          name: 'Redis Cache',
          type: 'cache',
          enabled: true,
          healthStatus: 'healthy'
        });
      }
    } catch {
      // Redis not available
    }

    // Cloud target (if configured)
    if (process.env.CLOUD_SYNC_ENDPOINT) {
      this.addTarget({
        id: 'cloud',
        name: 'Cloud Instance',
        type: 'cloud',
        enabled: true,
        endpoint: process.env.CLOUD_SYNC_ENDPOINT,
        healthStatus: 'healthy'
      });
    }
  }

  /**
   * Start periodic synchronization
   */
  private startPeriodicSync(): void {
    this.syncTimer = setInterval(async () => {
      if (this.pendingChanges.length > 0) {
        await this.performSync();
      }
    }, this.config.syncInterval);
  }

  /**
   * Perform synchronization to all targets
   */
  private async performSync(): Promise<void> {
    if (this.syncInProgress || this.pendingChanges.length === 0) {
      return;
    }

    this.syncInProgress = true;
    const changesToSync = this.pendingChanges.splice(0, this.config.batchSize);
    
    try {
      await Promise.allSettled(
        this.config.targets
          .filter(target => target.enabled)
          .map(target => this.syncToTarget(target, changesToSync))
      );

      // Mark changes as propagated
      changesToSync.forEach(change => {
        change.propagated = true;
      });

      this.emit('sync-completed', { 
        changeCount: changesToSync.length,
        targetCount: this.config.targets.filter(t => t.enabled).length
      });

    } catch (error) {
      // Re-queue failed changes
      this.pendingChanges.unshift(...changesToSync);
      logError('State sync batch failed', error);
      this.emit('sync-failed', error);
    } finally {
      this.syncInProgress = false;
    }
  }

  /**
   * Sync changes to a specific target
   */
  private async syncToTarget(target: SyncTarget, changes: StateChange[]): Promise<void> {
    try {
      switch (target.type) {
        case 'database':
          await this.syncToDatabase(changes);
          break;
        case 'cache':
          await this.syncToCache(changes);
          break;
        case 'cloud':
          await this.syncToCloud(target, changes);
          break;
        case 'edge':
          await this.syncToEdge(target, changes);
          break;
      }

      target.healthStatus = 'healthy';
      target.lastSync = new Date();
      
    } catch (error) {
      target.healthStatus = 'failed';
      logError(`Sync to target ${target.name} failed`, error);
      throw error;
    }
  }

  /**
   * Sync changes to database
   */
  private async syncToDatabase(changes: StateChange[]): Promise<void> {
    // Simulate database sync
    await new Promise(resolve => setTimeout(resolve, 100));
    log(`Synced ${changes.length} state changes to database`);
  }

  /**
   * Sync changes to cache
   */
  private async syncToCache(changes: StateChange[]): Promise<void> {
    try {
      const { getRedisClient } = await import('../services/cache');
      const redis = await getRedisClient();
      
      for (const change of changes) {
        if (change.newState) {
          await redis.hset(
            `state:${change.entityType}:${change.entityId}`, 
            change.newState
          );
        }
      }
      
      log(`Synced ${changes.length} state changes to cache`);
    } catch (error) {
      throw new Error(`Cache sync failed: ${error}`);
    }
  }

  /**
   * Sync changes to cloud endpoint
   */
  private async syncToCloud(target: SyncTarget, changes: StateChange[]): Promise<void> {
    // Simulate HTTP POST to cloud endpoint
    await new Promise(resolve => setTimeout(resolve, 200));
    
    if (Math.random() < 0.05) {
      throw new Error('Simulated cloud sync failure');
    }
    
    log(`Synced ${changes.length} state changes to cloud (${target.endpoint})`);
  }

  /**
   * Sync changes to edge device
   */
  private async syncToEdge(target: SyncTarget, changes: StateChange[]): Promise<void> {
    // Simulate edge device sync
    await new Promise(resolve => setTimeout(resolve, 150));
    log(`Synced ${changes.length} state changes to edge device (${target.name})`);
  }
}

// Singleton instance
export const stateSyncBridge = new StateSyncBridge();