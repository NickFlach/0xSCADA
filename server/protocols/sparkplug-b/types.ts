/**
 * Sparkplug B Bridge — configuration & domain types.
 *
 * Provides a Zod-validated config loader (matching the repo's config-manager
 * conventions) plus the metric/payload value types used across the codec and
 * the lifecycle state machine.
 *
 * Issue #463 — [wave:2c] Build MQTT Sparkplug B Bridge.
 */

import { z } from "zod";

/**
 * Sparkplug B metric data types relevant to a SCADA edge node. The numeric
 * codes match the `DataType` enum defined in the Sparkplug B specification
 * (§15.1) and used by the `sparkplug-payload` protobuf encoder.
 */
export enum SparkplugDataType {
  Int8 = 1,
  Int16 = 2,
  Int32 = 3,
  Int64 = 4,
  UInt8 = 5,
  UInt16 = 6,
  UInt32 = 7,
  UInt64 = 8,
  Float = 9,
  Double = 10,
  Boolean = 11,
  String = 12,
  DateTime = 13,
  Text = 14,
  UUID = 15,
}

/** Map a Sparkplug data-type name to its enum value (used by config/tags). */
export const SPARKPLUG_DATA_TYPE_BY_NAME: Record<string, SparkplugDataType> = {
  Int8: SparkplugDataType.Int8,
  Int16: SparkplugDataType.Int16,
  Int32: SparkplugDataType.Int32,
  Int64: SparkplugDataType.Int64,
  UInt8: SparkplugDataType.UInt8,
  UInt16: SparkplugDataType.UInt16,
  UInt32: SparkplugDataType.UInt32,
  UInt64: SparkplugDataType.UInt64,
  Float: SparkplugDataType.Float,
  Double: SparkplugDataType.Double,
  Boolean: SparkplugDataType.Boolean,
  String: SparkplugDataType.String,
  DateTime: SparkplugDataType.DateTime,
  Text: SparkplugDataType.Text,
  UUID: SparkplugDataType.UUID,
};

/** Primitive value a Sparkplug metric can carry. */
export type MetricValue = number | bigint | boolean | string | null;

/**
 * A single Sparkplug B metric. This is the internal representation; the codec
 * maps it onto/off the protobuf `Payload.Metric` shape.
 */
export interface SparkplugMetric {
  /** Metric name, e.g. "Temperature" or "Node Control/Rebirth". */
  name: string;
  /** Optional metric alias (numeric) used to shrink DATA payloads. */
  alias?: number;
  /** Sparkplug data type. */
  dataType: SparkplugDataType;
  /** Current value. */
  value: MetricValue;
  /** Epoch milliseconds the value was sampled. Defaults to now at encode. */
  timestamp?: number;
  /** Whether this metric represents the historical / not-live flag. */
  isHistorical?: boolean;
  /** Sparkplug "is null" indicator (set when value === null). */
  isNull?: boolean;
  /** Optional engineering properties (units, quality, etc.). */
  properties?: Record<string, MetricValue>;
}

/**
 * A decoded Sparkplug B payload (NBIRTH/NDATA/DBIRTH/DDATA/STATE bodies).
 */
export interface SparkplugPayload {
  /** Payload timestamp (epoch ms). */
  timestamp: number;
  /** Sequence number 0..255 (rolls over). */
  seq?: number;
  /** Metrics carried by the payload. */
  metrics: SparkplugMetric[];
  /** Optional opaque body (used by STATE messages in some hosts). */
  body?: Uint8Array;
  /** UUID — used by the spec for template/payload identification. */
  uuid?: string;
}

// --- Configuration ---

export const SparkplugConfigSchema = z.object({
  /** MQTT broker URL, e.g. mqtt://broker:1883 or mqtts://broker:8883. */
  brokerUrl: z.string().min(1),
  /** Optional MQTT username. */
  username: z.string().optional(),
  /** Optional MQTT password. */
  password: z.string().optional(),
  /** MQTT client id; defaults to a derived edge-node id. */
  clientId: z.string().optional(),
  /** Sparkplug group id (logical grouping of edge nodes). */
  groupId: z.string().min(1).default("0xSCADA"),
  /** This bridge's edge node id. */
  edgeNodeId: z.string().min(1).default("edge-node"),
  /**
   * Primary host application id we subscribe to for STATE. When the primary
   * host goes OFFLINE the bridge should stop publishing DATA per the spec.
   */
  primaryHostId: z.string().optional(),
  /** Keepalive in seconds for the MQTT connection. */
  keepaliveSec: z.coerce.number().int().positive().default(30),
  /** Reconnect period in milliseconds. */
  reconnectPeriodMs: z.coerce.number().int().nonnegative().default(5000),
  /** Whether the bridge is enabled. */
  enabled: z.boolean().default(false),
});

export type SparkplugConfig = z.infer<typeof SparkplugConfigSchema>;

/**
 * Load Sparkplug config from environment variables. The bridge is disabled
 * unless SPARKPLUG_BROKER_URL is set (mirrors the Flux integration pattern).
 */
export function loadSparkplugConfig(
  env: NodeJS.ProcessEnv = process.env,
): SparkplugConfig {
  return SparkplugConfigSchema.parse({
    brokerUrl: env.SPARKPLUG_BROKER_URL || "mqtt://localhost:1883",
    username: env.SPARKPLUG_USERNAME,
    password: env.SPARKPLUG_PASSWORD,
    clientId: env.SPARKPLUG_CLIENT_ID,
    groupId: env.SPARKPLUG_GROUP_ID || undefined,
    edgeNodeId: env.SPARKPLUG_EDGE_NODE_ID || undefined,
    primaryHostId: env.SPARKPLUG_PRIMARY_HOST_ID,
    keepaliveSec: env.SPARKPLUG_KEEPALIVE_SEC,
    reconnectPeriodMs: env.SPARKPLUG_RECONNECT_MS,
    enabled: env.SPARKPLUG_BROKER_URL ? true : false,
  });
}
