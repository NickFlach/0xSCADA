/**
 * DNP3 Application-Layer Object / Variation Definitions
 * Issue #464: DNP3 Outstation Mode
 *
 * Pure, fully-implemented constants + encoders for the DNP3 object model
 * (IEEE 1815-2012). These are the testable cores of the application layer:
 * group/variation identifiers, status-flag (quality) octets, and the helpers
 * that serialise a single point value into its wire representation.
 *
 * IMPLEMENTED (fully + unit tested):
 *   - Object group / variation enums for the five static groups + their events
 *   - Status-flag octet construction (IIN-independent point quality flags)
 *   - Internal Indication (IIN) bit constants
 *   - Function codes
 *   - Single-point value encoders for each supported variation
 *
 * NOTE: Object-header (qualifier/range) framing and full APDU assembly live in
 * `index.ts` and are marked there as substantial-but-partial. This file only
 * owns the leaf encoding that opendnp3 conformance most depends on.
 */

/** DNP3 application-layer function codes (subset relevant to an outstation). */
export const DNP3_FUNCTION = {
  // Requests (master -> outstation)
  CONFIRM: 0x00,
  READ: 0x01,
  WRITE: 0x02,
  SELECT: 0x03,
  OPERATE: 0x04,
  DIRECT_OPERATE: 0x05,
  DIRECT_OPERATE_NR: 0x06,
  COLD_RESTART: 0x0d,
  WARM_RESTART: 0x0e,
  ENABLE_UNSOLICITED: 0x14,
  DISABLE_UNSOLICITED: 0x15,
  // Responses (outstation -> master)
  RESPONSE: 0x81,
  UNSOLICITED_RESPONSE: 0x82,
  // Secure Authentication v5 (group 120) carrier function code
  AUTHENTICATE_RESP: 0x83,
} as const;

export type Dnp3FunctionCode = (typeof DNP3_FUNCTION)[keyof typeof DNP3_FUNCTION];

/**
 * DNP3 object groups for the five static measurement classes + their event
 * counterparts. Group numbers are fixed by IEEE 1815.
 */
export const DNP3_GROUP = {
  BINARY_INPUT_STATIC: 1,
  BINARY_INPUT_EVENT: 2,
  BINARY_OUTPUT_STATIC: 10,
  BINARY_OUTPUT_EVENT: 11,
  BINARY_OUTPUT_COMMAND: 12, // CROB
  COUNTER_STATIC: 20,
  COUNTER_EVENT: 22,
  ANALOG_INPUT_STATIC: 30,
  ANALOG_INPUT_EVENT: 32,
  ANALOG_OUTPUT_STATUS: 40,
  ANALOG_OUTPUT_EVENT: 42,
  ANALOG_OUTPUT_COMMAND: 41,
  CLASS_DATA: 60,
  INTERNAL_INDICATIONS: 80,
  SECURE_AUTH: 120,
} as const;

/**
 * Variation numbers used by this outstation. We pick the explicitly-typed
 * variations (with flags) for maximum master interoperability.
 */
export const DNP3_VARIATION = {
  // Group 1 — Binary Input
  BI_PACKED: 1, // 1-bit, no flags
  BI_WITH_FLAGS: 2,
  // Group 2 — Binary Input Event
  BI_EVENT_NO_TIME: 1,
  BI_EVENT_ABS_TIME: 2,
  // Group 10 — Binary Output Status
  BO_STATUS_WITH_FLAGS: 2,
  // Group 20 — Counter
  CNT_32_WITH_FLAG: 1,
  CNT_16_WITH_FLAG: 2,
  // Group 22 — Counter Event
  CNT_EVENT_32_WITH_FLAG: 1,
  // Group 30 — Analog Input
  AI_32_WITH_FLAG: 1,
  AI_16_WITH_FLAG: 2,
  AI_FLOAT_WITH_FLAG: 5,
  // Group 32 — Analog Input Event
  AI_EVENT_32_WITH_FLAG: 1,
  AI_EVENT_FLOAT_WITH_FLAG: 5,
  // Group 40 — Analog Output Status
  AO_STATUS_32_WITH_FLAG: 1,
  AO_STATUS_FLOAT_WITH_FLAG: 3,
  // Class objects (group 60)
  CLASS0: 1,
  CLASS1: 2,
  CLASS2: 3,
  CLASS3: 4,
} as const;

/**
 * DNP3 status-flag (quality) bits. These are common across binary, analog and
 * counter objects (IEEE 1815 Table). The flag octet is the first byte of every
 * "with flags" variation.
 */
export const DNP3_FLAG = {
  ONLINE: 0x01,
  RESTART: 0x02,
  COMM_LOST: 0x04,
  REMOTE_FORCED: 0x08,
  LOCAL_FORCED: 0x10,
  // Analog/counter only
  OVER_RANGE: 0x20,
  REFERENCE_ERR: 0x40,
  // Binary only — the actual state lives in bit 7
  STATE: 0x80,
  // Counter rollover reuses bit 5 (OVER_RANGE position) per spec
  ROLLOVER: 0x20,
  DISCONTINUITY: 0x40,
} as const;

/** Internal Indication (IIN) bits — outstation status reported in every response. */
export const DNP3_IIN = {
  // IIN1 (first octet)
  ALL_STATIONS: 0x0100,
  CLASS1_EVENTS: 0x0200,
  CLASS2_EVENTS: 0x0400,
  CLASS3_EVENTS: 0x0800,
  NEED_TIME: 0x1000,
  LOCAL_CONTROL: 0x2000,
  DEVICE_TROUBLE: 0x4000,
  DEVICE_RESTART: 0x8000,
  // IIN2 (second octet)
  NO_FUNC_CODE_SUPPORT: 0x0001,
  OBJECT_UNKNOWN: 0x0002,
  PARAMETER_ERROR: 0x0004,
  EVENT_BUFFER_OVERFLOW: 0x0008,
  ALREADY_EXECUTING: 0x0010,
  CONFIG_CORRUPT: 0x0020,
} as const;

/** Quality of a point as understood by the rest of 0xSCADA. */
export type PointQuality = 'good' | 'bad' | 'uncertain';

export interface FlagOptions {
  online?: boolean;
  restart?: boolean;
  commLost?: boolean;
  remoteForced?: boolean;
  localForced?: boolean;
  overRange?: boolean;
  referenceErr?: boolean;
  /** binary point state (sets bit 7) */
  state?: boolean;
  /** counter rollover (binary state position is not used for counters) */
  rollover?: boolean;
}

/**
 * Build the DNP3 flag octet for an analog or counter point.
 * Bit layout: [online, restart, commLost, remoteForced, localForced,
 *              overRange/rollover, referenceErr/discontinuity, reserved].
 */
export function buildAnalogFlags(opts: FlagOptions): number {
  let flags = 0;
  if (opts.online ?? true) flags |= DNP3_FLAG.ONLINE;
  if (opts.restart) flags |= DNP3_FLAG.RESTART;
  if (opts.commLost) flags |= DNP3_FLAG.COMM_LOST;
  if (opts.remoteForced) flags |= DNP3_FLAG.REMOTE_FORCED;
  if (opts.localForced) flags |= DNP3_FLAG.LOCAL_FORCED;
  if (opts.overRange || opts.rollover) flags |= DNP3_FLAG.OVER_RANGE;
  if (opts.referenceErr) flags |= DNP3_FLAG.REFERENCE_ERR;
  return flags & 0xff;
}

/**
 * Build the DNP3 flag octet for a binary point. Identical to the analog octet
 * except bit 7 carries the actual binary state.
 */
export function buildBinaryFlags(opts: FlagOptions): number {
  let flags = buildAnalogFlags(opts) & 0x7f; // clear state bit region
  if (opts.state) flags |= DNP3_FLAG.STATE;
  return flags & 0xff;
}

/**
 * Map 0xSCADA point quality to the DNP3 flag option set. A `bad` quality clears
 * ONLINE and sets COMM_LOST; `uncertain` keeps ONLINE but marks local-forced.
 */
export function qualityToFlags(quality: PointQuality, state?: boolean): FlagOptions {
  switch (quality) {
    case 'good':
      return { online: true, state };
    case 'uncertain':
      return { online: true, localForced: true, state };
    case 'bad':
    default:
      return { online: false, commLost: true, state };
  }
}

/** Encode a 16-bit signed analog value with flag (group 30 var 2 / 32 var 2). */
export function encodeAnalog16WithFlag(value: number, flags: number): Buffer {
  const buf = Buffer.alloc(3);
  buf.writeUInt8(flags, 0);
  buf.writeInt16LE(clampInt(value, -32768, 32767), 1);
  return buf;
}

/** Encode a 32-bit signed analog value with flag (group 30 var 1 / 32 var 1). */
export function encodeAnalog32WithFlag(value: number, flags: number): Buffer {
  const buf = Buffer.alloc(5);
  buf.writeUInt8(flags, 0);
  buf.writeInt32LE(clampInt(value, -2147483648, 2147483647), 1);
  return buf;
}

/** Encode a single-precision float analog value with flag (group 30 var 5). */
export function encodeAnalogFloatWithFlag(value: number, flags: number): Buffer {
  const buf = Buffer.alloc(5);
  buf.writeUInt8(flags, 0);
  buf.writeFloatLE(value, 1);
  return buf;
}

/** Encode a 32-bit counter with flag (group 20 var 1 / 22 var 1). */
export function encodeCounter32WithFlag(value: number, flags: number): Buffer {
  const buf = Buffer.alloc(5);
  buf.writeUInt8(flags, 0);
  buf.writeUInt32LE(clampUint(value, 0xffffffff), 1);
  return buf;
}

/** Encode a binary point flag octet only (group 1 var 2 / group 10 var 2). */
export function encodeBinaryWithFlag(flags: number): Buffer {
  return Buffer.from([flags & 0xff]);
}

/** Clamp an integer into [min,max], rounding toward zero. */
function clampInt(value: number, min: number, max: number): number {
  const v = Math.trunc(value);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/** Clamp an unsigned integer into [0,max]. */
function clampUint(value: number, max: number): number {
  const v = Math.trunc(value);
  if (v < 0) return 0;
  if (v > max) return max;
  return v;
}
