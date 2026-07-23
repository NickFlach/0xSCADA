/**
 * Sparkplug B Edge-Node Lifecycle State Machine.
 *
 * This is the heart of the bridge and is intentionally PURE: it produces the
 * ordered list of messages (topic + payload) that must be published for each
 * lifecycle transition, but performs no I/O. The broker client (index.ts)
 * drives this machine and is responsible for the actual MQTT publish/subscribe.
 *
 * Implemented per Sparkplug B Specification v3.0.0:
 *  - §6.1   sequence number `seq` is 0 on every *BIRTH and increments (mod 256)
 *           on every subsequent message from the edge node.
 *  - §6.4   bdSeq counter increments per connect session; the NDEATH set as the
 *           MQTT Will carries the *same* bdSeq as the NBIRTH for that session.
 *  - §7     NBIRTH carries every metric definition; NDATA carries deltas.
 *  - §8     DBIRTH announces a device's metrics; DDATA carries deltas; DDEATH on
 *           device offline.
 *  - §10    Host application STATE: when the primary host is OFFLINE the edge
 *           node must stop publishing DATA (it stays BIRTHed but quiesces).
 *
 * Issue #463 — [wave:2c] Build MQTT Sparkplug B Bridge.
 */

import {
  buildDeviceTopic,
  buildNodeTopic,
  type EdgeNodeDescriptor,
} from "./topic";
import {
  SparkplugDataType,
  type SparkplugMetric,
  type SparkplugPayload,
} from "./types";

/** Edge-node lifecycle states. */
export type NodeState = "offline" | "connecting" | "online";

/** Per-device lifecycle states. */
export type DeviceState = "offline" | "online";

/** Primary-host STATE as observed from the broker. */
export type HostState = "unknown" | "online" | "offline";

/** A message the state machine wants the transport to publish. */
export interface OutboundMessage {
  topic: string;
  payload: SparkplugPayload;
  /** MQTT QoS — Sparkplug mandates QoS 0 for DATA, QoS 1 for BIRTH/DEATH. */
  qos: 0 | 1;
  /** Whether the broker should retain the message (STATE only, never NBIRTH). */
  retain: boolean;
  /** The message type, for transport-side topic/QoS sanity & logging. */
  messageType: "NBIRTH" | "NDEATH" | "NDATA" | "DBIRTH" | "DDEATH" | "DDATA";
  /**
   * Monotonic token for a pending device lifecycle transition. The transport
   * must echo this token when it confirms or rejects DBIRTH/DDEATH so an older
   * MQTT callback cannot settle a newer transition for the same device.
   */
  transitionId?: number;
}

/** Definition of a device managed by this edge node. */
export interface DeviceDefinition {
  deviceId: string;
  /** Full metric set published at DBIRTH. */
  metrics: SparkplugMetric[];
}

const SEQ_MODULO = 256;

/** Well-known Sparkplug node-control metric names (rebirth, etc.). */
export const NODE_CONTROL_REBIRTH = "Node Control/Rebirth";

interface DeviceRecord {
  definition: DeviceDefinition;
  state: DeviceState;
  pending?: {
    kind: "birth" | "death";
    id: number;
  };
}

/**
 * Pure lifecycle state machine for a single edge node and its devices.
 *
 * Construct once per bridge. The transport calls the lifecycle methods on the
 * relevant events (connected, tag change, device offline, host STATE received)
 * and publishes the returned {@link OutboundMessage}s in order.
 */
export class EdgeNodeLifecycle {
  private readonly node: EdgeNodeDescriptor;
  private nodeMetrics: SparkplugMetric[];

  private nodeState: NodeState = "offline";
  private hostState: HostState = "unknown";

  /** Birth/death sequence — increments per connect session (§6.4). */
  private bdSeq = 0;
  /** Sequence number for the *current* birth session (§6.1). */
  private seq = 0;

  private readonly devices = new Map<string, DeviceRecord>();
  private nextTransitionId = 1;

  constructor(node: EdgeNodeDescriptor, nodeMetrics: SparkplugMetric[] = []) {
    this.node = node;
    this.nodeMetrics = nodeMetrics;
  }

  // --- Introspection ---

  getNodeState(): NodeState {
    return this.nodeState;
  }

  getHostState(): HostState {
    return this.hostState;
  }

  getBdSeq(): number {
    return this.bdSeq;
  }

  /** Current seq counter value (next message's seq). */
  getSeq(): number {
    return this.seq;
  }

  getDeviceState(deviceId: string): DeviceState | undefined {
    return this.devices.get(deviceId)?.state;
  }

  listDevices(): string[] {
    return Array.from(this.devices.keys());
  }

  /**
   * Whether the edge node is permitted to publish DATA right now. Per §10 the
   * node must quiesce DATA when the *known* primary host is OFFLINE. If we have
   * no host configured / host state unknown, DATA is allowed.
   */
  canPublishData(): boolean {
    return this.nodeState === "online" && this.hostState !== "offline";
  }

  /** Register (or replace) a device definition. Does not change its state. */
  registerDevice(definition: DeviceDefinition): void {
    const existing = this.devices.get(definition.deviceId);
    this.devices.set(definition.deviceId, {
      definition,
      state: existing?.state ?? "offline",
      pending: existing?.pending,
    });
  }

  /** Replace the node's full metric set (used before (re)birth). */
  setNodeMetrics(metrics: SparkplugMetric[]): void {
    this.nodeMetrics = metrics;
  }

  /**
   * Reset the rolling `seq` counter to 0 *without* starting a new MQTT session.
   *
   * This is the correct primitive for an in-session re-birth triggered by a
   * host `Node Control/Rebirth` command (§7.6): the edge node re-publishes
   * NBIRTH at `seq = 0` but keeps the **same** `bdSeq` so the previously
   * registered NDEATH Will still correlates with this birth (§6.4). It must NOT
   * call {@link beginSession}, which bumps `bdSeq` and would desynchronise the
   * already-registered Will.
   */
  resetSeq(): void {
    this.seq = 0;
  }

  // --- Sequence helpers ---

  /** Consume and return the next seq value, advancing the rolling counter. */
  private nextSeq(): number {
    const current = this.seq;
    this.seq = (this.seq + 1) % SEQ_MODULO;
    return current;
  }

  /**
   * Build the NDEATH payload for the MQTT Will. The Will is registered at
   * connect time and MUST carry the bdSeq of the session it terminates (§6.4).
   * Exposed so the transport can set it as the LWT before connecting.
   */
  buildWillPayload(bdSeq: number = this.bdSeq): SparkplugPayload {
    return {
      timestamp: this.now(),
      metrics: [bdSeqMetric(bdSeq)],
    };
  }

  buildWillTopic(): string {
    return buildNodeTopic(this.node, "NDEATH");
  }

  // --- Transitions ---

  /**
   * Begin a connect session. Increments bdSeq (the value the caller must also
   * embed in the Will/NDEATH) and resets the seq counter to 0. Call this just
   * before connecting to the broker so {@link buildWillPayload} reflects the
   * new bdSeq.
   *
   * @returns the bdSeq for this session.
   */
  beginSession(): number {
    this.bdSeq = (this.bdSeq + 1) % 256;
    this.seq = 0;
    this.nodeState = "connecting";
    return this.bdSeq;
  }

  /**
   * Produce the NBIRTH message on successful (re)connect. NBIRTH always uses
   * seq 0 and carries every node metric plus the bdSeq + standard control
   * metrics. Devices known to the machine are *not* auto-birthed here; the
   * transport should call {@link birthDevice} for each online device after
   * NBIRTH (spec §7.2: DBIRTH must follow NBIRTH).
   *
   * Building the message is deliberately only the first half of the
   * transition. The node remains `connecting` until the transport confirms
   * that MQTT accepted the NBIRTH via {@link confirmNodeBirth}. This prevents
   * DATA from escaping while a QoS-1 BIRTH is still pending or after its
   * publish callback fails.
   */
  onConnect(): OutboundMessage {
    if (this.seq !== 0) {
      // Defensive: a BIRTH must be seq 0. beginSession() resets it.
      this.seq = 0;
    }
    this.nodeState = "connecting";
    // Every NBIRTH invalidates the previous device BIRTH set. Devices must
    // DBIRTH again before DDATA is permitted in the new birth sequence.
    for (const record of this.devices.values()) {
      record.state = "offline";
      record.pending = undefined;
    }

    const metrics: SparkplugMetric[] = [
      bdSeqMetric(this.bdSeq),
      rebirthControlMetric(),
      ...this.nodeMetrics,
    ];

    const payload: SparkplugPayload = {
      timestamp: this.now(),
      seq: this.nextSeq(), // consumes seq 0
      metrics,
    };

    return {
      topic: buildNodeTopic(this.node, "NBIRTH"),
      payload,
      qos: 1,
      retain: false,
      messageType: "NBIRTH",
    };
  }

  /** Commit a pending NBIRTH after its MQTT publish callback succeeds. */
  confirmNodeBirth(): boolean {
    if (this.nodeState !== "connecting") return false;
    this.nodeState = "online";
    return true;
  }

  /** Roll back a pending/failed NBIRTH and block all DATA publishing. */
  failNodeBirth(): void {
    this.onDisconnect();
  }

  /**
   * Produce an NDATA message carrying changed node metrics. Returns null if the
   * node is not permitted to publish (offline or host offline) or no metrics
   * supplied.
   */
  publishNodeData(changed: SparkplugMetric[]): OutboundMessage | null {
    if (!this.canPublishData() || changed.length === 0) return null;
    const payload: SparkplugPayload = {
      timestamp: this.now(),
      seq: this.nextSeq(),
      metrics: changed,
    };
    return {
      topic: buildNodeTopic(this.node, "NDATA"),
      payload,
      qos: 0,
      retain: false,
      messageType: "NDATA",
    };
  }

  /**
   * Produce a DBIRTH for a device on its first publish. Registers the device if
   * not already known. DBIRTH shares the node's seq sequence (§6.1) and carries
   * the device's full metric set.
   *
   * As with NBIRTH, building the message does not commit the device online.
   * The transport must call {@link confirmDeviceBirth} after MQTT accepts the
   * QoS-1 DBIRTH. Until then DDATA remains blocked.
   */
  birthDevice(definition: DeviceDefinition): OutboundMessage {
    if (this.nodeState !== "online") {
      throw new Error(
        `Cannot DBIRTH device "${definition.deviceId}" before edge node NBIRTH`,
      );
    }
    this.registerDevice(definition);
    const record = this.devices.get(definition.deviceId)!;
    record.state = "offline";
    const transitionId = this.nextTransitionId++;
    record.pending = { kind: "birth", id: transitionId };

    const payload: SparkplugPayload = {
      timestamp: this.now(),
      seq: this.nextSeq(),
      metrics: definition.metrics,
    };

    return {
      topic: buildDeviceTopic({ ...this.node, deviceId: definition.deviceId }, "DBIRTH"),
      payload,
      qos: 1,
      retain: false,
      messageType: "DBIRTH",
      transitionId,
    };
  }

  /** Commit a pending DBIRTH after its MQTT publish callback succeeds. */
  confirmDeviceBirth(deviceId: string, transitionId?: number): boolean {
    const record = this.devices.get(deviceId);
    if (
      !record ||
      this.nodeState !== "online" ||
      record.pending?.kind !== "birth" ||
      (transitionId !== undefined && record.pending.id !== transitionId)
    ) {
      return false;
    }
    record.state = "online";
    record.pending = undefined;
    return true;
  }

  /**
   * Roll back the optimistic DBIRTH state when the transport cannot encode or
   * queue the birth message. DATA must remain blocked until a later successful
   * birth attempt.
   */
  failDeviceBirth(deviceId: string, transitionId?: number): void {
    const record = this.devices.get(deviceId);
    if (!record) return;
    if (transitionId === undefined) {
      // DDATA has no transition token. Never let an older DATA callback erase a
      // newer DBIRTH/DDEATH transition that is already pending.
      if (record.pending) return;
    } else if (
      record.pending?.kind !== "birth" ||
      record.pending.id !== transitionId
    ) {
      return;
    }
    record.state = "offline";
    record.pending = undefined;
  }

  /**
   * Produce a DDATA message for a device's changed tags. If the device has not
   * been birthed yet this returns null (the transport should DBIRTH first).
   * Returns null if DATA publishing is currently disallowed.
   */
  publishDeviceData(
    deviceId: string,
    changed: SparkplugMetric[],
  ): OutboundMessage | null {
    const record = this.devices.get(deviceId);
    if (!record || record.state !== "online") return null;
    if (record.pending) return null;
    if (!this.canPublishData() || changed.length === 0) return null;

    const payload: SparkplugPayload = {
      timestamp: this.now(),
      seq: this.nextSeq(),
      metrics: changed,
    };

    return {
      topic: buildDeviceTopic({ ...this.node, deviceId }, "DDATA"),
      payload,
      qos: 0,
      retain: false,
      messageType: "DDATA",
    };
  }

  /**
   * Produce a DDEATH when a site/device goes offline. The device remains
   * logically online but DATA is blocked until the transport settles the
   * QoS-1 publish. This makes a failed DDEATH retryable instead of leaving the
   * broker and local lifecycle permanently divergent.
   */
  deathDevice(deviceId: string): OutboundMessage | null {
    const record = this.devices.get(deviceId);
    if (!record || record.state !== "online" || record.pending) return null;
    const transitionId = this.nextTransitionId++;
    record.pending = { kind: "death", id: transitionId };

    const payload: SparkplugPayload = {
      timestamp: this.now(),
      seq: this.nextSeq(),
      metrics: [],
    };

    return {
      topic: buildDeviceTopic({ ...this.node, deviceId }, "DDEATH"),
      qos: 1,
      retain: false,
      payload,
      messageType: "DDEATH",
      transitionId,
    };
  }

  /** Commit a pending DDEATH after its MQTT publish callback succeeds. */
  confirmDeviceDeath(deviceId: string, transitionId?: number): boolean {
    const record = this.devices.get(deviceId);
    if (
      !record ||
      record.pending?.kind !== "death" ||
      (transitionId !== undefined && record.pending.id !== transitionId)
    ) {
      return false;
    }
    record.state = "offline";
    record.pending = undefined;
    return true;
  }

  /** Clear a failed DDEATH so the caller can retry it. */
  failDeviceDeath(deviceId: string, transitionId?: number): void {
    const record = this.devices.get(deviceId);
    if (
      !record ||
      record.pending?.kind !== "death" ||
      (transitionId !== undefined && record.pending.id !== transitionId)
    ) {
      return;
    }
    record.pending = undefined;
  }

  /**
   * Mark the node disconnected (e.g. clean shutdown or detected broker loss).
   * The actual NDEATH is delivered by the broker via the Will, so this only
   * updates internal state and marks all devices offline.
   */
  onDisconnect(): void {
    this.nodeState = "offline";
    for (const record of this.devices.values()) {
      record.state = "offline";
      record.pending = undefined;
    }
  }

  /**
   * Apply a received host-application STATE. Per spec the STATE payload is a
   * small JSON object `{ "online": boolean, "timestamp": number }`. Returns
   * whether DATA publishing transitioned (so the transport can log/rebirth).
   */
  onHostState(online: boolean): { dataAllowedChanged: boolean } {
    const before = this.canPublishData();
    this.hostState = online ? "online" : "offline";
    const after = this.canPublishData();
    return { dataAllowedChanged: before !== after };
  }

  /** Override-able clock for deterministic tests. */
  protected now(): number {
    return Date.now();
  }
}

// --- Standard control / housekeeping metrics ---

/** The bdSeq metric carried by NBIRTH and NDEATH (§6.4). */
export function bdSeqMetric(bdSeq: number): SparkplugMetric {
  return {
    name: "bdSeq",
    dataType: SparkplugDataType.Int64,
    value: bdSeq,
  };
}

/** The Node Control/Rebirth command metric advertised at NBIRTH (§7.6). */
export function rebirthControlMetric(): SparkplugMetric {
  return {
    name: NODE_CONTROL_REBIRTH,
    dataType: SparkplugDataType.Boolean,
    value: false,
  };
}
