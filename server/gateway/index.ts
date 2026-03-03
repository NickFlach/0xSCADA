/**
 * Gateway Protocol Types and Interfaces
 * Handles protocol drivers for industrial communication
 */

// Protocol Types Union
export type ProtocolType = 
  | 'DNP3_TCP'
  | 'DNP3_SERIAL'
  | 'IEC61850_MMS';

export interface ProtocolConfig {
  type: ProtocolType;
  name: string;
  connectionString: string;
  enabled: boolean;
}

export interface GatewayDriver {
  id: string;
  protocol: ProtocolConfig;
  status: 'connected' | 'disconnected' | 'error';
  lastUpdate: Date;
}

export interface Tag {
  id: string;
  name: string;
  address: string;
  dataType: 'boolean' | 'number' | 'string';
  value?: any;
  quality: 'good' | 'bad' | 'uncertain';
  timestamp: Date;
}

export class GatewayManager {
  private drivers: Map<string, GatewayDriver> = new Map();
  
  constructor() {}
  
  addDriver(driver: GatewayDriver): void {
    this.drivers.set(driver.id, driver);
  }
  
  removeDriver(id: string): boolean {
    return this.drivers.delete(id);
  }
  
  getDriver(id: string): GatewayDriver | undefined {
    return this.drivers.get(id);
  }
  
  getAllDrivers(): GatewayDriver[] {
    return Array.from(this.drivers.values());
  }
  
  getDriversByProtocol(protocol: ProtocolType): GatewayDriver[] {
    return this.getAllDrivers().filter(driver => driver.protocol.type === protocol);
  }
}

export const gatewayManager = new GatewayManager();