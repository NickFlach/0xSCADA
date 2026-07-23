/**
 * Byte-level regression tests for the vendor fix cluster #360–365 (issue #484).
 *
 * These pin the exact wire encoding so a merge can never silently revert the
 * fixes again (which is precisely what happened — #362 SZL and #363 pduRef were
 * reverted by merge 4efe59bc5 with no test to catch it).
 */
import { describe, it, expect } from 'vitest';
import {
  encodeModbusTcpRequest,
  buildModbusWriteMultipleRegisters,
  ModbusTransactionCounter,
  MODBUS_FC,
} from '../modbus-utils';
import { buildS7SzlRead, nextPduRef } from '../siemens-adapter';
import { encodeHartShortFrame } from '../emerson-adapter';
import {
  sendIec104IFrame,
  acknowledgeIec104Frames,
  processIncomingIec104Frame,
  Iec104WindowFullError,
  IEC104_PARAMS,
} from '../schneider-adapter';
import { relayFeedbackAnalysis } from '../../optimization/pid-autotuner';
import { PIDController } from '../../optimization/pid-controller';

// ─── #360 — Emerson Modbus WriteMultipleRegisters unitId ─────────────────────

describe('#360 Modbus unitId is written from the argument, not hardcoded', () => {
  it('encodeModbusTcpRequest places the passed unitId at MBAP offset 6', () => {
    const frame = encodeModbusTcpRequest(0x2A, MODBUS_FC.READ_HOLDING_REGISTERS, Buffer.from([0, 0, 0, 1]));
    expect(frame.readUInt8(6)).toBe(0x2A); // Unit Identifier
  });

  it('buildModbusWriteMultipleRegisters carries the unitId into the frame', () => {
    const frame = buildModbusWriteMultipleRegisters(0x11, 100, [1, 2, 3]);
    expect(frame.readUInt8(6)).toBe(0x11);
    expect(frame.readUInt8(7)).toBe(MODBUS_FC.WRITE_MULTIPLE_REGISTERS); // FC after MBAP
  });
});

// ─── #361 — HART short-frame allocation (off-by-one) ─────────────────────────

describe('#361 HART short frame is sized to include the byteCount byte', () => {
  it('encodes without overflowing the buffer (bug caused a RangeError)', () => {
    expect(() => encodeHartShortFrame(0, 0x00, Buffer.from([1, 2, 3]))).not.toThrow();
  });

  it('frame length grows by exactly the data length (nothing truncated)', () => {
    const empty = encodeHartShortFrame(0, 0x00, Buffer.alloc(0));
    const withData = encodeHartShortFrame(0, 0x00, Buffer.from([9, 9, 9, 9]));
    expect(withData.length - empty.length).toBe(4);
  });

  it('the byteCount field equals data.length and a checksum byte follows the data', () => {
    const data = Buffer.from([0xAA, 0xBB, 0xCC]);
    const frame = encodeHartShortFrame(0, 0x00, data);
    // Layout tail: [... byteCount][data...][checksum]. byteCount is 1 before data.
    const byteCountPos = frame.length - data.length - 2;
    expect(frame.readUInt8(byteCountPos)).toBe(data.length);
    // Checksum (last byte) = XOR of everything after the preamble (delimiter onward).
    // Locate the delimiter: first non-preamble byte. Preamble is repeated 0xFF.
    let i = 0;
    while (i < frame.length && frame[i] === 0xFF) i++;
    let cs = 0;
    for (let j = i; j < frame.length - 1; j++) cs ^= frame[j];
    expect(frame[frame.length - 1]).toBe(cs);
  });
});

// ─── #362 — Siemens S7 SZL read data section ─────────────────────────────────

describe('#362 buildS7SzlRead writes the SZL ID/Index data section', () => {
  it('produces a 28-byte frame with data length 8 and the SZL ID/Index', () => {
    const frame = buildS7SzlRead(1, 0x0011, 0x0003);
    expect(frame.length).toBe(28);
    // S7 header: data-length field at offset 8 must be 8 (was 4 in the reverted bug).
    expect(frame.readUInt16BE(8)).toBe(8);
    // Data section starts at offset 18 (10 header + 8 param):
    expect(frame.readUInt8(18)).toBe(0xFF);   // return code: success
    expect(frame.readUInt8(19)).toBe(0x09);   // transport size: octet string
    expect(frame.readUInt16BE(20)).toBe(4);   // data length (SZL ID + Index)
    expect(frame.readUInt16BE(22)).toBe(0x0011); // SZL ID
    expect(frame.readUInt16BE(24)).toBe(0x0003); // SZL Index
  });

  it('the szlId/szlIndex args actually affect the bytes (were unused in the bug)', () => {
    const a = buildS7SzlRead(1, 0x00A0, 0x0000);
    const b = buildS7SzlRead(1, 0x0131, 0x0007);
    expect(a.readUInt16BE(22)).toBe(0x00A0);
    expect(b.readUInt16BE(22)).toBe(0x0131);
    expect(b.readUInt16BE(24)).toBe(0x0007);
  });
});

// ─── #363 — Siemens pduRef wrap (RangeError at 65536) ────────────────────────

describe('#363 pduRef is masked to 16 bits (no RangeError at 65536)', () => {
  it('nextPduRef wraps 0xFFFF → 0', () => {
    const conn = { pduRef: 0xFFFF };
    expect(nextPduRef(conn)).toBe(0);
    expect(conn.pduRef).toBe(0);
  });

  it('stays in [0, 0xFFFF] across a full wrap and never overflows writeUInt16BE', () => {
    const conn = { pduRef: 0xFFFE };
    for (let i = 0; i < 5; i++) {
      const ref = nextPduRef(conn);
      expect(ref).toBeGreaterThanOrEqual(0);
      expect(ref).toBeLessThanOrEqual(0xFFFF);
      // The reverted bug did `++conn.pduRef` → 65536 → this throws.
      expect(() => buildS7SzlRead(ref, 0x0011)).not.toThrow();
    }
  });
});

// ─── #363 — Schneider IEC-104 k=12 unconfirmed-frame window ───────────────────

describe('#363 IEC-104 k=12 send window is enforced', () => {
  function freshConn() {
    return { sendSeq: 0, receiveSeq: 0, unconfirmedSent: 0, ackReceiveSeq: 0 } as any;
  }
  const asdu = Buffer.from([0x64, 0x01, 0x06, 0x00, 0x01, 0x00]);

  it('allows exactly K unconfirmed I-frames, then blocks the K+1th', () => {
    const conn = freshConn();
    for (let i = 0; i < IEC104_PARAMS.K; i++) {
      expect(() => sendIec104IFrame(conn, asdu)).not.toThrow();
    }
    expect(conn.unconfirmedSent).toBe(IEC104_PARAMS.K);
    expect(() => sendIec104IFrame(conn, asdu)).toThrow(Iec104WindowFullError);
  });

  it('acknowledging frames reopens the window', () => {
    const conn = freshConn();
    for (let i = 0; i < IEC104_PARAMS.K; i++) sendIec104IFrame(conn, asdu);
    expect(() => sendIec104IFrame(conn, asdu)).toThrow(); // full
    acknowledgeIec104Frames(conn, 5);
    expect(conn.unconfirmedSent).toBe(IEC104_PARAMS.K - 5);
    for (let i = 0; i < 5; i++) expect(() => sendIec104IFrame(conn, asdu)).not.toThrow();
    expect(() => sendIec104IFrame(conn, asdu)).toThrow();
  });

  it('an incoming S-frame acknowledges sent frames via its receive sequence', () => {
    const conn = freshConn();
    for (let i = 0; i < 4; i++) sendIec104IFrame(conn, asdu); // unconfirmedSent=4
    // S-format frame: 0x68, len, ctrl(0x01), 0x00, receiveSeq<<1 (LE)
    const sFrame = Buffer.alloc(6);
    sFrame.writeUInt8(0x68, 0);
    sFrame.writeUInt8(4, 1);
    sFrame.writeUInt8(0x01, 2); // S-format
    sFrame.writeUInt8(0x00, 3);
    sFrame.writeUInt16LE(3 << 1, 4); // receiveSeq = 3
    const frame = processIncomingIec104Frame(conn, sFrame);
    expect(frame.type).toBe('S');
    expect(conn.unconfirmedSent).toBe(1); // 3 of 4 confirmed
  });
});

// ─── #363 — Modbus transaction IDs per-instance ──────────────────────────────

describe('#363 Modbus transaction IDs are per-instance, not global', () => {
  it('two counters advance independently', () => {
    const a = new ModbusTransactionCounter();
    const b = new ModbusTransactionCounter();
    expect(a.next()).toBe(0);
    expect(a.next()).toBe(1);
    expect(b.next()).toBe(0); // NOT 2 — independent of a
    expect(a.next()).toBe(2);
    expect(b.next()).toBe(1);
  });

  it('a counter wraps at 16 bits', () => {
    const c = new ModbusTransactionCounter();
    for (let i = 0; i < 0xFFFF; i++) c.next();
    expect(c.next()).toBe(0xFFFF);
    expect(c.next()).toBe(0); // wraps
  });

  it('encodeModbusTcpRequest uses the supplied transaction id at MBAP offset 0', () => {
    const c = new ModbusTransactionCounter();
    const t0 = c.next();
    const frame = encodeModbusTcpRequest(1, MODBUS_FC.READ_COILS, Buffer.from([0, 0, 0, 1]), t0);
    expect(frame.readUInt16BE(0)).toBe(t0);
  });
});

// ─── #364 — PID relay-feedback stores PV values separately from timestamps ───

describe('#364 relay-feedback derives Ku from PV values and Tu from timestamps', () => {
  it('Tu comes from peak timestamps; Ku from peak/valley VALUES', () => {
    const relayAmplitude = 10;
    const peakTimestamps = [1000, 2000, 3000]; // 1000ms spacing → Tu=1000
    const valleyTimestamps = [1500, 2500, 3500];
    const peakValues = [12, 12, 12];   // PV peaks
    const valleyValues = [8, 8, 8];    // PV valleys → amplitude=(12-8)/2=2
    const result = relayFeedbackAnalysis(relayAmplitude, peakTimestamps, valleyTimestamps, peakValues, valleyValues);
    expect(result).not.toBeNull();
    expect(result!.tu).toBe(1000); // from timestamps, NOT conflated with values
    // Ku = 4d/(π·a) = 40/(π·2)
    expect(result!.ku).toBeCloseTo(40 / (Math.PI * 2), 6);
  });

  it('returns null without separate value arrays (bug stored values as timestamps)', () => {
    expect(relayFeedbackAnalysis(10, [1000, 2000], [1500, 2500])).toBeNull();
  });
});

// ─── #365 — PID anti-windup floating-point comparison ────────────────────────

describe('#365 PID anti-windup holds the integral under saturation', () => {
  it('does not wind the integral up to its limit when the output is saturated', () => {
    const pid = new PIDController({
      id: 'awt', name: 'anti-windup', gains: { kp: 0, ki: 1, kd: 0 },
      setpoint: 100, outputMin: 0, outputMax: 10, integralLimit: 1000, sampleTime: 1,
    });
    let state = pid.update(0); // large error → output saturates at 10
    for (let i = 0; i < 60; i++) state = pid.update(0, 1);
    // With anti-windup the integral is held near the saturation point; without it
    // (the bug's exact float comparison) it winds up to integralLimit (1000).
    expect(Math.abs(state.integral)).toBeLessThan(500);
  });
});
