/**
 * End-to-end Class 0/1/2/3 read tests through the pure application handler (#464).
 *
 * These assert the bytes a master would actually receive: the application
 * header (FIR/FIN/CON/sequence + IIN) plus the serialised event objects, the
 * multi-fragment split, and the rule that events only leave the buffer on an
 * application CONFIRM.
 */
import { describe, test, expect } from 'vitest';
import {
  createOutstationContext,
  handleApplicationRequest,
  type OutstationContext,
} from '../index';
import { parseRequest, APP_CTRL_CON, APP_CTRL_FIR, APP_CTRL_FIN } from '../app-layer';
import { Dnp3PointMap } from '../point-map';
import { Dnp3EventBuffer, type EventClass } from '../event-buffer';
import { DNP3_FUNCTION, DNP3_GROUP, DNP3_IIN, DNP3_VARIATION, DNP3_FLAG } from '../app-objects';

const T0 = 0xabcdef;

/** READ g60 for the given classes, with qualifier 0x06 (all objects). */
function readClasses(seq: number, ...classes: (0 | 1 | 2 | 3)[]): ReturnType<typeof parseRequest> {
  const variationOf = { 0: DNP3_VARIATION.CLASS0, 1: DNP3_VARIATION.CLASS1, 2: DNP3_VARIATION.CLASS2, 3: DNP3_VARIATION.CLASS3 };
  const bytes = [0xc0 | (seq & 0x0f), DNP3_FUNCTION.READ];
  for (const cls of classes) bytes.push(DNP3_GROUP.CLASS_DATA, variationOf[cls], 0x06);
  return parseRequest(Buffer.from(bytes));
}

/** An application CONFIRM (function 0x00) for a given sequence number. */
function confirm(seq: number): ReturnType<typeof parseRequest> {
  return parseRequest(Buffer.from([0xc0 | (seq & 0x0f), DNP3_FUNCTION.CONFIRM]));
}

function makeCtx(opts?: { maxTxFragmentSize?: number }): OutstationContext {
  const pointMap = new Dnp3PointMap({
    points: [
      { tagId: 'bi3', type: 'binaryInput', index: 3, eventClass: 1 },
      { tagId: 'bi7', type: 'binaryInput', index: 7, eventClass: 1 },
      { tagId: 'c0', type: 'counter', index: 0, eventClass: 2 },
      { tagId: 'ai1', type: 'analogInput', index: 1, eventClass: 3, encoding: 'int32' },
    ],
  });
  return createOutstationContext({
    pointMap,
    eventBuffer: new Dnp3EventBuffer(),
    maxTxFragmentSize: opts?.maxTxFragmentSize,
  });
}

function pushBinaryEvent(ctx: OutstationContext, index: number, on: boolean, timestamp: number, cls: EventClass = 1): number {
  return ctx.eventBuffer.enqueue({
    pointType: 'binaryInput',
    index,
    eventClass: cls,
    value: on,
    flags: on ? DNP3_FLAG.ONLINE | DNP3_FLAG.STATE : DNP3_FLAG.ONLINE,
    timestamp,
  });
}

describe('Class 1/2/3 read with an empty buffer', () => {
  test('returns a bare 4-octet header with no class-event IIN bits and no CON', () => {
    const ctx = makeCtx();
    const { response, fragments } = handleApplicationRequest(ctx, readClasses(1, 1, 2, 3));
    expect(fragments).toHaveLength(1);
    expect([...response]).toEqual([
      0xc1, // FIR|FIN, no CON, sequence 1
      0x81, // RESPONSE
      0x00, 0x00, // IIN: nothing pending
    ]);
    expect(fragments[0].con).toBe(false);
    expect(fragments[0].eventSeqs).toEqual([]);
  });
});

describe('Class 1 read with buffered events — golden vector', () => {
  test('serialises g2v2 objects into the response and sets CON + the class-1 IIN bit', () => {
    const ctx = makeCtx();
    pushBinaryEvent(ctx, 3, true, T0);
    pushBinaryEvent(ctx, 7, false, T0 + 6);

    const { response, fragments } = handleApplicationRequest(ctx, readClasses(0, 1));
    expect([...response]).toEqual([
      // ── application header ──
      0xe0, // FIR|FIN|CON, sequence 0
      0x81, // RESPONSE
      0x00, 0x02, // IIN little-endian: 0x0200 = CLASS1_EVENTS
      // ── g2v2 events, qualifier 0x17, count 2 ──
      0x02, 0x02, 0x17, 0x02,
      0x03, 0x81, 0xef, 0xcd, 0xab, 0x00, 0x00, 0x00,
      0x07, 0x01, 0xf5, 0xcd, 0xab, 0x00, 0x00, 0x00,
    ]);
    expect(response.readUInt16LE(2) & DNP3_IIN.CLASS1_EVENTS).toBe(DNP3_IIN.CLASS1_EVENTS);
    expect(fragments[0].con).toBe(true);
    expect(fragments[0].eventSeqs).toEqual([1, 2]);
  });

  test('reading class 1 does not drain class 2 or 3', () => {
    const ctx = makeCtx();
    pushBinaryEvent(ctx, 3, true, T0, 1);
    ctx.eventBuffer.enqueue({ pointType: 'counter', index: 0, eventClass: 2, value: 5, flags: 0x01, timestamp: T0 });

    const { fragments } = handleApplicationRequest(ctx, readClasses(0, 1));
    expect(fragments[0].eventSeqs).toEqual([1]);
    expect(ctx.eventBuffer.classSize(2)).toBe(1);
  });
});

describe('mixed-class reads', () => {
  test('a class 1+2+3 read returns all three groups in chronological order', () => {
    const ctx = makeCtx();
    pushBinaryEvent(ctx, 3, true, T0, 1);
    ctx.eventBuffer.enqueue({ pointType: 'counter', index: 0, eventClass: 2, value: 0x12345678, flags: 0x01, timestamp: T0 });
    ctx.eventBuffer.enqueue({ pointType: 'analogInput', index: 1, eventClass: 3, value: -2, flags: 0x01, timestamp: T0 });

    const { response, fragments } = handleApplicationRequest(ctx, readClasses(2, 1, 2, 3));
    expect(fragments[0].eventSeqs).toEqual([1, 2, 3]);
    expect([...response]).toEqual([
      0xe2, 0x81, 0x00, 0x0e, // FIR|FIN|CON seq 2; IIN 0x0E00 = CLASS1|CLASS2|CLASS3
      0x02, 0x02, 0x17, 0x01, 0x03, 0x81, 0xef, 0xcd, 0xab, 0x00, 0x00, 0x00, // g2v2
      0x16, 0x05, 0x17, 0x01, 0x00, 0x01, 0x78, 0x56, 0x34, 0x12, 0xef, 0xcd, 0xab, 0x00, 0x00, 0x00, // g22v5
      0x20, 0x03, 0x17, 0x01, 0x01, 0x01, 0xfe, 0xff, 0xff, 0xff, 0xef, 0xcd, 0xab, 0x00, 0x00, 0x00, // g32v3
    ]);
  });

  test('a class 0+1 read puts static objects first, then events', () => {
    const ctx = makeCtx();
    ctx.pointMap.applyTagUpdate('bi3', { value: true, quality: 'good', timestamp: T0 });
    pushBinaryEvent(ctx, 3, true, T0);

    const { response } = handleApplicationRequest(ctx, readClasses(0, 0, 1));
    // Static block for the binary inputs (group 1) comes before the g2 events.
    const staticStart = 4;
    expect(response[staticStart]).toBe(DNP3_GROUP.BINARY_INPUT_STATIC);
    expect(response.indexOf(Buffer.from([0x02, 0x02, 0x17]))).toBeGreaterThan(staticStart);
  });

  test('a read with no recognised class object falls back to all static data', () => {
    const ctx = makeCtx();
    ctx.pointMap.applyTagUpdate('bi3', { value: true, quality: 'good', timestamp: T0 });
    const { response } = handleApplicationRequest(ctx, parseRequest(Buffer.from([0xc0, DNP3_FUNCTION.READ])));
    expect(response[4]).toBe(DNP3_GROUP.BINARY_INPUT_STATIC);
  });
});

describe('response fragmentation', () => {
  /**
   * g2v2 costs 4 header octets + 8 per event, and the application header is 4,
   * so a 24-octet fragment budget leaves 20 octets of objects = exactly two
   * events per fragment.
   */
  test('five events split into three fragments with correct FIR/FIN/CON and sequences', () => {
    const ctx = makeCtx({ maxTxFragmentSize: 24 });
    for (let i = 0; i < 5; i++) pushBinaryEvent(ctx, 3, true, T0 + i);

    const { fragments, response } = handleApplicationRequest(ctx, readClasses(5, 1));
    expect(fragments).toHaveLength(3);
    expect(fragments.map((f) => f.eventSeqs)).toEqual([[1, 2], [3, 4], [5]]);
    expect(fragments.map((f) => f.seq)).toEqual([5, 6, 7]);
    expect(fragments.every((f) => f.bytes.length <= 24)).toBe(true);

    // First: FIR set, FIN clear, CON set. Middle: neither FIR nor FIN. Last: FIN.
    expect(fragments[0].bytes[0] & APP_CTRL_FIR).toBe(APP_CTRL_FIR);
    expect(fragments[0].bytes[0] & APP_CTRL_FIN).toBe(0);
    expect(fragments[1].bytes[0] & APP_CTRL_FIR).toBe(0);
    expect(fragments[1].bytes[0] & APP_CTRL_FIN).toBe(0);
    expect(fragments[2].bytes[0] & APP_CTRL_FIN).toBe(APP_CTRL_FIN);
    expect(fragments.every((f) => (f.bytes[0] & APP_CTRL_CON) === APP_CTRL_CON)).toBe(true);

    // Only the first fragment is transmitted immediately.
    expect(response.equals(fragments[0].bytes)).toBe(true);
  });

  test('the master walks the fragments with CONFIRMs, and each confirm drains its own events', () => {
    const ctx = makeCtx({ maxTxFragmentSize: 24 });
    for (let i = 0; i < 5; i++) pushBinaryEvent(ctx, 3, true, T0 + i);
    const { fragments } = handleApplicationRequest(ctx, readClasses(5, 1));
    expect(ctx.eventBuffer.classSize(1)).toBe(5);

    const second = handleApplicationRequest(ctx, confirm(5));
    expect(second.response.equals(fragments[1].bytes)).toBe(true);
    expect(ctx.eventBuffer.classSize(1)).toBe(3); // first two confirmed

    const third = handleApplicationRequest(ctx, confirm(6));
    expect(third.response.equals(fragments[2].bytes)).toBe(true);
    expect(ctx.eventBuffer.classSize(1)).toBe(1);

    const done = handleApplicationRequest(ctx, confirm(7));
    expect(done.response.length).toBe(0);
    expect(ctx.eventBuffer.classSize(1)).toBe(0);
  });

  test('a fragment budget too small for one event object withholds events instead of looping', () => {
    // 4 header + 4 object header + 8 per event = 16 minimum; 12 cannot fit one.
    const ctx = makeCtx({ maxTxFragmentSize: 12 });
    pushBinaryEvent(ctx, 3, true, T0);
    const { fragments } = handleApplicationRequest(ctx, readClasses(0, 1));
    expect(fragments).toHaveLength(1);
    expect(fragments[0].eventSeqs).toEqual([]);
    expect(fragments[0].bytes.length).toBe(4);
    expect(ctx.eventBuffer.classSize(1)).toBe(1); // still buffered, nothing lost
  });
});

describe('confirm semantics', () => {
  test('events survive the read and are removed only by a matching CONFIRM', () => {
    const ctx = makeCtx();
    pushBinaryEvent(ctx, 3, true, T0);
    pushBinaryEvent(ctx, 7, false, T0 + 6);

    handleApplicationRequest(ctx, readClasses(4, 1));
    expect(ctx.eventBuffer.classSize(1)).toBe(2); // sent, not yet confirmed

    handleApplicationRequest(ctx, confirm(4));
    expect(ctx.eventBuffer.classSize(1)).toBe(0);
  });

  test('a CONFIRM with the wrong sequence number drops nothing', () => {
    const ctx = makeCtx();
    pushBinaryEvent(ctx, 3, true, T0);
    handleApplicationRequest(ctx, readClasses(4, 1));
    const stray = handleApplicationRequest(ctx, confirm(9));
    expect(stray.response.length).toBe(0);
    expect(ctx.eventBuffer.classSize(1)).toBe(1); // the event is still buffered
  });

  test('an unconfirmed event is re-sent on the next poll', () => {
    const ctx = makeCtx();
    pushBinaryEvent(ctx, 3, true, T0);
    const first = handleApplicationRequest(ctx, readClasses(1, 1));
    const second = handleApplicationRequest(ctx, readClasses(2, 1));
    // Same objects, different sequence number in the header.
    expect([...first.response.subarray(4)]).toEqual([...second.response.subarray(4)]);
    expect(second.fragments[0].eventSeqs).toEqual([1]);
  });

  test('a new request abandons an outstanding unconfirmed response', () => {
    const ctx = makeCtx({ maxTxFragmentSize: 24 });
    for (let i = 0; i < 5; i++) pushBinaryEvent(ctx, 3, true, T0 + i);
    handleApplicationRequest(ctx, readClasses(5, 1));
    expect(ctx.session.pendingFragments.length).toBe(2);

    // Any new request cancels it — here an (empty) class 2 poll.
    handleApplicationRequest(ctx, readClasses(8, 2));
    expect(ctx.session.pendingFragments.length).toBe(0);
    expect(ctx.session.awaitingConfirm).toBeNull();
    // A now-stale CONFIRM must not drop anything.
    handleApplicationRequest(ctx, confirm(5));
    expect(ctx.eventBuffer.classSize(1)).toBe(5);
  });

  test('a CONFIRM with nothing outstanding is silently ignored', () => {
    const ctx = makeCtx();
    const result = handleApplicationRequest(ctx, confirm(3));
    expect(result.response.length).toBe(0);
    expect(result.fragments).toEqual([]);
  });
});

describe('IIN reporting', () => {
  test('event-buffer overflow raises the EVENT_BUFFER_OVERFLOW bit', () => {
    const ctx = createOutstationContext({
      pointMap: new Dnp3PointMap({ points: [{ tagId: 'bi3', type: 'binaryInput', index: 3, eventClass: 1 }] }),
      eventBuffer: new Dnp3EventBuffer({
        class1: { maxEvents: 2, unsolicitedThreshold: 0 },
        class2: { maxEvents: 2, unsolicitedThreshold: 0 },
        class3: { maxEvents: 2, unsolicitedThreshold: 0 },
        unsolicitedMaxDelayMs: 0,
      }),
    });
    for (let i = 0; i < 3; i++) pushBinaryEvent(ctx, 3, true, T0 + i);

    const { response } = handleApplicationRequest(ctx, readClasses(0, 1));
    const iin = response.readUInt16LE(2);
    expect(iin & DNP3_IIN.EVENT_BUFFER_OVERFLOW).toBe(DNP3_IIN.EVENT_BUFFER_OVERFLOW);
    expect(iin & DNP3_IIN.CLASS1_EVENTS).toBe(DNP3_IIN.CLASS1_EVENTS);
  });

  test('the class-event bit stays set until the events are confirmed', () => {
    const ctx = makeCtx();
    pushBinaryEvent(ctx, 3, true, T0);
    const first = handleApplicationRequest(ctx, readClasses(0, 1));
    expect(first.response.readUInt16LE(2) & DNP3_IIN.CLASS1_EVENTS).toBe(DNP3_IIN.CLASS1_EVENTS);

    handleApplicationRequest(ctx, confirm(0));
    const after = handleApplicationRequest(ctx, readClasses(1, 1));
    expect(after.response.readUInt16LE(2) & DNP3_IIN.CLASS1_EVENTS).toBe(0);
  });
});

describe('static reads split into fragment-sized blocks', () => {
  test('a large point map produces multiple object headers and fragments', () => {
    const points = Array.from({ length: 40 }, (_, i) => ({
      tagId: `ai${i}`,
      type: 'analogInput' as const,
      index: i,
      encoding: 'int32' as const,
    }));
    const ctx = createOutstationContext({
      pointMap: new Dnp3PointMap({ points }),
      maxTxFragmentSize: 64,
    });
    const { fragments } = handleApplicationRequest(ctx, readClasses(0, 0));
    expect(fragments.length).toBeGreaterThan(1);
    expect(fragments.every((f) => f.bytes.length <= 64)).toBe(true);
    // Each fragment starts with a well-formed g30v1 object header.
    for (const f of fragments) {
      expect(f.bytes[4]).toBe(DNP3_GROUP.ANALOG_INPUT_STATIC);
      expect(f.bytes[5]).toBe(DNP3_VARIATION.AI_32_WITH_FLAG);
      expect(f.bytes[6]).toBe(0x00); // qualifier: 8-bit start/stop range
    }
    // Every point appears exactly once across the fragments.
    const totalPoints = fragments.reduce((sum, f) => {
      let n = 0;
      for (let off = 4; off + 5 <= f.bytes.length; ) {
        const start = f.bytes[off + 3];
        const stop = f.bytes[off + 4];
        n += stop - start + 1;
        off += 5 + (stop - start + 1) * 5;
      }
      return sum + n;
    }, 0);
    expect(totalPoints).toBe(40);
  });

  test('non-contiguous indices get their own object header instead of a bogus range', () => {
    const ctx = createOutstationContext({
      pointMap: new Dnp3PointMap({
        points: [
          { tagId: 'a', type: 'binaryInput', index: 0 },
          { tagId: 'b', type: 'binaryInput', index: 1 },
          { tagId: 'c', type: 'binaryInput', index: 9 },
        ],
      }),
    });
    const { response } = handleApplicationRequest(ctx, readClasses(0, 0));
    expect([...response.subarray(4)]).toEqual([
      0x01, 0x02, 0x00, 0x00, 0x01, // g1v2 range 0..1
      0x04, 0x04, // two points, quality bad until first sample (COMM_LOST)
      0x01, 0x02, 0x00, 0x09, 0x09, // g1v2 range 9..9
      0x04,
    ]);
  });

  test('an index above 255 uses the 16-bit range qualifier 0x01', () => {
    const ctx = createOutstationContext({
      pointMap: new Dnp3PointMap({ points: [{ tagId: 'far', type: 'binaryInput', index: 300 }] }),
    });
    const { response } = handleApplicationRequest(ctx, readClasses(0, 0));
    expect([...response.subarray(4)]).toEqual([
      0x01, 0x02, 0x01, // g1v2, qualifier 0x01 (16-bit start/stop)
      0x2c, 0x01, 0x2c, 0x01, // start 300, stop 300
      0x04,
    ]);
  });
});
