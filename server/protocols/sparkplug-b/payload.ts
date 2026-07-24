/**
 * Sparkplug B Payload Codec.
 *
 * Two concerns live here, deliberately separated so the pure parts are
 * unit-testable without the protobuf dependency present:
 *
 *  1. Pure metric mapping — converting between our internal {@link SparkplugMetric}
 *     representation and the plain-object shape that `sparkplug-payload`
 *     consumes/produces. This is the value-type fan-out that the spec is most
 *     pedantic about (Int64/UInt64 → string-or-bigint, isNull, aliases, etc.).
 *
 *  2. Protobuf encode/decode — a thin wrapper around the `sparkplug-payload`
 *     npm package (the reference codec generated from Eclipse Tahu's `.proto`).
 *     The dependency is loaded lazily so the rest of the bridge — and the unit
 *     tests — work even when node_modules is absent. If it is missing at
 *     runtime, encode/decode throw a clear, actionable error.
 *
 * Issue #463 — [wave:2c] Build MQTT Sparkplug B Bridge.
 *
 * INTEGRATION (sparkplug-payload): we type the dependency locally rather than
 * depend on its (untyped) shape. See `SparkplugPayloadCodec` below.
 */

import {
  SparkplugDataType,
  type MetricValue,
  type SparkplugMetric,
  type SparkplugPayload,
} from "./types";

/**
 * Minimal structural type for the `sparkplug-payload` v3 package. The package
 * exposes `get('spBv1.0')` returning an object with `encodePayload`/`decodePayload`.
 * We only depend on this narrow surface.
 */
interface SparkplugPayloadCodec {
  encodePayload(payload: ProtoPayload): Uint8Array;
  decodePayload(buffer: Uint8Array): ProtoPayload;
}

interface SparkplugPayloadModule {
  get(namespace: string): SparkplugPayloadCodec | null;
}

/**
 * Structural representation of the `long` values returned by protobufjs.
 *
 * `sparkplug-payload` can resolve a different `long` constructor than its own
 * direct dependency (the audited protobufjs 8 graph currently does), so
 * `instanceof Long` is not reliable. In that graph the package returns the raw
 * Long-like object for high-bit UInt32 values rather than applying its signed
 * `toInt()` branch. Reading the two 32-bit words preserves UInt32 values through
 * 0xffffffff and also recovers signed Int64 values when the decoded Long's own
 * unsigned flag is not trustworthy.
 */
interface LongLike {
  low: number;
  high: number;
  unsigned?: boolean;
  toString(): string;
}

type CodecInteger = number | string | LongLike;
type CodecValue = MetricValue | LongLike;

/** Plain-object property value shape understood by `sparkplug-payload`. */
interface ProtoPropertyValue {
  type: string;
  value: CodecValue;
}

/** Plain-object metric shape understood by `sparkplug-payload`. */
export interface ProtoMetric {
  name?: string;
  alias?: CodecInteger;
  timestamp?: CodecInteger;
  /** Public codec field name (not the protobuf schema's `datatype` field). */
  type: string;
  value: CodecValue;
  isHistorical?: boolean;
  isNull?: boolean;
  properties?: Record<string, ProtoPropertyValue>;
}

/** Plain-object payload shape understood by `sparkplug-payload`. */
export interface ProtoPayload {
  timestamp: CodecInteger;
  seq?: CodecInteger;
  uuid?: string;
  body?: Uint8Array;
  metrics: ProtoMetric[];
}

/** Reverse lookup: enum value → spec data-type name string. */
const DATA_TYPE_NAME: Record<SparkplugDataType, string> = {
  [SparkplugDataType.Int8]: "Int8",
  [SparkplugDataType.Int16]: "Int16",
  [SparkplugDataType.Int32]: "Int32",
  [SparkplugDataType.Int64]: "Int64",
  [SparkplugDataType.UInt8]: "UInt8",
  [SparkplugDataType.UInt16]: "UInt16",
  [SparkplugDataType.UInt32]: "UInt32",
  [SparkplugDataType.UInt64]: "UInt64",
  [SparkplugDataType.Float]: "Float",
  [SparkplugDataType.Double]: "Double",
  [SparkplugDataType.Boolean]: "Boolean",
  [SparkplugDataType.String]: "String",
  [SparkplugDataType.DateTime]: "DateTime",
  [SparkplugDataType.Text]: "Text",
  [SparkplugDataType.UUID]: "UUID",
};

const DATA_TYPE_BY_NAME: Record<string, SparkplugDataType> = Object.fromEntries(
  Object.entries(DATA_TYPE_NAME).map(([k, v]) => [v, Number(k) as SparkplugDataType]),
) as Record<string, SparkplugDataType>;

/** Convert a {@link SparkplugDataType} to the spec name string. */
export function dataTypeName(dataType: SparkplugDataType): string {
  const name = DATA_TYPE_NAME[dataType];
  if (!name) throw new Error(`Unknown Sparkplug data type: ${dataType}`);
  return name;
}

/** Convert a spec data-type name string back to a {@link SparkplugDataType}. */
export function dataTypeFromName(name: string): SparkplugDataType {
  const dt = DATA_TYPE_BY_NAME[name];
  if (dt === undefined) throw new Error(`Unknown Sparkplug data type name: ${name}`);
  return dt;
}

// --- Pure metric mapping (unit-testable, no protobuf dependency) ---

/**
 * Map an internal metric onto the plain-object shape consumed by the protobuf
 * encoder. Defaults the timestamp to `now` and derives `isNull`.
 */
export function metricToProto(metric: SparkplugMetric, now: number = Date.now()): ProtoMetric {
  const isNull = metric.isNull ?? metric.value === null;
  const timestamp = validateUnsignedSafeInteger(
    metric.timestamp ?? now,
    "metric timestamp",
  );
  const proto: ProtoMetric = {
    name: metric.name,
    type: dataTypeName(metric.dataType),
    timestamp,
    value: isNull ? null : metricValueToCodec(metric.value, metric.dataType),
    isNull,
  };
  if (metric.alias !== undefined) {
    proto.alias = validateUnsignedSafeInteger(metric.alias, "metric alias");
  }
  if (metric.isHistorical) proto.isHistorical = true;
  if (metric.properties) {
    proto.properties = {};
    for (const [key, value] of Object.entries(metric.properties)) {
      const type = inferPropertyType(value);
      proto.properties[key] = {
        type,
        value:
          value === null
            ? null
            : metricValueToCodec(value, dataTypeFromName(type)),
      };
    }
  }
  return proto;
}

/** Map a decoded protobuf metric back to our internal representation. */
export function metricFromProto(proto: ProtoMetric): SparkplugMetric {
  const dataType = dataTypeFromName(proto.type);
  const metric: SparkplugMetric = {
    name: proto.name ?? "",
    dataType,
    value: proto.isNull ? null : metricValueFromCodec(proto.value, dataType),
  };
  if (proto.alias !== undefined) {
    metric.alias = codecIntegerToUnsignedSafeNumber(proto.alias, "metric alias");
  }
  if (proto.timestamp !== undefined) {
    metric.timestamp = codecIntegerToUnsignedSafeNumber(
      proto.timestamp,
      "metric timestamp",
    );
  }
  if (proto.isHistorical) metric.isHistorical = true;
  if (proto.isNull) metric.isNull = true;
  if (proto.properties) {
    metric.properties = {};
    for (const [key, prop] of Object.entries(proto.properties)) {
      metric.properties[key] = metricValueFromCodec(
        prop.value,
        dataTypeFromName(prop.type),
      );
    }
  }
  return metric;
}

/** Map a whole internal payload onto the protobuf plain-object shape. */
export function payloadToProto(payload: SparkplugPayload, now: number = Date.now()): ProtoPayload {
  const proto: ProtoPayload = {
    timestamp: validateUnsignedSafeInteger(payload.timestamp, "payload timestamp"),
    metrics: payload.metrics.map((m) => metricToProto(m, now)),
  };
  if (payload.seq !== undefined) {
    proto.seq = validateSequence(payload.seq);
  }
  if (payload.uuid !== undefined) proto.uuid = payload.uuid;
  if (payload.body !== undefined) proto.body = payload.body;
  return proto;
}

/** Map a decoded protobuf payload back to our internal representation. */
export function payloadFromProto(proto: ProtoPayload): SparkplugPayload {
  const payload: SparkplugPayload = {
    timestamp: codecIntegerToUnsignedSafeNumber(
      proto.timestamp,
      "payload timestamp",
    ),
    metrics: (proto.metrics ?? []).map(metricFromProto),
  };
  if (proto.seq !== undefined) {
    const seq = codecIntegerToUnsignedSafeNumber(proto.seq, "payload sequence");
    if (seq > 255) {
      throw new RangeError(`payload sequence ${seq} is outside 0..255`);
    }
    payload.seq = seq;
  }
  if (proto.uuid !== undefined) payload.uuid = proto.uuid;
  if (proto.body !== undefined) payload.body = proto.body;
  return payload;
}

const SIGNED_INT64_MIN = -(1n << 63n);
const SIGNED_INT64_MAX = (1n << 63n) - 1n;
const UINT32_MAX = (1n << 32n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;
const INT32_MIN = -(1n << 31n);
const INT32_MAX = (1n << 31n) - 1n;
const SAFE_INTEGER_MIN = BigInt(Number.MIN_SAFE_INTEGER);
const SAFE_INTEGER_MAX = BigInt(Number.MAX_SAFE_INTEGER);

function validateUnsignedSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function validateSequence(value: number): number {
  const seq = validateUnsignedSafeInteger(value, "payload sequence");
  if (seq > 255) {
    throw new RangeError(`payload sequence ${seq} is outside 0..255`);
  }
  return seq;
}

function isLongDataType(dataType: SparkplugDataType): boolean {
  return (
    dataType === SparkplugDataType.Int64 ||
    dataType === SparkplugDataType.UInt32 ||
    dataType === SparkplugDataType.UInt64 ||
    dataType === SparkplugDataType.DateTime
  );
}

/**
 * Adapt internal bigint values to the decimal-string form accepted by
 * `sparkplug-payload`. Passing a JavaScript bigint directly currently encodes
 * as zero in protobufjs, so silently forwarding it would corrupt telemetry.
 */
function metricValueToCodec(
  value: MetricValue,
  dataType: SparkplugDataType,
): CodecValue {
  if (value === null) return null;
  if (!isLongDataType(dataType)) {
    if (typeof value === "bigint") {
      throw new TypeError(`${dataTypeName(dataType)} metrics do not accept bigint values`);
    }
    return value;
  }

  let exact: bigint;
  if (typeof value === "bigint") {
    exact = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(
        `${dataTypeName(dataType)} values supplied as number must be safe integers; ` +
          "use an integer string or bigint for exact 64-bit values",
      );
    }
    exact = BigInt(value);
  } else if (typeof value === "string") {
    if (!/^-?(0|[1-9]\d*)$/.test(value)) {
      throw new TypeError(
        `${dataTypeName(dataType)} string values must be canonical base-10 integers`,
      );
    }
    exact = BigInt(value);
  } else {
    throw new TypeError(
      `${dataTypeName(dataType)} metrics require an integer number, string, or bigint`,
    );
  }

  const [min, max] = integerBounds(dataType);
  if (exact < min || exact > max) {
    throw new RangeError(
      `${dataTypeName(dataType)} value ${exact} is outside ${min}..${max}`,
    );
  }
  return exact.toString();
}

/**
 * Convert a decoded long-like value into our number/bigint representation.
 * Safe values stay ergonomic numbers; larger values remain exact bigints.
 */
function metricValueFromCodec(
  value: CodecValue,
  dataType: SparkplugDataType,
): MetricValue {
  if (value === null || !isLongDataType(dataType)) return value as MetricValue;

  let exact: bigint;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(
        `Decoded ${dataTypeName(dataType)} number is not a safe integer`,
      );
    }
    exact = BigInt(value);
  } else if (typeof value === "bigint") {
    exact = value;
  } else if (typeof value === "string") {
    if (!/^-?(0|[1-9]\d*)$/.test(value)) {
      throw new TypeError(
        `Decoded ${dataTypeName(dataType)} string is not a canonical integer`,
      );
    }
    exact = BigInt(value);
  } else if (isLongLike(value)) {
    exact = longLikeToBigInt(value, dataType === SparkplugDataType.Int64);
  } else {
    throw new TypeError(
      `Decoded ${dataTypeName(dataType)} metric has a non-integer value`,
    );
  }
  const [min, max] = integerBounds(dataType);
  if (exact < min || exact > max) {
    throw new RangeError(
      `Decoded ${dataTypeName(dataType)} value ${exact} is outside ${min}..${max}`,
    );
  }
  return compactInteger(exact);
}

function integerBounds(dataType: SparkplugDataType): readonly [bigint, bigint] {
  if (dataType === SparkplugDataType.Int64) {
    return [SIGNED_INT64_MIN, SIGNED_INT64_MAX];
  }
  if (dataType === SparkplugDataType.UInt32) {
    return [0n, UINT32_MAX];
  }
  return [0n, UINT64_MAX];
}

function isLongLike(value: unknown): value is LongLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as LongLike).low === "number" &&
    typeof (value as LongLike).high === "number"
  );
}

/** Reconstruct the exact integer from protobufjs Long low/high words. */
function longLikeToBigInt(value: LongLike, signed: boolean): bigint {
  const bits =
    (BigInt(value.high >>> 0) << 32n) |
    BigInt(value.low >>> 0);
  return signed && bits >= 1n << 63n ? bits - (1n << 64n) : bits;
}

function codecIntegerToBigInt(value: CodecInteger): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`Decoded integer ${value} is not safely representable`);
    }
    return BigInt(value);
  }
  if (typeof value === "string") return BigInt(value);
  if (isLongLike(value)) return longLikeToBigInt(value, false);
  throw new TypeError("Decoded protobuf integer has an unsupported shape");
}

function codecIntegerToSafeNumber(value: CodecInteger, field: string): number {
  const exact = codecIntegerToBigInt(value);
  if (exact < SAFE_INTEGER_MIN || exact > SAFE_INTEGER_MAX) {
    throw new RangeError(`${field} ${exact} exceeds JavaScript's safe integer range`);
  }
  return Number(exact);
}

function codecIntegerToUnsignedSafeNumber(
  value: CodecInteger,
  field: string,
): number {
  const decoded = codecIntegerToSafeNumber(value, field);
  if (decoded < 0) {
    throw new RangeError(`${field} ${decoded} must be non-negative`);
  }
  return decoded;
}

function compactInteger(value: bigint): number | bigint {
  return value >= SAFE_INTEGER_MIN && value <= SAFE_INTEGER_MAX
    ? Number(value)
    : value;
}

/** Best-effort property data-type inference for metric property sets. */
function inferPropertyType(value: MetricValue): string {
  if (value === null) return "String";
  switch (typeof value) {
    case "boolean":
      return "Boolean";
    case "bigint": {
      if (value >= SIGNED_INT64_MIN && value <= SIGNED_INT64_MAX) {
        return "Int64";
      }
      if (value >= 0n && value <= UINT64_MAX) {
        return "UInt64";
      }
      throw new RangeError(`property integer ${value} is outside Int64/UInt64 range`);
    }
    case "number": {
      if (!Number.isInteger(value)) return "Double";
      if (!Number.isSafeInteger(value)) {
        throw new RangeError("property integer must be safely representable");
      }
      const exact = BigInt(value);
      if (exact >= INT32_MIN && exact <= INT32_MAX) return "Int32";
      if (exact >= 0n && exact <= UINT32_MAX) return "UInt32";
      return "Int64";
    }
    default:
      return "String";
  }
}

// --- Protobuf encode/decode (lazy dependency) ---

let cachedCodec: SparkplugPayloadCodec | null = null;
let codecLoadError: Error | null = null;

/**
 * Resolve the `sparkplug-payload` codec lazily. Cached after first success.
 *
 * TODO(#463): when `sparkplug-payload` is installed (it is declared in
 * package.json but `npm install` is intentionally not run in the worktree),
 * this resolves the real Eclipse-Tahu-generated protobuf codec. If the module
 * is missing we surface a single clear error rather than crashing the server.
 */
function resolveCodec(): SparkplugPayloadCodec {
  if (cachedCodec) return cachedCodec;
  if (codecLoadError) throw codecLoadError;
  try {
    // Use eval-require so bundlers/TS don't hard-fail when the optional dep is
    // absent; this mirrors the dynamic-import guard used elsewhere in server/.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("sparkplug-payload") as SparkplugPayloadModule;
    const codec = mod.get("spBv1.0");
    if (!codec) {
      throw new Error("codec namespace spBv1.0 is unavailable");
    }
    cachedCodec = codec;
    return cachedCodec;
  } catch (err) {
    codecLoadError = new Error(
      "sparkplug-payload is not available. Add it to dependencies and run " +
        "`npm install` to enable Sparkplug B protobuf encoding. " +
        `Underlying error: ${(err as Error).message}`,
    );
    throw codecLoadError;
  }
}

/** Returns true if the protobuf codec can be loaded in this environment. */
export function isCodecAvailable(): boolean {
  try {
    resolveCodec();
    return true;
  } catch {
    return false;
  }
}

/**
 * Allow tests (and the broker client, for dependency injection) to supply a
 * codec implementation directly, bypassing the lazy require.
 */
export function setCodec(codec: SparkplugPayloadCodec | null): void {
  cachedCodec = codec;
  codecLoadError = null;
}

/**
 * Encode an internal payload to Sparkplug B protobuf bytes.
 * @throws if the protobuf codec is unavailable.
 */
export function encodePayload(payload: SparkplugPayload, now: number = Date.now()): Uint8Array {
  const codec = resolveCodec();
  return codec.encodePayload(payloadToProto(payload, now));
}

/**
 * Decode Sparkplug B protobuf bytes into an internal payload.
 * @throws if the protobuf codec is unavailable.
 */
export function decodePayload(buffer: Uint8Array): SparkplugPayload {
  const codec = resolveCodec();
  return payloadFromProto(codec.decodePayload(buffer));
}
