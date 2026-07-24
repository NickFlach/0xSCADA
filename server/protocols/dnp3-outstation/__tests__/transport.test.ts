/**
 * Tests for DNP3 transport segmentation / reassembly (#464).
 */
import { describe, test, expect } from 'vitest';
import {
  segment,
  TransportReassembler,
  TRANSPORT_FIR,
  TRANSPORT_FIN,
} from '../transport';

describe('segment', () => {
  test('single small fragment => one FIR+FIN segment', () => {
    const segs = segment(Buffer.from([1, 2, 3]), 0);
    expect(segs.length).toBe(1);
    expect(segs[0][0] & TRANSPORT_FIR).toBe(TRANSPORT_FIR);
    expect(segs[0][0] & TRANSPORT_FIN).toBe(TRANSPORT_FIN);
    expect(segs[0].subarray(1).equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  test('empty fragment => single empty FIR+FIN segment', () => {
    const segs = segment(Buffer.alloc(0), 5);
    expect(segs.length).toBe(1);
    expect(segs[0].length).toBe(1);
    expect(segs[0][0] & 0x3f).toBe(5);
  });

  test('large fragment splits with FIR on first, FIN on last only', () => {
    const data = Buffer.alloc(600, 0x55);
    const segs = segment(data, 0, 249);
    expect(segs.length).toBe(3); // 249 + 249 + 102
    expect(segs[0][0] & TRANSPORT_FIR).toBe(TRANSPORT_FIR);
    expect(segs[0][0] & TRANSPORT_FIN).toBe(0);
    expect(segs[1][0] & TRANSPORT_FIR).toBe(0);
    expect(segs[1][0] & TRANSPORT_FIN).toBe(0);
    expect(segs[2][0] & TRANSPORT_FIN).toBe(TRANSPORT_FIN);
  });

  test('sequence numbers increment and wrap mod 64', () => {
    const data = Buffer.alloc(249 * 2 + 10);
    const segs = segment(data, 63, 249);
    expect(segs[0][0] & 0x3f).toBe(63);
    expect(segs[1][0] & 0x3f).toBe(0); // wrapped
    expect(segs[2][0] & 0x3f).toBe(1);
  });
});

describe('TransportReassembler', () => {
  test('reassembles a multi-segment fragment', () => {
    const data = Buffer.alloc(600);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
    const segs = segment(data, 0, 249);
    const rasm = new TransportReassembler();
    let result;
    for (const s of segs) result = rasm.accept(s);
    expect(result!.fragment).toBeDefined();
    expect(result!.fragment!.equals(data)).toBe(true);
  });

  test('single-segment fragment returns immediately', () => {
    const rasm = new TransportReassembler();
    const r = rasm.accept(segment(Buffer.from([9, 9]))[0]);
    expect(r.fragment!.equals(Buffer.from([9, 9]))).toBe(true);
  });

  test('non-FIR first segment is an error', () => {
    const rasm = new TransportReassembler();
    const r = rasm.accept(Buffer.from([0x00, 0xaa])); // no FIR
    expect(r.error).toBe('missing-fir');
  });

  test('out-of-order sequence resets reassembly', () => {
    const rasm = new TransportReassembler();
    rasm.accept(Buffer.from([TRANSPORT_FIR | 0, 0x01])); // FIR seq 0
    const r = rasm.accept(Buffer.from([0x05, 0x02])); // expected seq 1, got 5
    expect(r.error).toBe('unexpected-sequence');
  });

  test('reset discards partial state', () => {
    const rasm = new TransportReassembler();
    rasm.accept(Buffer.from([TRANSPORT_FIR | 0, 0x01]));
    rasm.reset();
    const r = rasm.accept(Buffer.from([0x01, 0x02])); // no FIR after reset
    expect(r.error).toBe('missing-fir');
  });
});
