/**
 * Modbus function-code handlers — pure request -> response processing.
 *
 * Issue #462: Modbus TCP Server Mode.
 *
 * Given a decoded `ModbusRequest` and a `ModbusDataModel`, `processRequest`
 * produces the response frame bytes (normal or exception). It has no socket
 * dependency, so every function code and every exception path is unit-testable.
 *
 * Supported function codes:
 *   0x01 Read Coils
 *   0x02 Read Discrete Inputs
 *   0x03 Read Holding Registers
 *   0x04 Read Input Registers
 *   0x05 Write Single Coil
 *   0x06 Write Single Register
 *   0x0F Write Multiple Coils
 *   0x10 Write Multiple Registers
 *
 * Exception codes returned:
 *   0x01 Illegal Function      — unsupported function code
 *   0x02 Illegal Data Address  — address/range not mapped
 *   0x03 Illegal Data Value    — quantity / byte-count / value out of spec range
 *   0x04 Server Device Failure — data model raised an unexpected error
 */

import {
  ExceptionCode,
  FunctionCode,
  MAX_READ_BITS,
  MAX_READ_REGISTERS,
  MAX_WRITE_COILS,
  MAX_WRITE_REGISTERS,
  encodeExceptionResponse,
  encodeResponse,
  packBits,
  packRegisters,
  unpackBits,
  unpackRegisters,
  type ModbusRequest,
} from "./codec";
import { DataModelError, type ModbusDataModel } from "./data-model";

const COIL_ON = 0xff00;
const COIL_OFF = 0x0000;

/** A typed error a handler can throw to short-circuit to an exception response. */
class ModbusException extends Error {
  constructor(public readonly code: ExceptionCode) {
    super(`Modbus exception 0x${code.toString(16)}`);
    this.name = "ModbusException";
  }
}

/**
 * Process one decoded request against the data model and return the encoded
 * response frame. Never throws — all failures become exception responses.
 */
export async function processRequest(
  request: ModbusRequest,
  model: ModbusDataModel,
): Promise<Buffer> {
  const { header, functionCode, data } = request;

  try {
    const responsePdu = await dispatch(functionCode, data, model);
    return encodeResponse(header, functionCode, responsePdu);
  } catch (err) {
    const code = toExceptionCode(err);
    return encodeExceptionResponse(header, functionCode, code);
  }
}

/** Map a thrown error to the appropriate Modbus exception code. */
function toExceptionCode(err: unknown): ExceptionCode {
  if (err instanceof ModbusException) {
    return err.code;
  }
  if (err instanceof DataModelError) {
    switch (err.kind) {
      case "ILLEGAL_DATA_ADDRESS":
        return ExceptionCode.ILLEGAL_DATA_ADDRESS;
      case "ILLEGAL_DATA_VALUE":
        return ExceptionCode.ILLEGAL_DATA_VALUE;
      case "SERVER_FAILURE":
        return ExceptionCode.SERVER_DEVICE_FAILURE;
    }
  }
  // Unexpected: treat as a server-side failure rather than leaking details.
  return ExceptionCode.SERVER_DEVICE_FAILURE;
}

/** Dispatch to the per-function-code handler; returns the response PDU body. */
async function dispatch(
  functionCode: number,
  data: Buffer,
  model: ModbusDataModel,
): Promise<Buffer> {
  switch (functionCode) {
    case FunctionCode.READ_COILS:
      return readBits(data, MAX_READ_BITS, (addr, qty) =>
        model.readCoils(addr, qty),
      );
    case FunctionCode.READ_DISCRETE_INPUTS:
      return readBits(data, MAX_READ_BITS, (addr, qty) =>
        model.readDiscreteInputs(addr, qty),
      );
    case FunctionCode.READ_HOLDING_REGISTERS:
      return readRegisters(data, (addr, qty) =>
        model.readHoldingRegisters(addr, qty),
      );
    case FunctionCode.READ_INPUT_REGISTERS:
      return readRegisters(data, (addr, qty) =>
        model.readInputRegisters(addr, qty),
      );
    case FunctionCode.WRITE_SINGLE_COIL:
      return writeSingleCoil(data, model);
    case FunctionCode.WRITE_SINGLE_REGISTER:
      return writeSingleRegister(data, model);
    case FunctionCode.WRITE_MULTIPLE_COILS:
      return writeMultipleCoils(data, model);
    case FunctionCode.WRITE_MULTIPLE_REGISTERS:
      return writeMultipleRegisters(data, model);
    default:
      throw new ModbusException(ExceptionCode.ILLEGAL_FUNCTION);
  }
}

/** Require that the request PDU body has at least `n` bytes. */
function requireBytes(data: Buffer, n: number): void {
  if (data.length < n) {
    // A truncated PDU is structurally invalid data.
    throw new ModbusException(ExceptionCode.ILLEGAL_DATA_VALUE);
  }
}

// ── FC01 / FC02: read bits ──────────────────────────────────────────────────

async function readBits(
  data: Buffer,
  maxQuantity: number,
  read: (address: number, quantity: number) => Promise<boolean[]>,
): Promise<Buffer> {
  requireBytes(data, 4);
  const address = data.readUInt16BE(0);
  const quantity = data.readUInt16BE(2);

  if (quantity < 1 || quantity > maxQuantity) {
    throw new ModbusException(ExceptionCode.ILLEGAL_DATA_VALUE);
  }

  const bits = await read(address, quantity);
  const packed = packBits(bits);
  const out = Buffer.alloc(1 + packed.length);
  out.writeUInt8(packed.length, 0); // byte count
  packed.copy(out, 1);
  return out;
}

// ── FC03 / FC04: read registers ───────────────────────────────────────────

async function readRegisters(
  data: Buffer,
  read: (address: number, quantity: number) => Promise<number[]>,
): Promise<Buffer> {
  requireBytes(data, 4);
  const address = data.readUInt16BE(0);
  const quantity = data.readUInt16BE(2);

  if (quantity < 1 || quantity > MAX_READ_REGISTERS) {
    throw new ModbusException(ExceptionCode.ILLEGAL_DATA_VALUE);
  }

  const registers = await read(address, quantity);
  const packed = packRegisters(registers);
  const out = Buffer.alloc(1 + packed.length);
  out.writeUInt8(packed.length, 0); // byte count = quantity * 2
  packed.copy(out, 1);
  return out;
}

// ── FC05: write single coil ──────────────────────────────────────────────────

async function writeSingleCoil(
  data: Buffer,
  model: ModbusDataModel,
): Promise<Buffer> {
  requireBytes(data, 4);
  const address = data.readUInt16BE(0);
  const raw = data.readUInt16BE(2);

  if (raw !== COIL_ON && raw !== COIL_OFF) {
    throw new ModbusException(ExceptionCode.ILLEGAL_DATA_VALUE);
  }

  await model.writeCoils(address, [raw === COIL_ON]);
  // Echo the request back as the response.
  return Buffer.from(data.subarray(0, 4));
}

// ── FC06: write single register ──────────────────────────────────────────────

async function writeSingleRegister(
  data: Buffer,
  model: ModbusDataModel,
): Promise<Buffer> {
  requireBytes(data, 4);
  const address = data.readUInt16BE(0);
  const value = data.readUInt16BE(2);

  await model.writeHoldingRegisters(address, [value]);
  // Echo the request back as the response.
  return Buffer.from(data.subarray(0, 4));
}

// ── FC15: write multiple coils ───────────────────────────────────────────────

async function writeMultipleCoils(
  data: Buffer,
  model: ModbusDataModel,
): Promise<Buffer> {
  requireBytes(data, 5);
  const address = data.readUInt16BE(0);
  const quantity = data.readUInt16BE(2);
  const byteCount = data.readUInt8(4);

  if (quantity < 1 || quantity > MAX_WRITE_COILS) {
    throw new ModbusException(ExceptionCode.ILLEGAL_DATA_VALUE);
  }
  if (byteCount !== Math.ceil(quantity / 8) || data.length < 5 + byteCount) {
    throw new ModbusException(ExceptionCode.ILLEGAL_DATA_VALUE);
  }

  const values = unpackBits(data.subarray(5, 5 + byteCount), quantity);
  await model.writeCoils(address, values);

  // Response: starting address + quantity of coils written.
  const out = Buffer.alloc(4);
  out.writeUInt16BE(address, 0);
  out.writeUInt16BE(quantity, 2);
  return out;
}

// ── FC16: write multiple registers ───────────────────────────────────────────

async function writeMultipleRegisters(
  data: Buffer,
  model: ModbusDataModel,
): Promise<Buffer> {
  requireBytes(data, 5);
  const address = data.readUInt16BE(0);
  const quantity = data.readUInt16BE(2);
  const byteCount = data.readUInt8(4);

  if (quantity < 1 || quantity > MAX_WRITE_REGISTERS) {
    throw new ModbusException(ExceptionCode.ILLEGAL_DATA_VALUE);
  }
  if (byteCount !== quantity * 2 || data.length < 5 + byteCount) {
    throw new ModbusException(ExceptionCode.ILLEGAL_DATA_VALUE);
  }

  const values = unpackRegisters(data.subarray(5, 5 + byteCount), quantity);
  await model.writeHoldingRegisters(address, values);

  // Response: starting address + quantity of registers written.
  const out = Buffer.alloc(4);
  out.writeUInt16BE(address, 0);
  out.writeUInt16BE(quantity, 2);
  return out;
}
