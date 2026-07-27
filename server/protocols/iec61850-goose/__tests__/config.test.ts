/**
 * Tests for the GOOSE service configuration loader and the startup wiring.
 *
 * Issue: #465
 */

import { describe, it, expect, afterEach } from "vitest";
import { loadGooseServiceConfig, loadGooseSubscriptionsFile } from "../config.js";
import { startGooseSubscriber, stopGooseSubscriber, getGooseSubscriber } from "../index.js";
import { REPLAY_APP_ID, REPLAY_GOCB_REF } from "./fixtures.js";
import { REPLAY_PCAP_PATH } from "./generate-replay-pcap.js";

const SUBSCRIPTIONS_JSON = JSON.stringify([
  {
    gocbRef: REPLAY_GOCB_REF,
    appId: REPLAY_APP_ID,
    dataset: [
      { tagName: "IED1/XCBR1.Pos.stVal", type: "boolean" },
      { tagName: "IED1/XCBR1.Pos.q", type: "quality", isQuality: true },
      { tagName: "IED1/MMXU1.A.phsA.cVal.mag.f", type: "float" },
    ],
  },
]);

const readStub = (contents: string) => (): string => contents;

afterEach(async () => {
  await stopGooseSubscriber();
});

describe("loadGooseServiceConfig", () => {
  it("defaults to no subscriptions, no capture file and eth0", () => {
    const config = loadGooseServiceConfig({});
    expect(config.subscriptions).toEqual([]);
    expect(config.pcapPath).toBeUndefined();
    expect(config.iface).toBe("eth0");
    expect(config.pcapRealtime).toBe(true);
  });

  it("reads subscriptions from GOOSE_SUBSCRIPTIONS_FILE", () => {
    const config = loadGooseServiceConfig(
      { GOOSE_SUBSCRIPTIONS_FILE: "subs.json", GOOSE_IFACE: "eth7" },
      readStub(SUBSCRIPTIONS_JSON),
    );
    expect(config.subscriptions).toHaveLength(1);
    expect(config.subscriptions[0].gocbRef).toBe(REPLAY_GOCB_REF);
    // Zod defaults are applied to each subscription.
    expect(config.subscriptions[0].simulationPolicy).toBe("accept-flagged");
    expect(config.iface).toBe("eth7");
  });

  it("honours GOOSE_PCAP_FILE and GOOSE_PCAP_REALTIME", () => {
    const config = loadGooseServiceConfig(
      {
        GOOSE_SUBSCRIPTIONS_FILE: "subs.json",
        GOOSE_PCAP_FILE: "trace.pcap",
        GOOSE_PCAP_REALTIME: "false",
      },
      readStub(SUBSCRIPTIONS_JSON),
    );
    expect(config.pcapPath).toBe("trace.pcap");
    expect(config.pcapRealtime).toBe(false);
  });

  it("rejects a subscription list that fails schema validation", () => {
    expect(() =>
      loadGooseServiceConfig(
        { GOOSE_SUBSCRIPTIONS_FILE: "subs.json" },
        readStub(JSON.stringify([{ gocbRef: "x", appId: 0x9999, dataset: [] }])),
      ),
    ).toThrow();
  });

  it("names the offending file when the JSON is malformed", () => {
    expect(() => loadGooseSubscriptionsFile("bad.json", readStub("{not json"))).toThrow(
      /bad\.json/,
    );
  });

  it("requires the file to hold a JSON array", () => {
    expect(() => loadGooseSubscriptionsFile("obj.json", readStub("{}"))).toThrow(/array/i);
  });

  it("surfaces a read failure with the path", () => {
    expect(() =>
      loadGooseSubscriptionsFile("missing.json", () => {
        throw new Error("ENOENT");
      }),
    ).toThrow(/missing\.json/);
  });
});

describe("startGooseSubscriber", () => {
  it("stays off when no subscriptions are configured", async () => {
    await expect(startGooseSubscriber(loadGooseServiceConfig({}))).resolves.toBeNull();
    expect(getGooseSubscriber()).toBeNull();
  });

  it("starts but reports 'unavailable' when no capture source is configured", async () => {
    const config = loadGooseServiceConfig(
      { GOOSE_SUBSCRIPTIONS_FILE: "subs.json" },
      readStub(SUBSCRIPTIONS_JSON),
    );
    const subscriber = await startGooseSubscriber(config);
    expect(subscriber).not.toBeNull();
    expect(subscriber!.getState()).toBe("unavailable");
    expect(subscriber!.getBackend().name).toBe("null");
  });

  it("replays a configured capture and reaches 'running'", async () => {
    const config = loadGooseServiceConfig(
      {
        GOOSE_SUBSCRIPTIONS_FILE: "subs.json",
        GOOSE_PCAP_FILE: REPLAY_PCAP_PATH,
        GOOSE_PCAP_REALTIME: "0",
      },
      readStub(SUBSCRIPTIONS_JSON),
    );
    const subscriber = await startGooseSubscriber(config);
    expect(subscriber).not.toBeNull();
    expect(subscriber!.getState()).toBe("running");
    expect(subscriber!.getBackend().name).toBe("pcap-replay");
    expect(getGooseSubscriber()).toBe(subscriber);
  });

  it("stops the previous subscriber instead of leaking it when started twice", async () => {
    const config = loadGooseServiceConfig(
      { GOOSE_SUBSCRIPTIONS_FILE: "subs.json" },
      readStub(SUBSCRIPTIONS_JSON),
    );
    const first = await startGooseSubscriber(config);
    const second = await startGooseSubscriber(config);

    expect(second).not.toBe(first);
    // The abandoned instance must be shut down, not left holding a watchdog.
    expect(first!.getState()).toBe("stopped");
    expect(getGooseSubscriber()).toBe(second);
  });
});

describe("GooseSubscriber.start() idempotence", () => {
  it("refuses to open a second frame stream when already running", async () => {
    const config = loadGooseServiceConfig(
      {
        GOOSE_SUBSCRIPTIONS_FILE: "subs.json",
        GOOSE_PCAP_FILE: REPLAY_PCAP_PATH,
        GOOSE_PCAP_REALTIME: "0",
      },
      readStub(SUBSCRIPTIONS_JSON),
    );
    const subscriber = await startGooseSubscriber(config);
    expect(subscriber!.getState()).toBe("running");

    // Without the guard this reopens the backend and lands in "error".
    await expect(subscriber!.start()).resolves.toBe("running");
  });
});
