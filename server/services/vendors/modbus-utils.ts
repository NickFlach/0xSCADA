/**
 * Shared Modbus TCP Utilities
 * Issue #370: Extract duplicated Modbus framing from vendor adapters
 */

/** Standard Modbus function codes */
export const MODBUS_FC = {
  READ_COILS: 0x01,
  READ_DISCRETE_INPUTS: 0x02,
  READ_HOLDING_REGISTERS: 0x03,
  READ_INPUT_REGISTERS: 0x04,
  WRITE_SINGLE_COIL: 0x05,
  WRITE_SINGLE_REGISTER: 0x06,
  WRITE_MULTIPLE_COILS: 0x0F,
  WRITE_MULTIPLE_REGISTERS: 0x10,
  READ_EXCEPTION_STATUS: 0x07,
  DIAGNOSTICS: 0x08,
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
  MEMORY_PARITY_ERROR: 0x08,
  GATEWAY_PATH_UNAVAILABLE: 0x0A,
  GATEWAY_TARGET_FAILED: 0x0B,
} as const;

let modbusTransactionId = 0;

function nextTransactionId(): number {
  const id = modbusTransactionId & 0xFFFF;
  modbusTransactionId = (modbusTransactionId + 1) & 0xFFFF;
  return id;
}

/**
 * Encode a Modbus TCP (MBAP) request frame.
 * Generic form: MBAP header + function code + payload.
 */
export function encodeModbusTcpRequest(unitId: number, functionCode: number, payload: Buffer): Buffer {
  const transId = nextTransactionId();
  const mbapHeader = Buffer.alloc(7);
  mbapHeader.writeUInt16BE(transId, 0);            // Transaction ID
  mbapHeader.writeUInt16BE(0x0000, 2);              // Protocol ID (Modbus = 0)
  mbapHeader.writeUInt16BE(1 + 1 + payload.length, 4); // Length (Unit ID + FC + payload)
  mbapHeader.writeUInt8(unitId, 6);                 // Unit Identifier

  const pdu = Buffer.alloc(1 + payload.length);
  pdu.writeUInt8(functionCode, 0);
  payload.copy(pdu, 1);

  return Buffer.concat([mbapHeader, pdu]);
}

/** Build Modbus TCP read request (FC01/02/03/04) */
export function buildModbusReadRequest(unitId: number, fc: number, startAddress: number, quantity: number): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt16BE(startAddress, 0);
  payload.writeUInt16BE(quantity, 2);
  return encodeModbusTcpRequest(unitId, fc, payload);
}

/** Build Modbus TCP write single register (FC06) */
export function buildModbusWriteSingleRegister(unitId: number, address: number, value: number): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt16BE(address, 0);
  payload.writeUInt16BE(value & 0xFFFF, 2);
  return encodeModbusTcpRequest(unitId, MODBUS_FC.WRITE_SINGLE_REGISTER, payload);
}

/** Build Modbus TCP write single coil (FC05) */
export function buildModbusWriteSingleCoil(unitId: number, address: number, value: boolean): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt16BE(address, 0);
  payload.writeUInt16BE(value ? 0xFF00 : 0x0000, 2);
  return encodeModbusTcpRequest(unitId, MODBUS_FC.WRITE_SINGLE_COIL, payload);
}

/** Build Modbus TCP write multiple registers (FC16) */
export function buildModbusWriteMultipleRegisters(unitId: number, startAddress: number, values: number[]): Buffer {
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

/** Build Modbus TCP write multiple coils (FC15) */
export function buildModbusWriteMultipleCoils(unitId: number, startAddress: number, values: boolean[]): Buffer {
  const byteCount = Math.ceil(values.length / 8);
  const payload = Buffer.alloc(5 + byteCount);
  payload.writeUInt16BE(startAddress, 0);
  payload.writeUInt16BE(values.length, 2);
  payload.writeUInt8(byteCount, 4);
  for (let i = 0; i < values.length; i++) {
    if (values[i]) {
      payload[5 + Math.floor(i / 8)] |= (1 << (i % 8));
    }
  }
  return encodeModbusTcpRequest(unitId, MODBUS_FC.WRITE_MULTIPLE_COILS, payload);
}
