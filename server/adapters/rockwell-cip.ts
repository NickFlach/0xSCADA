/**
 * Rockwell CIP Protocol Adapter
 * Implements both Protocol and Device adapter interfaces for Rockwell/Allen-Bradley PLCs
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
} from "@shared/types/vendor-adapter";

const ROCKWELL_CIP_CAPABILITIES: AdapterCapability[] = [
  {
    id: "read-tags",
    name: "Tag Reading", 
    category: "communication",
    required: true
  },
  {
    id: "write-tags",
    name: "Tag Writing",
    category: "communication", 
    required: true
  },
  {
    id: "browse-tags",
    name: "Tag Browsing",
    category: "communication",
    description: "CIP-specific tag browsing and symbol table access",
    required: false
  },
  {
    id: "fault-logs",
    name: "Fault Log Access",
    category: "diagnostics",
    description: "Access ControlLogix fault logs and diagnostic data",
    required: false
  },
  {
    id: "connection-manager",
    name: "CIP Connection Manager",
    category: "diagnostics", 
    description: "Monitor CIP connection status and statistics",
    required: false
  },
  {
    id: "module-identity",
    name: "Module Identity",
    category: "diagnostics",
    description: "Read module identity and device information",
    required: false
  }
];

export class RockwellCipAdapter extends BaseAdapter<'protocol'> implements ProtocolAdapter, DeviceAdapter {
  readonly manifest: AdapterManifest & { type: 'protocol' } = {
    id: "rockwell-cip",
    name: "Rockwell CIP Protocol Adapter", 
    vendor: "Rockwell Automation",
    version: "1.0.0",
    type: "protocol",
    capabilities: ROCKWELL_CIP_CAPABILITIES,
    description: "Support for ControlLogix, CompactLogix, and other CIP-enabled Rockwell PLCs"
  };
  
  readonly protocols = ["cip", "ethernet-ip"];
  readonly deviceTypes = ["controllogix", "compactlogix", "micrologix", "slc500"];
  
  private connections: Map<string, ProtocolConnection> = new Map();
  private lastActivity: Date = new Date();
  
  protected async doInitialize(context: AdapterContext): Promise<void> {
    // Initialize CIP communication library
    context.logger.info("Initializing Rockwell CIP adapter");
    
    // In a real implementation, this would initialize the CIP communication library
    // For now, we'll simulate initialization
    await this.simulateDelay(1000);
  }
  
  protected async doConnect(): Promise<void> {
    // Establish CIP connections to configured endpoints
    this.context?.logger.info("Connecting to Rockwell CIP devices");
    
    // Simulate connection process
    await this.simulateDelay(2000);
    this.lastActivity = new Date();
  }
  
  protected async doDisconnect(): Promise<void> {
    this.context?.logger.info("Disconnecting from Rockwell CIP devices");
    
    // Close all connections
    this.connections.clear();
    await this.simulateDelay(500);
  }
  
  protected async doDestroy(): Promise<void> {
    this.context?.logger.info("Destroying Rockwell CIP adapter");
    // Cleanup resources
    this.connections.clear();
  }
  
  // ProtocolAdapter implementation
  async readTags(addresses: string[]): Promise<AdapterTag[]> {
    if (this.state !== 'connected') {
      throw new Error('Adapter not connected');
    }
    
    this.context?.logger.debug(`Reading ${addresses.length} CIP tags`);
    
    // Simulate reading tags from Rockwell PLC
    const tags: AdapterTag[] = addresses.map((address, index) => ({
      address,
      name: `Tag_${index}`,
      dataType: this.inferDataType(address),
      value: this.simulateTagValue(address),
      quality: 'good',
      timestamp: new Date()
    }));
    
    this.lastActivity = new Date();
    return tags;
  }
  
  async writeTags(tags: AdapterTag[]): Promise<void> {
    if (this.state !== 'connected') {
      throw new Error('Adapter not connected');
    }
    
    this.context?.logger.debug(`Writing ${tags.length} CIP tags`);
    
    // Simulate writing tags to Rockwell PLC
    await this.simulateDelay(100);
    this.lastActivity = new Date();
  }
  
  async discoverDevices(): Promise<any[]> {
    this.context?.logger.info("Discovering CIP devices on network");
    
    // Simulate device discovery
    await this.simulateDelay(3000);
    
    return [
      {
        deviceId: "192.168.1.10_slot_0",
        name: "ControlLogix CPU",
        type: "controllogix",
        address: "192.168.1.10",
        slot: 0,
        productCode: 0x00AE,
        vendorId: 0x0001,
        revision: "20.011"
      },
      {
        deviceId: "192.168.1.10_slot_1", 
        name: "Analog Input Module",
        type: "analog-input",
        address: "192.168.1.10",
        slot: 1,
        productCode: 0x00CC,
        vendorId: 0x0001,
        revision: "3.001"
      }
    ];
  }
  
  // DeviceAdapter implementation
  async getDeviceInfo(deviceId: string): Promise<any> {
    this.context?.logger.debug(`Getting device info for ${deviceId}`);
    
    return {
      deviceId,
      identity: {
        vendorId: 0x0001, // Rockwell Automation
        productType: 14, // Communication Adapter
        productCode: 0x00AE,
        revision: { major: 20, minor: 11 },
        status: 0x0000,
        serialNumber: 0x12345678,
        productName: "1756-L83E ControlLogix CPU"
      },
      connectionInfo: {
        ipAddress: deviceId.split('_')[0],
        slot: parseInt(deviceId.split('_')[2] || '0'),
        connected: true,
        lastSeen: new Date()
      }
    };
  }
  
  async getDeviceDiagnostics(deviceId: string): Promise<any> {
    this.context?.logger.debug(`Getting diagnostics for ${deviceId}`);
    
    return {
      deviceId,
      faultLog: [
        {
          faultCode: 0x0001,
          description: "Communication lost with module in slot 3",
          timestamp: new Date(Date.now() - 3600000),
          severity: "minor"
        }
      ],
      statistics: {
        packetsReceived: 12543,
        packetsSent: 12540,
        errorsReceived: 3,
        connectionsActive: 2,
        cpuUsage: 15.6,
        memoryUsage: 42.3
      },
      moduleStatus: {
        slot0: { status: "OK", faults: 0 },
        slot1: { status: "OK", faults: 0 },
        slot2: { status: "OK", faults: 0 },
        slot3: { status: "COMM_LOST", faults: 1 }
      }
    };
  }
  
  protected async getMetrics(): Promise<any> {
    return {
      connectionsActive: this.connections.size,
      messagesProcessed: 0, // Would track in real implementation
      errorsCount: 0,
      uptime: Date.now() - this.lastActivity.getTime()
    };
  }
  
  protected async getDiagnostics(): Promise<any> {
    return {
      protocolVersion: "1.0",
      connectionCount: this.connections.size,
      lastActivity: this.lastActivity.toISOString(),
      supportedServices: [
        "Read Tag",
        "Write Tag", 
        "Read Tag Fragmented",
        "Write Tag Fragmented",
        "Multiple Service Packet"
      ]
    };
  }
  
  // Helper methods
  private inferDataType(address: string): 'boolean' | 'number' | 'string' | 'object' {
    if (address.toLowerCase().includes('bool') || address.includes('.')) {
      return 'boolean';
    }
    if (address.toLowerCase().includes('string')) {
      return 'string';
    }
    if (address.toLowerCase().includes('timer') || address.toLowerCase().includes('counter')) {
      return 'object';
    }
    return 'number';
  }
  
  private simulateTagValue(address: string): any {
    const dataType = this.inferDataType(address);
    
    switch (dataType) {
      case 'boolean':
        return Math.random() > 0.5;
      case 'string':
        return `Value_${Math.floor(Math.random() * 1000)}`;
      case 'object':
        return { acc: Math.floor(Math.random() * 1000), en: true, dn: false };
      case 'number':
      default:
        return Math.random() * 100;
    }
  }
  
  private async simulateDelay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}