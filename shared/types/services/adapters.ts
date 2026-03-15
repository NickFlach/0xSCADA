/**
 * Vendor Adapter Type System
 * Generic base class for protocol and device adapters
 */

export type AdapterType = 'device' | 'protocol';

export type AdapterState = 
  | 'registered'    // Registered but not initialized
  | 'initializing'  // Currently initializing
  | 'ready'         // Initialized and ready to connect
  | 'connecting'    // Attempting to connect
  | 'connected'     // Connected and operational
  | 'disconnecting' // Disconnecting
  | 'error'         // Error state
  | 'unregistered'; // Removed from registry

export interface AdapterCapability {
  id: string;
  name: string;
  category: 'communication' | 'diagnostics' | 'configuration' | 'custom';
  description?: string;
  required: boolean;
}

export interface AdapterManifest {
  id: string;
  name: string;
  vendor: string;
  version: string;
  type: AdapterType;
  capabilities: AdapterCapability[];
  description?: string;
}

export interface AdapterContext {
  config: Record<string, unknown>;
  logger: {
    debug: (message: string, ...args: any[]) => void;
    info: (message: string, ...args: any[]) => void;
    warn: (message: string, ...args: any[]) => void;
    error: (message: string, ...args: any[]) => void;
  };
  storage: {
    get: (key: string) => Promise<any>;
    set: (key: string, value: any) => Promise<void>;
    delete: (key: string) => Promise<void>;
  };
}

export interface AdapterHealthStatus {
  state: AdapterState;
  lastUpdate: Date;
  metrics?: Record<string, unknown> & {
    connectionsActive?: number;
    messagesProcessed?: number;
    errorsCount?: number;
    uptime?: number;
  };
  diagnostics?: Record<string, unknown>;
}

export interface AdapterTag {
  address: string;
  name?: string;
  dataType: 'boolean' | 'number' | 'string' | 'object';
  value?: unknown;
  quality: 'good' | 'bad' | 'uncertain';
  timestamp: Date;
}

// Protocol-specific interfaces
export interface ProtocolEndpoint {
  host: string;
  port: number;
  protocol: string;
  authentication?: {
    type: 'none' | 'basic' | 'certificate';
    credentials?: Record<string, unknown>;
  };
}

export interface ProtocolConnection {
  endpoint: ProtocolEndpoint;
  isConnected: boolean;
  lastActivity: Date;
  connectionId: string;
}

// Base adapter interface
export interface IAdapter {
  readonly manifest: AdapterManifest;
  state: AdapterState;
  
  initialize(context: AdapterContext): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getHealth(): Promise<AdapterHealthStatus>;
  destroy(): Promise<void>;
}

// Protocol adapter specific interface
export interface ProtocolAdapter extends IAdapter {
  readonly manifest: AdapterManifest & { type: 'protocol' };
  readonly protocols: string[];
  
  readTags(addresses: string[]): Promise<AdapterTag[]>;
  writeTags(tags: AdapterTag[]): Promise<void>;
  discoverDevices?(): Promise<Record<string, unknown>[]>;
}

// Device adapter specific interface  
export interface DeviceAdapter extends IAdapter {
  readonly manifest: AdapterManifest & { type: 'device' };
  readonly deviceTypes: string[];
  
  getDeviceInfo(deviceId: string): Promise<Record<string, unknown>>;
  getDeviceDiagnostics?(deviceId: string): Promise<Record<string, unknown>>;
  updateFirmware?(deviceId: string, firmware: Buffer): Promise<void>;
}

// Generic base class for adapters
export abstract class BaseAdapter<T extends AdapterType> implements IAdapter {
  abstract readonly manifest: AdapterManifest & { type: T };
  
  private _state: AdapterState = 'registered';
  protected context?: AdapterContext;
  
  get state(): AdapterState {
    return this._state;
  }
  
  protected setState(newState: AdapterState): void {
    this._state = newState;
    this.onStateChange?.(newState);
  }
  
  protected onStateChange?(state: AdapterState): void;
  
  async initialize(context: AdapterContext): Promise<void> {
    this.setState('initializing');
    this.context = context;
    
    try {
      await this.doInitialize(context);
      this.setState('ready');
      this.context.logger.info(`Adapter ${this.manifest.id} initialized successfully`);
    } catch (error) {
      this.setState('error');
      this.context.logger.error(`Failed to initialize adapter ${this.manifest.id}:`, error);
      throw error;
    }
  }
  
  async connect(): Promise<void> {
    if (this._state !== 'ready') {
      throw new Error(`Cannot connect adapter ${this.manifest.id} from state: ${this._state}`);
    }
    
    this.setState('connecting');
    
    try {
      await this.doConnect();
      this.setState('connected');
      this.context?.logger.info(`Adapter ${this.manifest.id} connected successfully`);
    } catch (error) {
      this.setState('error');
      this.context?.logger.error(`Failed to connect adapter ${this.manifest.id}:`, error);
      throw error;
    }
  }
  
  async disconnect(): Promise<void> {
    if (this._state !== 'connected') {
      return;
    }
    
    this.setState('disconnecting');
    
    try {
      await this.doDisconnect();
      this.setState('ready');
      this.context?.logger.info(`Adapter ${this.manifest.id} disconnected successfully`);
    } catch (error) {
      this.setState('error');
      this.context?.logger.error(`Failed to disconnect adapter ${this.manifest.id}:`, error);
      throw error;
    }
  }
  
  async getHealth(): Promise<AdapterHealthStatus> {
    return {
      state: this._state,
      lastUpdate: new Date(),
      metrics: await this.getMetrics(),
      diagnostics: await this.getDiagnostics()
    };
  }
  
  async destroy(): Promise<void> {
    try {
      if (this._state === 'connected') {
        await this.disconnect();
      }
      await this.doDestroy();
      this.setState('unregistered');
    } catch (error) {
      this.context?.logger.error(`Error destroying adapter ${this.manifest.id}:`, error);
      throw error;
    }
  }
  
  // Abstract methods that subclasses must implement
  protected abstract doInitialize(context: AdapterContext): Promise<void>;
  protected abstract doConnect(): Promise<void>;
  protected abstract doDisconnect(): Promise<void>;
  protected abstract doDestroy(): Promise<void>;
  
  // Optional methods that subclasses can override
  protected async getMetrics(): Promise<Record<string, unknown>> {
    return {};
  }
  
  protected async getDiagnostics(): Promise<Record<string, unknown>> {
    return {};
  }
}