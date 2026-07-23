/**
 * Shared Modbus TCP Utilities
 * Issue #370: Extract duplicated Modbus framing from vendor adapters
 *
 * The function-code and exception-code constants now live in the shared,
 * protocol-agnostic module `@shared/protocols/modbus-constants` so they cannot
 * drift from the Modbus TCP server's copy (issue #462). They are re-exported
 * here under their original names — including the legacy "slave" exception
 * names — so existing vendor-adapter imports keep working unchanged.
 */

import {
  MODBUS_FUNCTION_CODES,
  MODBUS_EXCEPTION_CODES,
} from '@shared/protocols/modbus-constants';

/**
 * Standard Modbus function codes.
 * Re-exported alias of the shared {@link MODBUS_FUNCTION_CODES}.
 */
export const MODBUS_FC = MODBUS_FUNCTION_CODES;

/**
 * Modbus exception codes, using the legacy "slave" naming the vendor adapters
 * were built against. Values come from the shared {@link MODBUS_EXCEPTION_CODES}
 * (where 0x04/0x06 use the modern "server" names).
 */
export const MODBUS_EXCEPTION = {
  ILLEGAL_FUNCTION: MODBUS_EXCEPTION_CODES.ILLEGAL_FUNCTION,
  ILLEGAL_DATA_ADDRESS: MODBUS_EXCEPTION_CODES.ILLEGAL_DATA_ADDRESS,
  ILLEGAL_DATA_VALUE: MODBUS_EXCEPTION_CODES.ILLEGAL_DATA_VALUE,
  SLAVE_DEVICE_FAILURE: MODBUS_EXCEPTION_CODES.SERVER_DEVICE_FAILURE,
  ACKNOWLEDGE: MODBUS_EXCEPTION_CODES.ACKNOWLEDGE,
  SLAVE_DEVICE_BUSY: MODBUS_EXCEPTION_CODES.SERVER_DEVICE_BUSY,
  MEMORY_PARITY_ERROR: MODBUS_EXCEPTION_CODES.MEMORY_PARITY_ERROR,
  GATEWAY_PATH_UNAVAILABLE: MODBUS_EXCEPTION_CODES.GATEWAY_PATH_UNAVAILABLE,
  GATEWAY_TARGET_FAILED: MODBUS_EXCEPTION_CODES.GATEWAY_TARGET_FAILED,
} as const;

let modbusTransactionId = 0;

function nextTransactionId(): number {
  const id = modbusTransactionId & 0xFFFF;
  modbusTransactionId = (modbusTransactionId + 1) & 0xFFFF;
  return id;
}

/**
 * Per-connection / per-instance Modbus transaction-ID counter (#363). Each
 * adapter holds its own so transaction IDs are NOT shared across adapters — the
 * MBAP transaction id matches a response to its request on a given connection,
 * and a global counter (the former behavior) mixes streams across instances.
 */
export class ModbusTransactionCounter {
  private id = 0;
  next(): number {
    const v = this.id & 0xFFFF;
    this.id = (this.id + 1) & 0xFFFF;
    return v;
  }
}

/**
 * Encode a Modbus TCP (MBAP) request frame.
 * Generic form: MBAP header + function code + payload.
 * Pass `transactionId` for per-connection sequencing; omit to use the shared
 * module counter (legacy fallback).
 */
export function encodeModbusTcpRequest(unitId: number, functionCode: number, payload: Buffer, transactionId?: number): Buffer {
  const transId = transactionId !== undefined ? (transactionId & 0xFFFF) : nextTransactionId();
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
export function buildModbusReadRequest(unitId: number, fc: number, startAddress: number, quantity: number, transactionId?: number): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt16BE(startAddress, 0);
  payload.writeUInt16BE(quantity, 2);
  return encodeModbusTcpRequest(unitId, fc, payload, transactionId);
}

/** Build Modbus TCP write single register (FC06) */
export function buildModbusWriteSingleRegister(unitId: number, address: number, value: number, transactionId?: number): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt16BE(address, 0);
  payload.writeUInt16BE(value & 0xFFFF, 2);
  return encodeModbusTcpRequest(unitId, MODBUS_FC.WRITE_SINGLE_REGISTER, payload, transactionId);
}

/** Build Modbus TCP write single coil (FC05) */
export function buildModbusWriteSingleCoil(unitId: number, address: number, value: boolean, transactionId?: number): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt16BE(address, 0);
  payload.writeUInt16BE(value ? 0xFF00 : 0x0000, 2);
  return encodeModbusTcpRequest(unitId, MODBUS_FC.WRITE_SINGLE_COIL, payload, transactionId);
}

/** Build Modbus TCP write multiple registers (FC16) */
export function buildModbusWriteMultipleRegisters(unitId: number, startAddress: number, values: number[], transactionId?: number): Buffer {
  const byteCount = values.length * 2;
  const payload = Buffer.alloc(5 + byteCount);
  payload.writeUInt16BE(startAddress, 0);
  payload.writeUInt16BE(values.length, 2);
  payload.writeUInt8(byteCount, 4);
  for (let i = 0; i < values.length; i++) {
    payload.writeUInt16BE(values[i] & 0xFFFF, 5 + i * 2);
  }
  return encodeModbusTcpRequest(unitId, MODBUS_FC.WRITE_MULTIPLE_REGISTERS, payload, transactionId);
}

/** Build Modbus TCP write multiple coils (FC15) */
export function buildModbusWriteMultipleCoils(unitId: number, startAddress: number, values: boolean[], transactionId?: number): Buffer {
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
  return encodeModbusTcpRequest(unitId, MODBUS_FC.WRITE_MULTIPLE_COILS, payload, transactionId);
}
