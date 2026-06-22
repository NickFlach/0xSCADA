/**
 * DNP3 Application Layer — APDU Assembly
 * Issue #464: DNP3 Outstation Mode
 *
 * PARTIAL (substantial). The request-header parse, response-header build,
 * object-header (qualifier 0x00/0x01 — 1-octet start/stop range) emission, and
 * the Class-0 static-read assembly are implemented + unit tested. Full request
 * parsing for every qualifier code, prefixed object headers, and per-variation
 * read selection are marked TODO inline.
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
} from './app-objects';
import {
  Dnp3PointMap,
  serializeStaticPoint,
  type Dnp3PointType,
  type PointGroupVariation,
} from './point-map';

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
  /** raw bytes after the function code (for SAv5 critical-ASDU MAC input) */
  rawObjects: Buffer;
}

export interface ParsedObjectHeader {
  group: number;
  variation: number;
  qualifier: number;
}

/**
 * Parse an application request fragment. Implemented: header + object-header
 * group/variation/qualifier scan with range field skipping for the common
 * qualifiers (0x00,0x01,0x06,0x07,0x08). TODO: prefixed counts (0x17/0x28) and
 * object-data length computation for write/operate payloads.
 */
export function parseRequest(fragment: Buffer): ParsedRequest {
  if (fragment.length < 2) {
    throw new Error('DNP3 application fragment too short');
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
    objects.push({ group, variation, qualifier });
    off += 3;
    // Skip the range field based on qualifier code (low nibble).
    const rangeSpecifier = qualifier & 0x0f;
    switch (rangeSpecifier) {
      case 0x00: // start/stop 1-octet
        off += 2;
        break;
      case 0x01: // start/stop 2-octet
        off += 4;
        break;
      case 0x06: // all objects, no range
        break;
      case 0x07: // 1-octet count
        off += 1;
        break;
      case 0x08: // 2-octet count
        off += 2;
        break;
      default:
        // TODO: prefixed-index qualifiers (0x17/0x28) carry object data we do
        // not yet length-decode; stop scanning to avoid misparsing.
        off = fragment.length;
        break;
    }
  }

  return {
    appControl,
    fir: (appControl & APP_CTRL_FIR) !== 0,
    fin: (appControl & APP_CTRL_FIN) !== 0,
    con: (appControl & APP_CTRL_CON) !== 0,
    uns: (appControl & APP_CTRL_UNS) !== 0,
    seq: appControl & APP_CTRL_SEQ_MASK,
    func,
    objects,
    rawObjects,
  };
}

/** Build the 4-octet response header (APP_CONTROL + FUNCTION + IIN). */
export function buildResponseHeader(opts: {
  seq: number;
  fir?: boolean;
  fin?: boolean;
  con?: boolean;
  unsolicited?: boolean;
  iin: number;
}): Buffer {
  let appControl = opts.seq & APP_CTRL_SEQ_MASK;
  if (opts.fir ?? true) appControl |= APP_CTRL_FIR;
  if (opts.fin ?? true) appControl |= APP_CTRL_FIN;
  if (opts.con) appControl |= APP_CTRL_CON;
  if (opts.unsolicited) appControl |= APP_CTRL_UNS;

  const buf = Buffer.alloc(4);
  buf.writeUInt8(appControl, 0);
  buf.writeUInt8(opts.unsolicited ? DNP3_FUNCTION.UNSOLICITED_RESPONSE : DNP3_FUNCTION.RESPONSE, 1);
  buf.writeUInt16LE(opts.iin & 0xffff, 2);
  return buf;
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

/** Mapping of the five point types to read order for Class 0. */
const STATIC_READ_ORDER: Dnp3PointType[] = [
  'binaryInput',
  'binaryOutput',
  'counter',
  'analogInput',
  'analogOutput',
];

/**
 * Assemble the object portion of a Class-0 (all static data) response from the
 * point map. Groups contiguous points of each type into a single qualifier-0x00
 * object header. Returns the concatenated object bytes (no app header).
 *
 * NOTE: assumes each type's indices are contiguous from 0; gaps would require
 * multiple range headers — a TODO for sparse maps.
 */
export function buildClass0Objects(map: Dnp3PointMap): Buffer {
  const parts: Buffer[] = [];
  for (const type of STATIC_READ_ORDER) {
    const points = map.pointsOfType(type);
    if (points.length === 0) continue;

    const dataChunks: Buffer[] = [];
    let gv: PointGroupVariation | null = null;
    for (const def of points) {
      const resolved = map.resolve(def.type, def.index)!;
      const ser = serializeStaticPoint(resolved);
      gv = ser.groupVariation;
      dataChunks.push(ser.data);
    }
    if (!gv) continue;
    const start = points[0].index;
    const stop = points[points.length - 1].index;
    parts.push(buildObjectHeaderRange8(gv, start, stop, Buffer.concat(dataChunks)));
  }
  return Buffer.concat(parts);
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
