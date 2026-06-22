/**
 * Sparkplug B Topic Namespace — pure topic construction & parsing.
 *
 * Sparkplug B topics follow the form:
 *   namespace/group_id/message_type/edge_node_id[/device_id]
 *
 * For example:
 *   spBv1.0/Plant-North/NBIRTH/edge-01
 *   spBv1.0/Plant-North/DDATA/edge-01/pump-42
 *   spBv1.0/STATE/<host_application_id>   (host application state)
 *
 * Reference: Sparkplug B Specification v3.0.0 §6 "Topics and Messages".
 *
 * This module is intentionally free of any I/O so the topic grammar can be
 * exhaustively unit-tested without an MQTT broker present.
 */

/** The only Sparkplug B namespace defined by the v3.0.0 spec. */
export const SPARKPLUG_B_NAMESPACE = "spBv1.0" as const;

/** Reserved group/segment used for host-application STATE messages. */
export const STATE_SEGMENT = "STATE" as const;

/**
 * Sparkplug B message types. Node-scoped (N*) messages omit `device_id`;
 * device-scoped (D*) messages require it.
 */
export type SparkplugMessageType =
  | "NBIRTH"
  | "NDEATH"
  | "NDATA"
  | "NCMD"
  | "DBIRTH"
  | "DDEATH"
  | "DDATA"
  | "DCMD"
  | "STATE";

/** Message types that are scoped to a device and therefore need a device_id. */
export const DEVICE_SCOPED_MESSAGE_TYPES: ReadonlySet<SparkplugMessageType> =
  new Set<SparkplugMessageType>(["DBIRTH", "DDEATH", "DDATA", "DCMD"]);

/** Message types that are scoped to an edge node (no device_id). */
export const NODE_SCOPED_MESSAGE_TYPES: ReadonlySet<SparkplugMessageType> =
  new Set<SparkplugMessageType>(["NBIRTH", "NDEATH", "NDATA", "NCMD"]);

/** Identity of a Sparkplug B edge node. */
export interface EdgeNodeDescriptor {
  /** Logical grouping of edge nodes, e.g. a plant or region. */
  groupId: string;
  /** Unique edge node identifier within the group. */
  edgeNodeId: string;
}

/** Identity of a device beneath an edge node. */
export interface DeviceDescriptor extends EdgeNodeDescriptor {
  deviceId: string;
}

/** A fully-parsed Sparkplug B topic. */
export interface ParsedTopic {
  namespace: string;
  groupId: string;
  messageType: SparkplugMessageType;
  edgeNodeId: string;
  /** Present only for device-scoped message types. */
  deviceId?: string;
}

/** A parsed host-application STATE topic (`spBv1.0/STATE/<hostId>`). */
export interface ParsedStateTopic {
  namespace: string;
  hostApplicationId: string;
}

/**
 * Characters that are illegal inside Sparkplug B topic segments. The spec
 * forbids MQTT wildcards and the topic level separator inside identifiers.
 */
const ILLEGAL_SEGMENT_CHARS = /[+#/]/;

function assertValidSegment(label: string, value: string): void {
  if (value.length === 0) {
    throw new Error(`Sparkplug topic ${label} must not be empty`);
  }
  if (ILLEGAL_SEGMENT_CHARS.test(value)) {
    throw new Error(
      `Sparkplug topic ${label} "${value}" contains an illegal character (+, # or /)`,
    );
  }
}

/**
 * Build a node-scoped topic (NBIRTH/NDEATH/NDATA/NCMD).
 * @throws if a device-scoped message type is supplied.
 */
export function buildNodeTopic(
  node: EdgeNodeDescriptor,
  messageType: SparkplugMessageType,
): string {
  if (!NODE_SCOPED_MESSAGE_TYPES.has(messageType)) {
    throw new Error(
      `${messageType} is not a node-scoped message type; use buildDeviceTopic`,
    );
  }
  assertValidSegment("group_id", node.groupId);
  assertValidSegment("edge_node_id", node.edgeNodeId);
  return `${SPARKPLUG_B_NAMESPACE}/${node.groupId}/${messageType}/${node.edgeNodeId}`;
}

/**
 * Build a device-scoped topic (DBIRTH/DDEATH/DDATA/DCMD).
 * @throws if a node-scoped message type is supplied.
 */
export function buildDeviceTopic(
  device: DeviceDescriptor,
  messageType: SparkplugMessageType,
): string {
  if (!DEVICE_SCOPED_MESSAGE_TYPES.has(messageType)) {
    throw new Error(
      `${messageType} is not a device-scoped message type; use buildNodeTopic`,
    );
  }
  assertValidSegment("group_id", device.groupId);
  assertValidSegment("edge_node_id", device.edgeNodeId);
  assertValidSegment("device_id", device.deviceId);
  return `${SPARKPLUG_B_NAMESPACE}/${device.groupId}/${messageType}/${device.edgeNodeId}/${device.deviceId}`;
}

/** Build the host-application STATE topic: `spBv1.0/STATE/<hostApplicationId>`. */
export function buildStateTopic(hostApplicationId: string): string {
  assertValidSegment("host_application_id", hostApplicationId);
  return `${SPARKPLUG_B_NAMESPACE}/${STATE_SEGMENT}/${hostApplicationId}`;
}

/**
 * Subscription filter matching every command + state message this edge node
 * cares about. We listen for node/device commands addressed to us plus the
 * primary host's STATE.
 */
export function buildCommandSubscriptionFilters(node: EdgeNodeDescriptor): string[] {
  assertValidSegment("group_id", node.groupId);
  assertValidSegment("edge_node_id", node.edgeNodeId);
  return [
    // NCMD targeted at this edge node.
    `${SPARKPLUG_B_NAMESPACE}/${node.groupId}/NCMD/${node.edgeNodeId}`,
    // DCMD targeted at any device beneath this edge node.
    `${SPARKPLUG_B_NAMESPACE}/${node.groupId}/DCMD/${node.edgeNodeId}/+`,
    // Any host application STATE message.
    `${SPARKPLUG_B_NAMESPACE}/${STATE_SEGMENT}/+`,
  ];
}

/** Returns true if `topic` is a host-application STATE topic. */
export function isStateTopic(topic: string): boolean {
  const parts = topic.split("/");
  return (
    parts.length === 3 &&
    parts[0] === SPARKPLUG_B_NAMESPACE &&
    parts[1] === STATE_SEGMENT
  );
}

/**
 * Parse a host-application STATE topic.
 * @returns the parsed descriptor, or null if the topic is not a STATE topic.
 */
export function parseStateTopic(topic: string): ParsedStateTopic | null {
  const parts = topic.split("/");
  if (parts.length !== 3 || parts[0] !== SPARKPLUG_B_NAMESPACE || parts[1] !== STATE_SEGMENT) {
    return null;
  }
  if (parts[2].length === 0) return null;
  return { namespace: parts[0], hostApplicationId: parts[2] };
}

function isKnownMessageType(value: string): value is SparkplugMessageType {
  return (
    NODE_SCOPED_MESSAGE_TYPES.has(value as SparkplugMessageType) ||
    DEVICE_SCOPED_MESSAGE_TYPES.has(value as SparkplugMessageType) ||
    value === STATE_SEGMENT
  );
}

/**
 * Parse a Sparkplug B node/device topic into its components.
 *
 * @returns the parsed topic, or null if the string is not a well-formed
 *   Sparkplug B data/command topic (callers should treat null as "ignore").
 */
export function parseTopic(topic: string): ParsedTopic | null {
  const parts = topic.split("/");
  if (parts.length < 4 || parts.length > 5) return null;

  const [namespace, groupId, rawType, edgeNodeId, deviceId] = parts;
  if (namespace !== SPARKPLUG_B_NAMESPACE) return null;
  if (!isKnownMessageType(rawType)) return null;
  if (rawType === STATE_SEGMENT) return null; // STATE has its own parser.

  const messageType = rawType as SparkplugMessageType;
  const deviceScoped = DEVICE_SCOPED_MESSAGE_TYPES.has(messageType);

  if (deviceScoped) {
    if (parts.length !== 5 || !deviceId) return null;
    return { namespace, groupId, messageType, edgeNodeId, deviceId };
  }

  // Node-scoped: must have exactly 4 segments and no device id.
  if (parts.length !== 4) return null;
  return { namespace, groupId, messageType, edgeNodeId };
}
