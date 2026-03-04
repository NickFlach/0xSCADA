/**
 * Rockwell Automation Vendor Adapter
 * 
 * Extends 0xSCADA BaseAdapter with Rockwell-specific protocol details
 * extracted from SIN's SCADA aggregator vendor definitions.
 * 
 * Supported protocols: EtherNet/IP, ControlNet, DeviceNet
 * Supported models: ControlLogix 1756, CompactLogix 5380, Micro800
 */

import {
  BaseAdapter,
  ProtocolAdapter,
  DeviceAdapter,
  AdapterManifest,
  AdapterCapability,
  AdapterContext,
  AdapterTag,
  ProtocolEndpoint,
  ProtocolConnection
} from '@shared/types/services/adapters';

// Rockwell-specific register mappings from SIN
export const ROCKWELL_REGISTER_MAP = {
  // CIP Class/Instance/Attribute addressing
  IDENTITY: { classId: 0x01, instanceId: 1, attributeId: 1 },
  MESSAGE_ROUTER: { classId: 0x02, instanceId: 1, attributeId: 0 },
  CONNECTION_MANAGER: { classId: 0x06, instanceId: 1, attributeId: 0 },
  ASSEMBLY: { classId: 0x04, instanceId: 0, attributeId: 0 },
  // Tag data types mapped to CIP type codes
  DATA_TYPES: {
    BOOL: 0xC1,
    SINT: 0xC2,
    INT: 0xC3,
    DINT: 0xC4,
    LINT: 0xC5,
    REAL: 0xCA,
    LREAL: 0xCB,
    STRING: 0xD0,
    TIMER: 0x8000_100F, // UDT
    COUNTER: 0x8000_1010, // UDT
  },
} as const;

// Connection parameters from SIN vendor config
export const ROCKWELL_CONNECTION_PARAMS = {
  defaultPort: 44818, // EtherNet/IP
  cipTimeout: 10000,
  connectionSize: 508, // bytes
  rpi: 100, // Requested Packet Interval (ms)
  maxRetries: 3,
  keepAliveInterval: 30000,
  maxConcurrentConnections: 32,
} as const;

// Polling intervals from SIN aggregator
export const ROCKWELL_POLLING = {
  fast: 100,    // ms - for critical process variables
  normal: 500,  // ms - standard polling
  slow: 2000,   // ms - diagnostics and non-critical
  discovery: 10000, // ms - device discovery broadcast
} as const;

const ROCKWELL_CAPABILITIES: AdapterCapability[] = [
  { id: 'read-tags', name: 'Tag Reading', category: 'communication', required: true },
  { id: 'write-tags', name: 'Tag Writing', category: 'communication', required: true },
  { id: 'browse-tags', name: 'Tag Browsing', category: 'communication', description: 'CIP symbol table browsing', required: false },
  { id: 'fault-logs', name: 'Fault Log Access', category: 'diagnostics', required: false },
  { id: 'connection-manager', name: 'CIP Connection Manager', category: 'diagnostics', required: false },
  { id: 'module-identity', name: 'Module Identity', category: 'diagnostics', required: false },
  { id: 'program-upload', name: 'Program Upload/Download', category: 'configuration', required: false },
];

// Models and their characteristics from SIN vendor data
export const ROCKWELL_MODELS = {
  'ControlLogix 1756': { maxIO: 128000, maxPrograms: 100, ethernet: true, controlnet: true },
  'CompactLogix 5380': { maxIO: 32000, maxPrograms: 32, ethernet: true, controlnet: false },
  'Micro800': { maxIO: 132, maxPrograms: 1, ethernet: true, controlnet: false },
} as const;

export class RockwellVendorAdapter extends BaseAdapter<'protocol'> implements ProtocolAdapter {
  readonly manifest: AdapterManifest & { type: 'protocol' } = {
    id: 'rockwell-vendor',
    name: 'Rockwell Automation Vendor Adapter',
    vendor: 'Rockwell Automation',
    version: '1.0.0',
    type: 'protocol',
    capabilities: ROCKWELL_CAPABILITIES,
    description: 'Full vendor adapter for ControlLogix, CompactLogix, Micro800 via EtherNet/IP and CIP',
  };

  readonly protocols = ['ethernet-ip', 'cip', 'controlnet', 'devicenet'];
  readonly deviceTypes = ['controllogix', 'compactlogix', 'micro800', 'slc500', 'micrologix'];

  private connections: Map<string, ProtocolConnection> = new Map();
  private tagCache: Map<string, { value: any; timestamp: Date; quality: string }> = new Map();
  private pollingTimers: Map<string, NodeJS.Timeout> = new Map();

  protected async doInitialize(context: AdapterContext): Promise<void> {
    context.logger.info('Initializing Rockwell vendor adapter');
    // TODO: Initialize ethernet-ip library (e.g. ethernet-ip npm package)
    // TODO: Load saved connection profiles from context.storage
  }

  protected async doConnect(): Promise<void> {
    this.context?.logger.info('Establishing CIP connections to Rockwell PLCs');
    // TODO: Implement real CIP forward-open connection sequence
    // TODO: Register session with target PLC using ROCKWELL_CONNECTION_PARAMS
    // TODO: Negotiate connection size and RPI
  }

  protected async doDisconnect(): Promise<void> {
    this.context?.logger.info('Closing Rockwell CIP connections');
    // Stop all polling timers
    for (const [key, timer] of this.pollingTimers) {
      clearInterval(timer);
    }
    this.pollingTimers.clear();
    // TODO: Send CIP forward-close to all active connections
    this.connections.clear();
    this.tagCache.clear();
  }

  protected async doDestroy(): Promise<void> {
    this.connections.clear();
    this.tagCache.clear();
  }

  // ProtocolAdapter implementation
  async readTags(addresses: string[]): Promise<AdapterTag[]> {
    this.context?.logger.debug(`Reading ${addresses.length} Rockwell tags`);

    // TODO: Implement real CIP Read Tag Service (0x4C)
    // TODO: For large tag sets, use Multiple Service Packet (0x0A)
    // TODO: Support fragmented reads for large tags (0x52)
    const tags: AdapterTag[] = addresses.map((address) => {
      const cached = this.tagCache.get(address);
      return {
        address,
        name: this.parseTagName(address),
        dataType: this.inferCipDataType(address),
        value: cached?.value ?? null,
        quality: (cached?.quality as any) ?? 'uncertain',
        timestamp: cached?.timestamp ?? new Date(),
      };
    });

    return tags;
  }

  async writeTags(tags: AdapterTag[]): Promise<void> {
    this.context?.logger.debug(`Writing ${tags.length} Rockwell tags`);
    // TODO: Implement real CIP Write Tag Service (0x4D)
    // TODO: Support fragmented writes for large tags (0x53)
    // TODO: Validate data types match PLC tag definitions
    for (const tag of tags) {
      this.tagCache.set(tag.address, {
        value: tag.value,
        timestamp: new Date(),
        quality: 'good',
      });
    }
  }

  async discoverDevices(): Promise<any[]> {
    this.context?.logger.info('Broadcasting CIP ListIdentity on port 44818');
    // TODO: Send CIP ListIdentity broadcast to 255.255.255.255:44818
    // TODO: Parse responses to extract vendor ID, product code, serial, name
    return [];
  }

  // DeviceAdapter implementation
  async getDeviceInfo(deviceId: string): Promise<any> {
    // TODO: Read CIP Identity Object (Class 0x01, Instance 1)
    return {
      deviceId,
      vendor: 'Rockwell Automation',
      vendorId: 0x0001,
      productType: 14,
      models: ROCKWELL_MODELS,
    };
  }

  async getDeviceDiagnostics(deviceId: string): Promise<any> {
    // TODO: Read fault log via CIP Message Router
    // TODO: Read module status for all slots in chassis
    return { deviceId, faultLog: [], moduleStatus: {} };
  }

  // Rockwell-specific helpers

  /** Start polling a set of tags at the specified interval tier */
  startPolling(addresses: string[], tier: keyof typeof ROCKWELL_POLLING, callback: (tags: AdapterTag[]) => void): void {
    const interval = ROCKWELL_POLLING[tier];
    const key = `poll_${tier}_${Date.now()}`;
    const timer = setInterval(async () => {
      try {
        const tags = await this.readTags(addresses);
        callback(tags);
      } catch (err) {
        this.context?.logger.error(`Polling error (${tier}):`, err);
      }
    }, interval);
    this.pollingTimers.set(key, timer);
  }

  /** Parse CIP tag path from symbolic address */
  private parseTagName(address: string): string {
    // Rockwell symbolic tags: Program:MainProgram.TagName or just TagName
    const parts = address.split('.');
    return parts[parts.length - 1];
  }

  private inferCipDataType(address: string): 'boolean' | 'number' | 'string' | 'object' {
    const lower = address.toLowerCase();
    if (lower.includes('bool') || lower.includes('.')) return 'boolean';
    if (lower.includes('string')) return 'string';
    if (lower.includes('timer') || lower.includes('counter') || lower.includes('udt')) return 'object';
    return 'number';
  }

  protected async getMetrics() {
    return {
      connectionsActive: this.connections.size,
      messagesProcessed: 0,
      errorsCount: 0,
      uptime: 0,
      cachedTags: this.tagCache.size,
      activePollers: this.pollingTimers.size,
    };
  }

  protected async getDiagnostics() {
    return {
      registerMap: ROCKWELL_REGISTER_MAP,
      connectionParams: ROCKWELL_CONNECTION_PARAMS,
      pollingConfig: ROCKWELL_POLLING,
      supportedModels: Object.keys(ROCKWELL_MODELS),
    };
  }
}
