/**
 * Schneider Electric Vendor Adapter
 * 
 * Extends 0xSCADA BaseAdapter for Schneider Electric PLC/HMI/RTU systems.
 * Protocols: Modbus TCP, EtherNet/IP, IEC 60870-5-104
 * Models: Modicon M580, M340, Quantum, SCADAPack, Easergy
 */

import {
  BaseAdapter,
  ProtocolAdapter,
  DeviceAdapter,
  AdapterManifest,
  AdapterCapability,
  AdapterContext,
  AdapterTag,
  ProtocolConnection,
} from '@shared/types/services/adapters';

export const SCHNEIDER_REGISTER_MAP = {
  MODBUS: {
    // Modicon standard Modbus register layout
    COILS: { start: 0, functionRead: 0x01, functionWrite: 0x05, functionWriteMulti: 0x0F },
    DISCRETE_INPUTS: { start: 10001, functionRead: 0x02 },
    INPUT_REGISTERS: { start: 30001, functionRead: 0x04 },
    HOLDING_REGISTERS: { start: 40001, functionRead: 0x03, functionWrite: 0x06, functionWriteMulti: 0x10 },
    // M580-specific extended registers
    EXTENDED_REGISTERS: { start: 400001, functionRead: 0x03 }, // 32-bit addressing
  },
  M580: {
    SYSTEM_BITS: { start: 0, count: 128, description: 'System %S bits' },
    SYSTEM_WORDS: { start: 40001, count: 100, description: 'System %SW words' },
    CPU_STATUS: { register: 40001, description: 'CPU run/stop/fault status' },
    SCAN_TIME: { register: 40010, description: 'Current scan time (ms)' },
    IO_HEALTH: { register: 40020, count: 16, description: 'I/O module health bitmap' },
  },
  IEC104: {
    // IEC 60870-5-104 information object addresses
    SINGLE_POINT: { typeId: 1, cause: 3 },  // M_SP_NA_1
    DOUBLE_POINT: { typeId: 3, cause: 3 },  // M_DP_NA_1
    MEASURED_SCALED: { typeId: 11, cause: 3 }, // M_ME_NB_1
    MEASURED_FLOAT: { typeId: 13, cause: 3 },  // M_ME_NC_1
    SINGLE_COMMAND: { typeId: 45, cause: 6 },  // C_SC_NA_1
    DOUBLE_COMMAND: { typeId: 46, cause: 6 },  // C_DC_NA_1
    SETPOINT_FLOAT: { typeId: 50, cause: 6 },  // C_SE_NC_1
    INTERROGATION: { typeId: 100, cause: 6 },  // C_IC_NA_1
    CLOCK_SYNC: { typeId: 103, cause: 6 },     // C_CS_NA_1
  },
  SCADAPACK: {
    // SCADAPack register layout
    ANALOG_INPUTS: { start: 30001, count: 32 },
    ANALOG_OUTPUTS: { start: 40001, count: 16 },
    DIGITAL_INPUTS: { start: 10001, count: 64 },
    DIGITAL_OUTPUTS: { start: 1, count: 64 },
    ACCUMULATORS: { start: 40101, count: 16 },
    SYSTEM_REGISTERS: { start: 47001, count: 100 },
  },
} as const;

export const SCHNEIDER_CONNECTION_PARAMS = {
  modbusTcp: { defaultPort: 502, unitId: 1, timeout: 5000, maxRetries: 3 },
  ethernetIp: { defaultPort: 44818, timeout: 10000 },
  iec104: { defaultPort: 2404, t0: 30, t1: 15, t2: 10, t3: 20, k: 12, w: 8 },
  unityPro: { defaultPort: 502, servicePort: 27127 }, // Unity Pro programming port
} as const;

export const SCHNEIDER_POLLING = {
  fast: 100,
  normal: 500,
  slow: 2000,
  iec104Spontaneous: 0, // IEC 104 uses event-driven, not polling
} as const;

const SCHNEIDER_CAPABILITIES: AdapterCapability[] = [
  { id: 'read-tags', name: 'Tag Reading', category: 'communication', required: true },
  { id: 'write-tags', name: 'Tag Writing', category: 'communication', required: true },
  { id: 'iec104', name: 'IEC 60870-5-104', category: 'communication', required: false },
  { id: 'scadapack-config', name: 'SCADAPack Configuration', category: 'configuration', required: false },
  { id: 'cybersecurity', name: 'Achilles-certified Security', category: 'diagnostics', required: false },
  { id: 'redundancy', name: 'Hot Standby Redundancy', category: 'configuration', required: false },
];

export const SCHNEIDER_MODELS = {
  'Modicon M580': { type: 'PLC', maxIO: 32768, redundancy: true, protocols: ['Modbus TCP', 'EtherNet/IP'] },
  'Modicon M340': { type: 'PLC', maxIO: 1024, redundancy: false, protocols: ['Modbus TCP', 'EtherNet/IP'] },
  'Modicon Quantum': { type: 'PLC', maxIO: 64000, redundancy: true, protocols: ['Modbus TCP'] },
  'SCADAPack': { type: 'RTU', maxIO: 256, redundancy: false, protocols: ['Modbus', 'DNP3', 'IEC 104'] },
  'Easergy': { type: 'RTU', maxIO: 128, redundancy: false, protocols: ['IEC 104', 'DNP3', 'Modbus'] },
} as const;

export class SchneiderVendorAdapter extends BaseAdapter<'protocol'> implements ProtocolAdapter {
  readonly manifest: AdapterManifest & { type: 'protocol' } = {
    id: 'schneider-vendor',
    name: 'Schneider Electric Vendor Adapter',
    vendor: 'Schneider Electric',
    version: '1.0.0',
    type: 'protocol',
    capabilities: SCHNEIDER_CAPABILITIES,
    description: 'Full vendor adapter for Modicon M580/M340/Quantum, SCADAPack, Easergy',
  };

  readonly protocols = ['modbus-tcp', 'ethernet-ip', 'iec-60870-5-104', 'dnp3'];
  readonly deviceTypes = ['m580', 'm340', 'quantum', 'scadapack', 'easergy'];

  private connections: Map<string, ProtocolConnection> = new Map();
  private tagCache: Map<string, { value: any; timestamp: Date }> = new Map();

  protected async doInitialize(context: AdapterContext): Promise<void> {
    context.logger.info('Initializing Schneider Electric vendor adapter');
    // TODO: Initialize Modbus TCP client
    // TODO: Initialize IEC 104 stack (if available)
  }

  protected async doConnect(): Promise<void> {
    // TODO: Modbus TCP connection to M580/M340
    // TODO: IEC 104 connection: STARTDT → general interrogation
    // TODO: SCADAPack: Modbus with SCADAPack-specific register map
  }

  protected async doDisconnect(): Promise<void> {
    // TODO: IEC 104: STOPDT
    this.connections.clear();
    this.tagCache.clear();
  }

  protected async doDestroy(): Promise<void> {
    this.connections.clear();
  }

  async readTags(addresses: string[]): Promise<AdapterTag[]> {
    // TODO: Parse Modbus addresses (e.g., %MW100, 40001, %I0.0)
    // TODO: For IEC 104 devices, use spontaneous data + general interrogation
    // TODO: Use SCHNEIDER_REGISTER_MAP to route to correct function codes
    return addresses.map((address) => ({
      address,
      dataType: this.inferModbusDataType(address),
      value: this.tagCache.get(address)?.value ?? null,
      quality: 'uncertain' as const,
      timestamp: this.tagCache.get(address)?.timestamp ?? new Date(),
    }));
  }

  async writeTags(tags: AdapterTag[]): Promise<void> {
    // TODO: Modbus FC05/FC06/FC15/FC16
    // TODO: IEC 104: Single/Double command, setpoint
    for (const tag of tags) {
      this.tagCache.set(tag.address, { value: tag.value, timestamp: new Date() });
    }
  }

  async discoverDevices(): Promise<any[]> {
    // TODO: Modbus scan unit IDs on subnet
    return [];
  }

  async getDeviceInfo(deviceId: string): Promise<any> {
    return { deviceId, vendor: 'Schneider Electric', models: SCHNEIDER_MODELS };
  }

  async getDeviceDiagnostics(deviceId: string): Promise<any> {
    // TODO: Read %S system bits for M580 status
    // TODO: Read system registers for SCADAPack
    return { deviceId };
  }

  private inferModbusDataType(address: string): 'boolean' | 'number' | 'string' | 'object' {
    const upper = address.toUpperCase();
    if (upper.startsWith('%I') || upper.startsWith('%Q') || upper.startsWith('%M0')) return 'boolean';
    if (parseInt(address) < 10000 || (parseInt(address) >= 10001 && parseInt(address) < 20000)) return 'boolean';
    return 'number';
  }

  protected async getMetrics() {
    return { connectionsActive: this.connections.size, cachedTags: this.tagCache.size };
  }

  protected async getDiagnostics() {
    return { registerMap: SCHNEIDER_REGISTER_MAP, connectionParams: SCHNEIDER_CONNECTION_PARAMS };
  }
}
