/**
 * Codec tests (#462): MBAP/PDU decode + encode round-trips.
 */
import { describe, it, expect } from "vitest";
import {
  EXCEPTION_FLAG,
  ExceptionCode,
  MBAP_HEADER_LENGTH,
  MODBUS_PROTOCOL_ID,
  ModbusFrameError,
  decodeMbapHeader,
  decodeRequest,
  encodeExceptionResponse,
  encodeMbapHeader,
  encodeResponse,
  packBits,
  packRegisters,
  unpackBits,
  unpackRegisters,
} from "../codec";

describe("MBAP header", () => {
  it("encodes then decodes to the same values (round-trip)", () => {
    const header = { transactionId: 0x1234, protocolId: 0, unitId: 0x11 };
    const pduLength = 5; // FC + 4 data bytes
    const buf = encodeMbapHeader(header, pduLength);

    expect(buf.length).toBe(MBAP_HEADER_LENGTH);
    const decoded = decodeMbapHeader(buf);
    expect(decoded.transactionId).toBe(0x1234);
    expect(decoded.protocolId).toBe(MODBUS_PROTOCOL_ID);
    expect(decoded.unitId).toBe(0x11);
    // Length = pduLength + 1 (unit id)
    expect(decoded.length).toBe(pduLength + 1);
  });

  it("throws on a too-short buffer", () => {
    expect(() => decodeMbapHeader(Buffer.alloc(3))).toThrow(ModbusFrameError);
  });
});

describe("decodeRequest", () => {
  function frame(
    transactionId: number,
    unitId: number,
    fc: number,
    data: Buffer,
  ): Buffer {
    const pduLength = 1 + data.length;
    const header = encodeMbapHeader(
      { transactionId, protocolId: 0, unitId },
      pduLength,
    );
    return Buffer.concat([header, Buffer.from([fc]), data]);
  }

  it("decodes a complete FC03 request", () => {
    const data = Buffer.from([0x00, 0x6b, 0x00, 0x03]); // addr 107, qty 3
    const buf = frame(0x0001, 0x01, 0x03, data);

    const result = decodeRequest(buf);
    expect(result).not.toBeNull();
    expect(result!.bytesConsumed).toBe(buf.length);
    expect(result!.request.functionCode).toBe(0x03);
    expect(result!.request.header.transactionId).toBe(1);
    expect(result!.request.data.equals(data)).toBe(true);
  });

  it("returns null for an incomplete header", () => {
    expect(decodeRequest(Buffer.alloc(3))).toBeNull();
  });

  it("returns null for an incomplete body (partial frame)", () => {
    const data = Buffer.from([0x00, 0x6b, 0x00, 0x03]);
    const buf = frame(0x0001, 0x01, 0x03, data);
    // Drop the last 2 bytes
    expect(decodeRequest(buf.subarray(0, buf.length - 2))).toBeNull();
  });

  it("consumes only the first frame when two are coalesced", () => {
    const a = frame(0x0001, 0x01, 0x03, Buffer.from([0, 0, 0, 1]));
    const b = frame(0x0002, 0x01, 0x03, Buffer.from([0, 5, 0, 1]));
    const combined = Buffer.concat([a, b]);

    const first = decodeRequest(combined)!;
    expect(first.bytesConsumed).toBe(a.length);
    expect(first.request.header.transactionId).toBe(1);

    const rest = combined.subarray(first.bytesConsumed);
    const second = decodeRequest(rest)!;
    expect(second.request.header.transactionId).toBe(2);
  });

  it("throws on an unexpected protocol id", () => {
    const buf = frame(0x0001, 0x01, 0x03, Buffer.from([0, 0, 0, 1]));
    buf.writeUInt16BE(0x0001, 2); // corrupt protocol id
    expect(() => decodeRequest(buf)).toThrow(ModbusFrameError);
  });

  it("throws on an MBAP length below the minimum", () => {
    const buf = frame(0x0001, 0x01, 0x03, Buffer.from([0, 0, 0, 1]));
    buf.writeUInt16BE(0x0001, 4); // length = 1 (no room for PDU)
    expect(() => decodeRequest(buf)).toThrow(ModbusFrameError);
  });
});

describe("response encoding", () => {
  it("encodes a normal response and decodes back into a frame", () => {
    const header = { transactionId: 0x2222, protocolId: 0, unitId: 0x05 };
    const pdu = Buffer.from([0x02, 0xca, 0xfe]); // byte count + 2 bytes
    const buf = encodeResponse(header, 0x03, pdu);

    const decoded = decodeRequest(buf)!;
    expect(decoded.request.functionCode).toBe(0x03);
    expect(decoded.request.header.transactionId).toBe(0x2222);
    expect(decoded.request.data.equals(pdu)).toBe(true);
  });

  it("encodes an exception response with the FC high bit set", () => {
    const header = { transactionId: 7, protocolId: 0, unitId: 1 };
    const buf = encodeExceptionResponse(
      header,
      0x03,
      ExceptionCode.ILLEGAL_DATA_ADDRESS,
    );
    // FC byte = 0x83, exception byte = 0x02
    expect(buf.readUInt8(MBAP_HEADER_LENGTH)).toBe(0x03 | EXCEPTION_FLAG);
    expect(buf.readUInt8(MBAP_HEADER_LENGTH + 1)).toBe(
      ExceptionCode.ILLEGAL_DATA_ADDRESS,
    );
  });
});

describe("bit packing", () => {
  it("packs and unpacks bits LSB-first", () => {
    const bits = [true, false, true, true, false, false, false, false, true];
    const packed = packBits(bits);
    expect(packed.length).toBe(2); // 9 bits -> 2 bytes
    expect(packed[0]).toBe(0b00001101); // bits 0,2,3
    expect(packed[1]).toBe(0b00000001); // bit 8
    expect(unpackBits(packed, bits.length)).toEqual(bits);
  });

  it("round-trips a single byte boundary", () => {
    const bits = [true, true, true, true, true, true, true, true];
    expect(unpackBits(packBits(bits), 8)).toEqual(bits);
  });
});

describe("register packing", () => {
  it("packs and unpacks 16-bit registers big-endian", () => {
    const regs = [0x1234, 0xabcd, 0x0001];
    const packed = packRegisters(regs);
    expect(packed.length).toBe(6);
    expect(packed.readUInt16BE(0)).toBe(0x1234);
    expect(unpackRegisters(packed, regs.length)).toEqual(regs);
  });
});
