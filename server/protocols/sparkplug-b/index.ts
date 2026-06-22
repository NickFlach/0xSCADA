/**
 * MQTT Sparkplug B Bridge — transport / broker client.
 *
 * Connects to a configurable MQTT broker (URL + credentials + Last-Will), and
 * drives the pure {@link EdgeNodeLifecycle} state machine:
 *   - sets the NDEATH as the MQTT Will (LWT) before connecting;
 *   - publishes NBIRTH (with full metric definitions) on connect;
 *   - publishes DBIRTH on a site's first publish, DDATA on tag updates,
 *     DDEATH when a site goes offline;
 *   - subscribes to host-application STATE and quiesces DATA when the primary
 *     host is OFFLINE;
 *   - subscribes to NCMD/DCMD and handles the Rebirth command.
 *
 * The protobuf codec (`sparkplug-payload`) and the MQTT client (`mqtt`) are
 * loaded lazily so the pure lifecycle/topic/payload logic — and its unit tests
 * — work without the external dependencies installed. When the bridge is
 * actually started without those deps present, it logs a clear error and stays
 * disabled rather than crashing the server.
 *
 * Issue #463 — [wave:2c] Build MQTT Sparkplug B Bridge.
 */

import { log, logError, logWarn } from "../../logger";
import {
  EdgeNodeLifecycle,
  NODE_CONTROL_REBIRTH,
  type DeviceDefinition,
  type OutboundMessage,
} from "./lifecycle";
import { decodePayload, encodePayload, isCodecAvailable } from "./payload";
import {
  buildCommandSubscriptionFilters,
  parseStateTopic,
  parseTopic,
  type EdgeNodeDescriptor,
} from "./topic";
import {
  loadSparkplugConfig,
  type SparkplugConfig,
  type SparkplugMetric,
} from "./types";

const LOG_SCOPE = "sparkplug";

/**
 * Minimal structural type for the subset of the `mqtt` client API we use.
 * Typed locally so the module compiles without `@types`/`mqtt` present.
 *
 * INTEGRATION (mqtt): replace with `import type { MqttClient } from "mqtt"`
 * once the dependency is installed if richer typing is desired.
 */
export interface MqttLike {
  on(event: "connect", cb: () => void): void;
  on(event: "message", cb: (topic: string, payload: Uint8Array) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "close" | "offline" | "reconnect", cb: () => void): void;
  subscribe(topic: string | string[], opts: { qos: 0 | 1 | 2 }, cb?: (err: Error | null) => void): void;
  publish(
    topic: string,
    payload: Uint8Array,
    opts: { qos: 0 | 1 | 2; retain: boolean },
    cb?: (err?: Error) => void,
  ): void;
  end(force?: boolean, opts?: object, cb?: () => void): void;
}

/** Connect options passed to the mqtt client. */
export interface MqttConnectOptions {
  clientId: string;
  username?: string;
  password?: string;
  keepalive: number;
  reconnectPeriod: number;
  clean: boolean;
  will: {
    topic: string;
    payload: Uint8Array;
    qos: 0 | 1 | 2;
    retain: boolean;
  };
}

/**
 * Factory that creates an MQTT connection. Injectable for tests. Defaults to a
 * lazy `require("mqtt").connect(...)`.
 */
export type MqttConnectFn = (url: string, opts: MqttConnectOptions) => MqttLike;

const defaultConnect: MqttConnectFn = (url, opts) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mqtt = require("mqtt") as { connect: (u: string, o: MqttConnectOptions) => MqttLike };
  return mqtt.connect(url, opts);
};

/** Callback invoked when a node/device command is received from the broker. */
export type CommandHandler = (cmd: {
  messageType: "NCMD" | "DCMD";
  deviceId?: string;
  metrics: SparkplugMetric[];
}) => void;

/**
 * The MQTT Sparkplug B bridge. One instance manages one edge node and its
 * devices against one broker.
 */
export class SparkplugBridge {
  private readonly config: SparkplugConfig;
  private readonly node: EdgeNodeDescriptor;
  private readonly lifecycle: EdgeNodeLifecycle;
  private readonly connectFn: MqttConnectFn;
  private client: MqttLike | null = null;
  private commandHandler: CommandHandler | null = null;
  private started = false;

  constructor(
    config: SparkplugConfig = loadSparkplugConfig(),
    nodeMetrics: SparkplugMetric[] = [],
    connectFn: MqttConnectFn = defaultConnect,
  ) {
    this.config = config;
    this.node = { groupId: config.groupId, edgeNodeId: config.edgeNodeId };
    this.lifecycle = new EdgeNodeLifecycle(this.node, nodeMetrics);
    this.connectFn = connectFn;
  }

  /** Register a handler for inbound NCMD/DCMD commands. */
  onCommand(handler: CommandHandler): void {
    this.commandHandler = handler;
  }

  /** Replace the node metric definitions advertised at the next NBIRTH. */
  setNodeMetrics(metrics: SparkplugMetric[]): void {
    this.lifecycle.setNodeMetrics(metrics);
  }

  /**
   * Connect to the broker and begin the lifecycle. The NDEATH Will is set with
   * the bdSeq for this session before connecting; NBIRTH is published in the
   * `connect` handler.
   */
  start(): void {
    if (this.started) return;
    if (!this.config.enabled) {
      log("Sparkplug B bridge disabled (set SPARKPLUG_BROKER_URL to enable)", LOG_SCOPE);
      return;
    }
    if (!isCodecAvailable()) {
      logWarn(
        "Sparkplug B bridge cannot start: protobuf codec `sparkplug-payload` is not installed. " +
          "Add the dependency and run `npm install`.",
        LOG_SCOPE,
      );
      return;
    }

    // §6.4 — bump bdSeq + reset seq, then encode the Will/NDEATH with that bdSeq.
    const bdSeq = this.lifecycle.beginSession();
    const willPayload = this.lifecycle.buildWillPayload(bdSeq);
    const willTopic = this.lifecycle.buildWillTopic();

    const opts: MqttConnectOptions = {
      clientId: this.config.clientId ?? `${this.config.groupId}-${this.config.edgeNodeId}`,
      username: this.config.username,
      password: this.config.password,
      keepalive: this.config.keepaliveSec,
      reconnectPeriod: this.config.reconnectPeriodMs,
      clean: true,
      will: {
        topic: willTopic,
        payload: encodePayload(willPayload),
        qos: 1,
        retain: false,
      },
    };

    try {
      this.client = this.connectFn(this.config.brokerUrl, opts);
    } catch (err) {
      logError(err, "Sparkplug B: failed to create MQTT connection");
      return;
    }
    this.started = true;
    this.attachHandlers(this.client);
    log(
      `Sparkplug B bridge connecting → ${this.config.brokerUrl} ` +
        `(group=${this.config.groupId}, edge=${this.config.edgeNodeId}, bdSeq=${bdSeq})`,
      LOG_SCOPE,
    );
  }

  private attachHandlers(client: MqttLike): void {
    client.on("connect", () => {
      log(`Sparkplug B connected; publishing NBIRTH for ${this.config.edgeNodeId}`, LOG_SCOPE);
      // §7.2 — NBIRTH first, then subscribe for commands & host STATE.
      this.publishMessage(this.lifecycle.onConnect());
      const filters = buildCommandSubscriptionFilters(this.node);
      client.subscribe(filters, { qos: 1 }, (err) => {
        if (err) logError(err, "Sparkplug B: subscribe failed");
      });
      // Re-birth any devices that were online before a reconnect.
      for (const deviceId of this.lifecycle.listDevices()) {
        if (this.lifecycle.getDeviceState(deviceId) === "online") {
          // Device metrics are owned by the caller; re-birth requires the caller
          // to re-supply via birthDevice. We only log here so state is honest.
          logWarn(
            `Sparkplug B: device "${deviceId}" was online before reconnect; ` +
              "caller should re-birth it (call birthSite again).",
            LOG_SCOPE,
          );
        }
      }
    });

    client.on("message", (topic, payload) => this.handleMessage(topic, payload));

    client.on("error", (err) => logError(err, "Sparkplug B: MQTT error"));
    client.on("offline", () => {
      logWarn("Sparkplug B: MQTT offline", LOG_SCOPE);
      this.lifecycle.onDisconnect();
    });
    client.on("close", () => {
      this.lifecycle.onDisconnect();
    });
    client.on("reconnect", () => log("Sparkplug B: reconnecting", LOG_SCOPE));
  }

  private handleMessage(topic: string, raw: Uint8Array): void {
    // Host application STATE (spBv1.0/STATE/<hostId>) — small JSON body.
    const state = parseStateTopic(topic);
    if (state) {
      if (this.config.primaryHostId && state.hostApplicationId !== this.config.primaryHostId) {
        return; // Not our primary host.
      }
      const online = this.parseStatePayload(raw);
      const { dataAllowedChanged } = this.lifecycle.onHostState(online);
      log(
        `Sparkplug B: host ${state.hostApplicationId} STATE=${online ? "ONLINE" : "OFFLINE"}` +
          (dataAllowedChanged ? " (data publishing toggled)" : ""),
        LOG_SCOPE,
      );
      return;
    }

    const parsed = parseTopic(topic);
    if (!parsed) return;

    if (parsed.messageType === "NCMD" || parsed.messageType === "DCMD") {
      let decoded;
      try {
        decoded = decodePayload(raw);
      } catch (err) {
        logError(err, `Sparkplug B: failed to decode ${parsed.messageType}`);
        return;
      }
      // Built-in handling for the Rebirth command (§7.6).
      const rebirth = decoded.metrics.find(
        (m) => m.name === NODE_CONTROL_REBIRTH && m.value === true,
      );
      if (rebirth) {
        log("Sparkplug B: Rebirth requested by host", LOG_SCOPE);
        this.rebirth();
      }
      this.commandHandler?.({
        messageType: parsed.messageType,
        deviceId: parsed.deviceId,
        metrics: decoded.metrics,
      });
    }
  }

  /** Parse a STATE payload body. Sparkplug v3 uses JSON `{ online, timestamp }`. */
  private parseStatePayload(raw: Uint8Array): boolean {
    try {
      const text = Buffer.from(raw).toString("utf8").trim();
      // Legacy hosts publish the literal strings "ONLINE"/"OFFLINE".
      if (text === "ONLINE") return true;
      if (text === "OFFLINE") return false;
      const obj = JSON.parse(text) as { online?: boolean };
      return obj.online === true;
    } catch {
      return false;
    }
  }

  // --- Public publishing API (used by the gateway/storage layer) ---

  /** Announce a device on its first publish (DBIRTH). */
  birthSite(definition: DeviceDefinition): void {
    if (this.lifecycle.getNodeState() !== "online") {
      logWarn(`Sparkplug B: cannot birth "${definition.deviceId}" before NBIRTH`, LOG_SCOPE);
      return;
    }
    this.publishMessage(this.lifecycle.birthDevice(definition));
  }

  /** Publish changed device tags (DDATA). No-op if not allowed/birthed. */
  publishSiteData(deviceId: string, changed: SparkplugMetric[]): void {
    const msg = this.lifecycle.publishDeviceData(deviceId, changed);
    if (msg) this.publishMessage(msg);
  }

  /** Publish changed node-level metrics (NDATA). */
  publishNodeData(changed: SparkplugMetric[]): void {
    const msg = this.lifecycle.publishNodeData(changed);
    if (msg) this.publishMessage(msg);
  }

  /** Mark a device offline (DDEATH). */
  deathSite(deviceId: string): void {
    const msg = this.lifecycle.deathDevice(deviceId);
    if (msg) this.publishMessage(msg);
  }

  /**
   * Re-publish NBIRTH in response to a host `Node Control/Rebirth` command
   * (§7.6). This is an *in-session* rebirth: the seq sequence restarts at 0 but
   * the bdSeq is unchanged so the already-registered NDEATH Will still
   * correlates with this birth (§6.4). A new MQTT session (and thus a new
   * bdSeq) only happens on an actual reconnect, which is driven by the broker's
   * `connect` event, not by a Rebirth command.
   */
  rebirth(): void {
    if (this.lifecycle.getNodeState() !== "online") return;
    // Restart seq at 0 WITHOUT bumping bdSeq (would desync the Will/NDEATH).
    this.lifecycle.resetSeq();
    this.publishMessage(this.lifecycle.onConnect());
  }

  /** Disconnect cleanly. Publishes nothing — NDEATH is delivered by the Will. */
  stop(): void {
    this.lifecycle.onDisconnect();
    if (this.client) {
      this.client.end(false, {}, () => log("Sparkplug B bridge stopped", LOG_SCOPE));
      this.client = null;
    }
    this.started = false;
  }

  /** Status snapshot for health/metrics endpoints. */
  getStatus(): {
    enabled: boolean;
    started: boolean;
    nodeState: string;
    hostState: string;
    bdSeq: number;
    seq: number;
    devices: string[];
    canPublishData: boolean;
  } {
    return {
      enabled: this.config.enabled,
      started: this.started,
      nodeState: this.lifecycle.getNodeState(),
      hostState: this.lifecycle.getHostState(),
      bdSeq: this.lifecycle.getBdSeq(),
      seq: this.lifecycle.getSeq(),
      devices: this.lifecycle.listDevices(),
      canPublishData: this.lifecycle.canPublishData(),
    };
  }

  private publishMessage(msg: OutboundMessage): void {
    if (!this.client) {
      logWarn(`Sparkplug B: dropping ${msg.messageType} (no MQTT client)`, LOG_SCOPE);
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = encodePayload(msg.payload);
    } catch (err) {
      logError(err, `Sparkplug B: failed to encode ${msg.messageType}`);
      return;
    }
    this.client.publish(msg.topic, bytes, { qos: msg.qos, retain: msg.retain }, (err) => {
      if (err) logError(err, `Sparkplug B: publish ${msg.messageType} failed`);
    });
  }
}

// --- Singleton wiring (mirrors server/services/flux/index.ts) ---

let _bridge: SparkplugBridge | null = null;

/** Get or create the SparkplugBridge singleton. */
export function getSparkplugBridge(): SparkplugBridge {
  if (!_bridge) {
    _bridge = new SparkplugBridge(loadSparkplugConfig());
  }
  return _bridge;
}

/** Start the Sparkplug B integration (no-op if disabled). */
export function startSparkplugBridge(): SparkplugBridge {
  const bridge = getSparkplugBridge();
  bridge.start();
  return bridge;
}

/** Stop the Sparkplug B integration cleanly. */
export function stopSparkplugBridge(): void {
  _bridge?.stop();
}

export { EdgeNodeLifecycle } from "./lifecycle";
export type { DeviceDefinition, OutboundMessage } from "./lifecycle";
export {
  buildNodeTopic,
  buildDeviceTopic,
  buildStateTopic,
  parseTopic,
  parseStateTopic,
  SPARKPLUG_B_NAMESPACE,
} from "./topic";
export { encodePayload, decodePayload, isCodecAvailable, setCodec } from "./payload";
export {
  loadSparkplugConfig,
  SparkplugConfigSchema,
  SparkplugDataType,
} from "./types";
export type { SparkplugConfig, SparkplugMetric, SparkplugPayload } from "./types";
