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
  get(namespace: string): SparkplugPayloadCodec;
}

/** Plain-object metric shape understood by `sparkplug-payload`. */
export interface ProtoMetric {
  name?: string;
  alias?: number;
  timestamp?: number;
  dataType: string;
  value: MetricValue;
  isHistorical?: boolean;
  isNull?: boolean;
  properties?: Record<string, { type: string; value: MetricValue }>;
}

/** Plain-object payload shape understood by `sparkplug-payload`. */
export interface ProtoPayload {
  timestamp: number;
  seq?: number;
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
  const proto: ProtoMetric = {
    name: metric.name,
    dataType: dataTypeName(metric.dataType),
    timestamp: metric.timestamp ?? now,
    value: isNull ? null : metric.value,
    isNull,
  };
  if (metric.alias !== undefined) proto.alias = metric.alias;
  if (metric.isHistorical) proto.isHistorical = true;
  if (metric.properties) {
    proto.properties = {};
    for (const [key, value] of Object.entries(metric.properties)) {
      proto.properties[key] = { type: inferPropertyType(value), value };
    }
  }
  return proto;
}

/** Map a decoded protobuf metric back to our internal representation. */
export function metricFromProto(proto: ProtoMetric): SparkplugMetric {
  const metric: SparkplugMetric = {
    name: proto.name ?? "",
    dataType: dataTypeFromName(proto.dataType),
    value: proto.isNull ? null : proto.value,
  };
  if (proto.alias !== undefined) metric.alias = proto.alias;
  if (proto.timestamp !== undefined) metric.timestamp = proto.timestamp;
  if (proto.isHistorical) metric.isHistorical = true;
  if (proto.isNull) metric.isNull = true;
  if (proto.properties) {
    metric.properties = {};
    for (const [key, prop] of Object.entries(proto.properties)) {
      metric.properties[key] = prop.value;
    }
  }
  return metric;
}

/** Map a whole internal payload onto the protobuf plain-object shape. */
export function payloadToProto(payload: SparkplugPayload, now: number = Date.now()): ProtoPayload {
  const proto: ProtoPayload = {
    timestamp: payload.timestamp,
    metrics: payload.metrics.map((m) => metricToProto(m, now)),
  };
  if (payload.seq !== undefined) proto.seq = payload.seq;
  if (payload.uuid !== undefined) proto.uuid = payload.uuid;
  if (payload.body !== undefined) proto.body = payload.body;
  return proto;
}

/** Map a decoded protobuf payload back to our internal representation. */
export function payloadFromProto(proto: ProtoPayload): SparkplugPayload {
  const payload: SparkplugPayload = {
    timestamp: proto.timestamp,
    metrics: (proto.metrics ?? []).map(metricFromProto),
  };
  if (proto.seq !== undefined) payload.seq = proto.seq;
  if (proto.uuid !== undefined) payload.uuid = proto.uuid;
  if (proto.body !== undefined) payload.body = proto.body;
  return payload;
}

/** Best-effort property data-type inference for metric property sets. */
function inferPropertyType(value: MetricValue): string {
  if (value === null) return "String";
  switch (typeof value) {
    case "boolean":
      return "Boolean";
    case "bigint":
      return "Int64";
    case "number":
      return Number.isInteger(value) ? "Int32" : "Double";
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
    cachedCodec = mod.get("spBv1.0");
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
