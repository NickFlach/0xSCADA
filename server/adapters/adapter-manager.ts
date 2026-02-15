/**
 * Adapter Manager
 *
 * Lifecycle management, health monitoring, and hot-reload for vendor adapters.
 */

import { EventEmitter } from "events";
import type {
  BaseAdapter,
  AdapterContext,
  AdapterHealthStatus,
  AdapterLogger,
  AdapterStorage,
  AdapterType,
  PlatformServices,
} from "../../shared/types/vendor-adapter";
import { AdapterRegistry, getAdapterRegistry } from "./adapter-registry";

// =============================================================================
// IN-MEMORY ADAPTER STORAGE
// =============================================================================

class InMemoryAdapterStorage implements AdapterStorage {
  private store = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined;
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async list(): Promise<string[]> {
    return Array.from(this.store.keys());
  }
}

// =============================================================================
// ADAPTER MANAGER
// =============================================================================

export interface AdapterManagerConfig {
  /** Health check interval in ms (default: 30000) */
  healthCheckIntervalMs?: number;
  /** Whether to auto-initialize adapters on register (default: true) */
  autoInitialize?: boolean;
  /** Per-adapter config overrides keyed by adapter ID */
  adapterConfigs?: Record<string, Record<string, unknown>>;
}

export class AdapterManager extends EventEmitter {
  private registry: AdapterRegistry;
  private config: Required<AdapterManagerConfig>;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private healthStatuses = new Map<string, AdapterHealthStatus>();
  private storageMap = new Map<string, InMemoryAdapterStorage>();
  private started = false;

  constructor(config: AdapterManagerConfig = {}) {
    super();
    this.registry = getAdapterRegistry();
    this.config = {
      healthCheckIntervalMs: config.healthCheckIntervalMs ?? 30000,
      autoInitialize: config.autoInitialize ?? true,
      adapterConfigs: config.adapterConfigs ?? {},
    };
  }

  /**
   * Register and optionally initialize an adapter.
   */
  async registerAdapter(adapter: BaseAdapter): Promise<void> {
    this.registry.register(adapter);

    if (this.config.autoInitialize) {
      await this.initializeAdapter(adapter.manifest.id);
    }
  }

  /**
   * Initialize a registered adapter with platform context.
   */
  async initializeAdapter(adapterId: string): Promise<void> {
    const adapter = this.registry.get(adapterId);
    if (!adapter) {
      throw new Error(`Adapter "${adapterId}" not found`);
    }

    const context = this.createContext(adapterId);
    try {
      await adapter.initialize(context);
      console.log(`[AdapterManager] Initialized: ${adapterId}`);
      this.emit("adapter:initialized", { adapterId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[AdapterManager] Failed to initialize ${adapterId}: ${msg}`);
      this.emit("adapter:error", { adapterId, error: msg });
      throw err;
    }
  }

  /**
   * Hot-reload: dispose old adapter, register new one.
   */
  async reloadAdapter(adapter: BaseAdapter): Promise<void> {
    const id = adapter.manifest.id;
    const existing = this.registry.get(id);
    if (existing) {
      await existing.dispose();
      this.registry.unregister(id);
    }
    await this.registerAdapter(adapter);
    console.log(`[AdapterManager] Hot-reloaded: ${id}`);
  }

  /**
   * Start health monitoring.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.healthTimer = setInterval(
      () => this.runHealthChecks(),
      this.config.healthCheckIntervalMs
    );
    console.log(`[AdapterManager] Started (health interval: ${this.config.healthCheckIntervalMs}ms)`);
  }

  /**
   * Stop health monitoring and dispose all adapters.
   */
  async stop(): Promise<void> {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    this.started = false;

    // Dispose all adapters
    const adapters = this.registry.getAll();
    await Promise.allSettled(adapters.map((a) => a.dispose()));
    console.log(`[AdapterManager] Stopped, disposed ${adapters.length} adapters`);
  }

  /**
   * Run health checks on all adapters.
   */
  async runHealthChecks(): Promise<Map<string, AdapterHealthStatus>> {
    const adapters = this.registry.getAll();
    const results = new Map<string, AdapterHealthStatus>();

    await Promise.allSettled(
      adapters.map(async (adapter) => {
        try {
          const status = await adapter.healthCheck();
          this.healthStatuses.set(adapter.manifest.id, status);
          results.set(adapter.manifest.id, status);
          this.emit("adapter:health", { adapterId: adapter.manifest.id, status });
        } catch (err) {
          const errorStatus: AdapterHealthStatus = {
            adapterId: adapter.manifest.id,
            state: "error",
            healthy: false,
            lastHealthCheck: new Date(),
            uptime: 0,
            errorCount: 1,
            lastError: err instanceof Error ? err.message : String(err),
          };
          this.healthStatuses.set(adapter.manifest.id, errorStatus);
          results.set(adapter.manifest.id, errorStatus);
        }
      })
    );

    return results;
  }

  /**
   * Get cached health status for an adapter.
   */
  getHealthStatus(adapterId: string): AdapterHealthStatus | undefined {
    return this.healthStatuses.get(adapterId);
  }

  /**
   * Get all health statuses.
   */
  getAllHealthStatuses(): Map<string, AdapterHealthStatus> {
    return new Map(this.healthStatuses);
  }

  /**
   * Get the registry instance.
   */
  getRegistry(): AdapterRegistry {
    return this.registry;
  }

  // ===========================================================================
  // PRIVATE
  // ===========================================================================

  private createContext(adapterId: string): AdapterContext {
    const logger = this.createLogger(adapterId);
    const adapterConfig = this.config.adapterConfigs[adapterId] ?? {};
    const platformServices = this.createPlatformServices();

    return {
      log: logger,
      config: adapterConfig,
      emit: (event: string, data: unknown) => {
        this.emit(`adapter:${adapterId}:${event}`, data);
      },
      platform: platformServices,
    };
  }

  private createLogger(adapterId: string): AdapterLogger {
    const prefix = `[Adapter:${adapterId}]`;
    return {
      debug: (msg, ...args) => console.debug(`${prefix} ${msg}`, ...args),
      info: (msg, ...args) => console.log(`${prefix} ${msg}`, ...args),
      warn: (msg, ...args) => console.warn(`${prefix} ${msg}`, ...args),
      error: (msg, ...args) => console.error(`${prefix} ${msg}`, ...args),
    };
  }

  private createPlatformServices(): PlatformServices {
    return {
      getAdapter: (id: string) => this.registry.get(id),
      getAdaptersByType: (type: AdapterType) => this.registry.getAll(type),
      getStorage: (namespace: string) => {
        if (!this.storageMap.has(namespace)) {
          this.storageMap.set(namespace, new InMemoryAdapterStorage());
        }
        return this.storageMap.get(namespace)!;
      },
    };
  }
}

// Singleton
let managerInstance: AdapterManager | null = null;

export function getAdapterManager(
  config?: AdapterManagerConfig
): AdapterManager {
  if (!managerInstance) {
    managerInstance = new AdapterManager(config);
  }
  return managerInstance;
}

export function resetAdapterManager(): void {
  managerInstance = null;
}
