/**
 * Ubiquity Service
 * 
 * Provides universal access patterns and cross-cutting concerns:
 * - Universal device discovery and registration
 * - Cross-protocol communication abstraction
 * - Universal data format transformation
 * - Device capability discovery and negotiation
 * - Universal authentication and authorization
 */

import { EventEmitter } from 'events';
import { log, logError } from '../../logger';

export interface UniversalDevice {
  id: string;
  name: string;
  type: string;
  protocol: string;
  endpoint: string;
  capabilities: DeviceCapability[];
  status: 'online' | 'offline' | 'error' | 'discovering';
  metadata: Record<string, unknown>;
  lastSeen: Date;
  discoveredBy: string;
}

export interface DeviceCapability {
  name: string;
  type: 'read' | 'write' | 'subscribe' | 'execute' | 'discover';
  dataType: 'boolean' | 'number' | 'string' | 'object' | 'array';
  description?: string;
  parameters?: Record<string, unknown>;
  security?: SecurityRequirement;
}

export interface SecurityRequirement {
  authentication: 'none' | 'basic' | 'certificate' | 'oauth' | 'apikey';
  authorization: 'none' | 'rbac' | 'acl' | 'custom';
  encryption: 'none' | 'tls' | 'custom';
}

export interface UniversalCommand {
  id: string;
  deviceId: string;
  capability: string;
  parameters: Record<string, unknown>;
  timeout?: number;
  priority: 'low' | 'normal' | 'high' | 'critical';
  source: string;
  timestamp: Date;
}

export interface CommandResult {
  commandId: string;
  status: 'success' | 'failure' | 'timeout' | 'pending';
  result?: unknown;
  error?: string;
  executionTime: number;
  timestamp: Date;
}

export interface DiscoveryAdapter {
  name: string;
  protocols: string[];
  discover: (options?: Record<string, unknown>) => Promise<UniversalDevice[]>;
  validate: (device: UniversalDevice) => Promise<boolean>;
}

export class UbiquityService extends EventEmitter {
  private devices: Map<string, UniversalDevice> = new Map();
  private discoveryAdapters: Map<string, DiscoveryAdapter> = new Map();
  private commandQueue: UniversalCommand[] = [];
  private commandResults: Map<string, CommandResult> = new Map();
  private discoveryTimer?: NodeJS.Timeout;
  private isInitialized = false;

  constructor() {
    super();
  }

  /**
   * Initialize the ubiquity service
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    log('Initializing ubiquity service');
    
    // Register built-in discovery adapters
    await this.registerBuiltinAdapters();
    
    // Start device discovery
    this.startDeviceDiscovery();
    
    // Start command processing
    this.startCommandProcessor();
    
    this.isInitialized = true;
    this.emit('initialized');
    log('Ubiquity service initialized');
  }

  /**
   * Register a discovery adapter
   */
  registerDiscoveryAdapter(adapter: DiscoveryAdapter): void {
    this.discoveryAdapters.set(adapter.name, adapter);
    log(`Discovery adapter registered: ${adapter.name} (${adapter.protocols.join(', ')})`);
    this.emit('adapter-registered', adapter);
  }

  /**
   * Discover devices using all available adapters
   */
  async discoverDevices(force = false): Promise<UniversalDevice[]> {
    if (!this.isInitialized) {
      throw new Error('Ubiquity service not initialized');
    }

    const discoveredDevices: UniversalDevice[] = [];

    for (const [adapterName, adapter] of this.discoveryAdapters) {
      try {
        log(`Running device discovery with ${adapterName}`);
        const devices = await adapter.discover();
        
        for (const device of devices) {
          device.discoveredBy = adapterName;
          device.lastSeen = new Date();
          
          // Validate device if not forced
          if (force || await adapter.validate(device)) {
            const existingDevice = this.devices.get(device.id);
            if (existingDevice) {
              // Update existing device
              this.updateDevice(device);
            } else {
              // Add new device
              this.addDevice(device);
            }
            discoveredDevices.push(device);
          }
        }
      } catch (error) {
        logError(`Discovery failed for adapter ${adapterName}`, error);
      }
    }

    log(`Device discovery completed: ${discoveredDevices.length} devices found`);
    this.emit('discovery-completed', discoveredDevices);
    
    return discoveredDevices;
  }

  /**
   * Execute a command on a device
   */
  async executeCommand(command: UniversalCommand): Promise<string> {
    const device = this.devices.get(command.deviceId);
    if (!device) {
      throw new Error(`Device ${command.deviceId} not found`);
    }

    // Check if device supports the capability
    const capability = device.capabilities.find(c => c.name === command.capability);
    if (!capability) {
      throw new Error(`Device ${command.deviceId} does not support capability ${command.capability}`);
    }

    // Add to command queue
    this.commandQueue.push(command);
    log(`Command queued: ${command.capability} on ${command.deviceId}`);
    
    this.emit('command-queued', command);
    return command.id;
  }

  /**
   * Get command result
   */
  getCommandResult(commandId: string): CommandResult | null {
    return this.commandResults.get(commandId) || null;
  }

  /**
   * Transform data between universal format and device-specific format
   */
  transformData(
    data: unknown, 
    fromFormat: string, 
    toFormat: string, 
    device?: UniversalDevice
  ): unknown {
    // Universal data transformation logic
    if (fromFormat === 'universal' && toFormat === 'device-specific') {
      return this.toDeviceFormat(data, device);
    }
    
    if (fromFormat === 'device-specific' && toFormat === 'universal') {
      return this.fromDeviceFormat(data, device);
    }

    // Pass-through if no transformation needed
    return data;
  }

  /**
   * Get device capabilities in universal format
   */
  getDeviceCapabilities(deviceId: string): DeviceCapability[] {
    const device = this.devices.get(deviceId);
    return device ? device.capabilities : [];
  }

  /**
   * Get all discovered devices
   */
  getDiscoveredDevices(filter?: {
    protocol?: string;
    type?: string;
    status?: string;
    online?: boolean;
  }): UniversalDevice[] {
    let devices = Array.from(this.devices.values());

    if (filter) {
      if (filter.protocol) {
        devices = devices.filter(d => d.protocol === filter.protocol);
      }
      if (filter.type) {
        devices = devices.filter(d => d.type === filter.type);
      }
      if (filter.status) {
        devices = devices.filter(d => d.status === filter.status);
      }
      if (filter.online !== undefined) {
        devices = devices.filter(d => filter.online ? d.status === 'online' : d.status !== 'online');
      }
    }

    return devices;
  }

  /**
   * Get service status
   */
  getStatus(): {
    initialized: boolean;
    devicesCount: number;
    onlineDevices: number;
    adaptersCount: number;
    queuedCommands: number;
    recentCommands: number;
  } {
    const onlineDevices = Array.from(this.devices.values()).filter(d => d.status === 'online').length;
    const recentCommands = Array.from(this.commandResults.values())
      .filter(r => r.timestamp > new Date(Date.now() - 60 * 60 * 1000)) // Last hour
      .length;

    return {
      initialized: this.isInitialized,
      devicesCount: this.devices.size,
      onlineDevices,
      adaptersCount: this.discoveryAdapters.size,
      queuedCommands: this.commandQueue.length,
      recentCommands
    };
  }

  /**
   * Health check for ubiquity service
   */
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    if (!this.isInitialized) {
      return {
        healthy: false,
        message: 'Ubiquity service not initialized'
      };
    }

    const status = this.getStatus();
    
    if (status.adaptersCount === 0) {
      return {
        healthy: false,
        message: 'No discovery adapters registered'
      };
    }

    if (status.queuedCommands > 1000) {
      return {
        healthy: false,
        message: `Command queue overloaded: ${status.queuedCommands} commands`
      };
    }

    return {
      healthy: true,
      message: `Ubiquity service healthy: ${status.onlineDevices}/${status.devicesCount} devices online`
    };
  }

  // ── Private Methods ────────────────────────────────────────────────────────

  /**
   * Add a new device
   */
  private addDevice(device: UniversalDevice): void {
    this.devices.set(device.id, device);
    log(`Universal device added: ${device.name} (${device.protocol})`);
    this.emit('device-added', device);
  }

  /**
   * Update an existing device
   */
  private updateDevice(updatedDevice: UniversalDevice): void {
    const existing = this.devices.get(updatedDevice.id);
    if (existing) {
      // Merge updates while preserving important fields
      Object.assign(existing, updatedDevice);
      existing.lastSeen = new Date();
      log(`Universal device updated: ${existing.name}`);
      this.emit('device-updated', existing);
    }
  }

  /**
   * Register built-in discovery adapters
   */
  private async registerBuiltinAdapters(): Promise<void> {
    // OPC-UA discovery adapter
    this.registerDiscoveryAdapter({
      name: 'opcua-discovery',
      protocols: ['OPC-UA'],
      discover: async () => {
        // Simulate OPC-UA discovery
        return [{
          id: 'opcua-server-1',
          name: 'OPC-UA Production Server',
          type: 'industrial-controller',
          protocol: 'OPC-UA',
          endpoint: 'opc.tcp://192.168.1.100:4840',
          capabilities: [
            {
              name: 'read-tags',
              type: 'read',
              dataType: 'object',
              description: 'Read process variables'
            },
            {
              name: 'subscribe-changes',
              type: 'subscribe',
              dataType: 'object',
              description: 'Subscribe to value changes'
            }
          ],
          status: 'online',
          metadata: { vendor: 'Siemens', model: 'S7-1500' },
          lastSeen: new Date(),
          discoveredBy: 'opcua-discovery'
        }];
      },
      validate: async (device) => {
        // Simulate validation ping
        return device.endpoint.startsWith('opc.tcp://');
      }
    });

    // Modbus discovery adapter
    this.registerDiscoveryAdapter({
      name: 'modbus-discovery',
      protocols: ['Modbus TCP', 'Modbus RTU'],
      discover: async () => {
        // Simulate Modbus discovery
        return [{
          id: 'modbus-device-1',
          name: 'Modbus Energy Meter',
          type: 'energy-meter',
          protocol: 'Modbus TCP',
          endpoint: '192.168.1.101:502',
          capabilities: [
            {
              name: 'read-registers',
              type: 'read',
              dataType: 'number',
              description: 'Read holding registers'
            },
            {
              name: 'write-registers',
              type: 'write',
              dataType: 'number',
              description: 'Write holding registers'
            }
          ],
          status: 'online',
          metadata: { unitId: 1, vendor: 'Schneider Electric' },
          lastSeen: new Date(),
          discoveredBy: 'modbus-discovery'
        }];
      },
      validate: async (device) => {
        // Simulate Modbus validation
        return device.endpoint.includes(':502');
      }
    });

    log('Built-in discovery adapters registered');
  }

  /**
   * Start periodic device discovery
   */
  private startDeviceDiscovery(): void {
    // Run discovery every 5 minutes
    this.discoveryTimer = setInterval(() => {
      this.discoverDevices().catch(error => {
        logError('Periodic device discovery failed', error);
      });
    }, 5 * 60 * 1000);

    // Initial discovery
    setTimeout(() => this.discoverDevices(), 1000);
  }

  /**
   * Start command processor
   */
  private startCommandProcessor(): void {
    // Process commands every 1 second
    setInterval(() => {
      this.processCommands();
    }, 1000);
  }

  /**
   * Process queued commands
   */
  private async processCommands(): Promise<void> {
    while (this.commandQueue.length > 0) {
      const command = this.commandQueue.shift()!;
      
      try {
        const startTime = Date.now();
        
        // Simulate command execution
        await this.executeDeviceCommand(command);
        
        const result: CommandResult = {
          commandId: command.id,
          status: 'success',
          result: { message: 'Command executed successfully' },
          executionTime: Date.now() - startTime,
          timestamp: new Date()
        };
        
        this.commandResults.set(command.id, result);
        this.emit('command-completed', command, result);
        
      } catch (error) {
        const result: CommandResult = {
          commandId: command.id,
          status: 'failure',
          error: error instanceof Error ? error.message : 'Unknown error',
          executionTime: Date.now() - Date.now(),
          timestamp: new Date()
        };
        
        this.commandResults.set(command.id, result);
        this.emit('command-failed', command, result);
      }
      
      // Cleanup old results (keep last 1000)
      if (this.commandResults.size > 1000) {
        const oldest = Array.from(this.commandResults.keys())[0];
        this.commandResults.delete(oldest);
      }
    }
  }

  /**
   * Execute command on device (simulated)
   */
  private async executeDeviceCommand(command: UniversalCommand): Promise<void> {
    // Simulate network delay and processing
    await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 400));
    
    // Simulate occasional failures
    if (Math.random() < 0.05) {
      throw new Error(`Command execution failed: ${command.capability}`);
    }
    
    log(`Executed ${command.capability} on device ${command.deviceId}`);
  }

  /**
   * Transform data to device-specific format
   */
  private toDeviceFormat(data: unknown, device?: UniversalDevice): unknown {
    // Simplified transformation logic
    if (!device) return data;
    
    switch (device.protocol) {
      case 'OPC-UA':
        // Transform to OPC-UA format
        return { nodeId: 'ns=2;s=Data', value: data };
      case 'Modbus TCP':
        // Transform to Modbus format
        return { address: 40001, value: Number(data) };
      default:
        return data;
    }
  }

  /**
   * Transform data from device-specific format
   */
  private fromDeviceFormat(data: unknown, device?: UniversalDevice): unknown {
    // Simplified transformation logic
    if (!device) return data;
    
    switch (device.protocol) {
      case 'OPC-UA':
        // Extract value from OPC-UA format
        return (data as any)?.value || data;
      case 'Modbus TCP':
        // Extract value from Modbus format
        return (data as any)?.value || data;
      default:
        return data;
    }
  }
}

// Singleton instance
export const ubiquityService = new UbiquityService();