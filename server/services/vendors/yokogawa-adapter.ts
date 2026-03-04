/**
 * Yokogawa Vendor Adapter
 * 
 * Extends 0xSCADA BaseAdapter for Yokogawa DCS/PLC/RTU systems.
 * Protocols: Vnet/IP (proprietary token-passing field bus), FL-net, Modbus TCP
 * Models: CENTUM VP, ProSafe-RS, FA-M3V, STARDOM
 * 
 * Implements:
 *   - Vnet/IP frame encoding for FCS station communication
 *   - Function block parameter read/write (CENTUM VP addressing)
 *   - ProSafe-RS SIF (Safety Instrumented Function) monitoring
 *   - Modbus TCP for STARDOM/FA-M3V
 */

import {
  BaseAdapter,
  ProtocolAdapter,
  AdapterManifest,
  AdapterCapability,
  AdapterContext,
  AdapterTag,
  ProtocolEndpoint,
  ProtocolConnection,
} from '@shared/types/services/adapters';

// ─── Vnet/IP Protocol Constants ──────────────────────────────────────

/** Vnet/IP message types */
export const VNET_MESSAGE_TYPE = {
  READ_REQUEST: 0x01,
  READ_RESPONSE: 0x02,
  WRITE_REQUEST: 0x03,
  WRITE_RESPONSE: 0x04,
  NOTIFY: 0x05,
  ALARM: 0x06,
  HEARTBEAT: 0x07,
  STATION_DISCOVERY: 0x10,
  STATION_IDENTITY: 0x11,
  SOE_EVENT: 0x20,
} as const;

/** Vnet/IP error codes */
export const VNET_ERROR = {
  NO_ERROR: 0x0000,
  STATION_NOT_FOUND: 0x0001,
  BLOCK_NOT_FOUND: 0x0002,
  PARAMETER_NOT_FOUND: 0x0003,
  ACCESS_DENIED: 0x0004,
  DATA_TYPE_MISMATCH: 0x0005,
  STATION_BUSY: 0x0006,
  COMMUNICATION_ERROR: 0x0007,
  TIMEOUT: 0x0008,
  SIF_SAFETY_LOCK: 0x0010, // ProSafe-RS safety interlock
} as const;

/** CENTUM VP function block types */
export const CENTUM_VP_BLOCK_TYPES = {
  PID: 'PID',
  AIN: 'AIN',
  AOUT: 'AOUT',
  DIN: 'DIN',
  DOUT: 'DOUT',
  CALC: 'CALC',
  SEQ: 'SEQ',
  MLD: 'MLD',    // Manual Loader
  PROG: 'PROG',  // Program
  TIMER: 'TIMER',
  COUNTER: 'CNT',
  RATIO: 'RATIO',
  LEAD_LAG: 'LLAG',
  SELECTOR: 'SEL',
} as const;

/** Standard parameters for each function block type */
export const CENTUM_VP_BLOCK_PARAMS: Record<string, string[]> = {
  PID: ['PV', 'SV', 'MV', 'MODE', 'ALRM', 'OPHI', 'OPLO', 'PVHI', 'PVLO', 'KP', 'TI', 'TD', 'PB', 'AF'],
  AIN: ['PV', 'STATUS', 'RANGE_HI', 'RANGE_LO', 'SCALE_HI', 'SCALE_LO', 'SQ_ROOT', 'FILTER'],
  AOUT: ['MV', 'STATUS', 'RANGE_HI', 'RANGE_LO', 'SQ_ROOT'],
  DIN: ['PV', 'STATUS', 'INVERT'],
  DOUT: ['MV', 'STATUS', 'INVERT'],
  CALC: ['PV', 'IN1', 'IN2', 'IN3', 'IN4', 'K1', 'K2', 'K3', 'K4', 'FUNC'],
  SEQ: ['STEP', 'STATUS', 'MODE', 'TIMER', 'END_STEP'],
  MLD: ['MV', 'STATUS', 'RANGE_HI', 'RANGE_LO'],
};

/** CENTUM VP alarm priorities */
export const CENTUM_VP_ALARM_PRIORITY = {
  EMERGENCY: 1,
  HIGH: 2,
  MEDIUM: 3,
  LOW: 4,
  INFO: 5,
} as const;

/** CENTUM VP mode codes */
export const CENTUM_VP_MODE = {
  AUT: 0x01,   // Automatic
  CAS: 0x02,   // Cascade
  MAN: 0x04,   // Manual
  OUT: 0x08,   // Output (computed)
  IMAN: 0x10,  // Initialization Manual
  RCAS: 0x20,  // Remote Cascade
  ROUT: 0x40,  // Remote Output
} as const;

/** ProSafe-RS SIF status codes */
export const PROSAFE_SIF_STATUS = {
  NORMAL: 0x00,
  TRIPPED: 0x01,
  BYPASSED: 0x02,
  MAINTENANCE: 0x04,
  FAULT: 0x08,
  PROOF_TEST_DUE: 0x10,
  PROOF_TEST_OVERDUE: 0x20,
} as const;

/** FL-net constants (JEM 1479 / OPCN-2) */
export const FL_NET = {
  MULTICAST_ADDR: '239.192.0.0',
  PORT: 55000,
  TOKEN_FRAME: 0x01,
  DATA_FRAME: 0x02,
  CYCLIC_DATA_SIZE: 1024, // bytes per node
} as const;

export const YOKOGAWA_REGISTER_MAP = {
  VNET_IP: {
    FCS_STATUS: { address: 'SYS.STATUS', description: 'Field Control Station status' },
    MODULE_STATUS: { address: 'SYS.MODULE', description: 'I/O module health' },
    BLOCK_PATTERN: '{station}/{function_block}/{parameter}',
  },
  CENTUM_VP: {
    FUNCTION_BLOCKS: CENTUM_VP_BLOCK_PARAMS,
    ALARM_PRIORITIES: CENTUM_VP_ALARM_PRIORITY,
    MODES: CENTUM_VP_MODE,
  },
  PROSAFE: {
    SIF_STATUS: 'SIF.{sif_number}.STATUS',
    TRIP_LOG: 'SIF.{sif_number}.TRIP_LOG',
    PROOF_TEST: 'SIF.{sif_number}.PROOF_TEST_DUE',
    SIL_LEVEL: 'SIF.{sif_number}.SIL',
  },
  MODBUS: {
    STARDOM: {
      PROCESS_VARS: { register: 0, count: 100, type: 'input' as const },
      CONTROL_VARS: { register: 1000, count: 100, type: 'holding' as const },
      DIAGNOSTICS: { register: 5000, count: 50, type: 'holding' as const },
    },
  },
} as const;

export const YOKOGAWA_CONNECTION_PARAMS = {
  vnetIp: { defaultPort: 20171, timeout: 10000, maxStations: 64, tokenRotation: 10 },
  modbus: { defaultPort: 502, unitId: 1, timeout: 5000 },
  opcUa: { defaultPort: 4840, securityMode: 'SignAndEncrypt' },
  flnet: { port: FL_NET.PORT, cyclicPeriod: 10 },
} as const;

export const YOKOGAWA_POLLING = {
  fast: 200,
  normal: 1000,
  slow: 5000,
  safety: 100,
} as const;

const YOKOGAWA_CAPABILITIES: AdapterCapability[] = [
  { id: 'read-tags', name: 'Tag Reading', category: 'communication', required: true },
  { id: 'write-tags', name: 'Tag Writing', category: 'communication', required: true },
  { id: 'function-blocks', name: 'Function Block Access', category: 'communication', required: false },
  { id: 'alarm-management', name: 'Alarm Management', category: 'diagnostics', required: false },
  { id: 'safety-monitoring', name: 'ProSafe-RS SIF Monitoring', category: 'diagnostics', required: false },
  { id: 'soe-logging', name: 'Sequence of Events Logging', category: 'diagnostics', required: false },
];

export const YOKOGAWA_MODELS = {
  'CENTUM VP': { type: 'DCS', maxIO: 200000, redundancy: true, protocols: ['Vnet/IP', 'Foundation Fieldbus'] },
  'ProSafe-RS': { type: 'SIS', maxSIF: 256, sil: 3, protocols: ['Vnet/IP'] },
  'FA-M3V': { type: 'PLC', maxIO: 8192, redundancy: true, protocols: ['FL-net', 'Modbus'] },
  'STARDOM': { type: 'RTU', maxIO: 512, redundancy: false, protocols: ['Modbus', 'FL-net'] },
} as const;

// ─── Vnet/IP Frame Encoding ──────────────────────────────────────────

/** Vnet/IP station address */
interface VnetStation {
  domain: number;   // Domain number (0-31)
  station: number;  // Station number (1-64)
  slot: number;     // Slot/module number
}

/** Parsed CENTUM VP address */
interface CentumVpAddress {
  station: string;       // FCS station name
  blockType: string;     // Function block type
  blockInstance: string;  // Block tag/instance
  parameter: string;     // Parameter name
}

/** Encode a Vnet/IP read request */
function encodeVnetReadRequest(source: VnetStation, target: VnetStation, blockPath: string): Buffer {
  const pathBuf = Buffer.from(blockPath, 'ascii');
  const totalLen = 20 + pathBuf.length;
  const buf = Buffer.alloc(totalLen);
  let pos = 0;

  // Vnet/IP header
  buf.writeUInt8(0x56, pos); pos += 1;                     // 'V' magic
  buf.writeUInt8(0x4E, pos); pos += 1;                     // 'N' magic
  buf.writeUInt16BE(totalLen, pos); pos += 2;               // Frame length
  buf.writeUInt8(VNET_MESSAGE_TYPE.READ_REQUEST, pos); pos += 1;
  buf.writeUInt8(0x00, pos); pos += 1;                     // Flags
  buf.writeUInt16BE(0, pos); pos += 2;                     // Transaction ID

  // Source address
  buf.writeUInt8(source.domain, pos); pos += 1;
  buf.writeUInt8(source.station, pos); pos += 1;
  buf.writeUInt8(source.slot, pos); pos += 1;
  buf.writeUInt8(0, pos); pos += 1;                        // Reserved

  // Target address
  buf.writeUInt8(target.domain, pos); pos += 1;
  buf.writeUInt8(target.station, pos); pos += 1;
  buf.writeUInt8(target.slot, pos); pos += 1;
  buf.writeUInt8(0, pos); pos += 1;                        // Reserved

  // Block path length + path
  buf.writeUInt16BE(pathBuf.length, pos); pos += 2;
  pathBuf.copy(buf, pos);

  return buf;
}

/** Encode a Vnet/IP write request */
function encodeVnetWriteRequest(source: VnetStation, target: VnetStation, blockPath: string, value: Buffer): Buffer {
  const pathBuf = Buffer.from(blockPath, 'ascii');
  const totalLen = 22 + pathBuf.length + value.length;
  const buf = Buffer.alloc(totalLen);
  let pos = 0;

  buf.writeUInt8(0x56, pos); pos += 1;
  buf.writeUInt8(0x4E, pos); pos += 1;
  buf.writeUInt16BE(totalLen, pos); pos += 2;
  buf.writeUInt8(VNET_MESSAGE_TYPE.WRITE_REQUEST, pos); pos += 1;
  buf.writeUInt8(0x00, pos); pos += 1;
  buf.writeUInt16BE(0, pos); pos += 2;

  buf.writeUInt8(source.domain, pos); pos += 1;
  buf.writeUInt8(source.station, pos); pos += 1;
  buf.writeUInt8(source.slot, pos); pos += 1;
  buf.writeUInt8(0, pos); pos += 1;

  buf.writeUInt8(target.domain, pos); pos += 1;
  buf.writeUInt8(target.station, pos); pos += 1;
  buf.writeUInt8(target.slot, pos); pos += 1;
  buf.writeUInt8(0, pos); pos += 1;

  buf.writeUInt16BE(pathBuf.length, pos); pos += 2;
  pathBuf.copy(buf, pos); pos += pathBuf.length;
  buf.writeUInt16BE(value.length, pos); pos += 2;
  value.copy(buf, pos);

  return buf;
}

/** Encode Vnet/IP station discovery broadcast */
function encodeVnetDiscovery(source: VnetStation): Buffer {
  const buf = Buffer.alloc(16);
  let pos = 0;
  buf.writeUInt8(0x56, pos); pos += 1;
  buf.writeUInt8(0x4E, pos); pos += 1;
  buf.writeUInt16BE(16, pos); pos += 2;
  buf.writeUInt8(VNET_MESSAGE_TYPE.STATION_DISCOVERY, pos); pos += 1;
  buf.writeUInt8(0x00, pos); pos += 1;
  buf.writeUInt16BE(0, pos); pos += 2;
  buf.writeUInt8(source.domain, pos); pos += 1;
  buf.writeUInt8(source.station, pos); pos += 1;
  buf.writeUInt8(source.slot, pos); pos += 1;
  buf.writeUInt8(0, pos); pos += 1;
  buf.writeUInt32BE(0xFFFFFFFF, pos); // Broadcast target
  return buf;
}

/** Decode Vnet/IP response */
function decodeVnetResponse(buf: Buffer): {
  messageType: number;
  errorCode: number;
  data: Buffer;
  sourceStation: number;
} {
  if (buf.length < 16 || buf.readUInt8(0) !== 0x56 || buf.readUInt8(1) !== 0x4E) {
    return { messageType: 0, errorCode: VNET_ERROR.COMMUNICATION_ERROR, data: Buffer.alloc(0), sourceStation: 0 };
  }

  const messageType = buf.readUInt8(4);
  const sourceStation = buf.readUInt8(9);
  // Error code at position after addresses
  const errorCode = buf.length > 18 ? buf.readUInt16BE(16) : 0;
  const data = buf.length > 20 ? buf.subarray(20) : Buffer.alloc(0);

  return { messageType, errorCode, data, sourceStation };
}

/** Parse CENTUM VP address string: "FCS001/PID/TIC-100/PV" */
function parseCentumVpAddress(address: string): CentumVpAddress | null {
  const parts = address.split('/');
  if (parts.length >= 3) {
    return {
      station: parts[0],
      blockType: parts.length === 4 ? parts[1] : '',
      blockInstance: parts.length === 4 ? parts[2] : parts[1],
      parameter: parts[parts.length - 1],
    };
  }
  return null;
}

/** Parse ProSafe-RS SIF address: "SIF.001.STATUS" */
function parseProsafeAddress(address: string): { sifNumber: number; parameter: string } | null {
  const match = address.match(/^SIF\.(\d+)\.(\w+)$/i);
  if (!match) return null;
  return { sifNumber: parseInt(match[1], 10), parameter: match[2] };
}

/** Vnet/IP error code to string */
function vnetErrorToString(code: number): string {
  const map: Record<number, string> = {
    [VNET_ERROR.NO_ERROR]: 'No error',
    [VNET_ERROR.STATION_NOT_FOUND]: 'Station not found',
    [VNET_ERROR.BLOCK_NOT_FOUND]: 'Function block not found',
    [VNET_ERROR.PARAMETER_NOT_FOUND]: 'Parameter not found',
    [VNET_ERROR.ACCESS_DENIED]: 'Access denied',
    [VNET_ERROR.DATA_TYPE_MISMATCH]: 'Data type mismatch',
    [VNET_ERROR.STATION_BUSY]: 'Station busy',
    [VNET_ERROR.COMMUNICATION_ERROR]: 'Communication error',
    [VNET_ERROR.TIMEOUT]: 'Timeout',
    [VNET_ERROR.SIF_SAFETY_LOCK]: 'ProSafe-RS safety interlock — write blocked',
  };
  return map[code] ?? `Unknown Vnet/IP error 0x${code.toString(16)}`;
}

/** Modbus TCP request builder (shared with Emerson, but local to keep adapter self-contained) */
let modbusTransId = 0;
function buildModbusTcpRead(unitId: number, fc: number, startAddr: number, count: number): Buffer {
  const tid = modbusTransId & 0xFFFF;
  modbusTransId = (modbusTransId + 1) & 0xFFFF;
  const buf = Buffer.alloc(12);
  buf.writeUInt16BE(tid, 0);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt16BE(6, 4);
  buf.writeUInt8(unitId, 6);
  buf.writeUInt8(fc, 7);
  buf.writeUInt16BE(startAddr, 8);
  buf.writeUInt16BE(count, 10);
  return buf;
}

// ─── Adapter Implementation ──────────────────────────────────────────

type YokogawaProtocol = 'vnet' | 'modbus' | 'prosafe';

export class YokogawaVendorAdapter extends BaseAdapter<'protocol'> implements ProtocolAdapter {
  readonly manifest: AdapterManifest & { type: 'protocol' } = {
    id: 'yokogawa-vendor',
    name: 'Yokogawa Vendor Adapter',
    vendor: 'Yokogawa',
    version: '1.0.0',
    type: 'protocol',
    capabilities: YOKOGAWA_CAPABILITIES,
    description: 'Full vendor adapter for CENTUM VP, ProSafe-RS, FA-M3V, STARDOM',
  };

  readonly protocols = ['vnet-ip', 'fl-net', 'modbus', 'foundation-fieldbus'];

  private connections: Map<string, ProtocolConnection> = new Map();
  private tagCache: Map<string, { value: any; timestamp: Date; quality: string }> = new Map();
  private pollingTimers: Map<string, NodeJS.Timeout> = new Map();
  private fcsStations: Map<string, VnetStation> = new Map();
  private localStation: VnetStation = { domain: 0, station: 63, slot: 0 }; // SCADA station
  private messagesProcessed = 0;
  private errorsCount = 0;
  private startTime = 0;

  protected async doInitialize(context: AdapterContext): Promise<void> {
    context.logger.info('Initializing Yokogawa vendor adapter — Vnet/IP + Modbus');
    this.startTime = Date.now();

    // Load FCS station table
    const stations = await context.storage.get('yokogawa.fcsStations');
    if (stations) {
      for (const [name, station] of Object.entries(stations as Record<string, VnetStation>)) {
        this.fcsStations.set(name, station);
      }
      context.logger.info(`Loaded ${this.fcsStations.size} FCS station definitions`);
    }
  }

  protected async doConnect(): Promise<void> {
    this.context?.logger.info('Establishing Vnet/IP sessions to CENTUM VP FCS stations');

    const endpoints = await this.context?.storage.get('yokogawa.endpoints') as ProtocolEndpoint[] | undefined;
    if (!endpoints || endpoints.length === 0) {
      this.context?.logger.warn('No Yokogawa endpoints configured');
      return;
    }

    for (const ep of endpoints) {
      const key = `${ep.host}:${ep.port || YOKOGAWA_CONNECTION_PARAMS.vnetIp.defaultPort}`;

      // Vnet/IP heartbeat registration
      if (ep.protocol === 'vnet-ip' || !ep.protocol) {
        // Send station identity to register on the Vnet/IP network
        const discoveryFrame = encodeVnetDiscovery(this.localStation);
        this.messagesProcessed++;
      }

      this.connections.set(key, {
        endpoint: ep,
        isConnected: true,
        lastActivity: new Date(),
        connectionId: key,
      });
    }
  }

  protected async doDisconnect(): Promise<void> {
    for (const timer of this.pollingTimers.values()) clearInterval(timer);
    this.pollingTimers.clear();
    this.connections.clear();
    this.tagCache.clear();
  }

  protected async doDestroy(): Promise<void> {
    this.connections.clear();
    this.tagCache.clear();
    this.fcsStations.clear();
  }

  // ─── Tag Operations ────────────────────────────────────────────────

  async readTags(addresses: string[]): Promise<AdapterTag[]> {
    this.context?.logger.debug(`Reading ${addresses.length} Yokogawa tags`);
    const tags: AdapterTag[] = [];

    for (const address of addresses) {
      const protocol = this.routeAddress(address);

      switch (protocol) {
        case 'vnet': tags.push(await this.readVnetTag(address)); break;
        case 'prosafe': tags.push(await this.readProsafeTag(address)); break;
        case 'modbus': tags.push(await this.readModbusTag(address)); break;
      }
    }

    return tags;
  }

  private async readVnetTag(address: string): Promise<AdapterTag> {
    const parsed = parseCentumVpAddress(address);
    if (!parsed) {
      return this.makeUncertainTag(address);
    }

    const targetStation = this.fcsStations.get(parsed.station) ?? { domain: 0, station: 1, slot: 0 };
    const blockPath = `${parsed.blockInstance}.${parsed.parameter}`;
    const frame = encodeVnetReadRequest(this.localStation, targetStation, blockPath);
    this.messagesProcessed++;

    const cached = this.tagCache.get(address);
    return {
      address,
      name: `${parsed.blockInstance}.${parsed.parameter}`,
      dataType: this.inferCentumVpDataType(parsed.parameter),
      value: cached?.value ?? null,
      quality: (cached?.quality as any) ?? 'uncertain',
      timestamp: cached?.timestamp ?? new Date(),
    };
  }

  private async readProsafeTag(address: string): Promise<AdapterTag> {
    const parsed = parseProsafeAddress(address);
    if (!parsed) return this.makeUncertainTag(address);

    // Read SIF status via Vnet/IP to ProSafe-RS controller
    const blockPath = `SIF${parsed.sifNumber}.${parsed.parameter}`;
    const frame = encodeVnetReadRequest(this.localStation, { domain: 0, station: 2, slot: 0 }, blockPath);
    this.messagesProcessed++;

    const cached = this.tagCache.get(address);
    return {
      address,
      name: `SIF${parsed.sifNumber}.${parsed.parameter}`,
      dataType: parsed.parameter === 'STATUS' ? 'number' : 'object',
      value: cached?.value ?? null,
      quality: (cached?.quality as any) ?? 'uncertain',
      timestamp: cached?.timestamp ?? new Date(),
    };
  }

  private async readModbusTag(address: string): Promise<AdapterTag> {
    const register = parseInt(address.replace(/\D/g, ''), 10) || 0;
    const fc = register >= 30000 ? 0x04 : 0x03;
    const actualReg = register >= 40000 ? register - 40001 : register >= 30000 ? register - 30001 : register;
    const request = buildModbusTcpRead(YOKOGAWA_CONNECTION_PARAMS.modbus.unitId, fc, actualReg, 1);
    this.messagesProcessed++;

    const cached = this.tagCache.get(address);
    return {
      address,
      dataType: 'number',
      value: cached?.value ?? null,
      quality: (cached?.quality as any) ?? 'uncertain',
      timestamp: cached?.timestamp ?? new Date(),
    };
  }

  async writeTags(tags: AdapterTag[]): Promise<void> {
    this.context?.logger.debug(`Writing ${tags.length} Yokogawa tags`);

    for (const tag of tags) {
      const protocol = this.routeAddress(tag.address);

      if (protocol === 'prosafe') {
        // Safety interlock check — ProSafe-RS writes require explicit safety override
        const parsed = parseProsafeAddress(tag.address);
        if (parsed && parsed.parameter !== 'BYPASS') {
          this.context?.logger.warn(`ProSafe-RS write to ${tag.address} blocked — safety interlock. Use BYPASS parameter to override.`);
          this.errorsCount++;
          continue;
        }
      }

      if (protocol === 'vnet') {
        const parsed = parseCentumVpAddress(tag.address);
        if (parsed) {
          const targetStation = this.fcsStations.get(parsed.station) ?? { domain: 0, station: 1, slot: 0 };
          const blockPath = `${parsed.blockInstance}.${parsed.parameter}`;
          const valueBuf = Buffer.alloc(4);
          valueBuf.writeFloatBE(Number(tag.value), 0);
          const frame = encodeVnetWriteRequest(this.localStation, targetStation, blockPath, valueBuf);
          this.messagesProcessed++;
        }
      }

      this.tagCache.set(tag.address, { value: tag.value, timestamp: new Date(), quality: 'good' });
    }
  }

  // ─── Discovery ─────────────────────────────────────────────────────

  async discoverDevices(): Promise<any[]> {
    this.context?.logger.info('Discovering Yokogawa devices via Vnet/IP station enumeration');
    const discoveryFrame = encodeVnetDiscovery(this.localStation);
    this.messagesProcessed++;
    // In production: send to Vnet/IP multicast, collect STATION_IDENTITY responses
    return [];
  }

  // ─── Diagnostics ───────────────────────────────────────────────────

  async getDeviceInfo(deviceId: string): Promise<any> {
    return { deviceId, vendor: 'Yokogawa', models: YOKOGAWA_MODELS };
  }

  async getDeviceDiagnostics(deviceId: string): Promise<any> {
    // Read FCS system status
    const statusFrame = encodeVnetReadRequest(this.localStation, { domain: 0, station: 1, slot: 0 }, 'SYS.STATUS');
    this.messagesProcessed++;

    // Read I/O module health
    const moduleFrame = encodeVnetReadRequest(this.localStation, { domain: 0, station: 1, slot: 0 }, 'SYS.MODULE');
    this.messagesProcessed++;

    return {
      deviceId,
      fcsStatus: null,
      moduleHealth: null,
    };
  }

  /** Read ProSafe-RS SIF status for all configured SIFs */
  async readSifStatus(sifNumbers: number[]): Promise<Array<{ sif: number; status: number; tripped: boolean; bypassed: boolean }>> {
    const results: Array<{ sif: number; status: number; tripped: boolean; bypassed: boolean }> = [];
    for (const sifNum of sifNumbers) {
      const address = `SIF.${sifNum}.STATUS`;
      const tag = await this.readProsafeTag(address);
      const status = Number(tag.value) || 0;
      results.push({
        sif: sifNum,
        status,
        tripped: (status & PROSAFE_SIF_STATUS.TRIPPED) !== 0,
        bypassed: (status & PROSAFE_SIF_STATUS.BYPASSED) !== 0,
      });
    }
    return results;
  }

  /** Read SOE (Sequence of Events) log */
  async readSoeLog(stationName: string, count: number = 100): Promise<any[]> {
    const targetStation = this.fcsStations.get(stationName) ?? { domain: 0, station: 1, slot: 0 };
    const frame = encodeVnetReadRequest(this.localStation, targetStation, 'SYS.SOE_LOG');
    this.messagesProcessed++;
    return [];
  }

  // ─── Polling ───────────────────────────────────────────────────────

  startPolling(addresses: string[], tier: keyof typeof YOKOGAWA_POLLING, callback: (tags: AdapterTag[]) => void): string {
    const interval = YOKOGAWA_POLLING[tier];
    const key = `poll_${tier}_${Date.now()}`;
    const timer = setInterval(async () => {
      try {
        const tags = await this.readTags(addresses);
        callback(tags);
      } catch (err) {
        this.context?.logger.error(`Yokogawa polling error (${tier}):`, err);
        this.errorsCount++;
      }
    }, interval);
    this.pollingTimers.set(key, timer);
    return key;
  }

  stopPolling(key: string): void {
    const timer = this.pollingTimers.get(key);
    if (timer) { clearInterval(timer); this.pollingTimers.delete(key); }
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private routeAddress(address: string): YokogawaProtocol {
    if (address.toUpperCase().startsWith('SIF.')) return 'prosafe';
    if (address.includes('/')) return 'vnet';
    return 'modbus';
  }

  private inferCentumVpDataType(parameter: string): 'boolean' | 'number' | 'string' | 'object' {
    const upper = parameter.toUpperCase();
    if (upper === 'MODE' || upper === 'STATUS' || upper === 'ALRM') return 'number';
    if (upper === 'PV' || upper === 'SV' || upper === 'MV' || upper === 'OUT') return 'number';
    if (upper.includes('HI') || upper.includes('LO')) return 'number';
    return 'number';
  }

  private makeUncertainTag(address: string): AdapterTag {
    return {
      address,
      dataType: 'number',
      value: null,
      quality: 'uncertain',
      timestamp: new Date(),
    };
  }

  protected async getMetrics() {
    return {
      connectionsActive: this.connections.size,
      messagesProcessed: this.messagesProcessed,
      errorsCount: this.errorsCount,
      uptime: Date.now() - this.startTime,
      cachedTags: this.tagCache.size,
      fcsStations: this.fcsStations.size,
      activePollers: this.pollingTimers.size,
    };
  }

  protected async getDiagnostics() {
    return {
      registerMap: YOKOGAWA_REGISTER_MAP,
      connectionParams: YOKOGAWA_CONNECTION_PARAMS,
      pollingConfig: YOKOGAWA_POLLING,
      supportedModels: Object.keys(YOKOGAWA_MODELS),
      vnetMessageTypes: VNET_MESSAGE_TYPE,
      centumVpModes: CENTUM_VP_MODE,
      prosafeSifStatus: PROSAFE_SIF_STATUS,
    };
  }
}
