/**
 * Adapter Registry and Management
 * Manages vendor adapters with the new generic base class system
 */

// import { IAdapter, AdapterType, AdapterState, AdapterContext } from "@shared/types/vendor-adapter";

// Temporary types to fix compilation
type IAdapter = any;
type AdapterType = any;
type AdapterState = any;
type AdapterContext = any;
import { RockwellCipAdapter } from "./rockwell-cip";
import { SiemensS7Adapter } from "./siemens-s7";
import { logError } from "../logger";

export class AdapterRegistry {
  private adapters: Map<string, IAdapter> = new Map();
  private adapterStates: Map<string, AdapterState> = new Map();
  
  constructor() {}
  
  /**
   * Register a new adapter instance
   */
  register(adapter: IAdapter): void {
    if (this.adapters.has(adapter.manifest.id)) {
      throw new Error(`Adapter ${adapter.manifest.id} is already registered`);
    }
    
    this.adapters.set(adapter.manifest.id, adapter);
    this.adapterStates.set(adapter.manifest.id, adapter.state);
    
    // Set up state change monitoring
    if ('onStateChange' in adapter) {
      (adapter as any).onStateChange = (newState: AdapterState) => {
        this.adapterStates.set(adapter.manifest.id, newState);
      };
    }
  }
  
  /**
   * Unregister an adapter
   */
  async unregister(adapterId: string): Promise<boolean> {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) {
      return false;
    }
    
    try {
      await adapter.destroy();
    } catch (error) {
      logError(`Error destroying adapter ${adapterId}:`, error as any);
    }
    
    this.adapters.delete(adapterId);
    this.adapterStates.delete(adapterId);
    return true;
  }
  
  /**
   * Get adapter by ID
   */
  getAdapter(adapterId: string): IAdapter | undefined {
    return this.adapters.get(adapterId);
  }
  
  /**
   * Get all adapters
   */
  getAllAdapters(): IAdapter[] {
    return Array.from(this.adapters.values());
  }
  
  /**
   * Get adapters by type
   */
  getAdaptersByType(type: AdapterType): IAdapter[] {
    return this.getAllAdapters().filter(adapter => adapter.manifest.type === type);
  }
  
  /**
   * Get adapters by capability
   */
  getAdaptersByCapability(capabilityId: string): IAdapter[] {
    return this.getAllAdapters().filter(adapter => 
      adapter.manifest.capabilities.some((cap: any) => cap.id === capabilityId)
    );
  }
  
  /**
   * Get adapter registry status
   */
  getStatus(): {
    totalAdapters: number;
    adaptersByType: Record<AdapterType, number>;
    adaptersByState: Record<AdapterState, number>;
    adapters: Array<{
      id: string;
      name: string;
      type: AdapterType;
      state: AdapterState;
      vendor: string;
    }>;
  } {
    const adapters = this.getAllAdapters();
    const adaptersByType: Record<AdapterType, number> = { device: 0, protocol: 0 };
    const adaptersByState: Record<AdapterState, number> = {
      registered: 0,
      initializing: 0,
      ready: 0,
      connecting: 0,
      connected: 0,
      disconnecting: 0,
      error: 0,
      unregistered: 0
    };
    
    const adapterInfo = adapters.map(adapter => {
      const state = this.adapterStates.get(adapter.manifest.id) || adapter.state;
      
      adaptersByType[adapter.manifest.type]++;
      adaptersByState[state]++;
      
      return {
        id: adapter.manifest.id,
        name: adapter.manifest.name,
        type: adapter.manifest.type,
        state,
        vendor: adapter.manifest.vendor
      };
    });
    
    return {
      totalAdapters: adapters.length,
      adaptersByType,
      adaptersByState,
      adapters: adapterInfo
    };
  }
  
  /**
   * Initialize all registered adapters
   */
  async initializeAll(context: AdapterContext): Promise<void> {
    const initPromises = this.getAllAdapters().map(async adapter => {
      try {
        await adapter.initialize(context);
      } catch (error) {
        logError(`Failed to initialize adapter ${adapter.manifest.id}:`, error as any);
      }
    });
    
    await Promise.all(initPromises);
  }
  
  /**
   * Connect all ready adapters
   */
  async connectAll(): Promise<void> {
    const adaptersToConnect = this.getAllAdapters().filter(adapter => adapter.state === 'ready');
    
    const connectPromises = adaptersToConnect.map(async adapter => {
      try {
        await adapter.connect();
      } catch (error) {
        logError(`Failed to connect adapter ${adapter.manifest.id}:`, error as any);
      }
    });
    
    await Promise.all(connectPromises);
  }
  
  /**
   * Disconnect all connected adapters
   */
  async disconnectAll(): Promise<void> {
    const adaptersToDisconnect = this.getAllAdapters().filter(adapter => adapter.state === 'connected');
    
    const disconnectPromises = adaptersToDisconnect.map(async adapter => {
      try {
        await adapter.disconnect();
      } catch (error) {
        logError(`Failed to disconnect adapter ${adapter.manifest.id}:`, error as any);
      }
    });
    
    await Promise.all(disconnectPromises);
  }
  
  /**
   * Get health status for all adapters
   */
  async getHealthStatus(): Promise<Array<any>> {
    const healthPromises = this.getAllAdapters().map(async adapter => {
      try {
        const health = await adapter.getHealth();
        return {
          adapterId: adapter.manifest.id,
          ...health
        };
      } catch (error) {
        return {
          adapterId: adapter.manifest.id,
          state: 'error',
          lastUpdate: new Date(),
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    });
    
    return Promise.all(healthPromises);
  }
}

// Global adapter registry instance
export const adapterRegistry = new AdapterRegistry();

/**
 * Initialize default adapters for development
 */
export async function initializeDefaultAdapters(context: AdapterContext): Promise<void> {
  // Register Rockwell CIP adapter
  const rockwellAdapter = new RockwellCipAdapter();
  adapterRegistry.register(rockwellAdapter);
  
  // Register Siemens S7 adapter  
  const siemensAdapter = new SiemensS7Adapter();
  adapterRegistry.register(siemensAdapter);
  
  context.logger.info(`Registered ${adapterRegistry.getAllAdapters().length} default adapters`);
  
  // Initialize all adapters
  await adapterRegistry.initializeAll(context);
}

// Export adapter classes for external use
export { RockwellCipAdapter } from "./rockwell-cip";
export { SiemensS7Adapter } from "./siemens-s7";