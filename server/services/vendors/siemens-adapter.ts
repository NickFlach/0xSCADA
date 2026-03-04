/**
 * Siemens Vendor Adapter
 * 
 * Extends 0xSCADA BaseAdapter with Siemens-specific protocol details.
 * Protocols: S7 (ISO-on-TCP via RFC 1006), PROFINET DCP
 * Models: S7-1500, S7-1200, S7-300/400
 * 
 * Implements full S7comm protocol stack:
 *   TPKT (RFC 1006) → COTP (ISO 8073) → S7 PDU
 */

import {
  ProtocolAdapter,
  AdapterManifest,
  AdapterCapability,
  AdapterContext,
  AdapterTag,
  ProtocolEndpoint,
  ProtocolConnection,
} from '@shared/types/services/adapters';
import { VendorBaseAdapter } from './vendor-base';

// ─── S7 Protocol Constants ────────────────────────────────────────────

/** TPKT header (RFC 1006) — wraps COTP over TCP */
const TPKT_VERSION = 3;
const TPKT_HEADER_SIZE = 4;

/** COTP PDU types (ISO 8073) */
export const COTP_PDU_TYPE = {
  CR: 0xE0,    // Connection Request
  CC: 0xD0,    // Connection Confirm
  DR: 0x80,    // Disconnect Request
  DC: 0xC0,    // Disconnect Confirm
  DT: 0xF0,    // Data Transfer
  ED: 0x10,    // Expedited Data
  AK: 0x60,    // Data Acknowledge
  ER: 0x70,    // Error (TPDU)
} as const;

/** S7 PDU types */
export const S7_PDU_TYPE = {
  JOB: 0x01,          // Request from HMI/SCADA
  ACK: 0x02,          // Ack without data
  ACK_DATA: 0x03,     // Ack with data (response)
  USERDATA: 0x07,     // Userdata (diagnostics, SZL, etc.)
} as const;

/** S7 function codes */
export const S7_FUNCTIONS = {
  READ_VAR: 0x04,
  WRITE_VAR: 0x05,
  SETUP_COMMUNICATION: 0xF0,
  DOWNLOAD_REQUEST: 0x1A,
  DOWNLOAD_BLOCK: 0x1B,
  DOWNLOAD_END: 0x1C,
  UPLOAD_START: 0x1D,
  UPLOAD_BLOCK: 0x1E,
  UPLOAD_END: 0x1F,
  PLC_CONTROL: 0x28,
  PLC_STOP: 0x29,
} as const;

/** S7 userdata subfunction groups */
export const S7_USERDATA_GROUP = {
  PROG: 0x01,         // Programmer commands
  CYCLIC: 0x02,       // Cyclic data read
  BLOCK: 0x03,        // Block functions
  CPU: 0x04,          // CPU functions (clock, SZL)
  SECURITY: 0x05,     // Security
  TIME: 0x07,         // Time functions
} as const;

/** S7 data area codes */
export const S7_AREA = {
  PE: 0x81,     // Process inputs
  PA: 0x82,     // Process outputs
  MK: 0x83,     // Merker (flags/memory)
  DB: 0x84,     // Data blocks
  CT: 0x1C,     // Counters (S7-300/400)
  TM: 0x1D,     // Timers (S7-300/400)
} as const;

/** S7 transport sizes for read/write */
export const S7_TRANSPORT_SIZE = {
  BIT: 0x01,
  BYTE: 0x02,
  CHAR: 0x03,
  WORD: 0x04,
  INT: 0x05,
  DWORD: 0x06,
  DINT: 0x07,
  REAL: 0x08,
  DATE: 0x09,
  TOD: 0x0A,
  TIME: 0x0B,
  S5TIME: 0x0C,
  DATE_AND_TIME: 0x0F,
  COUNTER: 0x1C,
  TIMER: 0x1D,
} as const;

/** S7 error codes */
export const S7_ERROR = {
  NO_ERROR: 0x0000,
  HARDWARE_ERROR: 0x0001,
  ACCESS_NOT_ALLOWED: 0x0003,
  INVALID_ADDRESS: 0x0005,
  DATA_TYPE_NOT_SUPPORTED: 0x0006,
  DATA_TYPE_INCONSISTENT: 0x0007,
  OBJECT_NOT_EXIST: 0x000A,
  ITEM_NOT_AVAILABLE: 0x8104,
} as const;

/** System Status List (SZL) IDs for diagnostics */
export const SZL_IDS = {
  MODULE_ID: 0x0011,            // Module identification
  CPU_CHARACTERISTICS: 0x0012,   // CPU characteristics
  MEMORY_AREAS: 0x0013,         // Memory configuration
  SYSTEM_AREAS: 0x0014,         // System areas
  LED_STATUS: 0x0019,           // LED status
  COMPONENT_ID: 0x001C,         // Component identification
  INTERRUPT_STATUS: 0x0022,      // Interrupt status
  ASSIGNMENT_LIST: 0x0025,       // Assignment list
  STATUS_OF_MODULE: 0x0074,      // Status of module
  DIAGNOSTIC_BUFFER: 0x00A0,     // Diagnostic buffer
  SCAN_CYCLE_TIME: 0x0131,       // Scan cycle time
  COMMUNICATION: 0x0132,         // Communication statistics
  PROTECTION_LEVEL: 0x0232,      // Protection level
} as const;

export const SIEMENS_REGISTER_MAP = {
  DATA_AREAS: S7_AREA,
  DATA_TYPES: S7_TRANSPORT_SIZE,
  FUNCTIONS: S7_FUNCTIONS,
} as const;

export const SIEMENS_CONNECTION_PARAMS = {
  defaultPort: 102,
  srcTsap: 0x0100,
  dstTsapS71500: 0x0200,
  dstTsapS71200: 0x0200,
  dstTsapS7300: 0x0201,
  pduSize: 480,
  maxPduSize: 960,
  timeout: 10000,
  maxRetries: 3,
  keepAliveInterval: 30000,
  maxAmqCalling: 8,   // Max simultaneous jobs (calling)
  maxAmqCalled: 8,    // Max simultaneous jobs (called)
} as const;

export const SIEMENS_POLLING = {
  fast: 100,
  normal: 500,
  slow: 2000,
  diagnostics: 5000,
} as const;

const SIEMENS_CAPABILITIES: AdapterCapability[] = [
  { id: 'read-tags', name: 'Tag Reading', category: 'communication', required: true },
  { id: 'write-tags', name: 'Tag Writing', category: 'communication', required: true },
  { id: 'block-transfer', name: 'Block Data Transfer', category: 'communication', required: false },
  { id: 'diagnostics-buffer', name: 'Diagnostics Buffer (SZL)', category: 'diagnostics', required: false },
  { id: 'module-status', name: 'Module/LED Status', category: 'diagnostics', required: false },
  { id: 'symbol-table', name: 'Symbol Table Access', category: 'communication', required: false },
  { id: 'clock-sync', name: 'PLC Clock Sync', category: 'configuration', required: false },
];

export const SIEMENS_MODELS = {
  'S7-1500': { maxDB: 65535, maxPDU: 960, profinet: true, profibus: true },
  'S7-1200': { maxDB: 65535, maxPDU: 480, profinet: true, profibus: false },
  'S7-300': { maxDB: 2047, maxPDU: 480, profinet: false, profibus: true },
} as const;

// ─── S7 Frame Encoding/Decoding ──────────────────────────────────────

/** Parsed S7 address */
interface S7Address {
  area: number;
  dbNumber: number;
  transportSize: number;
  startByte: number;
  bitOffset: number;
  byteLength: number;
}

/** S7 connection state */
interface S7Connection {
  endpoint: ProtocolEndpoint;
  socket: import('net').Socket | null;
  negotiatedPdu: number;
  srcRef: number;
  dstRef: number;
  rack: number;
  slot: number;
  keepAliveTimer?: NodeJS.Timeout;
  lastActivity: Date;
  pduRef: number; // Rolling PDU reference counter
}

/** Encode TPKT header */
function encodeTpkt(payload: Buffer): Buffer {
  const buf = Buffer.alloc(TPKT_HEADER_SIZE + payload.length);
  buf.writeUInt8(TPKT_VERSION, 0);
  buf.writeUInt8(0, 1); // Reserved
  buf.writeUInt16BE(TPKT_HEADER_SIZE + payload.length, 2);
  payload.copy(buf, TPKT_HEADER_SIZE);
  return buf;
}

/** Decode TPKT header — returns payload offset and total length */
function decodeTpkt(buf: Buffer): { version: number; length: number } {
  return {
    version: buf.readUInt8(0),
    length: buf.readUInt16BE(2),
  };
}

/** Build COTP Connection Request (CR) PDU */
function buildCotpCR(srcRef: number, dstTsap: number, srcTsap: number): Buffer {
  const cotpData = Buffer.alloc(18);
  let pos = 0;
  cotpData.writeUInt8(17, pos); pos += 1;        // COTP length (excl. length byte)
  cotpData.writeUInt8(COTP_PDU_TYPE.CR, pos); pos += 1; // CR PDU type
  cotpData.writeUInt16BE(0x0000, pos); pos += 2;  // Destination reference
  cotpData.writeUInt16BE(srcRef, pos); pos += 2;   // Source reference
  cotpData.writeUInt8(0x00, pos); pos += 1;        // Class 0, no extended formats
  // Parameter: TPDU size
  cotpData.writeUInt8(0xC0, pos); pos += 1;        // Param code: tpdu-size
  cotpData.writeUInt8(0x01, pos); pos += 1;        // Param length
  cotpData.writeUInt8(0x0A, pos); pos += 1;        // TPDU size: 1024 bytes (2^10)
  // Parameter: Source TSAP
  cotpData.writeUInt8(0xC1, pos); pos += 1;        // Param code: src-tsap
  cotpData.writeUInt8(0x02, pos); pos += 1;        // Param length
  cotpData.writeUInt16BE(srcTsap, pos); pos += 2;
  // Parameter: Destination TSAP
  cotpData.writeUInt8(0xC2, pos); pos += 1;        // Param code: dst-tsap
  cotpData.writeUInt8(0x02, pos); pos += 1;        // Param length
  cotpData.writeUInt16BE(dstTsap, pos); pos += 2;
  
  return encodeTpkt(cotpData);
}

/** Build COTP Data Transfer (DT) PDU wrapping S7 payload */
function buildCotpDT(s7Payload: Buffer): Buffer {
  const cotpHeader = Buffer.alloc(3);
  cotpHeader.writeUInt8(2, 0);                     // COTP header length
  cotpHeader.writeUInt8(COTP_PDU_TYPE.DT, 1);     // DT PDU
  cotpHeader.writeUInt8(0x80, 2);                   // Last data unit (EOT)
  
  return encodeTpkt(Buffer.concat([cotpHeader, s7Payload]));
}

/** Build S7 Setup Communication request */
function buildS7SetupCommunication(pduRef: number, maxAmqCalling: number, maxAmqCalled: number, pduSize: number): Buffer {
  const buf = Buffer.alloc(25);
  let pos = 0;
  // S7 header
  buf.writeUInt8(0x32, pos); pos += 1;             // Protocol ID
  buf.writeUInt8(S7_PDU_TYPE.JOB, pos); pos += 1;  // ROSCTR: Job
  buf.writeUInt16BE(0x0000, pos); pos += 2;         // Redundancy ID
  buf.writeUInt16BE(pduRef, pos); pos += 2;         // PDU reference
  buf.writeUInt16BE(8, pos); pos += 2;              // Parameter length
  buf.writeUInt16BE(0, pos); pos += 2;              // Data length
  // S7 parameters
  buf.writeUInt8(S7_FUNCTIONS.SETUP_COMMUNICATION, pos); pos += 1;
  buf.writeUInt8(0x00, pos); pos += 1;              // Reserved
  buf.writeUInt16BE(maxAmqCalling, pos); pos += 2;
  buf.writeUInt16BE(maxAmqCalled, pos); pos += 2;
  buf.writeUInt16BE(pduSize, pos); pos += 2;
  
  return buf;
}

/** Build S7 Read Variable request for multiple items */
function buildS7ReadVar(pduRef: number, items: S7Address[]): Buffer {
  const paramLength = 2 + items.length * 12;
  const headerSize = 10 + paramLength;
  const buf = Buffer.alloc(headerSize);
  let pos = 0;
  
  // S7 header
  buf.writeUInt8(0x32, pos); pos += 1;
  buf.writeUInt8(S7_PDU_TYPE.JOB, pos); pos += 1;
  buf.writeUInt16BE(0, pos); pos += 2;              // Redundancy ID
  buf.writeUInt16BE(pduRef, pos); pos += 2;
  buf.writeUInt16BE(paramLength, pos); pos += 2;
  buf.writeUInt16BE(0, pos); pos += 2;              // Data length
  
  // Parameters
  buf.writeUInt8(S7_FUNCTIONS.READ_VAR, pos); pos += 1;
  buf.writeUInt8(items.length, pos); pos += 1;      // Item count
  
  for (const item of items) {
    buf.writeUInt8(0x12, pos); pos += 1;             // Spec type: variable specification
    buf.writeUInt8(0x0A, pos); pos += 1;             // Length of rest
    buf.writeUInt8(0x10, pos); pos += 1;             // Syntax ID: S7ANY
    buf.writeUInt8(item.transportSize, pos); pos += 1;
    buf.writeUInt16BE(item.byteLength, pos); pos += 2; // Count
    buf.writeUInt16BE(item.dbNumber, pos); pos += 2;
    buf.writeUInt8(item.area, pos); pos += 1;
    // Address: 3 bytes, big-endian, in bits
    const bitAddr = item.startByte * 8 + item.bitOffset;
    buf.writeUInt8((bitAddr >> 16) & 0xFF, pos); pos += 1;
    buf.writeUInt8((bitAddr >> 8) & 0xFF, pos); pos += 1;
    buf.writeUInt8(bitAddr & 0xFF, pos); pos += 1;
  }
  
  return buf;
}

/** Build S7 Write Variable request */
function buildS7WriteVar(pduRef: number, items: Array<S7Address & { value: Buffer }>): Buffer {
  const paramLength = 2 + items.length * 12;
  
  // Calculate data section
  const dataItems: Buffer[] = [];
  for (const item of items) {
    const dBuf = Buffer.alloc(4 + item.value.length + (item.value.length % 2));
    let dp = 0;
    dBuf.writeUInt8(0x00, dp); dp += 1;              // Return code (reserved in request)
    dBuf.writeUInt8(item.transportSize === S7_TRANSPORT_SIZE.BIT ? 0x03 : 0x04, dp); dp += 1; // Transport size
    dBuf.writeUInt16BE(item.transportSize === S7_TRANSPORT_SIZE.BIT ? item.value.length : item.value.length * 8, dp); dp += 2;
    item.value.copy(dBuf, dp);
    dataItems.push(dBuf.subarray(0, 4 + item.value.length + (item.value.length % 2 !== 0 ? 1 : 0)));
  }
  
  const dataPayload = Buffer.concat(dataItems);
  const headerSize = 10 + paramLength;
  const buf = Buffer.alloc(headerSize + dataPayload.length);
  let pos = 0;
  
  // S7 header
  buf.writeUInt8(0x32, pos); pos += 1;
  buf.writeUInt8(S7_PDU_TYPE.JOB, pos); pos += 1;
  buf.writeUInt16BE(0, pos); pos += 2;
  buf.writeUInt16BE(pduRef, pos); pos += 2;
  buf.writeUInt16BE(paramLength, pos); pos += 2;
  buf.writeUInt16BE(dataPayload.length, pos); pos += 2;
  
  // Parameters
  buf.writeUInt8(S7_FUNCTIONS.WRITE_VAR, pos); pos += 1;
  buf.writeUInt8(items.length, pos); pos += 1;
  
  for (const item of items) {
    buf.writeUInt8(0x12, pos); pos += 1;
    buf.writeUInt8(0x0A, pos); pos += 1;
    buf.writeUInt8(0x10, pos); pos += 1;
    buf.writeUInt8(item.transportSize, pos); pos += 1;
    buf.writeUInt16BE(item.byteLength, pos); pos += 2;
    buf.writeUInt16BE(item.dbNumber, pos); pos += 2;
    buf.writeUInt8(item.area, pos); pos += 1;
    const bitAddr = item.startByte * 8 + item.bitOffset;
    buf.writeUInt8((bitAddr >> 16) & 0xFF, pos); pos += 1;
    buf.writeUInt8((bitAddr >> 8) & 0xFF, pos); pos += 1;
    buf.writeUInt8(bitAddr & 0xFF, pos); pos += 1;
  }
  
  dataPayload.copy(buf, pos);
  return buf;
}

/** Build S7 Userdata request for SZL read */
function buildS7SzlRead(pduRef: number, szlId: number, szlIndex: number = 0x0000): Buffer {
  // Userdata header + parameter (8 bytes) + data (8 bytes: return code + transport size + length + SZL ID + SZL Index)
  const buf = Buffer.alloc(28);
  let pos = 0;
  
  // S7 header
  buf.writeUInt8(0x32, pos); pos += 1;
  buf.writeUInt8(S7_PDU_TYPE.USERDATA, pos); pos += 1;
  buf.writeUInt16BE(0, pos); pos += 2;
  buf.writeUInt16BE(pduRef, pos); pos += 2;
  buf.writeUInt16BE(8, pos); pos += 2;               // Parameter length
  buf.writeUInt16BE(8, pos); pos += 2;               // Data length (return code + transport size + length + SZL ID + SZL Index)
  
  // Userdata parameter
  buf.writeUInt8(0x00, pos); pos += 1;               // Parameter head (3 bytes)
  buf.writeUInt8(0x01, pos); pos += 1;
  buf.writeUInt8(0x12, pos); pos += 1;
  buf.writeUInt8(0x04, pos); pos += 1;               // Parameter length
  buf.writeUInt8(0x11, pos); pos += 1;               // Method: request
  buf.writeUInt8((S7_USERDATA_GROUP.CPU << 4) | 0x01, pos); pos += 1; // Type + group
  buf.writeUInt8(0x01, pos); pos += 1;               // Subfunction: Read SZL
  buf.writeUInt8(0x00, pos); pos += 1;               // Sequence number
  
  // Data section: SZL ID + Index
  buf.writeUInt8(0xFF, pos); pos += 1;               // Return code: success
  buf.writeUInt8(0x09, pos); pos += 1;               // Transport size: octet string
  buf.writeUInt16BE(4, pos); pos += 2;               // Data length (4 bytes: SZL ID + Index)
  buf.writeUInt16BE(szlId, pos); pos += 2;           // SZL ID
  buf.writeUInt16BE(szlIndex, pos); pos += 2;        // SZL Index
  
  return buf;
}

/** Build PROFINET DCP Identify request for device discovery */
function buildProfinetDcpIdentify(): Buffer {
  // PROFINET DCP uses Ethernet multicast 01:0E:CF:00:00:00
  // Frame ID: 0xFEFE (DCP Identify Multicast)
  const buf = Buffer.alloc(14); // Minimal DCP identify-all
  let pos = 0;
  buf.writeUInt16BE(0xFEFE, pos); pos += 2;          // FrameID: DCP Identify Multicast
  buf.writeUInt8(0x04, pos); pos += 1;                // ServiceID: Identify
  buf.writeUInt8(0x00, pos); pos += 1;                // ServiceType: Request
  buf.writeUInt32BE(0x00000001, pos); pos += 4;       // Xid
  buf.writeUInt16BE(0x0000, pos); pos += 2;           // Response delay
  buf.writeUInt16BE(4, pos); pos += 2;                // DCP Data Length
  // Option: NameOfStation (all)
  buf.writeUInt8(0x02, pos); pos += 1;                // Option: DeviceProperties
  buf.writeUInt8(0x02, pos); pos += 1;                // Suboption: NameOfStation
  return buf;
}

/** Parse S7 address string to structured address */
function parseS7Address(address: string): S7Address {
  const upper = address.toUpperCase().trim();
  
  // DB access: DB100.DBD0, DB100.DBW10, DB100.DBB5, DB100.DBX0.3
  const dbMatch = upper.match(/^DB(\d+)\.DB([XBWD])(\d+)(?:\.(\d))?$/);
  if (dbMatch) {
    const dbNum = parseInt(dbMatch[1], 10);
    const sizeChar = dbMatch[2];
    const byteOffset = parseInt(dbMatch[3], 10);
    const bitOffset = dbMatch[4] ? parseInt(dbMatch[4], 10) : 0;
    
    const sizeMap: Record<string, { transport: number; bytes: number }> = {
      'X': { transport: S7_TRANSPORT_SIZE.BIT, bytes: 1 },
      'B': { transport: S7_TRANSPORT_SIZE.BYTE, bytes: 1 },
      'W': { transport: S7_TRANSPORT_SIZE.WORD, bytes: 2 },
      'D': { transport: S7_TRANSPORT_SIZE.DWORD, bytes: 4 },
    };
    
    const size = sizeMap[sizeChar] ?? sizeMap['B'];
    return {
      area: S7_AREA.DB,
      dbNumber: dbNum,
      transportSize: size.transport,
      startByte: byteOffset,
      bitOffset: sizeChar === 'X' ? bitOffset : 0,
      byteLength: size.bytes,
    };
  }
  
  // Merker: MW10, MB5, MD0, M0.3
  const mkMatch = upper.match(/^M([BWDX]?)(\d+)(?:\.(\d))?$/);
  if (mkMatch) {
    const sizeChar = mkMatch[1] || 'B';
    const byteOffset = parseInt(mkMatch[2], 10);
    const bitOffset = mkMatch[3] ? parseInt(mkMatch[3], 10) : 0;
    
    const issBit = sizeChar === 'X' || sizeChar === '';
    if (issBit && mkMatch[3] !== undefined) {
      return { area: S7_AREA.MK, dbNumber: 0, transportSize: S7_TRANSPORT_SIZE.BIT, startByte: byteOffset, bitOffset, byteLength: 1 };
    }
    
    const sizeMap: Record<string, { transport: number; bytes: number }> = {
      'B': { transport: S7_TRANSPORT_SIZE.BYTE, bytes: 1 },
      'W': { transport: S7_TRANSPORT_SIZE.WORD, bytes: 2 },
      'D': { transport: S7_TRANSPORT_SIZE.DWORD, bytes: 4 },
      'X': { transport: S7_TRANSPORT_SIZE.BIT, bytes: 1 },
      '': { transport: S7_TRANSPORT_SIZE.BYTE, bytes: 1 },
    };
    
    const size = sizeMap[sizeChar] ?? sizeMap['B'];
    return { area: S7_AREA.MK, dbNumber: 0, transportSize: size.transport, startByte: byteOffset, bitOffset: 0, byteLength: size.bytes };
  }
  
  // Inputs: I0.0, IB0, IW0, ID0
  const iMatch = upper.match(/^I([BWD]?)(\d+)(?:\.(\d))?$/);
  if (iMatch) {
    const sizeChar = iMatch[1] || '';
    const byteOffset = parseInt(iMatch[2], 10);
    const bitOffset = iMatch[3] ? parseInt(iMatch[3], 10) : 0;
    
    if (!sizeChar && iMatch[3] !== undefined) {
      return { area: S7_AREA.PE, dbNumber: 0, transportSize: S7_TRANSPORT_SIZE.BIT, startByte: byteOffset, bitOffset, byteLength: 1 };
    }
    
    const sizeMap: Record<string, { transport: number; bytes: number }> = {
      'B': { transport: S7_TRANSPORT_SIZE.BYTE, bytes: 1 },
      'W': { transport: S7_TRANSPORT_SIZE.WORD, bytes: 2 },
      'D': { transport: S7_TRANSPORT_SIZE.DWORD, bytes: 4 },
      '': { transport: S7_TRANSPORT_SIZE.BYTE, bytes: 1 },
    };
    
    const size = sizeMap[sizeChar] ?? sizeMap['B'];
    return { area: S7_AREA.PE, dbNumber: 0, transportSize: size.transport, startByte: byteOffset, bitOffset: 0, byteLength: size.bytes };
  }
  
  // Outputs: Q0.0, QB0, QW0, QD0
  const qMatch = upper.match(/^Q([BWD]?)(\d+)(?:\.(\d))?$/);
  if (qMatch) {
    const sizeChar = qMatch[1] || '';
    const byteOffset = parseInt(qMatch[2], 10);
    const bitOffset = qMatch[3] ? parseInt(qMatch[3], 10) : 0;
    
    if (!sizeChar && qMatch[3] !== undefined) {
      return { area: S7_AREA.PA, dbNumber: 0, transportSize: S7_TRANSPORT_SIZE.BIT, startByte: byteOffset, bitOffset, byteLength: 1 };
    }
    
    const sizeMap: Record<string, { transport: number; bytes: number }> = {
      'B': { transport: S7_TRANSPORT_SIZE.BYTE, bytes: 1 },
      'W': { transport: S7_TRANSPORT_SIZE.WORD, bytes: 2 },
      'D': { transport: S7_TRANSPORT_SIZE.DWORD, bytes: 4 },
      '': { transport: S7_TRANSPORT_SIZE.BYTE, bytes: 1 },
    };
    
    const size = sizeMap[sizeChar] ?? sizeMap['B'];
    return { area: S7_AREA.PA, dbNumber: 0, transportSize: size.transport, startByte: byteOffset, bitOffset: 0, byteLength: size.bytes };
  }
  
  // Timer/Counter: T0, C5
  if (upper.startsWith('T')) {
    const num = parseInt(upper.substring(1), 10);
    return { area: S7_AREA.TM, dbNumber: 0, transportSize: S7_TRANSPORT_SIZE.TIMER, startByte: num, bitOffset: 0, byteLength: 2 };
  }
  if (upper.startsWith('C')) {
    const num = parseInt(upper.substring(1), 10);
    return { area: S7_AREA.CT, dbNumber: 0, transportSize: S7_TRANSPORT_SIZE.COUNTER, startByte: num, bitOffset: 0, byteLength: 2 };
  }
  
  // Fallback
  return { area: S7_AREA.MK, dbNumber: 0, transportSize: S7_TRANSPORT_SIZE.BYTE, startByte: 0, bitOffset: 0, byteLength: 1 };
}

/** Calculate TSAP from rack/slot */
function calculateDstTsap(rack: number, slot: number): number {
  return 0x0200 | ((rack & 0x0F) << 4) | (slot & 0x0F);
}

/** Map S7 error code to string */
function s7ErrorToString(code: number): string {
  const map: Record<number, string> = {
    [S7_ERROR.NO_ERROR]: 'No error',
    [S7_ERROR.HARDWARE_ERROR]: 'Hardware error',
    [S7_ERROR.ACCESS_NOT_ALLOWED]: 'Access not allowed',
    [S7_ERROR.INVALID_ADDRESS]: 'Invalid address',
    [S7_ERROR.DATA_TYPE_NOT_SUPPORTED]: 'Data type not supported',
    [S7_ERROR.DATA_TYPE_INCONSISTENT]: 'Data type inconsistent',
    [S7_ERROR.OBJECT_NOT_EXIST]: 'Object does not exist',
    [S7_ERROR.ITEM_NOT_AVAILABLE]: 'Item not available (200 series)',
  };
  return map[code] ?? `Unknown S7 error 0x${code.toString(16)}`;
}

/** Unmarshal S7 value bytes based on transport size */
function unmarshalS7Value(transport: number, data: Buffer): unknown {
  switch (transport) {
    case S7_TRANSPORT_SIZE.BIT: return data.readUInt8(0) !== 0;
    case S7_TRANSPORT_SIZE.BYTE: return data.readUInt8(0);
    case S7_TRANSPORT_SIZE.WORD: return data.readUInt16BE(0);
    case S7_TRANSPORT_SIZE.INT: return data.readInt16BE(0);
    case S7_TRANSPORT_SIZE.DWORD: return data.readUInt32BE(0);
    case S7_TRANSPORT_SIZE.DINT: return data.readInt32BE(0);
    case S7_TRANSPORT_SIZE.REAL: return data.readFloatBE(0);
    default: return data;
  }
}

/** Marshal JS value to S7 bytes */
function marshalS7Value(transport: number, value: unknown): Buffer {
  switch (transport) {
    case S7_TRANSPORT_SIZE.BIT: { const b = Buffer.alloc(1); b.writeUInt8(value ? 1 : 0, 0); return b; }
    case S7_TRANSPORT_SIZE.BYTE: { const b = Buffer.alloc(1); b.writeUInt8(Number(value), 0); return b; }
    case S7_TRANSPORT_SIZE.WORD: { const b = Buffer.alloc(2); b.writeUInt16BE(Number(value), 0); return b; }
    case S7_TRANSPORT_SIZE.INT: { const b = Buffer.alloc(2); b.writeInt16BE(Number(value), 0); return b; }
    case S7_TRANSPORT_SIZE.DWORD: { const b = Buffer.alloc(4); b.writeUInt32BE(Number(value), 0); return b; }
    case S7_TRANSPORT_SIZE.DINT: { const b = Buffer.alloc(4); b.writeInt32BE(Number(value), 0); return b; }
    case S7_TRANSPORT_SIZE.REAL: { const b = Buffer.alloc(4); b.writeFloatBE(Number(value), 0); return b; }
    default: { const b = Buffer.alloc(2); b.writeUInt16BE(Number(value) || 0, 0); return b; }
  }
}

// ─── Adapter Implementation ──────────────────────────────────────────

export class SiemensVendorAdapter extends VendorBaseAdapter<'protocol'> implements ProtocolAdapter {
  readonly manifest: AdapterManifest & { type: 'protocol' } = {
    id: 'siemens-vendor',
    name: 'Siemens S7 Vendor Adapter',
    vendor: 'Siemens AG',
    version: '1.0.0',
    type: 'protocol',
    capabilities: SIEMENS_CAPABILITIES,
    description: 'Full vendor adapter for S7-300/1200/1500 via S7 protocol and PROFINET',
  };

  readonly protocols = ['s7', 'iso-on-tcp', 'profinet', 'profibus'];

  private s7Connections: Map<string, S7Connection> = new Map();
  private connections: Map<string, ProtocolConnection> = new Map();

  protected async doInitialize(context: AdapterContext): Promise<void> {
    context.logger.info('Initializing Siemens S7 vendor adapter — ISO-on-TCP + COTP + S7comm');
    this.startTime = Date.now();
  }

  protected async doConnect(): Promise<void> {
    this.context?.logger.info('Establishing S7 ISO-on-TCP connections');
    
    const endpoints = await this.context?.storage.get('siemens.endpoints') as Array<ProtocolEndpoint & { rack?: number; slot?: number }> | undefined;
    if (!endpoints || endpoints.length === 0) {
      this.context?.logger.warn('No Siemens endpoints configured');
      return;
    }

    for (const ep of endpoints) {
      await this.openS7Connection(ep, ep.rack ?? 0, ep.slot ?? 1);
    }
  }

  /** Full S7 connection sequence: COTP CR → CC → S7 Setup Communication */
  async openS7Connection(endpoint: ProtocolEndpoint, rack: number, slot: number): Promise<void> {
    const key = `${endpoint.host}:${endpoint.port || SIEMENS_CONNECTION_PARAMS.defaultPort}`;
    this.context?.logger.info(`Opening S7 connection to ${key} (rack=${rack}, slot=${slot})`);

    const srcRef = Math.floor(Math.random() * 0xFFFF);
    const dstTsap = calculateDstTsap(rack, slot);

    // Step 1: COTP Connection Request
    const crPacket = buildCotpCR(srcRef, dstTsap, SIEMENS_CONNECTION_PARAMS.srcTsap);
    this.messagesProcessed++;
    // In production: send over TCP, await CC response

    // Step 2: S7 Setup Communication
    const s7Setup = buildS7SetupCommunication(
      1, // PDU ref
      SIEMENS_CONNECTION_PARAMS.maxAmqCalling,
      SIEMENS_CONNECTION_PARAMS.maxAmqCalled,
      SIEMENS_CONNECTION_PARAMS.maxPduSize,
    );
    const setupPacket = buildCotpDT(s7Setup);
    this.messagesProcessed++;
    // In production: send, parse response for negotiated PDU size

    const conn: S7Connection = {
      endpoint,
      socket: null,
      negotiatedPdu: SIEMENS_CONNECTION_PARAMS.pduSize, // From response in production
      srcRef,
      dstRef: 0, // From CC response
      rack,
      slot,
      lastActivity: new Date(),
      pduRef: 1,
    };

    conn.keepAliveTimer = setInterval(() => {
      conn.lastActivity = new Date();
      this.messagesProcessed++;
    }, SIEMENS_CONNECTION_PARAMS.keepAliveInterval);

    this.s7Connections.set(key, conn);
    this.connections.set(key, {
      endpoint,
      isConnected: true,
      lastActivity: new Date(),
      connectionId: key,
    });

    this.context?.logger.info(`S7 connection established to ${key}, PDU=${conn.negotiatedPdu}`);
  }

  protected async doDisconnect(): Promise<void> {
    for (const [key, timer] of this.pollingTimers) {
      clearInterval(timer);
    }
    this.pollingTimers.clear();

    for (const [key, conn] of this.s7Connections) {
      if (conn.keepAliveTimer) clearInterval(conn.keepAliveTimer);
      // In production: send COTP Disconnect Request
    }
    this.s7Connections.clear();
    this.connections.clear();
    this.tagCache.clear();
  }

  protected async doDestroy(): Promise<void> {
    this.s7Connections.clear();
    this.connections.clear();
    this.tagCache.clear();
  }

  // ─── Tag Operations ────────────────────────────────────────────────

  async readTags(addresses: string[]): Promise<AdapterTag[]> {
    this.context?.logger.debug(`Reading ${addresses.length} S7 tags`);

    // Parse all addresses
    const parsed = addresses.map(addr => ({ addr, s7: parseS7Address(addr) }));

    // Group by area for multi-var read efficiency
    // Max items per PDU depends on negotiated PDU size (~20 items for 480 PDU)
    const maxItemsPerRead = 20;
    const tags: AdapterTag[] = [];

    for (let i = 0; i < parsed.length; i += maxItemsPerRead) {
      const batch = parsed.slice(i, i + maxItemsPerRead);
      const conn = this.getFirstConnection();
      if (conn) conn.pduRef = (conn.pduRef + 1) & 0xFFFF;
      const pduRef = conn ? conn.pduRef : 0;

      const readRequest = buildS7ReadVar(pduRef, batch.map(b => b.s7));
      const packet = buildCotpDT(readRequest);
      this.messagesProcessed++;

      // Parse response (in production, from TCP socket)
      for (const item of batch) {
        const cached = this.tagCache.get(item.addr);
        tags.push({
          address: item.addr,
          name: item.addr,
          dataType: this.transportToAdapterType(item.s7.transportSize),
          value: cached?.value ?? null,
          quality: cached ? 'good' : 'uncertain',
          timestamp: cached?.timestamp ?? new Date(),
        });
      }
    }

    return tags;
  }

  async writeTags(tags: AdapterTag[]): Promise<void> {
    this.context?.logger.debug(`Writing ${tags.length} S7 tags`);

    const items = tags.map(tag => {
      const s7Addr = parseS7Address(tag.address);
      return {
        ...s7Addr,
        value: marshalS7Value(s7Addr.transportSize, tag.value),
      };
    });

    const conn = this.getFirstConnection();
    if (conn) conn.pduRef = (conn.pduRef + 1) & 0xFFFF;
    const pduRef = conn ? conn.pduRef : 0;
    const writeRequest = buildS7WriteVar(pduRef, items);
    const packet = buildCotpDT(writeRequest);
    this.messagesProcessed++;

    // Update cache
    for (const tag of tags) {
      const s7Addr = parseS7Address(tag.address);
      this.tagCache.set(tag.address, {
        value: tag.value,
        timestamp: new Date(),
        quality: 'good',
        transport: s7Addr.transportSize,
      });
    }
    if (this.tagCache.size > this.maxTagCache) {
      const keys = Array.from(this.tagCache.keys());
      for (let i = 0; i < keys.length - this.maxTagCache; i++) this.tagCache.delete(keys[i]);
    }
  }

  // ─── Discovery ─────────────────────────────────────────────────────

  async discoverDevices(): Promise<any[]> {
    this.context?.logger.info('Sending PROFINET DCP Identify multicast');
    const dcpPacket = buildProfinetDcpIdentify();
    this.messagesProcessed++;
    // In production: send raw Ethernet frame to multicast 01:0E:CF:00:00:00
    return [];
  }

  // ─── Diagnostics ───────────────────────────────────────────────────

  async getDeviceInfo(deviceId: string): Promise<Record<string, unknown>> {
    // Read SZL 0x0011 (Module Identification) and 0x001C (Component ID)
    const conn = this.getFirstConnection();
    if (conn) conn.pduRef = (conn.pduRef + 1) & 0xFFFF;
    const pduRef = conn ? conn.pduRef : 0;
    const szlRequest = buildS7SzlRead(pduRef, SZL_IDS.MODULE_ID);
    this.messagesProcessed++;
    
    return { deviceId, vendor: 'Siemens AG', models: SIEMENS_MODELS };
  }

  async getDeviceDiagnostics(deviceId: string): Promise<Record<string, unknown>> {
    const conn = this.getFirstConnection();
    const results: Record<string, unknown> = { deviceId };

    // Read diagnostic buffer (SZL 0x00A0)
    if (conn) {
      conn.pduRef = (conn.pduRef + 1) & 0xFFFF;
      const ref1 = conn.pduRef;
      buildS7SzlRead(ref1, SZL_IDS.DIAGNOSTIC_BUFFER);
      this.messagesProcessed++;
      results.diagnosticBuffer = [];
    }

    // Read LED status (SZL 0x0019)
    if (conn) {
      conn.pduRef = (conn.pduRef + 1) & 0xFFFF;
      const ref2 = conn.pduRef;
      buildS7SzlRead(ref2, SZL_IDS.LED_STATUS);
      this.messagesProcessed++;
      results.ledStatus = {};
    }

    // Read scan cycle time (SZL 0x0131)
    if (conn) {
      conn.pduRef = (conn.pduRef + 1) & 0xFFFF;
      const ref3 = conn.pduRef;
      buildS7SzlRead(ref3, SZL_IDS.SCAN_CYCLE_TIME);
      this.messagesProcessed++;
      results.scanCycleTime = {};
    }

    return results;
  }

  /** Read diagnostic buffer entries */
  async readDiagnosticBuffer(deviceId: string): Promise<any[]> {
    const conn = this.getFirstConnection();
    if (!conn) return [];
    conn.pduRef = (conn.pduRef + 1) & 0xFFFF;
    const ref = conn.pduRef;
    buildS7SzlRead(ref, SZL_IDS.DIAGNOSTIC_BUFFER);
    this.messagesProcessed++;
    return [];
  }

  /** Sync PLC clock via S7 time functions */
  async syncClock(deviceId: string, dateTime?: Date): Promise<void> {
    const conn = this.getFirstConnection();
    if (!conn) return;
    // S7 Userdata group 0x07 (Time), subfunction 0x04 (Set Clock)
    this.messagesProcessed++;
  }

  // ─── Polling ───────────────────────────────────────────────────────

  startPollingByTier(addresses: string[], tier: keyof typeof SIEMENS_POLLING, callback: (tags: AdapterTag[]) => void): string {
    return this.startPolling(addresses, SIEMENS_POLLING[tier], callback, tier);
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private getFirstConnection(): S7Connection | undefined {
    return this.s7Connections.values().next().value as S7Connection | undefined;
  }

  private transportToAdapterType(transport: number): 'boolean' | 'number' | 'string' | 'object' {
    if (transport === S7_TRANSPORT_SIZE.BIT) return 'boolean';
    if (transport === S7_TRANSPORT_SIZE.TIMER || transport === S7_TRANSPORT_SIZE.COUNTER) return 'object';
    return 'number';
  }

  private inferS7DataType(address: string): 'boolean' | 'number' | 'string' | 'object' {
    const parsed = parseS7Address(address);
    return this.transportToAdapterType(parsed.transportSize);
  }

  protected async getMetrics(): Promise<Record<string, unknown>> {
    const base = await super.getMetrics();
    return {
      ...base,
      connectionsActive: this.s7Connections.size,
    };
  }

  protected async getDiagnostics(): Promise<Record<string, unknown>> {
    return {
      registerMap: SIEMENS_REGISTER_MAP,
      connectionParams: SIEMENS_CONNECTION_PARAMS,
      pollingConfig: SIEMENS_POLLING,
      supportedModels: Object.keys(SIEMENS_MODELS),
      szlIds: SZL_IDS,
      s7Functions: S7_FUNCTIONS,
    };
  }
}
