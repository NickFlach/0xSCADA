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

  on(event: string, cb: (...a: unknown[]) => void): void {
    (this.handlers[event] ??= []).push(cb);
  }
  subscribe(topic: string | string[], _opts: { qos: 0 | 1 | 2 }, cb?: (err: Error | null) => void): void {
    this.subscriptions.push(...(Array.isArray(topic) ? topic : [topic]));
    cb?.(null);
  }
  publish(
    topic: string,
    payload: Uint8Array,
    opts: { qos: 0 | 1 | 2; retain: boolean },
    cb?: (err?: Error) => void,
  ): void {
    this.publishes.push({ topic, payload, opts });
    cb?.(undefined);
  }
  end(_force?: boolean, _opts?: object, cb?: () => void): void {
    this.ended = true;
    cb?.();
  }

  // Test helpers
  emit(event: string, ...args: unknown[]): void {
    (this.handlers[event] ?? []).forEach((h) => h(...args));
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

  it("sets NDEATH as the Last-Will with this session's bdSeq", () => {
    const bridge = newBridge();
    bridge.start();
    expect(lastConnectOpts).not.toBeNull();
    expect(lastConnectOpts!.will.topic).toBe("spBv1.0/Plant-North/NDEATH/edge-01");
    expect(lastConnectOpts!.will.qos).toBe(1);
    const willBody = JSON.parse(new TextDecoder().decode(lastConnectOpts!.will.payload)) as ProtoPayload;
    expect(willBody.metrics[0].name).toBe("bdSeq");
    expect(willBody.metrics[0].value).toBe(1);
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
      metrics: [{ name: "Node Control/Rebirth", dataType: "Boolean", value: true }],
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
      metrics: [{ name: "Node Control/Reboot", dataType: "Boolean", value: true }],
    };
    fake.emit("message", "spBv1.0/Plant-North/NCMD/edge-01", fakeCodec.encodePayload(cmdBody));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ messageType: "NCMD" }),
    );
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
