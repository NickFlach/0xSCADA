/**
 * DNP3 Application Layer — APDU Assembly
 * Issue #464: DNP3 Outstation Mode
 *
 * Implemented + unit tested: request-header parse, object-header scan for the
 * range/count qualifiers AND the index-prefixed qualifiers (0x17/0x28) that
 * carry control objects, response-header build, and Class-0 static-read
 * assembly split into fragment-sized object blocks. Per-variation read
 * selection (a master asking for a specific variation rather than a class) is
 * still TODO and marked inline.
 *
 * Application request header (master -> outstation):
 *   APP_CONTROL (1) : FIR/FIN/CON/UNS/SEQ
 *   FUNCTION    (1)
 *   ...object headers...
 *
 * Application response header (outstation -> master):
 *   APP_CONTROL (1)
 *   FUNCTION    (1) : 0x81 RESPONSE / 0x82 UNSOLICITED
 *   IIN         (2) : internal indications
 *   ...object headers...
 */

import {
  DNP3_FUNCTION,
  DNP3_GROUP,
  DNP3_VARIATION,
  DNP3_IIN,
  type Dnp3FunctionCode,
} from "./app-objects";
import {
  Dnp3PointMap,
  serializeStaticPoint,
  type Dnp3PointType,
  type PointGroupVariation,
} from "./point-map";
import { commandObjectSize } from "./controls";

export const APP_CTRL_FIR = 0x80;
export const APP_CTRL_FIN = 0x40;
export const APP_CTRL_CON = 0x20;
export const APP_CTRL_UNS = 0x10;
export const APP_CTRL_SEQ_MASK = 0x0f;

/** Parsed application request header + a coarse object-request list. */
export interface ParsedRequest {
  appControl: number;
  fir: boolean;
  fin: boolean;
  con: boolean;
  uns: boolean;
  seq: number;
  func: number;
  /** object headers found (group/variation + qualifier), best-effort */
  objects: ParsedObjectHeader[];
  /** True only when every octet after the function code was consumed. */
  objectsComplete: boolean;
  /** raw bytes after the function code (for SAv5 critical-ASDU MAC input) */
  rawObjects: Buffer;
  /**
   * The complete application fragment as received. IEEE 1815 defines the
   * Secure-Authentication "Critical ASDU" as the whole fragment (application
   * header included), and a verified request has to be re-dispatched from it.
   */
  raw: Buffer;
}

/** One index-prefixed object carried by a request (qualifier 0x17 / 0x28). */
export interface ParsedPrefixedObject {
  /** DNP3 point index from the object's index prefix */
  index: number;
  /** object body octets, excluding the index prefix */
  data: Buffer;
}

export interface ParsedObjectHeader {
  group: number;
  variation: number;
  qualifier: number;
  /** start/stop range, for qualifiers 0x00 / 0x01 */
  range?: { start: number; stop: number };
  /** object count, for the count and index-prefixed qualifiers */
  count?: number;
  /**
   * Decoded index-prefixed objects, for qualifiers 0x17 / 0x28 whose object
   * length this outstation knows. Absent when the objects could not be
   * length-decoded — callers must then treat the header as undecodable rather
   * than guessing at the octets.
   */
  items?: ParsedPrefixedObject[];
  /**
   * Decoded non-prefixed object data for the fixed-size objects this parser
   * understands. Currently used by WRITE g80v1, whose range contains packed
   * Internal Indication bits.
   */
  data?: Buffer;
  /**
   * Variable-length object bodies carried by qualifier 0x5B. The range field
   * is an 8-bit object count and every object is prefixed by a 16-bit
   * little-endian byte length.
   */
  freeFormat?: Buffer[];
}

/**
 * Parse an application request fragment.
 *
 * Object-header scanning understands the range qualifiers (0x00/0x01), the
 * "all objects" qualifier (0x06), the count qualifiers (0x07/0x08) and the
 * index-prefixed qualifiers 0x17 (1-octet prefix + 1-octet count) and 0x28
 * (2-octet prefix + 2-octet count). Index-prefixed object bodies are decoded
 * when the group/variation has a known fixed size — which covers every control
 * object (g12v1, g41v1..v4). Anything else stops the scan rather than
 * misinterpreting octets.
 *
 * The 16-bit free-format qualifier (0x5B) used by group-120 Secure
 * Authentication objects is decoded as count8 followed by size16 + body for
 * each object. The one non-prefixed write object required for normal master
 * startup, g80v1, is decoded explicitly below.
 */
export function parseRequest(fragment: Buffer): ParsedRequest {
  if (fragment.length < 2) {
    throw new Error("DNP3 application fragment too short");
  }
  const appControl = fragment[0];
  const func = fragment[1];
  const objects: ParsedObjectHeader[] = [];
  const rawObjects = Buffer.from(fragment.subarray(2));

  let off = 2;
  while (off + 3 <= fragment.length) {
    const group = fragment[off];
    const variation = fragment[off + 1];
    const qualifier = fragment[off + 2];
    const header: ParsedObjectHeader = { group, variation, qualifier };
    objects.push(header);
    off += 3;

    const prefixCode = (qualifier & 0xf0) >>> 4;
    const rangeCode = qualifier & 0x0f;
    let count: number | null = null;

    if (qualifier === 0x5b) {
      if (off + 1 > fragment.length) return finish(false);
      count = fragment[off];
      header.count = count;
      off += 1;
      const bodies: Buffer[] = [];
      for (let n = 0; n < count; n++) {
        if (off + 2 > fragment.length) return finish(false);
        const length = fragment.readUInt16LE(off);
        off += 2;
        if (off + length > fragment.length) return finish(false);
        bodies.push(Buffer.from(fragment.subarray(off, off + length)));
        off += length;
      }
      header.freeFormat = bodies;
      continue;
    }

    switch (rangeCode) {
      case 0x00: // start/stop, 1-octet indices
        if (off + 2 > fragment.length) return finish(false);
        header.range = { start: fragment[off], stop: fragment[off + 1] };
        count = header.range.stop - header.range.start + 1;
        off += 2;
        break;
      case 0x01: // start/stop, 2-octet indices
        if (off + 4 > fragment.length) return finish(false);
        header.range = {
          start: fragment.readUInt16LE(off),
          stop: fragment.readUInt16LE(off + 2),
        };
        count = header.range.stop - header.range.start + 1;
        off += 4;
        break;
      case 0x06: // all objects — no range field, no object data
        break;
      case 0x07: // 1-octet count
        if (off + 1 > fragment.length) return finish(false);
        count = fragment[off];
        off += 1;
        break;
      case 0x08: // 2-octet count
        if (off + 2 > fragment.length) return finish(false);
        count = fragment.readUInt16LE(off);
        off += 2;
        break;
      default:
        // Unknown range specifier: object data of unknown length follows, so
        // stop scanning rather than misparsing.
        return finish(false);
    }
    if (count !== null && count < 0) return finish(false);
    if (count !== null) header.count = count;

    // Index-prefixed object data (qualifiers 0x17 / 0x28).
    if (prefixCode === 1 || prefixCode === 2) {
      const prefixLen = prefixCode === 1 ? 1 : 2;
      const objectSize = commandObjectSize(group, variation);
      if (objectSize === null || count === null || count < 0) {
        // We cannot compute where this header's data ends.
        return finish(false);
      }
      const items: ParsedPrefixedObject[] = [];
      let ok = true;
      for (let n = 0; n < count; n++) {
        if (off + prefixLen + objectSize > fragment.length) {
          ok = false;
          break;
        }
        const index =
          prefixLen === 1 ? fragment[off] : fragment.readUInt16LE(off);
        const data = Buffer.from(
          fragment.subarray(off + prefixLen, off + prefixLen + objectSize),
        );
        items.push({ index, data });
        off += prefixLen + objectSize;
      }
      if (!ok) {
        // Truncated object data: leave `items` unset so callers reject the
        // header with a format error instead of acting on a partial command.
        return finish(false);
      }
      header.items = items;
    } else if (
      prefixCode === 0 &&
      group === DNP3_GROUP.INTERNAL_INDICATIONS &&
      variation === 1 &&
      count !== null
    ) {
      // g80v1 is a packed bit string. OpenDNP3 and other conforming masters
      // write IIN1.7 = 0 after observing DEVICE_RESTART, so consuming this data
      // is required to keep startup from retrying integrity polls forever.
      if (count < 0) return finish(false);
      const byteLength = Math.ceil(count / 8);
      if (off + byteLength > fragment.length) return finish(false);
      header.data = Buffer.from(fragment.subarray(off, off + byteLength));
      off += byteLength;
    } else if (prefixCode !== 0) {
      // 4-octet index prefixes and the free-format/object-size prefixes are not
      // modelled; their object data length is unknown to us.
      return finish(false);
    }
  }

  return finish();

  function finish(parseValid = true): ParsedRequest {
    return {
      appControl,
      fir: (appControl & APP_CTRL_FIR) !== 0,
      fin: (appControl & APP_CTRL_FIN) !== 0,
      con: (appControl & APP_CTRL_CON) !== 0,
      uns: (appControl & APP_CTRL_UNS) !== 0,
      seq: appControl & APP_CTRL_SEQ_MASK,
      func,
      objects,
      objectsComplete: parseValid && off === fragment.length,
      rawObjects,
      raw: Buffer.from(fragment),
    };
  }
}

/** Build the 4-octet response header (APP_CONTROL + FUNCTION + IIN). */
export function buildResponseHeader(opts: {
  seq: number;
  fir?: boolean;
  fin?: boolean;
  con?: boolean;
  unsolicited?: boolean;
  functionCode?: Dnp3FunctionCode;
  iin: number;
}): Buffer {
  let appControl = opts.seq & APP_CTRL_SEQ_MASK;
  if (opts.fir ?? true) appControl |= APP_CTRL_FIR;
  if (opts.fin ?? true) appControl |= APP_CTRL_FIN;
  if (opts.con) appControl |= APP_CTRL_CON;
  if (opts.unsolicited) appControl |= APP_CTRL_UNS;

  const buf = Buffer.alloc(4);
  buf.writeUInt8(appControl, 0);
  buf.writeUInt8(
    opts.functionCode ??
      (opts.unsolicited
        ? DNP3_FUNCTION.UNSOLICITED_RESPONSE
        : DNP3_FUNCTION.RESPONSE),
    1,
  );
  buf.writeUInt16LE(opts.iin & 0xffff, 2);
  return buf;
}

/** Build one qualifier-0x5B object (count8=1, size16LE, body). */
export function buildFreeFormat16Object(
  group: number,
  variation: number,
  body: Buffer,
): Buffer {
  if (body.length > 0xffff) {
    throw new Error(
      `DNP3 free-format object exceeds 65535 octets: ${body.length}`,
    );
  }
  const header = Buffer.alloc(6);
  header.writeUInt8(group & 0xff, 0);
  header.writeUInt8(variation & 0xff, 1);
  header.writeUInt8(0x5b, 2);
  header.writeUInt8(1, 3);
  header.writeUInt16LE(body.length, 4);
  return Buffer.concat([header, body]);
}

/**
 * Build an object header with qualifier 0x00 (8-bit start/stop index range)
 * followed by the concatenated point data. Used for contiguous static reads.
 */
export function buildObjectHeaderRange8(
  gv: PointGroupVariation,
  start: number,
  stop: number,
  data: Buffer,
): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(gv.group, 0);
  header.writeUInt8(gv.variation, 1);
  header.writeUInt8(0x00, 2); // qualifier: 8-bit start/stop
  header.writeUInt8(start & 0xff, 3);
  header.writeUInt8(stop & 0xff, 4);
  return Buffer.concat([header, data]);
}

/**
 * Build an object header with qualifier 0x01 (16-bit start/stop index range).
 * Required once a point index exceeds 255 — the 8-bit form would silently
 * truncate the index and hand the master the wrong points.
 */
export function buildObjectHeaderRange16(
  gv: PointGroupVariation,
  start: number,
  stop: number,
  data: Buffer,
): Buffer {
  const header = Buffer.alloc(7);
  header.writeUInt8(gv.group, 0);
  header.writeUInt8(gv.variation, 1);
  header.writeUInt8(0x01, 2); // qualifier: 16-bit start/stop
  header.writeUInt16LE(start & 0xffff, 3);
  header.writeUInt16LE(stop & 0xffff, 5);
  return Buffer.concat([header, data]);
}

/** Mapping of the five point types to read order for Class 0. */
const STATIC_READ_ORDER: Dnp3PointType[] = [
  "binaryInput",
  "binaryOutput",
  "counter",
  "analogInput",
  "analogOutput",
];

/** A contiguous run of same-variation static points being assembled. */
interface StaticRun {
  gv: PointGroupVariation;
  /** true when the run needs the 16-bit start/stop qualifier */
  wide: boolean;
  start: number;
  stop: number;
  chunks: Buffer[];
  /** octets of point data accumulated so far (header excluded) */
  bytes: number;
}

function encodeStaticRun(run: StaticRun): Buffer {
  const data = Buffer.concat(run.chunks);
  return run.wide
    ? buildObjectHeaderRange16(run.gv, run.start, run.stop, data)
    : buildObjectHeaderRange8(run.gv, run.start, run.stop, data);
}

/**
 * Assemble the Class-0 (all static data) response as a list of self-contained
 * object blocks. Each block is one object header plus its points, so the caller
 * can pack blocks into response fragments without splitting an object header.
 *
 * A new block is started whenever the point indices stop being contiguous, the
 * group/variation changes (e.g. an int32 and a float32 analog input in the same
 * group), an index crosses 255 (the range qualifier has to widen), or adding
 * the next point would exceed `maxBlockBytes`.
 */
export function buildClass0Blocks(
  map: Dnp3PointMap,
  maxBlockBytes: number = Number.MAX_SAFE_INTEGER,
): Buffer[] {
  const blocks: Buffer[] = [];
  for (const type of STATIC_READ_ORDER) {
    let current: StaticRun | undefined;
    for (const def of map.pointsOfType(type)) {
      const resolved = map.resolve(def.type, def.index);
      if (!resolved) continue;
      const ser = serializeStaticPoint(resolved);
      const wide = def.index > 0xff;

      if (current !== undefined) {
        const headerLen = current.wide ? 7 : 5;
        const continues =
          def.index === current.stop + 1 &&
          wide === current.wide &&
          ser.groupVariation.group === current.gv.group &&
          ser.groupVariation.variation === current.gv.variation &&
          headerLen + current.bytes + ser.data.length <= maxBlockBytes;
        if (!continues) {
          blocks.push(encodeStaticRun(current));
          current = undefined;
        }
      }

      if (current === undefined) {
        current = {
          gv: ser.groupVariation,
          wide,
          start: def.index,
          stop: def.index,
          chunks: [ser.data],
          bytes: ser.data.length,
        };
      } else {
        current.chunks.push(ser.data);
        current.bytes += ser.data.length;
        current.stop = def.index;
      }
    }
    if (current !== undefined) blocks.push(encodeStaticRun(current));
  }
  return blocks;
}

/**
 * Assemble the object portion of a Class-0 response as one buffer. Convenience
 * wrapper over {@link buildClass0Blocks} for callers with no fragment budget.
 */
export function buildClass0Objects(map: Dnp3PointMap): Buffer {
  return Buffer.concat(buildClass0Blocks(map));
}

/**
 * Build the IIN word from outstation state.
 */
export function buildIin(opts: {
  deviceRestart?: boolean;
  needTime?: boolean;
  class1Events?: boolean;
  class2Events?: boolean;
  class3Events?: boolean;
  eventBufferOverflow?: boolean;
  noFuncSupport?: boolean;
  objectUnknown?: boolean;
  parameterError?: boolean;
  alreadyExecuting?: boolean;
}): number {
  let iin = 0;
  if (opts.class1Events) iin |= DNP3_IIN.CLASS1_EVENTS;
  if (opts.class2Events) iin |= DNP3_IIN.CLASS2_EVENTS;
  if (opts.class3Events) iin |= DNP3_IIN.CLASS3_EVENTS;
  if (opts.needTime) iin |= DNP3_IIN.NEED_TIME;
  if (opts.deviceRestart) iin |= DNP3_IIN.DEVICE_RESTART;
  if (opts.eventBufferOverflow) iin |= DNP3_IIN.EVENT_BUFFER_OVERFLOW;
  if (opts.noFuncSupport) iin |= DNP3_IIN.NO_FUNC_CODE_SUPPORT;
  if (opts.objectUnknown) iin |= DNP3_IIN.OBJECT_UNKNOWN;
  if (opts.parameterError) iin |= DNP3_IIN.PARAMETER_ERROR;
  if (opts.alreadyExecuting) iin |= DNP3_IIN.ALREADY_EXECUTING;
  return iin & 0xffff;
}

/**
 * Determine whether a parsed request is a Class-0/1/2/3 read by inspecting its
 * object headers (group 60). Returns which classes were requested.
 */
export function classReadTargets(req: ParsedRequest): {
  class0: boolean;
  class1: boolean;
  class2: boolean;
  class3: boolean;
} {
  const result = { class0: false, class1: false, class2: false, class3: false };
  if (req.func !== DNP3_FUNCTION.READ) return result;
  for (const obj of req.objects) {
    if (obj.group !== DNP3_GROUP.CLASS_DATA) continue;
    switch (obj.variation) {
      case DNP3_VARIATION.CLASS0:
        result.class0 = true;
        break;
      case DNP3_VARIATION.CLASS1:
        result.class1 = true;
        break;
      case DNP3_VARIATION.CLASS2:
        result.class2 = true;
        break;
      case DNP3_VARIATION.CLASS3:
        result.class3 = true;
        break;
    }
  }
  return result;
}
