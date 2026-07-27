/**
 * DNP3 Event Object Serialisation — g2 / g11 / g22 / g32 / g42 (+ g51 CTO)
 * Issue #464: DNP3 Outstation Mode
 *
 * Turns buffered `Dnp3Event`s into the octets a master expects inside a Class
 * 1/2/3 response. Before this module existed the event path returned
 * `Buffer.alloc(0)` — events were counted, reported and IIN-flagged but no data
 * ever reached the master.
 *
 * Wire rules implemented here (IEEE 1815-2012 §5.1.5, §A.2):
 *
 *   - Events are NOT contiguous in index space, so every event object header
 *     uses an INDEX-PREFIXED qualifier: 0x17 (1-octet index prefix, 1-octet
 *     count) while every index in the run is <= 255, otherwise 0x28 (2-octet
 *     index prefix, 2-octet count).
 *   - Consecutive events sharing a group/variation are merged into a single
 *     object header; a change of group/variation starts a new header. Event
 *     ordering (chronological, by the buffer's global sequence) is preserved
 *     across headers, which is what the standard requires.
 *   - Absolute timestamps are the 6-octet little-endian DNP3 Time.
 *   - Relative-time binary INPUT events (g2v3) are only legal after a Common
 *     Time Of Occurrence object, so a g51v1 CTO is emitted immediately before
 *     each relative-time run and the per-event field is the 16-bit unsigned
 *     millisecond offset from that CTO. A run is closed and a new CTO started
 *     whenever the offset would not fit in 16 bits or would go negative.
 *     Group 11 (Binary Output Event) has NO relative-time variation in IEEE
 *     1815 — only v1 and v2 — so a relative-time policy degrades to g11v2 for
 *     binary outputs rather than emitting an object no master can decode.
 *
 * Everything here is pure (events in -> octets out) and byte-exact, so it is
 * covered by golden-vector unit tests rather than a live master.
 */

import {
  DNP3_GROUP,
  DNP3_VARIATION,
  encodeDnp3Time,
} from './app-objects';
import type { Dnp3Event } from './event-buffer';
import { Dnp3PointMap, type AnalogEncoding, type Dnp3PointType } from './point-map';

/** Time representation to use for binary (g2/g11) events. */
export type BinaryEventTimeMode = 'no-time' | 'absolute-time' | 'relative-time';
/** Time representation to use for counter/analog events. */
export type NumericEventTimeMode = 'no-time' | 'absolute-time';

/**
 * Which variation family the outstation emits per event type. The numeric WIDTH
 * (int32 vs float32) is not configurable here — it follows the point's own
 * `encoding` so an event never silently truncates a value the static read
 * reports at full precision.
 */
export interface EventVariationPolicy {
  /** g2 (binary input) / g11 (binary output): v1 no time, v2 absolute, v3 relative */
  binary: BinaryEventTimeMode;
  /** g22 (counter): v1 no time, v5 with absolute time */
  counter: NumericEventTimeMode;
  /** g32 (analog input) / g42 (analog output): v1/v5 no time, v3/v7 with absolute time */
  analog: NumericEventTimeMode;
}

/**
 * Default policy: absolute timestamps everywhere. Timestamped variations are
 * what utility masters expect from an outstation that buffers events, and they
 * are self-contained (no CTO ordering dependency).
 */
export const DEFAULT_EVENT_VARIATIONS: EventVariationPolicy = {
  binary: 'absolute-time',
  counter: 'absolute-time',
  analog: 'absolute-time',
};

/** How the time field of one event object is encoded. */
type TimeMode = 'none' | 'absolute' | 'relative';

/** A single event, resolved to its group/variation and value octets. */
interface EventDescriptor {
  /** event-buffer sequence number (for confirm bookkeeping) */
  seq: number;
  group: number;
  variation: number;
  index: number;
  timestamp: number;
  /** flag octet + value octets, WITHOUT any time field */
  core: Buffer;
  timeMode: TimeMode;
}

export interface EventEncodeResult {
  /** Concatenated object blocks, ready to append after the application header. */
  bytes: Buffer;
  /** Event-buffer sequence numbers actually encoded, in emission order. */
  encodedSeqs: number[];
  /** Events that did not fit in the byte budget (they remain buffered). */
  remaining: number;
}

const EMPTY = Buffer.alloc(0);

/** Number of octets the time field of a descriptor occupies. */
function timeFieldLength(mode: TimeMode): number {
  switch (mode) {
    case 'absolute':
      return 6;
    case 'relative':
      return 2;
    case 'none':
      return 0;
  }
}

/** Group used for an event of the given point type. */
function eventGroupFor(pointType: Dnp3PointType): number | null {
  switch (pointType) {
    case 'binaryInput':
      return DNP3_GROUP.BINARY_INPUT_EVENT;
    case 'binaryOutput':
      return DNP3_GROUP.BINARY_OUTPUT_EVENT;
    case 'counter':
      return DNP3_GROUP.COUNTER_EVENT;
    case 'analogInput':
      return DNP3_GROUP.ANALOG_INPUT_EVENT;
    case 'analogOutput':
      return DNP3_GROUP.ANALOG_OUTPUT_EVENT;
    default:
      return null;
  }
}

/** Clamp+truncate to a signed 32-bit range (analog events). */
function toInt32(value: number): number {
  const v = Math.trunc(value);
  if (v < -2147483648) return -2147483648;
  if (v > 2147483647) return 2147483647;
  return v;
}

/** Clamp+truncate to an unsigned 32-bit range (counter events). */
function toUint32(value: number): number {
  const v = Math.trunc(value);
  if (v < 0) return 0;
  if (v > 0xffffffff) return 0xffffffff;
  return v;
}

/**
 * Resolve one buffered event to its group/variation + value octets. Returns null
 * for point types that have no event group (never happens for the five mapped
 * types, but keeps the function total).
 */
function describeEvent(
  event: Dnp3Event,
  encoding: AnalogEncoding,
  policy: EventVariationPolicy,
): EventDescriptor | null {
  const group = eventGroupFor(event.pointType);
  if (group === null) return null;
  const flags = event.flags & 0xff;

  if (event.pointType === 'binaryInput' || event.pointType === 'binaryOutput') {
    // g2v1/g11v1: flag octet only. The binary STATE is bit 7 of the flag octet,
    // so no separate value field exists for any binary event variation.
    const core = Buffer.from([flags]);
    // IEEE 1815-2012 Table A-1: group 2 (Binary Input Event) defines v1 (no
    // time), v2 (absolute time) and v3 (relative time), but group 11 (Binary
    // Output Event) defines ONLY v1 and v2 — there is no g11v3. A relative-time
    // policy therefore has to degrade to the absolute-time variation for binary
    // OUTPUT events; emitting a g11v3 would put an object on the wire that no
    // conformant master can decode.
    const isInput = event.pointType === 'binaryInput';
    const noTime = isInput ? DNP3_VARIATION.BI_EVENT_NO_TIME : DNP3_VARIATION.BO_EVENT_NO_TIME;
    const absTime = isInput ? DNP3_VARIATION.BI_EVENT_ABS_TIME : DNP3_VARIATION.BO_EVENT_ABS_TIME;
    const mode: BinaryEventTimeMode =
      policy.binary === 'relative-time' && !isInput ? 'absolute-time' : policy.binary;
    switch (mode) {
      case 'no-time':
        return { seq: event.seq, group, variation: noTime, index: event.index, timestamp: event.timestamp, core, timeMode: 'none' };
      case 'relative-time':
        return { seq: event.seq, group, variation: DNP3_VARIATION.BI_EVENT_REL_TIME, index: event.index, timestamp: event.timestamp, core, timeMode: 'relative' };
      case 'absolute-time':
      default:
        return { seq: event.seq, group, variation: absTime, index: event.index, timestamp: event.timestamp, core, timeMode: 'absolute' };
    }
  }

  if (event.pointType === 'counter') {
    // g22v1: flag + 32-bit unsigned. g22v5 appends the 6-octet DNP3 time.
    const core = Buffer.alloc(5);
    core.writeUInt8(flags, 0);
    core.writeUInt32LE(toUint32(Number(event.value)), 1);
    const withTime = policy.counter === 'absolute-time';
    return {
      seq: event.seq,
      group,
      variation: withTime ? DNP3_VARIATION.CNT_EVENT_32_ABS_TIME : DNP3_VARIATION.CNT_EVENT_32_WITH_FLAG,
      index: event.index,
      timestamp: event.timestamp,
      core,
      timeMode: withTime ? 'absolute' : 'none',
    };
  }

  // Analog input (g32) / analog output (g42). Width follows the point encoding:
  //   int32   -> v1 (no time) / v3 (with time)
  //   float32 -> v5 (no time) / v7 (with time)
  const withTime = policy.analog === 'absolute-time';
  const core = Buffer.alloc(5);
  core.writeUInt8(flags, 0);
  if (encoding === 'int32') {
    core.writeInt32LE(toInt32(Number(event.value)), 1);
  } else {
    core.writeFloatLE(Number(event.value), 1);
  }
  // Groups 32 and 42 share the same variation numbering, but name them
  // separately so the constant matches the group actually emitted.
  const isInput = event.pointType === 'analogInput';
  const variation = encoding === 'int32'
    ? withTime
      ? (isInput ? DNP3_VARIATION.AI_EVENT_32_ABS_TIME : DNP3_VARIATION.AO_EVENT_32_ABS_TIME)
      : (isInput ? DNP3_VARIATION.AI_EVENT_32_WITH_FLAG : DNP3_VARIATION.AO_EVENT_32_WITH_FLAG)
    : withTime
      ? (isInput ? DNP3_VARIATION.AI_EVENT_FLOAT_ABS_TIME : DNP3_VARIATION.AO_EVENT_FLOAT_ABS_TIME)
      : (isInput ? DNP3_VARIATION.AI_EVENT_FLOAT_WITH_FLAG : DNP3_VARIATION.AO_EVENT_FLOAT_WITH_FLAG);
  return {
    seq: event.seq,
    group,
    variation,
    index: event.index,
    timestamp: event.timestamp,
    core,
    timeMode: withTime ? 'absolute' : 'none',
  };
}

/**
 * Build a g51v1 Common Time Of Occurrence object: object header with qualifier
 * 0x07 (1-octet count) count=1, followed by the 6-octet absolute DNP3 time.
 * Ten octets total.
 */
export function buildCtoObject(epochMs: number): Buffer {
  return Buffer.concat([
    Buffer.from([DNP3_GROUP.TIME_AND_DATE_CTO, DNP3_VARIATION.CTO_SYNC, 0x07, 0x01]),
    encodeDnp3Time(epochMs),
  ]);
}

/**
 * Serialise buffered events into DNP3 event objects.
 *
 * Encoding stops as soon as the next event would exceed `maxBytes`; the events
 * that did fit are reported in `encodedSeqs` (always a prefix of `events`, so a
 * caller can resume with `events.slice(encodedSeqs.length)` on the next
 * fragment). Nothing is removed from the event buffer here — that is the
 * caller's confirm bookkeeping.
 */
export function buildEventObjects(
  events: readonly Dnp3Event[],
  opts: {
    pointMap: Dnp3PointMap;
    policy?: EventVariationPolicy;
    /** octets available for object data (the application header is excluded) */
    maxBytes?: number;
  },
): EventEncodeResult {
  const policy = opts.policy ?? DEFAULT_EVENT_VARIATIONS;
  const maxBytes = opts.maxBytes ?? Number.MAX_SAFE_INTEGER;

  const descriptors: EventDescriptor[] = [];
  for (const event of events) {
    const def = opts.pointMap.getPoint(event.pointType, event.index);
    const isAnalog = event.pointType === 'analogInput' || event.pointType === 'analogOutput';
    // An analog event whose point is no longer mapped has no known value width.
    // Stop here rather than guess: `encodedSeqs` must stay a prefix of `events`
    // so the caller can resume, and a wrong width would corrupt the response.
    if (isAnalog && !def) break;
    const encoding: AnalogEncoding = def?.encoding ?? 'float32';
    const descriptor = describeEvent(event, encoding, policy);
    if (!descriptor) break;
    descriptors.push(descriptor);
  }

  const parts: Buffer[] = [];
  const encodedSeqs: number[] = [];
  let used = 0;
  let i = 0;

  while (i < descriptors.length) {
    const first = descriptors[i];
    const twoOctet = first.index > 0xff;
    const prefixLen = twoOctet ? 2 : 1;
    const countLen = twoOctet ? 2 : 1;
    const qualifier = twoOctet ? 0x28 : 0x17;
    const maxCount = twoOctet ? 0xffff : 0xff;
    const headerLen = 3 + countLen;

    // A relative-time run must be introduced by its own CTO object.
    const ctoBytes = first.timeMode === 'relative' ? buildCtoObject(first.timestamp) : null;
    const ctoBase = first.timestamp;
    const ctoLen = ctoBytes ? ctoBytes.length : 0;

    const firstItemLen = prefixLen + first.core.length + timeFieldLength(first.timeMode);
    if (used + ctoLen + headerLen + firstItemLen > maxBytes) {
      // Not even one more object fits in this fragment.
      break;
    }

    const items: Buffer[] = [];
    const runSeqs: number[] = [];
    let itemsLen = 0;
    let j = i;
    while (j < descriptors.length && runSeqs.length < maxCount) {
      const d = descriptors[j];
      if (d.group !== first.group || d.variation !== first.variation) break;
      if ((d.index > 0xff) !== twoOctet) break;

      let timeField: Buffer;
      if (d.timeMode === 'absolute') {
        timeField = encodeDnp3Time(d.timestamp);
      } else if (d.timeMode === 'relative') {
        const offset = d.timestamp - ctoBase;
        // Offsets are 16-bit unsigned; anything outside that needs a new CTO.
        if (offset < 0 || offset > 0xffff) break;
        timeField = Buffer.alloc(2);
        timeField.writeUInt16LE(offset, 0);
      } else {
        timeField = EMPTY;
      }

      const itemLen = prefixLen + d.core.length + timeField.length;
      if (used + ctoLen + headerLen + itemsLen + itemLen > maxBytes) break;

      const prefix = Buffer.alloc(prefixLen);
      if (twoOctet) prefix.writeUInt16LE(d.index, 0);
      else prefix.writeUInt8(d.index, 0);
      items.push(prefix, d.core, timeField);
      itemsLen += itemLen;
      runSeqs.push(d.seq);
      j += 1;
    }

    // Defensive: the pre-check above guarantees at least one item, but never
    // loop forever if that ever stops holding.
    if (runSeqs.length === 0) break;

    const header = Buffer.alloc(headerLen);
    header.writeUInt8(first.group, 0);
    header.writeUInt8(first.variation, 1);
    header.writeUInt8(qualifier, 2);
    if (twoOctet) header.writeUInt16LE(runSeqs.length, 3);
    else header.writeUInt8(runSeqs.length, 3);

    if (ctoBytes) parts.push(ctoBytes);
    parts.push(header, ...items);
    used += ctoLen + headerLen + itemsLen;
    encodedSeqs.push(...runSeqs);
    i = j;
  }

  return {
    bytes: Buffer.concat(parts),
    encodedSeqs,
    remaining: events.length - encodedSeqs.length,
  };
}
