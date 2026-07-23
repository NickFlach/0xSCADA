/**
 * Gateway Protocol Types and Interfaces
 * Handles protocol drivers for industrial communication
 */

import { storeAndForwardService } from './store-and-forward';

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
  
  /**
   * Store data via edge store-and-forward service
   * This ensures no data is lost during network outages
   */
  async storeData(data: any, driverId: string): Promise<void> {
    try {
      await storeAndForwardService.store(data, driverId);
    } catch (error) {
      console.error(`Failed to store data for driver ${driverId}:`, error);
    }
  }
}

export const gatewayManager = new GatewayManager();
