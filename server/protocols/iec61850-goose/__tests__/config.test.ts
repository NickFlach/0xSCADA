/**
 * Tests for the GOOSE service configuration loader and the startup wiring.
 *
 * Issue: #465
 */

import { describe, it, expect, afterEach } from "vitest";
import { loadGooseServiceConfig, loadGooseSubscriptionsFile } from "../config.js";
import {
  createGooseCaptureBackend,
  startGooseSubscriber,
  stopGooseSubscriber,
  getGooseSubscriber,
} from "../index.js";
import { GooseLiveCaptureBackend, GOOSE_BPF_FILTER } from "../live-backend.js";
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
  it("defaults to no subscriptions, no capture at all and eth0", () => {
    const config = loadGooseServiceConfig({});
    expect(config.subscriptions).toEqual([]);
    expect(config.pcapPath).toBeUndefined();
    expect(config.iface).toBe("eth0");
    expect(config.pcapRealtime).toBe(true);
    // Capture is opt-in: an unconfigured environment must never start one.
    expect(config.capture).toBe("none");
    expect(config.captureTool).toBe("auto");
    expect(config.captureToolPath).toBeUndefined();
    expect(config.captureSnapLen).toBe(65535);
    expect(config.captureFilter).toBeUndefined();
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
    // GOOSE_PCAP_FILE alone still selects replay — unchanged behaviour.
    expect(config.capture).toBe("pcap");
  });

  it("only selects live capture when it is asked for explicitly", () => {
    expect(loadGooseServiceConfig({ GOOSE_IFACE: "eth4" }).capture).toBe("none");
    expect(loadGooseServiceConfig({ GOOSE_CAPTURE_TOOL: "tcpdump" }).capture).toBe("none");
    expect(loadGooseServiceConfig({ GOOSE_CAPTURE_SNAPLEN: "1500" }).capture).toBe("none");
    expect(loadGooseServiceConfig({ GOOSE_CAPTURE: "live" }).capture).toBe("live");
  });

  it("lets GOOSE_CAPTURE=none override a configured capture file", () => {
    const config = loadGooseServiceConfig({
      GOOSE_CAPTURE: "none",
      GOOSE_PCAP_FILE: "trace.pcap",
    });
    expect(config.capture).toBe("none");
  });

  it("reads the live-capture settings", () => {
    const config = loadGooseServiceConfig({
      GOOSE_CAPTURE: "live",
      GOOSE_IFACE: "ens1f0",
      GOOSE_CAPTURE_TOOL: "tcpdump",
      GOOSE_CAPTURE_TOOL_PATH: "/usr/sbin/tcpdump",
      GOOSE_CAPTURE_SNAPLEN: "1500",
      GOOSE_CAPTURE_FILTER: "ether proto 0x88b8",
    });
    expect(config.capture).toBe("live");
    expect(config.iface).toBe("ens1f0");
    expect(config.captureTool).toBe("tcpdump");
    expect(config.captureToolPath).toBe("/usr/sbin/tcpdump");
    expect(config.captureSnapLen).toBe(1500);
    expect(config.captureFilter).toBe("ether proto 0x88b8");
  });

  it("rejects an unknown capture mode", () => {
    expect(() => loadGooseServiceConfig({ GOOSE_CAPTURE: "sniff" })).toThrow();
  });

  it("rejects GOOSE_CAPTURE=pcap without a capture file", () => {
    expect(() => loadGooseServiceConfig({ GOOSE_CAPTURE: "pcap" })).toThrow(/GOOSE_PCAP_FILE/);
  });

  it("rejects a tool path without an explicit tool, because argv differs per tool", () => {
    expect(() =>
      loadGooseServiceConfig({
        GOOSE_CAPTURE: "live",
        GOOSE_CAPTURE_TOOL_PATH: "/usr/sbin/tcpdump",
      }),
    ).toThrow(/GOOSE_CAPTURE_TOOL/);
  });

  it("rejects a non-integer or out-of-range snapshot length", () => {
    expect(() => loadGooseServiceConfig({ GOOSE_CAPTURE_SNAPLEN: "big" })).toThrow(
      /GOOSE_CAPTURE_SNAPLEN must be an integer/,
    );
    expect(() => loadGooseServiceConfig({ GOOSE_CAPTURE_SNAPLEN: "4" })).toThrow();
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

describe("createGooseCaptureBackend", () => {
  it("builds the null backend when no capture is configured", () => {
    const backend = createGooseCaptureBackend(loadGooseServiceConfig({}));
    expect(backend.name).toBe("null");
    expect(backend.availability().available).toBe(false);
  });

  it("builds the replay backend for a configured capture file", () => {
    const backend = createGooseCaptureBackend(
      loadGooseServiceConfig({ GOOSE_PCAP_FILE: REPLAY_PCAP_PATH }),
    );
    expect(backend.name).toBe("pcap-replay");
  });

  it("builds the live backend on the configured interface and filter", () => {
    const backend = createGooseCaptureBackend(
      loadGooseServiceConfig({ GOOSE_CAPTURE: "live", GOOSE_IFACE: "ens1f0" }),
    );
    expect(backend.name).toBe("live-pcap");
    expect(backend).toBeInstanceOf(GooseLiveCaptureBackend);
    const live = backend as GooseLiveCaptureBackend;
    expect(live.getInterface()).toBe("ens1f0");
    expect(live.getFilter()).toBe(GOOSE_BPF_FILTER);
  });

  it("defaults the live backend to eth0, per the acceptance criterion", () => {
    const backend = createGooseCaptureBackend(loadGooseServiceConfig({ GOOSE_CAPTURE: "live" }));
    expect((backend as GooseLiveCaptureBackend).getInterface()).toBe("eth0");
  });

  it("passes a filter override through to the live backend", () => {
    const backend = createGooseCaptureBackend(
      loadGooseServiceConfig({
        GOOSE_CAPTURE: "live",
        GOOSE_CAPTURE_FILTER: "ether proto 0x88b8 and vlan 100",
      }),
    );
    expect((backend as GooseLiveCaptureBackend).getFilter()).toBe(
      "ether proto 0x88b8 and vlan 100",
    );
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
