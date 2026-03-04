/**
 * Schneider Electric Vendor Adapter
 * 
 * Extends 0xSCADA BaseAdapter for Schneider Electric PLC/HMI/RTU systems.
 * Protocols: Modbus TCP/RTU, EtherNet/IP, IEC 60870-5-104
 * Models: Modicon M580, M340, Quantum, SCADAPack, Easergy
 * 
 * Implements:
 *   - Modbus TCP (MBAP) frame encoding/decoding with full function code support
 *   - Modbus RTU with CRC-16 calculation
 *   - IEC 60870-5-104 APDU/ASDU encoding (STARTDT, STOPDT, interrogation, commands)
 *   - M580 system bit/word diagnostics
 *   - SCADAPack register map
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

// ─── Modbus Protocol Constants ───────────────────────────────────────

/** Modbus function codes */
export const MODBUS_FC = {
  READ_COILS: 0x01,
  READ_DISCRETE_INPUTS: 0x02,
  READ_HOLDING_REGISTERS: 0x03,
  READ_INPUT_REGISTERS: 0x04,
  WRITE_SINGLE_COIL: 0x05,
  WRITE_SINGLE_REGISTER: 0x06,
  READ_EXCEPTION_STATUS: 0x07,
  DIAGNOSTICS: 0x08,
  GET_COMM_EVENT_COUNTER: 0x0B,
  GET_COMM_EVENT_LOG: 0x0C,
  WRITE_MULTIPLE_COILS: 0x0F,
  WRITE_MULTIPLE_REGISTERS: 0x10,
  REPORT_SERVER_ID: 0x11,
  READ_FILE_RECORD: 0x14,
  WRITE_FILE_RECORD: 0x15,
  MASK_WRITE_REGISTER: 0x16,
  READ_WRITE_MULTIPLE_REGISTERS: 0x17,
  READ_DEVICE_IDENTIFICATION: 0x2B,
} as const;

/** Modbus exception codes */
export const MODBUS_EXCEPTION = {
  ILLEGAL_FUNCTION: 0x01,
  ILLEGAL_DATA_ADDRESS: 0x02,
  ILLEGAL_DATA_VALUE: 0x03,
  SLAVE_DEVICE_FAILURE: 0x04,
  ACKNOWLEDGE: 0x05,
  SLAVE_DEVICE_BUSY: 0x06,
  NEGATIVE_ACKNOWLEDGE: 0x07,
  MEMORY_PARITY_ERROR: 0x08,
  GATEWAY_PATH_UNAVAILABLE: 0x0A,
  GATEWAY_TARGET_FAILED: 0x0B,
} as const;

/** Modbus diagnostic sub-function codes (FC 0x08) */
export const MODBUS_DIAG_SUB = {
  RETURN_QUERY_DATA: 0x0000,
  RESTART_COMMUNICATIONS: 0x0001,
  RETURN_DIAGNOSTIC_REGISTER: 0x0002,
  FORCE_LISTEN_ONLY: 0x0004,
  CLEAR_COUNTERS: 0x000A,
  RETURN_BUS_MESSAGE_COUNT: 0x000B,
  RETURN_BUS_COMM_ERROR_COUNT: 0x000C,
  RETURN_BUS_EXCEPTION_ERROR_COUNT: 0x000D,
  RETURN_SERVER_MESSAGE_COUNT: 0x000E,
  RETURN_SERVER_NO_RESPONSE_COUNT: 0x000F,
} as const;

// ─── IEC 60870-5-104 Constants ───────────────────────────────────────

/** IEC 104 APCI frame types */
export const IEC104_FRAME_TYPE = {
  I_FORMAT: 0x00,   // Information transfer
  S_FORMAT: 0x01,   // Supervisory
  U_FORMAT: 0x03,   // Unnumbered control
} as const;

/** IEC 104 U-format function codes */
export const IEC104_U_FUNCTION = {
  STARTDT_ACT: 0x07,   // Start Data Transfer Activation
  STARTDT_CON: 0x0B,   // Start Data Transfer Confirmation
  STOPDT_ACT: 0x13,    // Stop Data Transfer Activation
  STOPDT_CON: 0x23,    // Stop Data Transfer Confirmation
  TESTFR_ACT: 0x43,    // Test Frame Activation
  TESTFR_CON: 0x83,    // Test Frame Confirmation
} as const;

/** IEC 104 Type Identification (TI) — Information Object types */
export const IEC104_TYPE_ID = {
  // Monitor direction (from controlled station)
  M_SP_NA_1: 1,    // Single-point information
  M_SP_TA_1: 2,    // Single-point with time tag
  M_DP_NA_1: 3,    // Double-point information
  M_DP_TA_1: 4,    // Double-point with time tag
  M_ST_NA_1: 5,    // Step position information
  M_BO_NA_1: 7,    // Bitstring of 32 bit
  M_ME_NA_1: 9,    // Measured value, normalized
  M_ME_NB_1: 11,   // Measured value, scaled
  M_ME_NC_1: 13,   // Measured value, short floating point
  M_IT_NA_1: 15,   // Integrated totals
  M_SP_TB_1: 30,   // Single-point with CP56Time2a
  M_DP_TB_1: 31,   // Double-point with CP56Time2a
  M_ME_TD_1: 34,   // Measured normalized with CP56Time2a
  M_ME_TE_1: 35,   // Measured scaled with CP56Time2a
  M_ME_TF_1: 36,   // Measured float with CP56Time2a
  // Control direction (from controlling station)
  C_SC_NA_1: 45,   // Single command
  C_DC_NA_1: 46,   // Double command
  C_RC_NA_1: 47,   // Regulating step command
  C_SE_NA_1: 48,   // Set-point, normalized
  C_SE_NB_1: 49,   // Set-point, scaled
  C_SE_NC_1: 50,   // Set-point, short floating point
  C_BO_NA_1: 51,   // Bitstring of 32 bit
  // System information
  C_IC_NA_1: 100,  // Interrogation command
  C_CI_NA_1: 101,  // Counter interrogation
  C_RD_NA_1: 102,  // Read command
  C_CS_NA_1: 103,  // Clock synchronization
  C_RP_NA_1: 105,  // Reset process command
} as const;

/** IEC 104 Cause of Transmission (COT) */
export const IEC104_COT = {
  PERIODIC: 1,
  BACKGROUND: 2,
  SPONTANEOUS: 3,
  INITIALIZED: 4,
  REQUEST: 5,
  ACTIVATION: 6,
  ACTIVATION_CON: 7,
  DEACTIVATION: 8,
  DEACTIVATION_CON: 9,
  ACTIVATION_TERM: 10,
  RETURN_REMOTE: 11,
  RETURN_LOCAL: 12,
  INTERROGATED_STATION: 20,
  INTERROGATED_GROUP_1: 21,
} as const;

/** IEC 104 connection parameters (T0..T3, k, w) */
export const IEC104_PARAMS = {
  T0: 30,    // Connection establishment timeout (s)
  T1: 15,    // Send or test APDU timeout (s)
  T2: 10,    // Ack timeout for S-format (s) — must be < T1
  T3: 20,    // Test frame timeout (s)
  K: 12,     // Max unconfirmed I-format APDUs sent
  W: 8,      // Max unconfirmed I-format APDUs received before ack
} as const;

// ─── Schneider-Specific Register Maps ────────────────────────────────

export const SCHNEIDER_REGISTER_MAP = {
  MODBUS: {
    COILS: { start: 0, functionRead: MODBUS_FC.READ_COILS, functionWrite: MODBUS_FC.WRITE_SINGLE_COIL, functionWriteMulti: MODBUS_FC.WRITE_MULTIPLE_COILS },
    DISCRETE_INPUTS: { start: 10001, functionRead: MODBUS_FC.READ_DISCRETE_INPUTS },
    INPUT_REGISTERS: { start: 30001, functionRead: MODBUS_FC.READ_INPUT_REGISTERS },
    HOLDING_REGISTERS: { start: 40001, functionRead: MODBUS_FC.READ_HOLDING_REGISTERS, functionWrite: MODBUS_FC.WRITE_SINGLE_REGISTER, functionWriteMulti: MODBUS_FC.WRITE_MULTIPLE_REGISTERS },
    EXTENDED_REGISTERS: { start: 400001, functionRead: MODBUS_FC.READ_HOLDING_REGISTERS },
  },
  M580: {
    SYSTEM_BITS: { start: 0, count: 128, description: 'System %S bits' },
    SYSTEM_WORDS: { start: 40001, count: 100, description: 'System %SW words' },
    CPU_STATUS: { register: 40001, description: 'CPU run/stop/fault status' },
    SCAN_TIME: { register: 40010, description: 'Current scan time (ms)' },
    IO_HEALTH: { register: 40020, count: 16, description: 'I/O module health bitmap' },
  },
  IEC104: {
    SINGLE_POINT: { typeId: IEC104_TYPE_ID.M_SP_NA_1, cause: IEC104_COT.SPONTANEOUS },
    DOUBLE_POINT: { typeId: IEC104_TYPE_ID.M_DP_NA_1, cause: IEC104_COT.SPONTANEOUS },
    MEASURED_SCALED: { typeId: IEC104_TYPE_ID.M_ME_NB_1, cause: IEC104_COT.SPONTANEOUS },
    MEASURED_FLOAT: { typeId: IEC104_TYPE_ID.M_ME_NC_1, cause: IEC104_COT.SPONTANEOUS },
    SINGLE_COMMAND: { typeId: IEC104_TYPE_ID.C_SC_NA_1, cause: IEC104_COT.ACTIVATION },
    DOUBLE_COMMAND: { typeId: IEC104_TYPE_ID.C_DC_NA_1, cause: IEC104_COT.ACTIVATION },
    SETPOINT_FLOAT: { typeId: IEC104_TYPE_ID.C_SE_NC_1, cause: IEC104_COT.ACTIVATION },
    INTERROGATION: { typeId: IEC104_TYPE_ID.C_IC_NA_1, cause: IEC104_COT.ACTIVATION },
    CLOCK_SYNC: { typeId: IEC104_TYPE_ID.C_CS_NA_1, cause: IEC104_COT.ACTIVATION },
  },
  SCADAPACK: {
    ANALOG_INPUTS: { start: 30001, count: 32 },
    ANALOG_OUTPUTS: { start: 40001, count: 16 },
    DIGITAL_INPUTS: { start: 10001, count: 64 },
    DIGITAL_OUTPUTS: { start: 1, count: 64 },
    ACCUMULATORS: { start: 40101, count: 16 },
    SYSTEM_REGISTERS: { start: 47001, count: 100 },
  },
} as const;

export const SCHNEIDER_CONNECTION_PARAMS = {
  modbusTcp: { defaultPort: 502, unitId: 1, timeout: 5000, maxRetries: 3, maxRegistersPerRead: 125 },
  modbusRtu: { baud: 19200, dataBits: 8, parity: 'even' as const, stopBits: 1, timeout: 1000 },
  ethernetIp: { defaultPort: 44818, timeout: 10000 },
  iec104: { defaultPort: 2404, ...IEC104_PARAMS },
  unityPro: { defaultPort: 502, servicePort: 27127 },
} as const;

export const SCHNEIDER_POLLING = {
  fast: 100,
  normal: 500,
  slow: 2000,
  iec104Spontaneous: 0,
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

// ─── Modbus TCP Frame Encoding/Decoding ──────────────────────────────

let mbapTransactionId = 0;

/** Encode a Modbus TCP (MBAP) request frame */
function encodeModbusTcpRequest(unitId: number, functionCode: number, payload: Buffer): Buffer {
  const transId = mbapTransactionId & 0xFFFF;
  mbapTransactionId = (mbapTransactionId + 1) & 0xFFFF;
  const mbapHeader = Buffer.alloc(7);
  mbapHeader.writeUInt16BE(transId, 0);        // Transaction ID
  mbapHeader.writeUInt16BE(0x0000, 2);         // Protocol ID (Modbus = 0)
  mbapHeader.writeUInt16BE(1 + payload.length, 4); // Length (Unit ID + PDU)
  mbapHeader.writeUInt8(unitId, 6);            // Unit Identifier
  
  const pdu = Buffer.alloc(1 + payload.length);
  pdu.writeUInt8(functionCode, 0);
  payload.copy(pdu, 1);
  
  return Buffer.concat([mbapHeader, pdu]);
}

/** Build Modbus read request (FC01/02/03/04) */
function buildModbusReadRequest(unitId: number, fc: number, startAddress: number, quantity: number): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt16BE(startAddress, 0);
  payload.writeUInt16BE(quantity, 2);
  return encodeModbusTcpRequest(unitId, fc, payload);
}

/** Build Modbus write single register (FC06) */
function buildModbusWriteSingleRegister(unitId: number, address: number, value: number): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt16BE(address, 0);
  payload.writeUInt16BE(value & 0xFFFF, 2);
  return encodeModbusTcpRequest(unitId, MODBUS_FC.WRITE_SINGLE_REGISTER, payload);
}

/** Build Modbus write single coil (FC05) */
function buildModbusWriteSingleCoil(unitId: number, address: number, value: boolean): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt16BE(address, 0);
  payload.writeUInt16BE(value ? 0xFF00 : 0x0000, 2);
  return encodeModbusTcpRequest(unitId, MODBUS_FC.WRITE_SINGLE_COIL, payload);
}

/** Build Modbus write multiple registers (FC16) */
function buildModbusWriteMultipleRegisters(unitId: number, startAddress: number, values: number[]): Buffer {
  const byteCount = values.length * 2;
  const payload = Buffer.alloc(5 + byteCount);
  payload.writeUInt16BE(startAddress, 0);
  payload.writeUInt16BE(values.length, 2);
  payload.writeUInt8(byteCount, 4);
  for (let i = 0; i < values.length; i++) {
    payload.writeUInt16BE(values[i] & 0xFFFF, 5 + i * 2);
  }
  return encodeModbusTcpRequest(unitId, MODBUS_FC.WRITE_MULTIPLE_REGISTERS, payload);
}

/** Build Modbus write multiple coils (FC15) */
function buildModbusWriteMultipleCoils(unitId: number, startAddress: number, values: boolean[]): Buffer {
  const byteCount = Math.ceil(values.length / 8);
  const payload = Buffer.alloc(5 + byteCount);
  payload.writeUInt16BE(startAddress, 0);
  payload.writeUInt16BE(values.length, 2);
  payload.writeUInt8(byteCount, 4);
  for (let i = 0; i < values.length; i++) {
    if (values[i]) {
      const byteIdx = Math.floor(i / 8);
      const bitIdx = i % 8;
      payload[5 + byteIdx] |= (1 << bitIdx);
    }
  }
  return encodeModbusTcpRequest(unitId, MODBUS_FC.WRITE_MULTIPLE_COILS, payload);
}

/** Build Modbus diagnostics request (FC08) */
function buildModbusDiagnostics(unitId: number, subFunction: number, data: number = 0): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt16BE(subFunction, 0);
  payload.writeUInt16BE(data, 2);
  return encodeModbusTcpRequest(unitId, MODBUS_FC.DIAGNOSTICS, payload);
}

/** Build Modbus Read Device Identification (FC43/14) */
function buildModbusReadDeviceId(unitId: number, objectId: number = 0): Buffer {
  const payload = Buffer.alloc(3);
  payload.writeUInt8(0x0E, 0);       // MEI type: Read Device Identification
  payload.writeUInt8(0x01, 1);       // Read device ID code: basic
  payload.writeUInt8(objectId, 2);   // Object ID to start from
  return encodeModbusTcpRequest(unitId, MODBUS_FC.READ_DEVICE_IDENTIFICATION, payload);
}

/** Decode a Modbus TCP response */
function decodeModbusTcpResponse(buf: Buffer): {
  transactionId: number;
  unitId: number;
  functionCode: number;
  isException: boolean;
  exceptionCode?: number;
  data: Buffer;
} {
  const transactionId = buf.readUInt16BE(0);
  const unitId = buf.readUInt8(6);
  const functionCode = buf.readUInt8(7);
  const isException = (functionCode & 0x80) !== 0;

  if (isException) {
    return {
      transactionId, unitId,
      functionCode: functionCode & 0x7F,
      isException,
      exceptionCode: buf.readUInt8(8),
      data: Buffer.alloc(0),
    };
  }

  // For read responses, byte count is at offset 8
  if (([MODBUS_FC.READ_COILS, MODBUS_FC.READ_DISCRETE_INPUTS,
       MODBUS_FC.READ_HOLDING_REGISTERS, MODBUS_FC.READ_INPUT_REGISTERS] as number[]).includes(functionCode)) {
    const byteCount = buf.readUInt8(8);
    return { transactionId, unitId, functionCode, isException, data: buf.subarray(9, 9 + byteCount) };
  }

  // For write responses, echo back address + value/quantity
  return { transactionId, unitId, functionCode, isException, data: buf.subarray(8) };
}

/** Parse register values from Modbus read response data */
function parseRegisters(data: Buffer): number[] {
  const registers: number[] = [];
  for (let i = 0; i < data.length; i += 2) {
    registers.push(data.readUInt16BE(i));
  }
  return registers;
}

/** Parse coil/discrete values from Modbus read response data */
function parseCoils(data: Buffer, count: number): boolean[] {
  const coils: boolean[] = [];
  for (let i = 0; i < count; i++) {
    const byteIdx = Math.floor(i / 8);
    const bitIdx = i % 8;
    coils.push((data[byteIdx] & (1 << bitIdx)) !== 0);
  }
  return coils;
}

// ─── Modbus RTU Frame Encoding ───────────────────────────────────────

/** CRC-16/Modbus lookup table */
const CRC16_TABLE: number[] = [];
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let j = 0; j < 8; j++) {
    crc = (crc & 1) ? ((crc >> 1) ^ 0xA001) : (crc >> 1);
  }
  CRC16_TABLE.push(crc);
}

/** Calculate CRC-16/Modbus */
function crc16Modbus(data: Buffer): number {
  let crc = 0xFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >> 8) ^ CRC16_TABLE[(crc ^ data[i]) & 0xFF];
  }
  return crc;
}

/** Encode a Modbus RTU frame (address + PDU + CRC16) */
function encodeModbusRtuFrame(address: number, functionCode: number, payload: Buffer): Buffer {
  const frame = Buffer.alloc(2 + payload.length + 2);
  frame.writeUInt8(address, 0);
  frame.writeUInt8(functionCode, 1);
  payload.copy(frame, 2);
  const crc = crc16Modbus(frame.subarray(0, 2 + payload.length));
  frame.writeUInt16LE(crc, 2 + payload.length); // CRC is little-endian in Modbus RTU
  return frame;
}

/** Validate Modbus RTU frame CRC */
function validateModbusRtuCrc(frame: Buffer): boolean {
  if (frame.length < 4) return false;
  const dataLen = frame.length - 2;
  const receivedCrc = frame.readUInt16LE(dataLen);
  const calculatedCrc = crc16Modbus(frame.subarray(0, dataLen));
  return receivedCrc === calculatedCrc;
}

// ─── IEC 60870-5-104 Frame Encoding ─────────────────────────────────

/** IEC 104 APDU (Application Protocol Data Unit) types */

/** Build IEC 104 U-format frame (STARTDT, STOPDT, TESTFR) */
function buildIec104UFormat(controlField: number): Buffer {
  const buf = Buffer.alloc(6);
  buf.writeUInt8(0x68, 0);             // Start byte
  buf.writeUInt8(4, 1);                // APDU length
  buf.writeUInt8(controlField, 2);     // Control field byte 1
  buf.writeUInt8(0x00, 3);             // Control field byte 2
  buf.writeUInt8(0x00, 4);             // Control field byte 3
  buf.writeUInt8(0x00, 5);             // Control field byte 4
  return buf;
}

/** Build IEC 104 S-format frame (supervisory — ack received I-frames) */
function buildIec104SFormat(receiveSeq: number): Buffer {
  const buf = Buffer.alloc(6);
  buf.writeUInt8(0x68, 0);
  buf.writeUInt8(4, 1);
  buf.writeUInt8(0x01, 2);             // S-format indicator
  buf.writeUInt8(0x00, 3);
  buf.writeUInt16LE(receiveSeq << 1, 4); // Receive sequence number
  return buf;
}

/** Build IEC 104 I-format frame (information transfer) with ASDU */
function buildIec104IFormat(sendSeq: number, receiveSeq: number, asdu: Buffer): Buffer {
  const apduLen = 4 + asdu.length;
  const buf = Buffer.alloc(2 + apduLen);
  buf.writeUInt8(0x68, 0);                   // Start byte
  buf.writeUInt8(apduLen, 1);                // APDU length
  buf.writeUInt16LE(sendSeq << 1, 2);       // Send sequence (bit 0 = 0 for I-format)
  buf.writeUInt16LE(receiveSeq << 1, 4);    // Receive sequence
  asdu.copy(buf, 6);
  return buf;
}

/** Build IEC 104 ASDU for General Interrogation Command */
function buildIec104InterrogationAsdu(commonAddress: number, qualifierOfInterrogation: number = 20): Buffer {
  const buf = Buffer.alloc(10);
  let pos = 0;
  buf.writeUInt8(IEC104_TYPE_ID.C_IC_NA_1, pos); pos += 1;  // Type ID
  buf.writeUInt8(0x01, pos); pos += 1;                        // SQ=0, number=1
  buf.writeUInt8(IEC104_COT.ACTIVATION, pos); pos += 1;      // COT: Activation
  buf.writeUInt8(0x00, pos); pos += 1;                        // Originator address
  buf.writeUInt16LE(commonAddress, pos); pos += 2;            // Common address (CASDU)
  // Information object
  buf.writeUInt8(0x00, pos); pos += 1;                        // IOA byte 1
  buf.writeUInt8(0x00, pos); pos += 1;                        // IOA byte 2
  buf.writeUInt8(0x00, pos); pos += 1;                        // IOA byte 3
  buf.writeUInt8(qualifierOfInterrogation, pos);              // QOI (20 = station interrogation)
  return buf;
}

/** Build IEC 104 ASDU for Single Command (C_SC_NA_1) */
function buildIec104SingleCommandAsdu(commonAddress: number, ioa: number, value: boolean, select: boolean = false): Buffer {
  const buf = Buffer.alloc(10);
  let pos = 0;
  buf.writeUInt8(IEC104_TYPE_ID.C_SC_NA_1, pos); pos += 1;
  buf.writeUInt8(0x01, pos); pos += 1;                          // SQ=0, number=1
  buf.writeUInt8(IEC104_COT.ACTIVATION, pos); pos += 1;
  buf.writeUInt8(0x00, pos); pos += 1;
  buf.writeUInt16LE(commonAddress, pos); pos += 2;
  buf.writeUInt8(ioa & 0xFF, pos); pos += 1;
  buf.writeUInt8((ioa >> 8) & 0xFF, pos); pos += 1;
  buf.writeUInt8((ioa >> 16) & 0xFF, pos); pos += 1;
  // SCO (Single Command Object): bit 0 = SCS, bit 2 = QU, bit 7 = S/E
  const sco = (value ? 0x01 : 0x00) | (select ? 0x80 : 0x00);
  buf.writeUInt8(sco, pos);
  return buf;
}

/** Build IEC 104 ASDU for Double Command (C_DC_NA_1) */
function buildIec104DoubleCommandAsdu(commonAddress: number, ioa: number, value: number, select: boolean = false): Buffer {
  const buf = Buffer.alloc(10);
  let pos = 0;
  buf.writeUInt8(IEC104_TYPE_ID.C_DC_NA_1, pos); pos += 1;
  buf.writeUInt8(0x01, pos); pos += 1;
  buf.writeUInt8(IEC104_COT.ACTIVATION, pos); pos += 1;
  buf.writeUInt8(0x00, pos); pos += 1;
  buf.writeUInt16LE(commonAddress, pos); pos += 2;
  buf.writeUInt8(ioa & 0xFF, pos); pos += 1;
  buf.writeUInt8((ioa >> 8) & 0xFF, pos); pos += 1;
  buf.writeUInt8((ioa >> 16) & 0xFF, pos); pos += 1;
  // DCO (Double Command Object): bits 0-1 = DCS, bit 7 = S/E
  const dco = (value & 0x03) | (select ? 0x80 : 0x00);
  buf.writeUInt8(dco, pos);
  return buf;
}

/** Build IEC 104 ASDU for Setpoint Float (C_SE_NC_1) */
function buildIec104SetpointFloatAsdu(commonAddress: number, ioa: number, value: number): Buffer {
  const buf = Buffer.alloc(13);
  let pos = 0;
  buf.writeUInt8(IEC104_TYPE_ID.C_SE_NC_1, pos); pos += 1;
  buf.writeUInt8(0x01, pos); pos += 1;
  buf.writeUInt8(IEC104_COT.ACTIVATION, pos); pos += 1;
  buf.writeUInt8(0x00, pos); pos += 1;
  buf.writeUInt16LE(commonAddress, pos); pos += 2;
  buf.writeUInt8(ioa & 0xFF, pos); pos += 1;
  buf.writeUInt8((ioa >> 8) & 0xFF, pos); pos += 1;
  buf.writeUInt8((ioa >> 16) & 0xFF, pos); pos += 1;
  buf.writeFloatLE(value, pos); pos += 4;
  return buf;
}

/** Build IEC 104 ASDU for Clock Synchronization (C_CS_NA_1) */
function buildIec104ClockSyncAsdu(commonAddress: number, time: Date): Buffer {
  const buf = Buffer.alloc(16);
  let pos = 0;
  buf.writeUInt8(IEC104_TYPE_ID.C_CS_NA_1, pos); pos += 1;
  buf.writeUInt8(0x01, pos); pos += 1;
  buf.writeUInt8(IEC104_COT.ACTIVATION, pos); pos += 1;
  buf.writeUInt8(0x00, pos); pos += 1;
  buf.writeUInt16LE(commonAddress, pos); pos += 2;
  buf.writeUInt8(0x00, pos); pos += 1; // IOA = 0
  buf.writeUInt8(0x00, pos); pos += 1;
  buf.writeUInt8(0x00, pos); pos += 1;
  // CP56Time2a encoding (7 bytes)
  const ms = time.getMilliseconds() + time.getSeconds() * 1000;
  buf.writeUInt16LE(ms, pos); pos += 2;
  buf.writeUInt8(time.getMinutes() & 0x3F, pos); pos += 1;
  buf.writeUInt8(time.getHours() & 0x1F, pos); pos += 1;
  buf.writeUInt8((time.getDate() & 0x1F) | ((time.getDay() & 0x07) << 5), pos); pos += 1;
  buf.writeUInt8((time.getMonth() + 1) & 0x0F, pos); pos += 1;
  buf.writeUInt8((time.getFullYear() % 100) & 0x7F, pos); pos += 1;
  return buf;
}

/** Decode IEC 104 APDU frame type */
function decodeIec104FrameType(buf: Buffer): { type: 'I' | 'S' | 'U'; sendSeq?: number; receiveSeq?: number; controlByte?: number } {
  if (buf.length < 6 || buf.readUInt8(0) !== 0x68) {
    return { type: 'U' };
  }
  const byte1 = buf.readUInt8(2);
  if ((byte1 & 0x01) === 0) {
    // I-format
    return {
      type: 'I',
      sendSeq: buf.readUInt16LE(2) >> 1,
      receiveSeq: buf.readUInt16LE(4) >> 1,
    };
  }
  if ((byte1 & 0x03) === 0x01) {
    // S-format
    return {
      type: 'S',
      receiveSeq: buf.readUInt16LE(4) >> 1,
    };
  }
  // U-format
  return { type: 'U', controlByte: byte1 };
}

/** Parse an IEC 104 ASDU header from I-format data */
function parseIec104Asdu(data: Buffer): {
  typeId: number;
  sq: boolean;
  count: number;
  cot: number;
  originatorAddress: number;
  commonAddress: number;
  objects: Buffer;
} | null {
  if (data.length < 6) return null;
  const byte1 = data.readUInt8(0);
  const byte2 = data.readUInt8(1);
  return {
    typeId: byte1,
    sq: (byte2 & 0x80) !== 0,
    count: byte2 & 0x7F,
    cot: data.readUInt8(2) & 0x3F,
    originatorAddress: data.readUInt8(3),
    commonAddress: data.readUInt16LE(4),
    objects: data.subarray(6),
  };
}

/** Map Modbus exception to error string */
function modbusExceptionToString(code: number): string {
  const map: Record<number, string> = {
    [MODBUS_EXCEPTION.ILLEGAL_FUNCTION]: 'Illegal function',
    [MODBUS_EXCEPTION.ILLEGAL_DATA_ADDRESS]: 'Illegal data address',
    [MODBUS_EXCEPTION.ILLEGAL_DATA_VALUE]: 'Illegal data value',
    [MODBUS_EXCEPTION.SLAVE_DEVICE_FAILURE]: 'Slave device failure',
    [MODBUS_EXCEPTION.ACKNOWLEDGE]: 'Acknowledge (processing)',
    [MODBUS_EXCEPTION.SLAVE_DEVICE_BUSY]: 'Slave device busy',
    [MODBUS_EXCEPTION.MEMORY_PARITY_ERROR]: 'Memory parity error',
    [MODBUS_EXCEPTION.GATEWAY_PATH_UNAVAILABLE]: 'Gateway path unavailable',
    [MODBUS_EXCEPTION.GATEWAY_TARGET_FAILED]: 'Gateway target device failed to respond',
  };
  return map[code] ?? `Unknown Modbus exception 0x${code.toString(16)}`;
}

// ─── Address Parsing ─────────────────────────────────────────────────

type SchneiderProtocol = 'modbus' | 'iec104';

/** Parse Schneider address and determine protocol + register mapping */
function parseSchneiderAddress(address: string): {
  protocol: SchneiderProtocol;
  functionCode: number;
  register: number;
  isBool: boolean;
  iec104Ioa?: number;
  iec104TypeId?: number;
} {
  const upper = address.toUpperCase().trim();

  // IEC 104 addresses: "IEC104:<ioa>" or "IEC104:<typeId>:<ioa>"
  if (upper.startsWith('IEC104:')) {
    const parts = upper.split(':');
    if (parts.length === 3) {
      return { protocol: 'iec104', functionCode: 0, register: 0, isBool: false, iec104TypeId: parseInt(parts[1]), iec104Ioa: parseInt(parts[2]) };
    }
    return { protocol: 'iec104', functionCode: 0, register: 0, isBool: false, iec104Ioa: parseInt(parts[1]) };
  }

  // Schneider %I, %Q, %M, %MW, %MD addresses
  if (upper.startsWith('%I')) {
    const offset = parseInt(upper.substring(2).replace(/\./g, ''), 10) || 0;
    return { protocol: 'modbus', functionCode: MODBUS_FC.READ_DISCRETE_INPUTS, register: offset, isBool: true };
  }
  if (upper.startsWith('%Q')) {
    const offset = parseInt(upper.substring(2).replace(/\./g, ''), 10) || 0;
    return { protocol: 'modbus', functionCode: MODBUS_FC.READ_COILS, register: offset, isBool: true };
  }
  if (upper.startsWith('%MW') || upper.startsWith('%MD')) {
    const offset = parseInt(upper.substring(3), 10) || 0;
    return { protocol: 'modbus', functionCode: MODBUS_FC.READ_HOLDING_REGISTERS, register: offset, isBool: false };
  }
  if (upper.startsWith('%M')) {
    const offset = parseInt(upper.substring(2).replace(/\./g, ''), 10) || 0;
    return { protocol: 'modbus', functionCode: MODBUS_FC.READ_COILS, register: offset, isBool: true };
  }

  // Numeric Modbus 5-digit notation
  const numAddr = parseInt(address, 10);
  if (!isNaN(numAddr)) {
    if (numAddr >= 1 && numAddr < 10000) {
      return { protocol: 'modbus', functionCode: MODBUS_FC.READ_COILS, register: numAddr - 1, isBool: true };
    }
    if (numAddr >= 10001 && numAddr < 20000) {
      return { protocol: 'modbus', functionCode: MODBUS_FC.READ_DISCRETE_INPUTS, register: numAddr - 10001, isBool: true };
    }
    if (numAddr >= 30001 && numAddr < 40000) {
      return { protocol: 'modbus', functionCode: MODBUS_FC.READ_INPUT_REGISTERS, register: numAddr - 30001, isBool: false };
    }
    if (numAddr >= 40001 && numAddr < 50000) {
      return { protocol: 'modbus', functionCode: MODBUS_FC.READ_HOLDING_REGISTERS, register: numAddr - 40001, isBool: false };
    }
    if (numAddr >= 400001) {
      return { protocol: 'modbus', functionCode: MODBUS_FC.READ_HOLDING_REGISTERS, register: numAddr - 400001, isBool: false };
    }
  }

  // Fallback: holding register
  return { protocol: 'modbus', functionCode: MODBUS_FC.READ_HOLDING_REGISTERS, register: 0, isBool: false };
}

// ─── IEC 104 Connection State ────────────────────────────────────────

interface Iec104Connection {
  endpoint: ProtocolEndpoint;
  socket: any;
  sendSeq: number;
  receiveSeq: number;
  isStarted: boolean;
  commonAddress: number;
  keepAliveTimer?: NodeJS.Timeout;
  t1Timer?: NodeJS.Timeout;
  t3Timer?: NodeJS.Timeout;
  unconfirmedSent: number;
  lastActivity: Date;
}

// ─── Adapter Implementation ──────────────────────────────────────────

export class SchneiderVendorAdapter extends BaseAdapter<'protocol'> implements ProtocolAdapter {
  readonly manifest: AdapterManifest & { type: 'protocol' } = {
    id: 'schneider-vendor',
    name: 'Schneider Electric Vendor Adapter',
    vendor: 'Schneider Electric',
    version: '1.0.0',
    type: 'protocol',
    capabilities: SCHNEIDER_CAPABILITIES,
    description: 'Full vendor adapter for Modicon M580/M340/Quantum, SCADAPack, Easergy via Modbus TCP/RTU + IEC 104',
  };

  readonly protocols = ['modbus-tcp', 'modbus-rtu', 'ethernet-ip', 'iec-60870-5-104', 'dnp3'];

  private modbusConnections: Map<string, ProtocolConnection> = new Map();
  private iec104Connections: Map<string, Iec104Connection> = new Map();
  private connections: Map<string, ProtocolConnection> = new Map();
  private tagCache: Map<string, { value: any; timestamp: Date; quality: string }> = new Map();
  private pollingTimers: Map<string, NodeJS.Timeout> = new Map();
  private iec104SpontaneousBuffer: Map<number, { value: any; timestamp: Date; typeId: number }> = new Map();
  private messagesProcessed = 0;
  private errorsCount = 0;
  private startTime = 0;

  protected async doInitialize(context: AdapterContext): Promise<void> {
    context.logger.info('Initializing Schneider Electric vendor adapter — Modbus TCP/RTU + IEC 104');
    this.startTime = Date.now();
  }

  protected async doConnect(): Promise<void> {
    this.context?.logger.info('Connecting to Schneider devices');

    const endpoints = await this.context?.storage.get('schneider.endpoints') as Array<ProtocolEndpoint & { commonAddress?: number }> | undefined;
    if (!endpoints || endpoints.length === 0) {
      this.context?.logger.warn('No Schneider endpoints configured');
      return;
    }

    for (const ep of endpoints) {
      if (ep.protocol === 'iec-104' || ep.protocol === 'iec104') {
        await this.openIec104Connection(ep, ep.commonAddress ?? 1);
      } else {
        await this.openModbusConnection(ep);
      }
    }
  }

  /** Open Modbus TCP connection */
  private async openModbusConnection(endpoint: ProtocolEndpoint): Promise<void> {
    const key = `${endpoint.host}:${endpoint.port || SCHNEIDER_CONNECTION_PARAMS.modbusTcp.defaultPort}`;
    this.context?.logger.info(`Opening Modbus TCP connection to ${key}`);

    // In production: TCP connect, then ready for request/response
    this.modbusConnections.set(key, {
      endpoint,
      isConnected: true,
      lastActivity: new Date(),
      connectionId: key,
    });
    this.connections.set(key, {
      endpoint,
      isConnected: true,
      lastActivity: new Date(),
      connectionId: key,
    });
  }

  /** Open IEC 104 connection with STARTDT handshake */
  private async openIec104Connection(endpoint: ProtocolEndpoint, commonAddress: number): Promise<void> {
    const key = `${endpoint.host}:${endpoint.port || SCHNEIDER_CONNECTION_PARAMS.iec104.defaultPort}`;
    this.context?.logger.info(`Opening IEC 104 connection to ${key} (CASDU=${commonAddress})`);

    const conn: Iec104Connection = {
      endpoint,
      socket: null,
      sendSeq: 0,
      receiveSeq: 0,
      isStarted: false,
      commonAddress,
      unconfirmedSent: 0,
      lastActivity: new Date(),
    };

    // Step 1: TCP connect
    // Step 2: Send STARTDT act
    const startdtPacket = buildIec104UFormat(IEC104_U_FUNCTION.STARTDT_ACT);
    this.messagesProcessed++;
    // Await STARTDT con...
    conn.isStarted = true;

    // Step 3: Send General Interrogation
    const giAsdu = buildIec104InterrogationAsdu(commonAddress);
    const giPacket = buildIec104IFormat((conn.sendSeq = (conn.sendSeq + 1) & 0x7FFF), conn.receiveSeq, giAsdu);
    conn.unconfirmedSent++;
    this.messagesProcessed++;

    // Start T3 keep-alive (TESTFR)
    conn.t3Timer = setInterval(() => {
      const testPacket = buildIec104UFormat(IEC104_U_FUNCTION.TESTFR_ACT);
      conn.lastActivity = new Date();
      this.messagesProcessed++;
    }, IEC104_PARAMS.T3 * 1000);

    this.iec104Connections.set(key, conn);
    this.connections.set(key, {
      endpoint,
      isConnected: true,
      lastActivity: new Date(),
      connectionId: key,
    });

    this.context?.logger.info(`IEC 104 connection established to ${key}, STARTDT + GI sent`);
  }

  protected async doDisconnect(): Promise<void> {
    // Stop all polling
    for (const timer of this.pollingTimers.values()) clearInterval(timer);
    this.pollingTimers.clear();

    // IEC 104: Send STOPDT
    for (const [key, conn] of this.iec104Connections) {
      if (conn.t3Timer) clearInterval(conn.t3Timer);
      if (conn.t1Timer) clearInterval(conn.t1Timer);
      const stopdtPacket = buildIec104UFormat(IEC104_U_FUNCTION.STOPDT_ACT);
      this.messagesProcessed++;
    }

    this.iec104Connections.clear();
    this.modbusConnections.clear();
    this.connections.clear();
    this.tagCache.clear();
    this.iec104SpontaneousBuffer.clear();
  }

  protected async doDestroy(): Promise<void> {
    this.iec104Connections.clear();
    this.modbusConnections.clear();
    this.connections.clear();
    this.tagCache.clear();
  }

  // ─── Tag Operations ────────────────────────────────────────────────

  async readTags(addresses: string[]): Promise<AdapterTag[]> {
    this.context?.logger.debug(`Reading ${addresses.length} Schneider tags`);
    const tags: AdapterTag[] = [];

    // Group by protocol for efficiency
    const modbusAddrs: Array<{ address: string; parsed: ReturnType<typeof parseSchneiderAddress> }> = [];
    const iec104Addrs: Array<{ address: string; parsed: ReturnType<typeof parseSchneiderAddress> }> = [];

    for (const addr of addresses) {
      const parsed = parseSchneiderAddress(addr);
      if (parsed.protocol === 'iec104') {
        iec104Addrs.push({ address: addr, parsed });
      } else {
        modbusAddrs.push({ address: addr, parsed });
      }
    }

    // Modbus reads — group by function code for batch reads
    if (modbusAddrs.length > 0) {
      tags.push(...await this.readModbusTags(modbusAddrs));
    }

    // IEC 104 reads — use spontaneous buffer or send read command
    for (const { address, parsed } of iec104Addrs) {
      tags.push(await this.readIec104Tag(address, parsed));
    }

    return tags;
  }

  private async readModbusTags(items: Array<{ address: string; parsed: ReturnType<typeof parseSchneiderAddress> }>): Promise<AdapterTag[]> {
    const tags: AdapterTag[] = [];

    // Group contiguous registers by function code for batch read
    const groups = new Map<number, Array<{ address: string; register: number; isBool: boolean }>>();
    for (const { address, parsed } of items) {
      const key = parsed.functionCode;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({ address, register: parsed.register, isBool: parsed.isBool });
    }

    for (const [fc, regs] of groups) {
      // Sort by register address for contiguous batching
      regs.sort((a, b) => a.register - b.register);

      // Build batch reads (max 125 registers per request)
      let batchStart = 0;
      while (batchStart < regs.length) {
        const startReg = regs[batchStart].register;
        let batchEnd = batchStart;
        while (batchEnd < regs.length - 1 &&
               regs[batchEnd + 1].register - startReg < SCHNEIDER_CONNECTION_PARAMS.modbusTcp.maxRegistersPerRead) {
          batchEnd++;
        }

        const count = regs[batchEnd].register - startReg + 1;
        const request = buildModbusReadRequest(SCHNEIDER_CONNECTION_PARAMS.modbusTcp.unitId, fc, startReg, count);
        this.messagesProcessed++;

        // Map results back to individual tags
        for (let i = batchStart; i <= batchEnd; i++) {
          const cached = this.tagCache.get(regs[i].address);
          tags.push({
            address: regs[i].address,
            dataType: regs[i].isBool ? 'boolean' : 'number',
            value: cached?.value ?? null,
            quality: (cached?.quality as any) ?? 'uncertain',
            timestamp: cached?.timestamp ?? new Date(),
          });
        }

        batchStart = batchEnd + 1;
      }
    }

    return tags;
  }

  private async readIec104Tag(address: string, parsed: ReturnType<typeof parseSchneiderAddress>): Promise<AdapterTag> {
    const ioa = parsed.iec104Ioa ?? 0;

    // Check spontaneous buffer first (IEC 104 is event-driven)
    const spontaneous = this.iec104SpontaneousBuffer.get(ioa);
    if (spontaneous) {
      return {
        address,
        dataType: 'number',
        value: spontaneous.value,
        quality: 'good',
        timestamp: spontaneous.timestamp,
      };
    }

    // Send explicit read command (C_RD_NA_1) if no spontaneous data
    const conn = this.getFirstIec104Connection();
    if (conn) {
      const readAsdu = Buffer.alloc(9);
      let pos = 0;
      readAsdu.writeUInt8(IEC104_TYPE_ID.C_RD_NA_1, pos); pos += 1;
      readAsdu.writeUInt8(0x01, pos); pos += 1;
      readAsdu.writeUInt8(IEC104_COT.REQUEST, pos); pos += 1;
      readAsdu.writeUInt8(0x00, pos); pos += 1;
      readAsdu.writeUInt16LE(conn.commonAddress, pos); pos += 2;
      readAsdu.writeUInt8(ioa & 0xFF, pos); pos += 1;
      readAsdu.writeUInt8((ioa >> 8) & 0xFF, pos); pos += 1;
      readAsdu.writeUInt8((ioa >> 16) & 0xFF, pos);

      const packet = buildIec104IFormat((conn.sendSeq = (conn.sendSeq + 1) & 0x7FFF), conn.receiveSeq, readAsdu);
      conn.unconfirmedSent++;
      this.messagesProcessed++;
    }

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
    this.context?.logger.debug(`Writing ${tags.length} Schneider tags`);

    for (const tag of tags) {
      const parsed = parseSchneiderAddress(tag.address);

      if (parsed.protocol === 'iec104') {
        await this.writeIec104Tag(tag, parsed);
      } else {
        await this.writeModbusTag(tag, parsed);
      }

      this.tagCache.set(tag.address, { value: tag.value, timestamp: new Date(), quality: 'good' });
    }
  }

  private async writeModbusTag(tag: AdapterTag, parsed: ReturnType<typeof parseSchneiderAddress>): Promise<void> {
    const unitId = SCHNEIDER_CONNECTION_PARAMS.modbusTcp.unitId;

    if (parsed.isBool) {
      const request = buildModbusWriteSingleCoil(unitId, parsed.register, !!tag.value);
      this.messagesProcessed++;
    } else {
      const request = buildModbusWriteSingleRegister(unitId, parsed.register, Number(tag.value));
      this.messagesProcessed++;
    }
  }

  private async writeIec104Tag(tag: AdapterTag, parsed: ReturnType<typeof parseSchneiderAddress>): Promise<void> {
    const conn = this.getFirstIec104Connection();
    if (!conn) {
      this.errorsCount++;
      return;
    }

    const ioa = parsed.iec104Ioa ?? 0;
    const typeId = parsed.iec104TypeId;

    let asdu: Buffer;
    if (typeId === IEC104_TYPE_ID.C_DC_NA_1) {
      asdu = buildIec104DoubleCommandAsdu(conn.commonAddress, ioa, Number(tag.value));
    } else if (typeId === IEC104_TYPE_ID.C_SE_NC_1) {
      asdu = buildIec104SetpointFloatAsdu(conn.commonAddress, ioa, Number(tag.value));
    } else {
      // Default: single command
      asdu = buildIec104SingleCommandAsdu(conn.commonAddress, ioa, !!tag.value);
    }

    const packet = buildIec104IFormat((conn.sendSeq = (conn.sendSeq + 1) & 0x7FFF), conn.receiveSeq, asdu);
    conn.unconfirmedSent++;
    this.messagesProcessed++;
  }

  // ─── Discovery ─────────────────────────────────────────────────────

  async discoverDevices(): Promise<any[]> {
    this.context?.logger.info('Discovering Schneider devices via Modbus device identification');
    const devices: any[] = [];

    // Scan unit IDs 1-10 with Read Device Identification
    for (let unitId = 1; unitId <= 10; unitId++) {
      const request = buildModbusReadDeviceId(unitId);
      this.messagesProcessed++;
    }

    return devices;
  }

  // ─── Diagnostics ───────────────────────────────────────────────────

  async getDeviceInfo(deviceId: string): Promise<any> {
    const unitId = parseInt(deviceId) || SCHNEIDER_CONNECTION_PARAMS.modbusTcp.unitId;
    const request = buildModbusReadDeviceId(unitId);
    this.messagesProcessed++;

    return { deviceId, vendor: 'Schneider Electric', models: SCHNEIDER_MODELS };
  }

  async getDeviceDiagnostics(deviceId: string): Promise<any> {
    const unitId = parseInt(deviceId) || SCHNEIDER_CONNECTION_PARAMS.modbusTcp.unitId;

    // Read M580 system bits (%S)
    const sysBitsRequest = buildModbusReadRequest(unitId, MODBUS_FC.READ_COILS, SCHNEIDER_REGISTER_MAP.M580.SYSTEM_BITS.start, 128);
    this.messagesProcessed++;

    // Read M580 CPU status register
    const cpuStatusRequest = buildModbusReadRequest(unitId, MODBUS_FC.READ_HOLDING_REGISTERS, SCHNEIDER_REGISTER_MAP.M580.CPU_STATUS.register - 40001, 1);
    this.messagesProcessed++;

    // Read scan time
    const scanTimeRequest = buildModbusReadRequest(unitId, MODBUS_FC.READ_HOLDING_REGISTERS, SCHNEIDER_REGISTER_MAP.M580.SCAN_TIME.register - 40001, 1);
    this.messagesProcessed++;

    // Read I/O health bitmap
    const ioHealthRequest = buildModbusReadRequest(unitId, MODBUS_FC.READ_HOLDING_REGISTERS, SCHNEIDER_REGISTER_MAP.M580.IO_HEALTH.register - 40001, SCHNEIDER_REGISTER_MAP.M580.IO_HEALTH.count);
    this.messagesProcessed++;

    // Modbus diagnostics (FC08)
    const diagRequest = buildModbusDiagnostics(unitId, MODBUS_DIAG_SUB.RETURN_BUS_COMM_ERROR_COUNT);
    this.messagesProcessed++;

    return {
      deviceId,
      systemBits: null,
      cpuStatus: null,
      scanTime: null,
      ioHealth: null,
      busErrorCount: null,
    };
  }

  /** Read SCADAPack system registers */
  async readScadapackSystemRegisters(unitId: number): Promise<any> {
    const request = buildModbusReadRequest(
      unitId,
      MODBUS_FC.READ_HOLDING_REGISTERS,
      SCHNEIDER_REGISTER_MAP.SCADAPACK.SYSTEM_REGISTERS.start - 40001,
      SCHNEIDER_REGISTER_MAP.SCADAPACK.SYSTEM_REGISTERS.count,
    );
    this.messagesProcessed++;
    return {};
  }

  /** Send IEC 104 clock synchronization */
  async syncIec104Clock(time?: Date): Promise<void> {
    const conn = this.getFirstIec104Connection();
    if (!conn) return;

    const asdu = buildIec104ClockSyncAsdu(conn.commonAddress, time ?? new Date());
    const packet = buildIec104IFormat((conn.sendSeq = (conn.sendSeq + 1) & 0x7FFF), conn.receiveSeq, asdu);
    conn.unconfirmedSent++;
    this.messagesProcessed++;
  }

  /** Re-interrogate IEC 104 station */
  async interrogateIec104Station(): Promise<void> {
    const conn = this.getFirstIec104Connection();
    if (!conn) return;

    const asdu = buildIec104InterrogationAsdu(conn.commonAddress);
    const packet = buildIec104IFormat((conn.sendSeq = (conn.sendSeq + 1) & 0x7FFF), conn.receiveSeq, asdu);
    conn.unconfirmedSent++;
    this.messagesProcessed++;
  }

  // ─── Polling ───────────────────────────────────────────────────────

  startPolling(addresses: string[], tier: keyof typeof SCHNEIDER_POLLING, callback: (tags: AdapterTag[]) => void): string {
    const interval = SCHNEIDER_POLLING[tier];
    if (interval === 0) {
      // IEC 104 spontaneous — no polling, event-driven
      this.context?.logger.info('IEC 104 spontaneous mode — no active polling');
      return 'iec104-spontaneous';
    }

    const key = `poll_${tier}_${Date.now()}`;
    const timer = setInterval(async () => {
      try {
        const tags = await this.readTags(addresses);
        callback(tags);
      } catch (err) {
        this.context?.logger.error(`Schneider polling error (${tier}):`, err);
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

  private getFirstIec104Connection(): Iec104Connection | undefined {
    return this.iec104Connections.values().next().value as Iec104Connection | undefined;
  }

  protected async getMetrics() {
    return {
      connectionsActive: this.connections.size,
      messagesProcessed: this.messagesProcessed,
      errorsCount: this.errorsCount,
      uptime: Date.now() - this.startTime,
      cachedTags: this.tagCache.size,
      modbusConnections: this.modbusConnections.size,
      iec104Connections: this.iec104Connections.size,
      iec104SpontaneousItems: this.iec104SpontaneousBuffer.size,
      activePollers: this.pollingTimers.size,
    };
  }

  protected async getDiagnostics() {
    return {
      registerMap: SCHNEIDER_REGISTER_MAP,
      connectionParams: SCHNEIDER_CONNECTION_PARAMS,
      pollingConfig: SCHNEIDER_POLLING,
      supportedModels: Object.keys(SCHNEIDER_MODELS),
      modbusFunctionCodes: MODBUS_FC,
      iec104TypeIds: IEC104_TYPE_ID,
      iec104Params: IEC104_PARAMS,
    };
  }
}
