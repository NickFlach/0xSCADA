/**
 * Golden-byte-vector tests for DNP3 event object serialisation (#464).
 *
 * Every expected buffer below is derived by hand from IEEE 1815-2012 and is
 * annotated octet by octet, so a failure points at the exact field that drifted
 * rather than at an opaque hex blob.
 *
 * Shared conventions used by these vectors:
 *   - Object header = GROUP(1) VARIATION(1) QUALIFIER(1) then the range field.
 *   - Qualifier 0x17 = index-prefix code 1 (1-octet prefix) + range code 7
 *     (1-octet count). Qualifier 0x28 = prefix code 2 (2-octet prefix) + range
 *     code 8 (2-octet count).
 *   - Flag octet bit 0 = ONLINE, bit 7 = binary STATE.
 *   - DNP3 Time is a 48-bit unsigned little-endian millisecond count.
 *
 * The timestamps are chosen so their little-endian octets are readable:
 *   T0 = 0x0000_00AB_CDEF ms -> EF CD AB 00 00 00
 *   T1 = T0 + 6             -> F5 CD AB 00 00 00
 */
import { describe, test, expect } from 'vitest';
import {
  buildEventObjects,
  buildCtoObject,
  DEFAULT_EVENT_VARIATIONS,
  type EventVariationPolicy,
} from '../event-objects';
import { Dnp3EventBuffer, type Dnp3Event } from '../event-buffer';
import { Dnp3PointMap } from '../point-map';
import { encodeDnp3Time, decodeDnp3Time, DNP3_FLAG } from '../app-objects';

const T0 = 0xabcdef; // 11_259_375 ms
const T1 = T0 + 6;

/** ONLINE + STATE(on) */
const FLAGS_ON = DNP3_FLAG.ONLINE | DNP3_FLAG.STATE; // 0x81
/** ONLINE, binary state off */
const FLAGS_OFF = DNP3_FLAG.ONLINE; // 0x01

function ev(partial: Partial<Dnp3Event> & Pick<Dnp3Event, 'seq' | 'pointType' | 'index'>): Dnp3Event {
  return {
    eventClass: 1,
    value: true,
    flags: FLAGS_ON,
    timestamp: T0,
    ...partial,
  } as Dnp3Event;
}

const binaryMap = new Dnp3PointMap({
  points: [
    { tagId: 'bi3', type: 'binaryInput', index: 3, eventClass: 1 },
    { tagId: 'bi7', type: 'binaryInput', index: 7, eventClass: 1 },
  ],
});

const twoBinaryEvents: Dnp3Event[] = [
  ev({ seq: 1, pointType: 'binaryInput', index: 3, value: true, flags: FLAGS_ON, timestamp: T0 }),
  ev({ seq: 2, pointType: 'binaryInput', index: 7, value: false, flags: FLAGS_OFF, timestamp: T1 }),
];

describe('DNP3 time field', () => {
  test('is a 48-bit little-endian millisecond count', () => {
    expect([...encodeDnp3Time(T0)]).toEqual([0xef, 0xcd, 0xab, 0x00, 0x00, 0x00]);
    expect(encodeDnp3Time(T0).length).toBe(6);
    expect(decodeDnp3Time(encodeDnp3Time(1_785_000_000_000))).toBe(1_785_000_000_000);
  });

  test('saturates at the 48-bit maximum instead of wrapping', () => {
    // 2^48 - 1 is the largest representable instant; a larger value must clamp,
    // never silently truncate into a wildly wrong timestamp.
    expect([...encodeDnp3Time(2 ** 48 + 5)]).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect([...encodeDnp3Time(-1)]).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe('g2 Binary Input Event — golden vectors', () => {
  test('g2v2 (absolute time), qualifier 0x17, two events', () => {
    const { bytes, encodedSeqs, remaining } = buildEventObjects(twoBinaryEvents, { pointMap: binaryMap });
    expect([...bytes]).toEqual([
      0x02, 0x02, 0x17, 0x02, // g2 v2, qualifier 0x17, count 2
      0x03, 0x81, 0xef, 0xcd, 0xab, 0x00, 0x00, 0x00, // index 3, flags ONLINE|STATE, T0
      0x07, 0x01, 0xf5, 0xcd, 0xab, 0x00, 0x00, 0x00, // index 7, flags ONLINE, T1
    ]);
    expect(encodedSeqs).toEqual([1, 2]);
    expect(remaining).toBe(0);
    // 4-octet header + 2 * (1 prefix + 1 flag + 6 time)
    expect(bytes.length).toBe(20);
  });

  test('g2v1 (no time) drops the time field entirely', () => {
    const policy: EventVariationPolicy = { ...DEFAULT_EVENT_VARIATIONS, binary: 'no-time' };
    const { bytes } = buildEventObjects(twoBinaryEvents, { pointMap: binaryMap, policy });
    expect([...bytes]).toEqual([
      0x02, 0x01, 0x17, 0x02, // g2 v1, qualifier 0x17, count 2
      0x03, 0x81, // index 3, flag octet only
      0x07, 0x01, // index 7, flag octet only
    ]);
  });

  test('g2v3 (relative time) is preceded by a g51v1 CTO and uses 16-bit offsets', () => {
    const policy: EventVariationPolicy = { ...DEFAULT_EVENT_VARIATIONS, binary: 'relative-time' };
    const { bytes } = buildEventObjects(twoBinaryEvents, { pointMap: binaryMap, policy });
    expect([...bytes]).toEqual([
      // g51 (0x33) v1 Common Time Of Occurrence, qualifier 0x07 count 1, T0
      0x33, 0x01, 0x07, 0x01, 0xef, 0xcd, 0xab, 0x00, 0x00, 0x00,
      0x02, 0x03, 0x17, 0x02, // g2 v3, qualifier 0x17, count 2
      0x03, 0x81, 0x00, 0x00, // index 3, flags, offset 0 ms from the CTO
      0x07, 0x01, 0x06, 0x00, // index 7, flags, offset 6 ms from the CTO
    ]);
  });

  test('a relative-time offset beyond 16 bits starts a fresh CTO run', () => {
    const policy: EventVariationPolicy = { ...DEFAULT_EVENT_VARIATIONS, binary: 'relative-time' };
    const far = T0 + 0x10000; // one millisecond too far for a uint16 offset
    const events = [
      twoBinaryEvents[0],
      ev({ seq: 2, pointType: 'binaryInput', index: 7, value: false, flags: FLAGS_OFF, timestamp: far }),
    ];
    const { bytes, encodedSeqs } = buildEventObjects(events, { pointMap: binaryMap, policy });
    expect(encodedSeqs).toEqual([1, 2]);
    // Two CTO objects, each introducing a single-event run.
    expect([...bytes]).toEqual([
      0x33, 0x01, 0x07, 0x01, 0xef, 0xcd, 0xab, 0x00, 0x00, 0x00,
      0x02, 0x03, 0x17, 0x01, 0x03, 0x81, 0x00, 0x00,
      // second CTO = T0 + 0x10000 = 0xABCDEF + 0x10000 = 0xACCDEF
      0x33, 0x01, 0x07, 0x01, 0xef, 0xcd, 0xac, 0x00, 0x00, 0x00,
      0x02, 0x03, 0x17, 0x01, 0x07, 0x01, 0x00, 0x00,
    ]);
  });

  test('buildCtoObject is a 10-octet g51v1 object', () => {
    expect([...buildCtoObject(T0)]).toEqual([0x33, 0x01, 0x07, 0x01, 0xef, 0xcd, 0xab, 0x00, 0x00, 0x00]);
  });
});

describe('g11 Binary Output Event — variation availability', () => {
  const boMap = new Dnp3PointMap({
    points: [{ tagId: 'bo0', type: 'binaryOutput', index: 0, eventClass: 1 }],
  });
  const boEvent = ev({ seq: 1, pointType: 'binaryOutput', index: 0, flags: FLAGS_ON, timestamp: T0 });

  test('absolute time emits g11v2', () => {
    const { bytes } = buildEventObjects([boEvent], { pointMap: boMap });
    expect([...bytes]).toEqual([
      0x0b, 0x02, 0x17, 0x01, // g11 (0x0B) v2, qualifier 0x17, count 1
      0x00, 0x81, 0xef, 0xcd, 0xab, 0x00, 0x00, 0x00,
    ]);
  });

  test('no-time emits g11v1', () => {
    const policy: EventVariationPolicy = { ...DEFAULT_EVENT_VARIATIONS, binary: 'no-time' };
    const { bytes } = buildEventObjects([boEvent], { pointMap: boMap, policy });
    expect([...bytes]).toEqual([0x0b, 0x01, 0x17, 0x01, 0x00, 0x81]);
  });

  test('a relative-time policy degrades to g11v2 — IEEE 1815 has no g11v3', () => {
    // Group 11 (Binary Output Event) defines only v0/v1/v2 in IEEE 1815-2012
    // Table A-1. Emitting a g11v3 (plus a CTO) would put an undecodable object
    // on the wire for any conformant master, so the relative-time policy must
    // fall back to the absolute-time variation for binary OUTPUT events only.
    const policy: EventVariationPolicy = { ...DEFAULT_EVENT_VARIATIONS, binary: 'relative-time' };
    const { bytes } = buildEventObjects([boEvent], { pointMap: boMap, policy });
    expect(bytes[0]).toBe(0x0b); // group 11
    expect(bytes[1]).toBe(0x02); // variation 2, NOT 3
    // No CTO object is emitted, because there is no relative-time run.
    expect([...bytes]).toEqual([
      0x0b, 0x02, 0x17, 0x01, 0x00, 0x81, 0xef, 0xcd, 0xab, 0x00, 0x00, 0x00,
    ]);

    // Binary INPUTS keep the relative-time behaviour: g2v3 preceded by a CTO.
    const biOnly = buildEventObjects([twoBinaryEvents[0]], { pointMap: binaryMap, policy });
    expect(biOnly.bytes[0]).toBe(0x33); // g51 CTO first
    expect(biOnly.bytes[10]).toBe(0x02); // then group 2
    expect(biOnly.bytes[11]).toBe(0x03); // variation 3 is legal for group 2
  });
});

describe('g22 Counter Event — golden vectors', () => {
  const map = new Dnp3PointMap({ points: [{ tagId: 'c0', type: 'counter', index: 0, eventClass: 2 }] });
  const counterEvent = ev({
    seq: 9,
    pointType: 'counter',
    index: 0,
    eventClass: 2,
    value: 0x12345678,
    flags: DNP3_FLAG.ONLINE,
    timestamp: T0,
  });

  test('g22v5 (32-bit with flag and time)', () => {
    const { bytes } = buildEventObjects([counterEvent], { pointMap: map });
    expect([...bytes]).toEqual([
      0x16, 0x05, 0x17, 0x01, // g22 (0x16) v5, qualifier 0x17, count 1
      0x00, // index 0
      0x01, // flags ONLINE
      0x78, 0x56, 0x34, 0x12, // counter 0x12345678 little-endian
      0xef, 0xcd, 0xab, 0x00, 0x00, 0x00, // T0
    ]);
  });

  test('g22v1 (32-bit with flag, no time)', () => {
    const policy: EventVariationPolicy = { ...DEFAULT_EVENT_VARIATIONS, counter: 'no-time' };
    const { bytes } = buildEventObjects([counterEvent], { pointMap: map, policy });
    expect([...bytes]).toEqual([0x16, 0x01, 0x17, 0x01, 0x00, 0x01, 0x78, 0x56, 0x34, 0x12]);
  });

  test('counter values are unsigned and saturate at 2^32-1', () => {
    const policy: EventVariationPolicy = { ...DEFAULT_EVENT_VARIATIONS, counter: 'no-time' };
    const { bytes } = buildEventObjects(
      [{ ...counterEvent, value: 0x1_0000_0000 }],
      { pointMap: map, policy },
    );
    expect([...bytes.subarray(6)]).toEqual([0xff, 0xff, 0xff, 0xff]);
  });
});

describe('g32 Analog Input Event — golden vectors', () => {
  const map = new Dnp3PointMap({
    points: [
      { tagId: 'ai1', type: 'analogInput', index: 1, eventClass: 3, encoding: 'int32' },
      { tagId: 'ai2', type: 'analogInput', index: 2, eventClass: 3, encoding: 'float32' },
    ],
  });

  test('g32v3 (32-bit int with time) for an int32 point', () => {
    const { bytes } = buildEventObjects(
      [ev({ seq: 4, pointType: 'analogInput', index: 1, eventClass: 3, value: -2, flags: DNP3_FLAG.ONLINE })],
      { pointMap: map },
    );
    expect([...bytes]).toEqual([
      0x20, 0x03, 0x17, 0x01, // g32 (0x20) v3, qualifier 0x17, count 1
      0x01, // index 1
      0x01, // flags ONLINE
      0xfe, 0xff, 0xff, 0xff, // int32 -2, little-endian two's complement
      0xef, 0xcd, 0xab, 0x00, 0x00, 0x00, // T0
    ]);
  });

  test('g32v1 (32-bit int, no time)', () => {
    const policy: EventVariationPolicy = { ...DEFAULT_EVENT_VARIATIONS, analog: 'no-time' };
    const { bytes } = buildEventObjects(
      [ev({ seq: 4, pointType: 'analogInput', index: 1, eventClass: 3, value: -2, flags: DNP3_FLAG.ONLINE })],
      { pointMap: map, policy },
    );
    expect([...bytes]).toEqual([0x20, 0x01, 0x17, 0x01, 0x01, 0x01, 0xfe, 0xff, 0xff, 0xff]);
  });

  test('a float32 point uses g32v7, not the int32 variation', () => {
    // Emitting v1/v3 for a float point would silently truncate the value the
    // static (g30v5) read reports at full precision.
    const { bytes } = buildEventObjects(
      [ev({ seq: 5, pointType: 'analogInput', index: 2, eventClass: 3, value: 1.5, flags: DNP3_FLAG.ONLINE })],
      { pointMap: map },
    );
    expect([...bytes]).toEqual([
      0x20, 0x07, 0x17, 0x01, // g32 v7 (single-precision float with time)
      0x02, // index 2
      0x01, // flags ONLINE
      0x00, 0x00, 0xc0, 0x3f, // IEEE-754 float32 1.5 little-endian
      0xef, 0xcd, 0xab, 0x00, 0x00, 0x00,
    ]);
  });

  test('analog events for an unmapped point are withheld rather than guessed', () => {
    const { bytes, encodedSeqs, remaining } = buildEventObjects(
      [ev({ seq: 6, pointType: 'analogInput', index: 99, eventClass: 3, value: 1, flags: 0x01 })],
      { pointMap: map },
    );
    expect(encodedSeqs).toEqual([]);
    expect(bytes.length).toBe(0);
    expect(remaining).toBe(1);
  });
});

describe('object-header run splitting', () => {
  const map = new Dnp3PointMap({
    points: [
      { tagId: 'bi0', type: 'binaryInput', index: 0, eventClass: 1 },
      { tagId: 'c0', type: 'counter', index: 0, eventClass: 1 },
      { tagId: 'bi1', type: 'binaryInput', index: 1, eventClass: 1 },
    ],
  });

  test('a change of group starts a new object header but keeps chronological order', () => {
    const events: Dnp3Event[] = [
      ev({ seq: 1, pointType: 'binaryInput', index: 0, flags: FLAGS_ON, timestamp: T0 }),
      ev({ seq: 2, pointType: 'counter', index: 0, value: 1, flags: 0x01, timestamp: T0 }),
      ev({ seq: 3, pointType: 'binaryInput', index: 1, flags: FLAGS_ON, timestamp: T0 }),
    ];
    const { bytes, encodedSeqs } = buildEventObjects(events, { pointMap: map });
    expect(encodedSeqs).toEqual([1, 2, 3]);
    // Three headers: g2 (1 event), g22 (1 event), g2 again (1 event).
    expect([...bytes.subarray(0, 4)]).toEqual([0x02, 0x02, 0x17, 0x01]);
    expect([...bytes.subarray(12, 16)]).toEqual([0x16, 0x05, 0x17, 0x01]);
    expect([...bytes.subarray(28, 32)]).toEqual([0x02, 0x02, 0x17, 0x01]);
  });

  test('an index above 255 switches to qualifier 0x28 (2-octet prefix and count)', () => {
    const wideMap = new Dnp3PointMap({
      points: [{ tagId: 'bi300', type: 'binaryInput', index: 300, eventClass: 1 }],
    });
    const { bytes } = buildEventObjects(
      [ev({ seq: 1, pointType: 'binaryInput', index: 300, flags: FLAGS_ON, timestamp: T0 })],
      { pointMap: wideMap },
    );
    expect([...bytes]).toEqual([
      0x02, 0x02, 0x28, // g2 v2, qualifier 0x28
      0x01, 0x00, // count 1, 2-octet little-endian
      0x2c, 0x01, // index 300 = 0x012C, 2-octet little-endian prefix
      0x81, 0xef, 0xcd, 0xab, 0x00, 0x00, 0x00,
    ]);
  });
});

describe('byte budget', () => {
  test('stops on the object that would overflow and reports the remainder', () => {
    // g2v2 costs 4 octets of header + 8 octets per event, so 12 fits exactly one
    // event and 19 still fits only one (a second needs 20).
    const one = buildEventObjects(twoBinaryEvents, { pointMap: binaryMap, maxBytes: 19 });
    expect(one.encodedSeqs).toEqual([1]);
    expect(one.remaining).toBe(1);
    expect(one.bytes.length).toBe(12);

    const both = buildEventObjects(twoBinaryEvents, { pointMap: binaryMap, maxBytes: 20 });
    expect(both.encodedSeqs).toEqual([1, 2]);
    expect(both.remaining).toBe(0);

    const none = buildEventObjects(twoBinaryEvents, { pointMap: binaryMap, maxBytes: 11 });
    expect(none.encodedSeqs).toEqual([]);
    expect(none.bytes.length).toBe(0);
  });

  test('encoded sequences are always a prefix of the input, so callers can resume', () => {
    const buffer = new Dnp3EventBuffer();
    for (let i = 0; i < 5; i++) {
      buffer.enqueue({ pointType: 'binaryInput', index: 3, eventClass: 1, value: true, flags: FLAGS_ON, timestamp: T0 + i });
    }
    let pending = buffer.peek([1]);
    const seen: number[] = [];
    while (pending.length > 0) {
      const res = buildEventObjects(pending, { pointMap: binaryMap, maxBytes: 20 });
      expect(res.encodedSeqs.length).toBeGreaterThan(0);
      seen.push(...res.encodedSeqs);
      pending = pending.slice(res.encodedSeqs.length);
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });
});
