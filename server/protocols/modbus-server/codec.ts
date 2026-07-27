/**
 * Modbus TCP wire codec — MBAP header + PDU encode/decode.
 *
 * Issue #462: Modbus TCP Server Mode.
 *
 * This module implements the Modbus TCP framing from scratch (no external
 * dependency) so it is fully unit-testable. It deals ONLY with bytes <-> typed
 * request/response objects; it has no knowledge of the data model, the tag
 * store, or sockets. See `handlers.ts` for request processing.
 *
 * Frame layout (Modbus Application Protocol / "Modbus Messaging on TCP/IP",
 * MODBUS Messaging Implementation Guide v1.0b):
 *
 *   MBAP header (7 bytes):
 *     [0..1] Transaction Identifier (echoed back unchanged)
 *     [2..3] Protocol Identifier     (0x0000 for Modbus)
 *     [4..5] Length                  (number of following bytes = unitId + PDU)
 *     [6]    Unit Identifier         (a.k.a. slave / server address)
 *   PDU:
 *     [7]    Function code
 *     [8..]  Function-specific data
 */

import {
  MODBUS_EXCEPTION_CODES,
  MODBUS_FUNCTION_CODES,
} from "@shared/protocols/modbus-constants";

/**
 * Standard Modbus function codes supported by this server — the subset of the
 * shared {@link MODBUS_FUNCTION_CODES} this server implements. Sourcing the
 * values from the shared module keeps them in lock-step with the vendor-side
 * `MODBUS_FC` (issue #370 / #462).
 */
export const FunctionCode = {
  READ_COILS: MODBUS_FUNCTION_CODES.READ_COILS,
  READ_DISCRETE_INPUTS: MODBUS_FUNCTION_CODES.READ_DISCRETE_INPUTS,
  READ_HOLDING_REGISTERS: MODBUS_FUNCTION_CODES.READ_HOLDING_REGISTERS,
  READ_INPUT_REGISTERS: MODBUS_FUNCTION_CODES.READ_INPUT_REGISTERS,
  WRITE_SINGLE_COIL: MODBUS_FUNCTION_CODES.WRITE_SINGLE_COIL,
  WRITE_SINGLE_REGISTER: MODBUS_FUNCTION_CODES.WRITE_SINGLE_REGISTER,
  WRITE_MULTIPLE_COILS: MODBUS_FUNCTION_CODES.WRITE_MULTIPLE_COILS,
  WRITE_MULTIPLE_REGISTERS: MODBUS_FUNCTION_CODES.WRITE_MULTIPLE_REGISTERS,
} as const;

export type FunctionCode = (typeof FunctionCode)[keyof typeof FunctionCode];

/**
 * Modbus exception codes this server can return (set in responses with the high
 * bit of the FC set) — the subset of the shared {@link MODBUS_EXCEPTION_CODES}
 * it produces.
 */
export const ExceptionCode = {
  ILLEGAL_FUNCTION: MODBUS_EXCEPTION_CODES.ILLEGAL_FUNCTION,
  ILLEGAL_DATA_ADDRESS: MODBUS_EXCEPTION_CODES.ILLEGAL_DATA_ADDRESS,
  ILLEGAL_DATA_VALUE: MODBUS_EXCEPTION_CODES.ILLEGAL_DATA_VALUE,
  SERVER_DEVICE_FAILURE: MODBUS_EXCEPTION_CODES.SERVER_DEVICE_FAILURE,
} as const;

export type ExceptionCode = (typeof ExceptionCode)[keyof typeof ExceptionCode];

/** Bit set in a response function code to flag an exception (FC | 0x80). */
export const EXCEPTION_FLAG = 0x80;

export const MBAP_HEADER_LENGTH = 7;
export const MODBUS_PROTOCOL_ID = 0x0000;
/** Modbus caps a single read at 0x07D0 (2000) coils/inputs. */
export const MAX_READ_BITS = 0x07d0;
/** Modbus caps a single read at 0x007D (125) registers. */
export const MAX_READ_REGISTERS = 0x007d;
/** Modbus caps writes at 0x07B0 (1968) coils. */
export const MAX_WRITE_COILS = 0x07b0;
/** Modbus caps writes at 0x007B (123) registers. */
export const MAX_WRITE_REGISTERS = 0x007b;

/** Parsed MBAP header. */
export interface MbapHeader {
  transactionId: number;
  protocolId: number;
  /** Declared length of (unitId + PDU). */
  length: number;
  unitId: number;
}

/** A fully decoded request: MBAP header + the raw PDU bytes. */
export interface ModbusRequest {
  header: MbapHeader;
  functionCode: number;
  /** PDU bytes AFTER the function code byte. */
  data: Buffer;
}

/** Raised when a buffer cannot be decoded into a Modbus frame. */
export class ModbusFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModbusFrameError";
  }
}

/**
 * Decode the 7-byte MBAP header.
 * @throws {ModbusFrameError} if the buffer is shorter than the header.
 */
export function decodeMbapHeader(buf: Buffer): MbapHeader {
  if (buf.length < MBAP_HEADER_LENGTH) {
    throw new ModbusFrameError(
      `MBAP header requires ${MBAP_HEADER_LENGTH} bytes, got ${buf.length}`,
    );
  }
  return {
    transactionId: buf.readUInt16BE(0),
    protocolId: buf.readUInt16BE(2),
    length: buf.readUInt16BE(4),
    unitId: buf.readUInt8(6),
  };
}

/**
 * Encode an MBAP header. `pduLength` is the length of the PDU (function code +
 * data); the declared MBAP length field is `pduLength + 1` to include unitId.
 */
export function encodeMbapHeader(
  header: Omit<MbapHeader, "length">,
  pduLength: number,
): Buffer {
  const out = Buffer.alloc(MBAP_HEADER_LENGTH);
  out.writeUInt16BE(header.transactionId & 0xffff, 0);
  out.writeUInt16BE(header.protocolId & 0xffff, 2);
  out.writeUInt16BE((pduLength + 1) & 0xffff, 4); // +1 for unit id
  out.writeUInt8(header.unitId & 0xff, 6);
  return out;
}

/**
 * Attempt to decode a single complete Modbus TCP frame from `buf`.
 *
 * Returns the decoded request plus the number of bytes consumed, or `null` if
 * the buffer does not yet contain a complete frame (the caller should wait for
 * more bytes — TCP is a stream and frames may be split or coalesced).
 *
 * @throws {ModbusFrameError} for structurally invalid frames (bad protocol id,
 *   nonsensical length) so the caller can close the connection.
 */
export function decodeRequest(
  buf: Buffer,
): { request: ModbusRequest; bytesConsumed: number } | null {
  if (buf.length < MBAP_HEADER_LENGTH) {
    return null; // need more bytes for the header
  }

  const header = decodeMbapHeader(buf);

  if (header.protocolId !== MODBUS_PROTOCOL_ID) {
    throw new ModbusFrameError(
      `Unexpected protocol id 0x${header.protocolId.toString(16)}`,
    );
  }
  // Length field counts unitId(1) + PDU. PDU must contain at least the FC byte.
  if (header.length < 2) {
    throw new ModbusFrameError(`Invalid MBAP length ${header.length}`);
  }

  const frameLength = MBAP_HEADER_LENGTH - 1 + header.length; // 6 + length
  if (buf.length < frameLength) {
    return null; // incomplete — wait for more bytes
  }

  const functionCode = buf.readUInt8(MBAP_HEADER_LENGTH);
  const data = buf.subarray(MBAP_HEADER_LENGTH + 1, frameLength);

  return {
    request: { header, functionCode, data: Buffer.from(data) },
    bytesConsumed: frameLength,
  };
}

/**
 * Encode a normal (non-exception) response frame.
 * `responsePdu` is the PDU body AFTER the function code byte.
 */
export function encodeResponse(
  header: Pick<MbapHeader, "transactionId" | "protocolId" | "unitId">,
  functionCode: number,
  responsePdu: Buffer,
): Buffer {
  const pduLength = 1 + responsePdu.length; // FC + body
  const mbap = encodeMbapHeader(header, pduLength);
  const fc = Buffer.from([functionCode & 0xff]);
  return Buffer.concat([mbap, fc, responsePdu]);
}

/**
 * Encode an exception response frame: function code with the high bit set,
 * followed by a single exception-code byte.
 */
export function encodeExceptionResponse(
  header: Pick<MbapHeader, "transactionId" | "protocolId" | "unitId">,
  functionCode: number,
  exceptionCode: ExceptionCode,
): Buffer {
  const mbap = encodeMbapHeader(header, 2); // FC + exception byte
  const body = Buffer.from([
    (functionCode | EXCEPTION_FLAG) & 0xff,
    exceptionCode & 0xff,
  ]);
  return Buffer.concat([mbap, body]);
}

/**
 * Pack an array of booleans into Modbus coil/discrete-input bytes (LSB-first
 * within each byte, per the spec). Used by FC01/FC02 responses.
 */
export function packBits(bits: boolean[]): Buffer {
  const byteCount = Math.ceil(bits.length / 8);
  const out = Buffer.alloc(byteCount);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) {
      out[Math.floor(i / 8)] |= 1 << i % 8;
    }
  }
  return out;
}

/**
 * Unpack `count` booleans from Modbus coil bytes (LSB-first within each byte).
 * Used to decode FC15 (write multiple coils) request bodies.
 */
export function unpackBits(buf: Buffer, count: number): boolean[] {
  const bits: boolean[] = [];
  for (let i = 0; i < count; i++) {
    const byte = buf[Math.floor(i / 8)] ?? 0;
    bits.push((byte & (1 << i % 8)) !== 0);
  }
  return bits;
}

/** Pack an array of 16-bit register values into a big-endian buffer. */
export function packRegisters(registers: number[]): Buffer {
  const out = Buffer.alloc(registers.length * 2);
  for (let i = 0; i < registers.length; i++) {
    out.writeUInt16BE(registers[i] & 0xffff, i * 2);
  }
  return out;
}

/** Unpack `count` big-endian 16-bit register values from a buffer. */
export function unpackRegisters(buf: Buffer, count: number): number[] {
  const registers: number[] = [];
  for (let i = 0; i < count; i++) {
    registers.push(buf.readUInt16BE(i * 2));
  }
  return registers;
}
