/**
 * Tests for DNP3 data-link layer framing + CRC (#464).
 */
import { describe, test, expect } from 'vitest';
import {
  dnp3Crc,
  appendCrc,
  verifyBlockCrc,
  parseLinkHeader,
  buildLinkFrame,
  extractPayload,
  buildResponseControl,
  DNP3_LINK_FUNCTION,
} from '../link-layer';

describe('dnp3Crc', () => {
  test('matches the canonical reset-link header test vector', () => {
    // 0x05 64 05 C0 01 00 00 04 -> CRC 0x21E9 (LE bytes E9 21)
    const header = Buffer.from([0x05, 0x64, 0x05, 0xc0, 0x01, 0x00, 0x00, 0x04]);
    const crc = dnp3Crc(header);
    expect(crc).toBe(0x21e9);
    const le = Buffer.alloc(2);
    le.writeUInt16LE(crc, 0);
    expect([le[0], le[1]]).toEqual([0xe9, 0x21]);
  });

  test('appendCrc + verifyBlockCrc round-trip', () => {
    const block = Buffer.from([1, 2, 3, 4, 5]);
    const withCrc = appendCrc(block);
    expect(withCrc.length).toBe(7);
    expect(verifyBlockCrc(withCrc)).toBe(true);
  });

  test('verifyBlockCrc rejects corruption', () => {
    const withCrc = appendCrc(Buffer.from([1, 2, 3]));
    withCrc[0] ^= 0xff;
    expect(verifyBlockCrc(withCrc)).toBe(false);
  });
});

describe('link header parse', () => {
  test('parses control bits and addresses', () => {
    // Build a frame and re-parse its header.
    const frame = buildLinkFrame({
      control: 0xc4, // DIR=1, PRM=1, func=4 (unconfirmed user data)
      destination: 0x000a,
      source: 0x0001,
      payload: Buffer.from([0xc0, 0x01]),
    });
    const header = parseLinkHeader(frame);
    expect(header).not.toBeNull();
    expect(header!.dir).toBe(true);
    expect(header!.prm).toBe(true);
    expect(header!.func).toBe(0x4);
    expect(header!.destination).toBe(0x000a);
    expect(header!.source).toBe(0x0001);
  });

  test('rejects bad start bytes', () => {
    const buf = Buffer.alloc(10);
    expect(parseLinkHeader(buf)).toBeNull();
  });

  test('rejects bad header CRC', () => {
    const frame = buildLinkFrame({ control: 0xc4, destination: 1, source: 2, payload: Buffer.from([1]) });
    frame[8] ^= 0xff; // corrupt header CRC
    expect(parseLinkHeader(frame)).toBeNull();
  });
});

describe('buildLinkFrame / extractPayload', () => {
  test('round-trips a short payload', () => {
    const payload = Buffer.from([0xc0, 0x01, 0x3c, 0x01, 0x06]); // read class 0
    const frame = buildLinkFrame({ control: 0xc4, destination: 0x000a, source: 0x0001, payload });
    const extracted = extractPayload(frame);
    expect(extracted).not.toBeNull();
    expect(extracted!.payload.equals(payload)).toBe(true);
    expect(extracted!.header.source).toBe(0x0001);
  });

  test('round-trips a multi-block (>16 byte) payload', () => {
    const payload = Buffer.alloc(40);
    for (let i = 0; i < payload.length; i++) payload[i] = i;
    const frame = buildLinkFrame({ control: 0xc4, destination: 5, source: 6, payload });
    const extracted = extractPayload(frame);
    expect(extracted).not.toBeNull();
    expect(extracted!.payload.equals(payload)).toBe(true);
  });

  test('extractPayload returns null when a data-block CRC is corrupt', () => {
    const payload = Buffer.from([1, 2, 3, 4]);
    const frame = buildLinkFrame({ control: 0xc4, destination: 1, source: 2, payload });
    // The first data block CRC is at offset 10 + 4.
    frame[10] ^= 0xff;
    expect(extractPayload(frame)).toBeNull();
  });

  test('rejects oversized payload (>250 user octets)', () => {
    expect(() =>
      buildLinkFrame({ control: 0xc4, destination: 1, source: 2, payload: Buffer.alloc(300) }),
    ).toThrow(/too long/);
  });
});

describe('buildResponseControl', () => {
  test('sets PRM and the function nibble', () => {
    const ctrl = buildResponseControl(DNP3_LINK_FUNCTION.UNCONFIRMED_USER_DATA);
    expect(ctrl & 0x0f).toBe(DNP3_LINK_FUNCTION.UNCONFIRMED_USER_DATA);
    expect(ctrl & 0x40).toBe(0x40); // PRM
    expect(ctrl & 0x80).toBe(0); // DIR=0 (outstation)
  });
});
