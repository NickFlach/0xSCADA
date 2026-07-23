/**
 * Tests for the SparkplugBridge transport wiring using an injected fake MQTT
 * client + fake protobuf codec. Verifies LWT setup, NBIRTH on connect, STATE
 * subscription/gating and the Rebirth command — without a real broker or the
 * `mqtt`/`sparkplug-payload` packages installed.
 * Issue #463.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SparkplugBridge, type MqttLike, type MqttConnectOptions } from "../index";
import { setCodec, type ProtoPayload } from "../payload";
import { SparkplugConfigSchema } from "../types";
import { buildStateTopic, parseTopic } from "../topic";

// JSON-backed fake codec so encode/decode work without the protobuf dep.
const fakeCodec = {
  encodePayload(p: ProtoPayload): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(p));
  },
  decodePayload(buf: Uint8Array): ProtoPayload {
    return JSON.parse(new TextDecoder().decode(buf)) as ProtoPayload;
  },
};

interface PublishCall {
  topic: string;
  payload: Uint8Array;
  opts: { qos: number; retain: boolean };
}

/** Minimal controllable fake MQTT client. */
class FakeMqtt implements MqttLike {
  handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  subscriptions: string[] = [];
  publishes: PublishCall[] = [];
  ended = false;
  publishThrowFor: ((topic: string) => Error | undefined) | null = null;
  publishErrorFor: ((topic: string) => Error | undefined) | null = null;
  deferPublishCallbacks = false;
  deferSubscribeCallbacks = false;
  subscribeError: Error | null = null;
  subscribeThrow: Error | null = null;
  private pendingPublishCallbacks: (() => void)[] = [];
  private pendingSubscribeCallbacks: (() => void)[] = [];

  on(event: string, cb: (...a: unknown[]) => void): void {
    (this.handlers[event] ??= []).push(cb);
  }
  subscribe(topic: string | string[], _opts: { qos: 0 | 1 | 2 }, cb?: (err: Error | null) => void): void {
    if (this.subscribeThrow) throw this.subscribeThrow;
    this.subscriptions.push(...(Array.isArray(topic) ? topic : [topic]));
    const complete = () => cb?.(this.subscribeError);
    if (this.deferSubscribeCallbacks) {
      this.pendingSubscribeCallbacks.push(complete);
    } else {
      complete();
    }
  }
  publish(
    topic: string,
    payload: Uint8Array,
    opts: { qos: 0 | 1 | 2; retain: boolean },
    cb?: (err?: Error) => void,
  ): void {
    const queueError = this.publishThrowFor?.(topic);
    if (queueError) throw queueError;
    this.publishes.push({ topic, payload, opts });
    const complete = () => cb?.(this.publishErrorFor?.(topic));
    if (this.deferPublishCallbacks) {
      this.pendingPublishCallbacks.push(complete);
    } else {
      complete();
    }
  }
  end(_force?: boolean, _opts?: object, cb?: () => void): void {
    this.ended = true;
    cb?.();
  }

  // Test helpers
  emit(event: string, ...args: unknown[]): void {
    (this.handlers[event] ?? []).forEach((h) => h(...args));
  }
  flushPublishCallbacks(): void {
    const callbacks = this.pendingPublishCallbacks.splice(0);
    callbacks.forEach((callback) => callback());
  }
  flushSubscribeCallbacks(): void {
    const callbacks = this.pendingSubscribeCallbacks.splice(0);
    callbacks.forEach((callback) => callback());
  }
  decodedPublishes(): { topic: string; body: ProtoPayload; opts: { qos: number; retain: boolean } }[] {
    return this.publishes.map((p) => ({
      topic: p.topic,
      body: JSON.parse(new TextDecoder().decode(p.payload)) as ProtoPayload,
      opts: p.opts,
    }));
  }
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return SparkplugConfigSchema.parse({
    brokerUrl: "mqtt://localhost:1883",
    groupId: "Plant-North",
    edgeNodeId: "edge-01",
    enabled: true,
    ...overrides,
  });
}

describe("SparkplugBridge", () => {
  let fake: FakeMqtt;
  let lastConnectOpts: MqttConnectOptions | null = null;

  beforeEach(() => {
    setCodec(fakeCodec);
    fake = new FakeMqtt();
    lastConnectOpts = null;
  });
  afterEach(() => {
    setCodec(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function newBridge(configOverrides: Record<string, unknown> = {}) {
    const connectFn = (_url: string, opts: MqttConnectOptions): MqttLike => {
      lastConnectOpts = opts;
      return fake;
    };
    return new SparkplugBridge(
      makeConfig(configOverrides),
      [{ name: "Node/Uptime", dataType: 4, value: 0 }],
      connectFn,
    );
  }

  it("does not connect when disabled", () => {
    const bridge = newBridge({ enabled: false, brokerUrl: "mqtt://localhost:1883" });
    bridge.start();
    expect(lastConnectOpts).toBeNull();
    expect(bridge.getStatus().started).toBe(false);
  });

  it("contains Will encoding failures instead of crashing server startup", () => {
    setCodec({
      encodePayload(): Uint8Array {
        throw new Error("codec rejected NDEATH");
      },
      decodePayload(): ProtoPayload {
        throw new Error("unused");
      },
    });
    const bridge = newBridge();

    expect(() => bridge.start()).not.toThrow();
    expect(lastConnectOpts).toBeNull();
    expect(bridge.getStatus()).toMatchObject({
      started: false,
      nodeState: "offline",
    });
  });

  it("sets NDEATH as the Last-Will with this session's bdSeq", () => {
    const bridge = newBridge();
    bridge.start();
    expect(lastConnectOpts).not.toBeNull();
    expect(lastConnectOpts!.will.topic).toBe("spBv1.0/Plant-North/NDEATH/edge-01");
    expect(lastConnectOpts!.will.qos).toBe(1);
    const willBody = JSON.parse(new TextDecoder().decode(lastConnectOpts!.will.payload)) as ProtoPayload;
    expect(willBody.metrics[0].name).toBe("bdSeq");
    // Int64 values are normalized to decimal strings at the codec boundary so
    // they round-trip without JavaScript number precision loss.
    expect(Number(willBody.metrics[0].value)).toBe(1);
  });

  it("forwards credentials to the connect options", () => {
    const bridge = newBridge({ username: "user", password: "pw" });
    bridge.start();
    expect(lastConnectOpts!.username).toBe("user");
    expect(lastConnectOpts!.password).toBe("pw");
  });

  it("publishes NBIRTH and subscribes for commands + STATE on connect", () => {
    const bridge = newBridge();
    bridge.start();
    fake.emit("connect");

    const nbirth = fake.decodedPublishes().find((p) => p.topic.includes("/NBIRTH/"));
    expect(nbirth).toBeDefined();
    expect(nbirth!.body.seq).toBe(0);
    expect(nbirth!.opts.qos).toBe(1);
    expect(nbirth!.body.metrics.map((m) => m.name)).toContain("Node/Uptime");

    expect(fake.subscriptions).toContain("spBv1.0/Plant-North/NCMD/edge-01");
    expect(fake.subscriptions).toContain("spBv1.0/STATE/+");
    expect(bridge.getStatus().nodeState).toBe("online");
  });

  it("keeps NBIRTH pending and blocks DATA/subscription until its callback succeeds", () => {
    fake.deferPublishCallbacks = true;
    const bridge = newBridge();
    bridge.start();
    fake.emit("connect");

    expect(bridge.getStatus()).toMatchObject({
      nodeState: "connecting",
      canPublishData: false,
    });
    expect(fake.subscriptions).toEqual([]);

    const before = fake.publishes.length;
    bridge.publishNodeData([{ name: "Node/Uptime", dataType: 4, value: 1 }]);
    bridge.birthSite({
      deviceId: "pump-42",
      metrics: [{ name: "Flow", dataType: 10, value: 0 }],
    });
    expect(fake.publishes).toHaveLength(before);

    fake.flushPublishCallbacks();
    expect(bridge.getStatus()).toMatchObject({
      nodeState: "online",
      canPublishData: true,
    });
    expect(fake.subscriptions).toContain("spBv1.0/Plant-North/NCMD/edge-01");
  });

  it("keeps DATA blocked until the asynchronous subscription callback succeeds", () => {
    fake.deferSubscribeCallbacks = true;
    const bridge = newBridge();
    bridge.start();
    fake.emit("connect");

    expect(fake.subscriptions).toContain("spBv1.0/Plant-North/NCMD/edge-01");
    expect(bridge.getStatus()).toMatchObject({
      nodeState: "connecting",
      canPublishData: false,
    });
    const before = fake.publishes.length;
    bridge.publishNodeData([{ name: "Node/Uptime", dataType: 4, value: 1 }]);
    expect(fake.publishes).toHaveLength(before);

    fake.flushSubscribeCallbacks();
    expect(bridge.getStatus()).toMatchObject({
      nodeState: "online",
      canPublishData: true,
    });
  });

  it("rolls back an NBIRTH encode failure without subscribing or allowing DATA", () => {
    setCodec({
      encodePayload(payload): Uint8Array {
        if (payload.metrics.some((metric) => metric.name === "Node Control/Rebirth")) {
          throw new Error("NBIRTH encode rejected");
        }
        return fakeCodec.encodePayload(payload);
      },
      decodePayload: fakeCodec.decodePayload,
    });
    const bridge = newBridge();
    bridge.start();

    expect(() => fake.emit("connect")).not.toThrow();
    expect(bridge.getStatus()).toMatchObject({
      nodeState: "offline",
      canPublishData: false,
    });
    expect(fake.subscriptions).toEqual([]);
    expect(fake.publishes).toEqual([]);

    bridge.publishNodeData([{ name: "Node/Uptime", dataType: 4, value: 1 }]);
    bridge.birthSite({
      deviceId: "pump-42",
      metrics: [{ name: "Flow", dataType: 10, value: 0 }],
    });
    expect(fake.publishes).toEqual([]);
  });

  it("rolls back a synchronous NBIRTH queue failure without subscribing", () => {
    fake.publishThrowFor = (topic) =>
      topic.includes("/NBIRTH/") ? new Error("queue rejected NBIRTH") : undefined;
    const bridge = newBridge();
    bridge.start();

    expect(() => fake.emit("connect")).not.toThrow();
    expect(bridge.getStatus()).toMatchObject({
      nodeState: "offline",
      canPublishData: false,
    });
    expect(fake.subscriptions).toEqual([]);
    expect(fake.publishes).toEqual([]);
  });

  it("rolls back an asynchronous NBIRTH callback error and never subscribes", () => {
    fake.deferPublishCallbacks = true;
    fake.publishErrorFor = (topic) =>
      topic.includes("/NBIRTH/") ? new Error("NBIRTH PUBACK failed") : undefined;
    const bridge = newBridge();
    bridge.start();
    fake.emit("connect");

    expect(bridge.getStatus().nodeState).toBe("connecting");
    expect(fake.subscriptions).toEqual([]);
    fake.flushPublishCallbacks();

    expect(bridge.getStatus()).toMatchObject({
      nodeState: "offline",
      canPublishData: false,
    });
    expect(fake.subscriptions).toEqual([]);
  });

  it("DBIRTH/DDATA/DDEATH flow through publish", () => {
    const bridge = newBridge();
    bridge.start();
    fake.emit("connect");

    bridge.birthSite({ deviceId: "pump-42", metrics: [{ name: "Flow", dataType: 10, value: 0 }] });
    bridge.publishSiteData("pump-42", [{ name: "Flow", dataType: 10, value: 5.5 }]);
    bridge.deathSite("pump-42");

    const topics = fake.publishes.map((p) => p.topic);
    expect(topics).toContain("spBv1.0/Plant-North/DBIRTH/edge-01/pump-42");
    expect(topics).toContain("spBv1.0/Plant-North/DDATA/edge-01/pump-42");
    expect(topics).toContain("spBv1.0/Plant-North/DDEATH/edge-01/pump-42");
    expect(bridge.getStatus().devices).toContain("pump-42");
  });

  it("keeps a failed DDEATH retryable and commits only a successful retry", () => {
    const bridge = newBridge();
    bridge.start();
    fake.emit("connect");
    bridge.birthSite({
      deviceId: "pump-42",
      metrics: [{ name: "Flow", dataType: 10, value: 0 }],
    });
    fake.deferPublishCallbacks = true;
    fake.publishErrorFor = (topic) =>
      topic.includes("/DDEATH/") ? new Error("DDEATH PUBACK failed") : undefined;

    bridge.deathSite("pump-42");
    expect(bridge.getStatus().deviceStates["pump-42"]).toBe("online");
    const beforeBlockedData = fake.publishes.length;
    bridge.publishSiteData("pump-42", [{ name: "Flow", dataType: 10, value: 1 }]);
    expect(fake.publishes).toHaveLength(beforeBlockedData);

    fake.flushPublishCallbacks();
    expect(bridge.getStatus().deviceStates["pump-42"]).toBe("online");

    fake.publishErrorFor = null;
    bridge.deathSite("pump-42");
    fake.flushPublishCallbacks();
    expect(bridge.getStatus().deviceStates["pump-42"]).toBe("offline");
    expect(fake.publishes.filter((p) => p.topic.includes("/DDEATH/"))).toHaveLength(2);
  });

  it("keeps a failed DBIRTH offline, blocks DDATA, and permits a valid retry", () => {
    const bridge = newBridge();
    bridge.start();
    fake.emit("connect");
    fake.publishErrorFor = (topic) =>
      topic.includes("/DBIRTH/") ? new Error("DBIRTH PUBACK failed") : undefined;

    bridge.birthSite({
      deviceId: "pump-42",
      metrics: [{ name: "Flow", dataType: 10, value: 0 }],
    });
    expect(bridge.getStatus().deviceStates["pump-42"]).toBe("offline");

    const beforeBlockedData = fake.publishes.length;
    bridge.publishSiteData("pump-42", [{ name: "Flow", dataType: 10, value: 5.5 }]);
    expect(fake.publishes).toHaveLength(beforeBlockedData);

    fake.publishErrorFor = null;
    bridge.birthSite({
      deviceId: "pump-42",
      metrics: [{ name: "Flow", dataType: 10, value: 0 }],
    });
    expect(bridge.getStatus().deviceStates["pump-42"]).toBe("online");

    bridge.publishSiteData("pump-42", [{ name: "Flow", dataType: 10, value: 5.5 }]);
    expect(fake.publishes.at(-1)?.topic).toBe(
      "spBv1.0/Plant-North/DDATA/edge-01/pump-42",
    );
  });

  it("rolls back a synchronous DBIRTH queue failure and permits retry", () => {
    const bridge = newBridge();
    bridge.start();
    fake.emit("connect");
    let rejectBirth = true;
    fake.publishThrowFor = (topic) => {
      if (rejectBirth && topic.includes("/DBIRTH/")) {
        rejectBirth = false;
        return new Error("queue rejected DBIRTH");
      }
      return undefined;
    };

    bridge.birthSite({
      deviceId: "pump-42",
      metrics: [{ name: "Flow", dataType: 10, value: 0 }],
    });
    expect(bridge.getStatus().deviceStates["pump-42"]).toBe("offline");
    const beforeBlockedData = fake.publishes.length;
    bridge.publishSiteData("pump-42", [{ name: "Flow", dataType: 10, value: 1 }]);
    expect(fake.publishes).toHaveLength(beforeBlockedData);

    bridge.birthSite({
      deviceId: "pump-42",
      metrics: [{ name: "Flow", dataType: 10, value: 0 }],
    });
    expect(bridge.getStatus().deviceStates["pump-42"]).toBe("online");
    bridge.publishSiteData("pump-42", [{ name: "Flow", dataType: 10, value: 2 }]);
    expect(fake.publishes.at(-1)?.topic).toContain("/DDATA/");
  });

  it("keeps a DBIRTH offline while its callback is pending", () => {
    const bridge = newBridge();
    bridge.start();
    fake.emit("connect");
    fake.deferPublishCallbacks = true;

    bridge.birthSite({
      deviceId: "pump-42",
      metrics: [{ name: "Flow", dataType: 10, value: 0 }],
    });
    expect(bridge.getStatus().deviceStates["pump-42"]).toBe("offline");
    const before = fake.publishes.length;
    bridge.publishSiteData("pump-42", [{ name: "Flow", dataType: 10, value: 2 }]);
    expect(fake.publishes).toHaveLength(before);

    fake.flushPublishCallbacks();
    expect(bridge.getStatus().deviceStates["pump-42"]).toBe("online");
  });

  it("fails a device closed after a DDATA publish callback error", () => {
    const bridge = newBridge();
    bridge.start();
    fake.emit("connect");
    bridge.birthSite({
      deviceId: "pump-42",
      metrics: [{ name: "Flow", dataType: 10, value: 0 }],
    });
    fake.publishErrorFor = (topic) =>
      topic.includes("/DDATA/") ? new Error("DDATA callback failed") : undefined;

    bridge.publishSiteData("pump-42", [{ name: "Flow", dataType: 10, value: 2 }]);
    expect(bridge.getStatus().deviceStates["pump-42"]).toBe("offline");
    const before = fake.publishes.length;
    bridge.publishSiteData("pump-42", [{ name: "Flow", dataType: 10, value: 3 }]);
    expect(fake.publishes).toHaveLength(before);
  });

  it("fails the node closed when the post-NBIRTH subscription callback errors", () => {
    fake.subscribeError = new Error("subscribe denied");
    const bridge = newBridge();
    bridge.start();

    expect(() => fake.emit("connect")).not.toThrow();
    expect(bridge.getStatus()).toMatchObject({
      nodeState: "offline",
      canPublishData: false,
    });
  });

  it("stops publishing DATA after primary host STATE OFFLINE", () => {
    const bridge = newBridge({ primaryHostId: "scada-host" });
    bridge.start();
    fake.emit("connect");
    bridge.birthSite({ deviceId: "pump-42", metrics: [{ name: "Flow", dataType: 10, value: 0 }] });

    // Host goes OFFLINE
    const stateTopic = buildStateTopic("scada-host");
    fake.emit("message", stateTopic, new TextEncoder().encode(JSON.stringify({ online: false })));
    expect(bridge.getStatus().canPublishData).toBe(false);

    const before = fake.publishes.length;
    bridge.publishSiteData("pump-42", [{ name: "Flow", dataType: 10, value: 9 }]);
    expect(fake.publishes.length).toBe(before); // suppressed

    // Host returns ONLINE → DATA resumes
    fake.emit("message", stateTopic, new TextEncoder().encode("ONLINE"));
    expect(bridge.getStatus().canPublishData).toBe(true);
    bridge.publishSiteData("pump-42", [{ name: "Flow", dataType: 10, value: 9 }]);
    expect(fake.publishes.length).toBe(before + 1);
  });

  it("ignores STATE from a non-primary host", () => {
    const bridge = newBridge({ primaryHostId: "scada-host" });
    bridge.start();
    fake.emit("connect");
    fake.emit("message", buildStateTopic("other-host"), new TextEncoder().encode("OFFLINE"));
    expect(bridge.getStatus().canPublishData).toBe(true);
  });

  it("re-births (fresh NBIRTH seq 0) on a Rebirth command", () => {
    const bridge = newBridge();
    bridge.start();
    fake.emit("connect");
    const beforeBdSeq = bridge.getStatus().bdSeq;

    // NCMD with Node Control/Rebirth = true
    const cmdTopic = "spBv1.0/Plant-North/NCMD/edge-01";
    expect(parseTopic(cmdTopic)?.messageType).toBe("NCMD");
    const rebirthBody: ProtoPayload = {
      timestamp: Date.now(),
      metrics: [{ name: "Node Control/Rebirth", type: "Boolean", value: true }],
    };
    fake.emit("message", cmdTopic, fakeCodec.encodePayload(rebirthBody));

    const nbirths = fake.decodedPublishes().filter((p) => p.topic.includes("/NBIRTH/"));
    expect(nbirths.length).toBe(2); // initial + rebirth
    expect(nbirths[1].body.seq).toBe(0);
    // An in-session Rebirth (§7.6) restarts seq at 0 but must NOT bump bdSeq:
    // the NDEATH Will registered at connect carries the original bdSeq, and a
    // mismatched birth bdSeq would break host birth/death correlation (§6.4).
    expect(bridge.getStatus().bdSeq).toBe(beforeBdSeq);
    // The re-birth NBIRTH carries the same bdSeq metric as the first NBIRTH.
    const bdSeqMetric0 = nbirths[0].body.metrics.find((m) => m.name === "bdSeq");
    const bdSeqMetric1 = nbirths[1].body.metrics.find((m) => m.name === "bdSeq");
    expect(bdSeqMetric1?.value).toBe(bdSeqMetric0?.value);
  });

  it("invokes the command handler on NCMD", () => {
    const bridge = newBridge();
    const handler = vi.fn();
    bridge.onCommand(handler);
    bridge.start();
    fake.emit("connect");

    const cmdBody: ProtoPayload = {
      timestamp: Date.now(),
      metrics: [{ name: "Node Control/Reboot", type: "Boolean", value: true }],
    };
    fake.emit("message", "spBv1.0/Plant-North/NCMD/edge-01", fakeCodec.encodePayload(cmdBody));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ messageType: "NCMD" }),
    );
  });

  it("contains command-handler callback exceptions without corrupting node state", () => {
    const bridge = newBridge();
    bridge.onCommand(() => {
      throw new Error("application command failed");
    });
    bridge.start();
    fake.emit("connect");
    const cmdBody: ProtoPayload = {
      timestamp: Date.now(),
      metrics: [{ name: "Node Control/Reboot", type: "Boolean", value: true }],
    };

    expect(() =>
      fake.emit(
        "message",
        "spBv1.0/Plant-North/NCMD/edge-01",
        fakeCodec.encodePayload(cmdBody),
      ),
    ).not.toThrow();
    expect(bridge.getStatus()).toMatchObject({
      nodeState: "online",
      canPublishData: true,
    });
  });

  it("creates a fresh client and matching incremented Will for every reconnect", () => {
    vi.useFakeTimers();
    const clients: FakeMqtt[] = [];
    const options: MqttConnectOptions[] = [];
    const bridge = new SparkplugBridge(
      makeConfig({ reconnectPeriodMs: 25 }),
      [{ name: "Node/Uptime", dataType: 4, value: 0 }],
      (_url, opts) => {
        const client = new FakeMqtt();
        clients.push(client);
        options.push(opts);
        return client;
      },
    );

    bridge.start();
    expect(options[0].reconnectPeriod).toBe(0);
    clients[0].emit("connect");
    expect(bridge.getStatus().nodeState).toBe("online");
    clients[0].emit("close");
    expect(bridge.getStatus().nodeState).toBe("offline");

    vi.advanceTimersByTime(25);
    expect(clients).toHaveLength(2);
    expect(options[1].reconnectPeriod).toBe(0);
    const firstWill = fakeCodec.decodePayload(options[0].will.payload);
    const secondWill = fakeCodec.decodePayload(options[1].will.payload);
    expect(Number(firstWill.metrics[0].value)).toBe(1);
    expect(Number(secondWill.metrics[0].value)).toBe(2);

    clients[1].emit("connect");
    expect(bridge.getStatus()).toMatchObject({
      nodeState: "online",
      bdSeq: 2,
    });
    bridge.stop();
  });

  it("ignores stale callbacks and events after a stop/start session change", () => {
    const first = new FakeMqtt();
    const second = new FakeMqtt();
    first.deferPublishCallbacks = true;
    const clients = [first, second];
    let nextClient = 0;
    const bridge = new SparkplugBridge(
      makeConfig({ primaryHostId: "primary-host" }),
      [{ name: "Node/Uptime", dataType: 4, value: 0 }],
      () => clients[nextClient++],
    );

    bridge.start();
    first.emit("connect");
    expect(bridge.getStatus().nodeState).toBe("connecting");
    bridge.stop();
    bridge.start();
    second.emit("connect");
    expect(bridge.getStatus().nodeState).toBe("online");
    const secondPublishCount = second.publishes.length;

    first.publishErrorFor = () => new Error("stale NBIRTH failure");
    first.flushPublishCallbacks();
    first.emit("offline");
    first.emit("close");
    first.emit("connect");
    first.emit(
      "message",
      buildStateTopic("primary-host"),
      new TextEncoder().encode(JSON.stringify({ online: false })),
    );

    expect(bridge.getStatus()).toMatchObject({
      nodeState: "online",
      canPublishData: true,
    });
    expect(second.publishes).toHaveLength(secondPublishCount);
    bridge.stop();
  });

  it("stop() ends the client and marks node offline", () => {
    const bridge = newBridge();
    bridge.start();
    fake.emit("connect");
    bridge.stop();
    expect(fake.ended).toBe(true);
    expect(bridge.getStatus().nodeState).toBe("offline");
  });
});
