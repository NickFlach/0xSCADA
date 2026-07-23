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
  /** Monotonic identity for each MQTT client/session attempt. */
  private sessionEpoch = 0;
  /** Monotonic identity for each NBIRTH sequence, including in-session rebirths. */
  private birthEpoch = 0;
  private connectedSessionEpoch: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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

    this.started = true;
    if (!this.openSession()) {
      this.started = false;
    }
  }

  /**
   * Create one MQTT client/session with a freshly incremented bdSeq and matching
   * NDEATH Will. MQTT.js auto-reconnect is deliberately disabled: a reconnect
   * must install a new Will, which requires constructing a new client.
   */
  private openSession(): boolean {
    const sessionEpoch = ++this.sessionEpoch;
    let bdSeq: number;
    let opts: MqttConnectOptions;
    try {
      // §6.4 — bump bdSeq + reset seq, then encode the Will/NDEATH with that
      // bdSeq. Encoding is part of startup preparation and must remain inside
      // this guard: malformed codec output must never take down the HTTP server.
      bdSeq = this.lifecycle.beginSession();
      const willPayload = this.lifecycle.buildWillPayload(bdSeq);
      const willTopic = this.lifecycle.buildWillTopic();
      const willBytes = encodePayload(willPayload);

      opts = {
        clientId: this.config.clientId ?? `${this.config.groupId}-${this.config.edgeNodeId}`,
        username: this.config.username,
        password: this.config.password,
        keepalive: this.config.keepaliveSec,
        reconnectPeriod: 0,
        clean: true,
        will: {
          topic: willTopic,
          payload: willBytes,
          qos: 1,
          retain: false,
        },
      };
    } catch (err) {
      this.lifecycle.onDisconnect();
      logError(err, "Sparkplug B: failed to prepare NDEATH Will");
      return false;
    }

    let client: MqttLike;
    try {
      client = this.connectFn(this.config.brokerUrl, opts);
    } catch (err) {
      this.lifecycle.onDisconnect();
      logError(err, "Sparkplug B: failed to create MQTT connection");
      return false;
    }

    if (!this.started || sessionEpoch !== this.sessionEpoch) {
      client.end(true);
      return false;
    }

    this.client = client;
    this.attachHandlers(client, sessionEpoch);
    log(
      `Sparkplug B bridge connecting → ${this.config.brokerUrl} ` +
        `(group=${this.config.groupId}, edge=${this.config.edgeNodeId}, bdSeq=${bdSeq})`,
      LOG_SCOPE,
    );
    return true;
  }

  private attachHandlers(client: MqttLike, sessionEpoch: number): void {
    client.on("connect", () => {
      if (
        !this.isCurrentSession(client, sessionEpoch) ||
        this.connectedSessionEpoch === sessionEpoch
      ) {
        return;
      }
      this.connectedSessionEpoch = sessionEpoch;
      const birthEpoch = ++this.birthEpoch;
      log(`Sparkplug B connected; publishing NBIRTH for ${this.config.edgeNodeId}`, LOG_SCOPE);
      // §7.2 — NBIRTH must be acknowledged before the node becomes online or
      // its command/STATE subscriptions are acknowledged. Until both complete,
      // the lifecycle stays `connecting`, so DATA and DBIRTH remain fail-closed.
      const birth = this.lifecycle.onConnect();
      this.publishMessage(birth, () =>
        this.subscribeAfterNodeBirth(client, sessionEpoch, birthEpoch),
      );
    });

    client.on("message", (topic, payload) => {
      if (!this.isCurrentSession(client, sessionEpoch)) return;
      this.handleMessage(topic, payload);
    });

    client.on("error", (err) => {
      if (!this.isCurrentSession(client, sessionEpoch)) return;
      logError(err, "Sparkplug B: MQTT error");
    });
    client.on("offline", () => {
      this.handleSessionLoss(client, sessionEpoch, "offline");
    });
    client.on("close", () => {
      this.handleSessionLoss(client, sessionEpoch, "close");
    });
    client.on("reconnect", () => {
      // Defensive for injected/custom clients. reconnectPeriod=0 means the real
      // MQTT client never reuses a session with a stale Will.
      this.handleSessionLoss(client, sessionEpoch, "reconnect");
    });
  }

  private isCurrentSession(client: MqttLike, sessionEpoch: number): boolean {
    return (
      this.started &&
      this.client === client &&
      this.sessionEpoch === sessionEpoch
    );
  }

  private isCurrentBirth(
    client: MqttLike,
    sessionEpoch: number,
    birthEpoch: number,
  ): boolean {
    return (
      this.isCurrentSession(client, sessionEpoch) &&
      this.birthEpoch === birthEpoch
    );
  }

  private handleSessionLoss(
    client: MqttLike,
    sessionEpoch: number,
    event: "offline" | "close" | "reconnect",
  ): void {
    if (!this.isCurrentSession(client, sessionEpoch)) return;
    if (event === "offline") {
      logWarn("Sparkplug B: MQTT offline", LOG_SCOPE);
    } else if (event === "reconnect") {
      logWarn("Sparkplug B: rejecting MQTT auto-reconnect with a stale Will", LOG_SCOPE);
    }

    this.client = null;
    ++this.sessionEpoch;
    ++this.birthEpoch;
    this.lifecycle.onDisconnect();
    if (event !== "close") {
      try {
        client.end(true);
      } catch (err) {
        logError(err, "Sparkplug B: failed to dispose stale MQTT client");
      }
    }
    this.scheduleReconnect(this.sessionEpoch);
  }

  private scheduleReconnect(expectedEpoch: number): void {
    if (!this.started || this.reconnectTimer) return;
    const timer = setTimeout(() => {
      if (this.reconnectTimer !== timer) return;
      this.reconnectTimer = null;
      if (
        !this.started ||
        this.client !== null ||
        this.sessionEpoch !== expectedEpoch
      ) {
        return;
      }
      if (!this.openSession()) {
        this.scheduleReconnect(this.sessionEpoch);
      }
    }, this.config.reconnectPeriodMs);
    this.reconnectTimer = timer;
    timer.unref?.();
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
      if (this.commandHandler) {
        try {
          this.commandHandler({
            messageType: parsed.messageType,
            deviceId: parsed.deviceId,
            metrics: decoded.metrics,
          });
        } catch (err) {
          // An application callback must not escape the MQTT event emitter and
          // crash the server. The bridge remains connected; the failed command
          // is logged and no transport state is fabricated.
          logError(err, `Sparkplug B: ${parsed.messageType} handler failed`);
        }
      }
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
    const birth = this.lifecycle.birthDevice(definition);
    this.publishMessage(birth);
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
   * bdSeq) only happens when the bridge creates a fresh MQTT client/session,
   * not when a Rebirth command is handled inside the current connection.
   */
  rebirth(): void {
    if (this.lifecycle.getNodeState() !== "online") return;
    // Restart seq at 0 WITHOUT bumping bdSeq (would desync the Will/NDEATH).
    this.lifecycle.resetSeq();
    ++this.birthEpoch;
    this.publishMessage(this.lifecycle.onConnect(), () => {
      this.lifecycle.confirmNodeBirth();
    });
  }

  /** Disconnect cleanly. Publishes nothing — NDEATH is delivered by the Will. */
  stop(): void {
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const client = this.client;
    this.client = null;
    const stoppedEpoch = ++this.sessionEpoch;
    ++this.birthEpoch;
    this.lifecycle.onDisconnect();
    if (client) {
      client.end(false, {}, () => {
        if (!this.started && this.sessionEpoch === stoppedEpoch) {
          log("Sparkplug B bridge stopped", LOG_SCOPE);
        }
      });
    }
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
    deviceStates: Record<string, string>;
    canPublishData: boolean;
  } {
    const devices = this.lifecycle.listDevices();
    return {
      enabled: this.config.enabled,
      started: this.started,
      nodeState: this.lifecycle.getNodeState(),
      hostState: this.lifecycle.getHostState(),
      bdSeq: this.lifecycle.getBdSeq(),
      seq: this.lifecycle.getSeq(),
      devices,
      deviceStates: Object.fromEntries(
        devices.map((deviceId) => [
          deviceId,
          this.lifecycle.getDeviceState(deviceId) ?? "offline",
        ]),
      ),
      canPublishData: this.lifecycle.canPublishData(),
    };
  }

  /**
   * Publish one lifecycle message transactionally.
   *
   * BIRTH transitions are committed only from the MQTT callback. Encoding,
   * synchronous queueing, and asynchronous callback failures all roll back the
   * optimistic lifecycle state. The optional success callback is used to defer
   * command/STATE subscription until NBIRTH is acknowledged.
   */
  private publishMessage(msg: OutboundMessage, onSuccess?: () => void): boolean {
    const client = this.client;
    const sessionEpoch = this.sessionEpoch;
    const birthEpoch = this.birthEpoch;
    if (!client) {
      logWarn(`Sparkplug B: dropping ${msg.messageType} (no MQTT client)`, LOG_SCOPE);
      this.handlePublishFailure(msg);
      return false;
    }
    let bytes: Uint8Array;
    try {
      bytes = encodePayload(msg.payload);
    } catch (err) {
      logError(err, `Sparkplug B: failed to encode ${msg.messageType}`);
      this.handlePublishFailure(msg);
      return false;
    }

    let callbackResult: boolean | undefined;
    let settled = false;
    try {
      client.publish(msg.topic, bytes, { qos: msg.qos, retain: msg.retain }, (err) => {
        if (settled) return;
        settled = true;
        if (!this.isCurrentBirth(client, sessionEpoch, birthEpoch)) return;
        if (err) {
          callbackResult = false;
          logError(err, `Sparkplug B: publish ${msg.messageType} failed`);
          this.handlePublishFailure(msg);
          return;
        }
        callbackResult = this.handlePublishSuccess(msg);
        if (!callbackResult) return;
        try {
          onSuccess?.();
        } catch (callbackErr) {
          // Defensive containment for injected/custom transport callbacks.
          logError(callbackErr, `Sparkplug B: post-publish ${msg.messageType} callback failed`);
          this.handlePublishFailure(msg);
        }
      });
      return callbackResult ?? true;
    } catch (err) {
      logError(err, `Sparkplug B: publish ${msg.messageType} threw`);
      // The first settlement wins for callback APIs that invoke synchronously.
      // A non-conforming transport that calls back and then throws must not
      // commit and roll back the same lifecycle operation.
      if (!settled) {
        settled = true;
        if (this.isCurrentBirth(client, sessionEpoch, birthEpoch)) {
          this.handlePublishFailure(msg);
        }
      }
      return false;
    }
  }

  /** Commit lifecycle state after an acknowledged publish. */
  private handlePublishSuccess(msg: OutboundMessage): boolean {
    if (msg.messageType === "NBIRTH") {
      // The node remains connecting until subscribeAfterNodeBirth also
      // acknowledges command/STATE subscriptions.
      return true;
    }
    if (msg.messageType === "DBIRTH") {
      const deviceId = parseTopic(msg.topic)?.deviceId;
      return deviceId
        ? this.lifecycle.confirmDeviceBirth(deviceId, msg.transitionId)
        : false;
    }
    if (msg.messageType === "DDEATH") {
      const deviceId = parseTopic(msg.topic)?.deviceId;
      return deviceId
        ? this.lifecycle.confirmDeviceDeath(deviceId, msg.transitionId)
        : false;
    }
    return true;
  }

  /** Fail closed for a message that could not be encoded/queued/acknowledged. */
  private handlePublishFailure(msg: OutboundMessage): void {
    if (msg.messageType === "NBIRTH" || msg.messageType === "NDATA") {
      this.lifecycle.failNodeBirth();
      return;
    }
    if (msg.messageType === "DBIRTH" || msg.messageType === "DDATA") {
      const deviceId = parseTopic(msg.topic)?.deviceId;
      if (deviceId) this.lifecycle.failDeviceBirth(deviceId, msg.transitionId);
      return;
    }
    if (msg.messageType === "DDEATH") {
      const deviceId = parseTopic(msg.topic)?.deviceId;
      if (deviceId) this.lifecycle.failDeviceDeath(deviceId, msg.transitionId);
    }
  }

  /** Complete NBIRTH only after command/STATE subscriptions are acknowledged. */
  private subscribeAfterNodeBirth(
    client: MqttLike,
    sessionEpoch: number,
    birthEpoch: number,
  ): void {
    if (!this.isCurrentBirth(client, sessionEpoch, birthEpoch)) return;
    const filters = buildCommandSubscriptionFilters(this.node);
    let settled = false;
    try {
      client.subscribe(filters, { qos: 1 }, (err) => {
        if (settled) return;
        settled = true;
        if (!this.isCurrentBirth(client, sessionEpoch, birthEpoch)) return;
        if (err) {
          logError(err, "Sparkplug B: subscribe failed");
          this.lifecycle.failNodeBirth();
          return;
        }
        this.lifecycle.confirmNodeBirth();
      });
    } catch (err) {
      if (settled || !this.isCurrentBirth(client, sessionEpoch, birthEpoch)) return;
      settled = true;
      logError(err, "Sparkplug B: subscribe threw");
      this.lifecycle.failNodeBirth();
    }
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
