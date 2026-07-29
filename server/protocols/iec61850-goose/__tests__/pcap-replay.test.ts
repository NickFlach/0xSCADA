/**
 * End-to-end replay tests: a committed `.pcap` is fed through the pcap capture
 * backend into the GOOSE subscriber, and the decoded dataset, timing/quality
 * validation, tag updates and Prometheus metrics are all asserted on real
 * frames — this is the issue's own Verification section made executable.
 *
 * It also pins the honest behaviour of the DEFAULT backend: it reports that it
 * cannot capture, rather than throwing or claiming to run.
 *
 * Issue: #465
 */

import { describe, it, expect, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  GooseSubscriber,
  GoosePcapReplayBackend,
  NullGooseCaptureBackend,
  GooseCaptureUnavailableError,
  detectRawSocketCapability,
} from "../index.js";
import { encodePcap, parsePcap, isGooseFrame } from "../index.js";
import type { GooseSubscriptionConfig } from "../subscription.js";
import type { GooseTagUpdate } from "../types.js";
import {
  gooseFramesReceivedTotal,
  gooseFramesRejectedTotal,
  gooseRoundTripUs,
  type GooseRejectReason,
} from "../metrics.js";
import {
  buildReplayScenario,
  buildPdu,
  buildFrame,
  data,
  REPLAY_APP_ID,
  REPLAY_CONF_REV,
  REPLAY_DEST_MAC,
  REPLAY_GOCB_REF,
  REPLAY_PUBLISH_LATENCY_MS,
  REPLAY_SRC_MAC,
  REPLAY_START_MS,
} from "./fixtures.js";
import { REPLAY_PCAP_PATH, encodeReplayPcap } from "./generate-replay-pcap.js";

const TAG_POSITION = "IED1/XCBR1.Pos.stVal";
const TAG_QUALITY = "IED1/XCBR1.Pos.q";
const TAG_CURRENT = "IED1/MMXU1.A.phsA.cVal.mag.f";

const replaySubscription: GooseSubscriptionConfig = {
  gocbRef: REPLAY_GOCB_REF,
  appId: REPLAY_APP_ID,
  expectedDestMac: REPLAY_DEST_MAC,
  expectedSrcMac: REPLAY_SRC_MAC,
  expectedConfRev: REPLAY_CONF_REV,
  dataset: [
    { tagName: TAG_POSITION, type: "boolean" },
    { tagName: TAG_QUALITY, type: "quality", isQuality: true },
    { tagName: TAG_CURRENT, type: "float" },
  ],
};

function rejected(reason: GooseRejectReason): number {
  return gooseFramesRejectedTotal.get({ reason });
}

function received(appId: number): number {
  return gooseFramesReceivedTotal.get({ app_id: `0x${appId.toString(16)}` });
}

function roundTrip(gocbRef: string): { sum: number; count: number } {
  const entry = gooseRoundTripUs.collect().find((e) => e.labels.gocb_ref === gocbRef);
  return entry ? { sum: entry.sum, count: entry.count } : { sum: 0, count: 0 };
}

/** Replay the committed capture with no delay and collect the tag updates. */
async function replayFixture(): Promise<{
  updates: GooseTagUpdate[];
  subscriber: GooseSubscriber;
  backend: GoosePcapReplayBackend;
}> {
  const updates: GooseTagUpdate[] = [];
  const backend = new GoosePcapReplayBackend({ path: REPLAY_PCAP_PATH, realtime: false });
  const subscriber = new GooseSubscriber({
    backend,
    subscriptions: [replaySubscription],
    onTagUpdate: (u) => updates.push(u),
  });
  const state = await subscriber.start();
  expect(state).toBe("running");
  await backend.completion();
  await subscriber.stop();
  return { updates, subscriber, backend };
}

describe("committed replay fixture", () => {
  it("is byte-for-byte what the generator produces from the scenario source", async () => {
    const onDisk = await readFile(REPLAY_PCAP_PATH);
    expect(onDisk.equals(encodeReplayPcap())).toBe(true);
  });

  it("is an Ethernet capture holding 8 GOOSE frames plus one non-GOOSE frame", async () => {
    const file = parsePcap(await readFile(REPLAY_PCAP_PATH));
    expect(file.header.linkType).toBe(1);
    expect(file.packets).toHaveLength(buildReplayScenario().length);
    expect(file.packets.filter((p) => isGooseFrame(p.data))).toHaveLength(8);
    expect(file.packets.filter((p) => !isGooseFrame(p.data))).toHaveLength(1);
  });

  it("preserves the recorded inter-frame timing", async () => {
    const file = parsePcap(await readFile(REPLAY_PCAP_PATH));
    const offsets = file.packets.map((p) => p.timestampMs - REPLAY_START_MS);
    expect(offsets).toEqual([0, 80, 160, 200, 260, 300, 340, 400, 440]);
  });
});

describe("pcap replay → subscriber", () => {
  it("decodes the expected dataset from every accepted frame", async () => {
    const { updates } = await replayFixture();

    // 6 accepted frames x 3 dataset members. The stale re-injected frame and
    // the foreign control block are rejected and emit nothing.
    expect(updates).toHaveLength(18);
    expect(updates.every((u) => u.origin === "goose")).toBe(true);
    expect(updates.every((u) => u.gocbRef === REPLAY_GOCB_REF)).toBe(true);
    expect(new Set(updates.map((u) => u.tagName))).toEqual(
      new Set([TAG_POSITION, TAG_QUALITY, TAG_CURRENT]),
    );
  });

  it("surfaces the breaker state change and the analogue value", async () => {
    const { updates } = await replayFixture();
    const positions = updates.filter((u) => u.tagName === TAG_POSITION);
    const currents = updates.filter((u) => u.tagName === TAG_CURRENT);

    expect(positions.map((u) => u.value)).toEqual([false, false, true, true, false, true]);
    expect(positions.map((u) => u.stNum)).toEqual([1, 1, 2, 3, 4, 5]);
    expect(currents.map((u) => u.value)).toEqual([41, 41, 42.5, 42.5, 0, 43.25]);
  });

  it("surfaces the quality-bit change as a tag update", async () => {
    const { updates } = await replayFixture();
    const quality = updates.filter((u) => u.tagName === TAG_QUALITY);

    // stNum 3 is the frame whose Quality degrades to invalid+failure.
    expect(quality.map((u) => u.quality)).toEqual([
      "good",
      "good",
      "good",
      "bad",
      "good",
      "good",
    ]);
    expect(quality.map((u) => u.value)).toEqual([
      "good",
      "good",
      "good",
      "invalid",
      "good",
      "good",
    ]);
  });

  it("flags the simulated frame and only that frame", async () => {
    const { updates } = await replayFixture();
    const simulated = updates.filter((u) => u.simulated);
    expect(simulated).toHaveLength(3); // the three members of the stNum=4 frame
    expect(simulated.every((u) => u.stNum === 4)).toBe(true);
  });

  it("never emits updates for the stale re-injected frame (stNum regression)", async () => {
    const before = rejected("stnum_regression");
    const { updates } = await replayFixture();
    expect(rejected("stnum_regression") - before).toBe(1);
    // stNum 2 appears exactly once — from the genuine state change, not the replay.
    expect(updates.filter((u) => u.tagName === TAG_POSITION && u.stNum === 2)).toHaveLength(1);
  });

  it("rejects the foreign control block instead of matching it", async () => {
    const before = rejected("no_subscription");
    await replayFixture();
    expect(rejected("no_subscription") - before).toBe(1);
  });

  it("counts every GOOSE frame received and never parses the non-GOOSE frame", async () => {
    const beforeSubscribed = received(REPLAY_APP_ID);
    const beforeForeign = received(0x3002);
    const beforeParseError = rejected("parse_error");

    const { backend } = await replayFixture();

    // 7 frames on the subscribed APPID + 1 on the foreign APPID = 8 parsed.
    expect(received(REPLAY_APP_ID) - beforeSubscribed).toBe(7);
    expect(received(0x3002) - beforeForeign).toBe(1);
    // The ARP frame is filtered by the backend, so it never reaches the parser.
    expect(rejected("parse_error") - beforeParseError).toBe(0);

    const stats = backend.getStats();
    expect(stats.packetsInFile).toBe(9);
    expect(stats.gooseFrames).toBe(8);
    expect(stats.nonGooseFrames).toBe(1);
    expect(stats.delivered).toBe(8);
    expect(stats.captureSpanMs).toBe(440);
  });

  it("observes a round-trip latency inside the sub-4 ms GOOSE budget", async () => {
    const before = roundTrip(REPLAY_GOCB_REF);
    await replayFixture();
    const after = roundTrip(REPLAY_GOCB_REF);

    const count = after.count - before.count;
    const sum = after.sum - before.sum;
    expect(count).toBe(6);
    // Every frame in the capture was published 2 ms before it was captured.
    expect(sum / count).toBeCloseTo(REPLAY_PUBLISH_LATENCY_MS * 1000, 0);
    expect(sum / count).toBeLessThan(4000);
  });
});

describe("pcap replay — timing", () => {
  const GAP_MS = 150;
  const WALL_START_MS = 10_000;

  /** Two GOOSE frames GAP_MS apart in recorded capture time. */
  function twoFrameCapture(): Buffer {
    const frame = (timestampMs: number, stNum: number): Buffer =>
      buildFrame(
        buildPdu({
          gocbRef: REPLAY_GOCB_REF,
          timeAllowedToLive: 2000,
          datSet: "ds",
          stNum,
          sqNum: 0,
          confRev: REPLAY_CONF_REV,
          t: timestampMs - REPLAY_PUBLISH_LATENCY_MS,
          allData: [data.boolean(true), data.quality(), data.float32(1)],
        }),
        { destMac: REPLAY_DEST_MAC, srcMac: REPLAY_SRC_MAC, appId: REPLAY_APP_ID },
      );
    return encodePcap([
      { timestampMs: REPLAY_START_MS, data: frame(REPLAY_START_MS, 1) },
      { timestampMs: REPLAY_START_MS + GAP_MS, data: frame(REPLAY_START_MS + GAP_MS, 2) },
    ]);
  }

  it("schedules frames at their recorded offsets from replay start", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(WALL_START_MS);
    const backend = new GoosePcapReplayBackend({
      buffer: twoFrameCapture(),
      realtime: true,
      speed: 1,
    });
    const arrivals: number[] = [];

    try {
      await backend.open(() => arrivals.push(Date.now()));
      expect(arrivals).toEqual([]);

      // Realtime scheduling targets each recorded offset from replay start. A
      // callback-to-callback wall-clock measurement is not equivalent: if the
      // first zero-delay timer is starved, the replay deliberately catches up.
      await vi.advanceTimersToNextTimerAsync();
      expect(arrivals).toEqual([WALL_START_MS]);

      await vi.advanceTimersByTimeAsync(GAP_MS - 1);
      expect(arrivals).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(arrivals).toEqual([WALL_START_MS, WALL_START_MS + GAP_MS]);
      await expect(backend.completion()).resolves.toMatchObject({ delivered: 2 });
    } finally {
      await backend.close();
      vi.useRealTimers();
    }
  });

  it("scales the recorded offset by the speed multiplier", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(WALL_START_MS);
    const speed = 5;
    const scaledGapMs = GAP_MS / speed;
    const backend = new GoosePcapReplayBackend({
      buffer: twoFrameCapture(),
      realtime: true,
      speed,
    });
    const arrivals: number[] = [];

    try {
      await backend.open(() => arrivals.push(Date.now()));
      await vi.advanceTimersToNextTimerAsync();
      expect(arrivals).toEqual([WALL_START_MS]);

      await vi.advanceTimersByTimeAsync(scaledGapMs - 1);
      expect(arrivals).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(arrivals).toEqual([WALL_START_MS, WALL_START_MS + scaledGapMs]);
      await expect(backend.completion()).resolves.toMatchObject({ delivered: 2 });
    } finally {
      await backend.close();
      vi.useRealTimers();
    }
  });

  it("drains the whole capture before open() resolves in no-delay mode", async () => {
    const backend = new GoosePcapReplayBackend({
      buffer: encodeReplayPcap(),
      realtime: false,
    });
    const delivered: Buffer[] = [];

    await backend.open((frame) => delivered.push(frame));
    // No-delay mode has no timer chain: every GOOSE frame is delivered
    // synchronously inside open(), before its promise resolves.
    expect(delivered).toHaveLength(8);
    expect(backend.getStats().delivered).toBe(8);
    await expect(backend.completion()).resolves.toMatchObject({ delivered: 8 });
    await backend.close();
  });
});

describe("pcap replay — TTL countdown on replayed frames", () => {
  function frameAt(timestampMs: number, stNum: number, ttlMs: number): Buffer {
    return buildFrame(
      buildPdu({
        gocbRef: REPLAY_GOCB_REF,
        timeAllowedToLive: ttlMs,
        datSet: "ds",
        stNum,
        sqNum: 0,
        confRev: REPLAY_CONF_REV,
        t: timestampMs - REPLAY_PUBLISH_LATENCY_MS,
        allData: [data.boolean(true), data.quality(), data.float32(1)],
      }),
      { destMac: REPLAY_DEST_MAC, srcMac: REPLAY_SRC_MAC, appId: REPLAY_APP_ID },
    );
  }

  it("records a TTL gap when the publisher misses its retransmission window", async () => {
    // TTL 1000 ms, but the next frame is 3000 ms later in the capture.
    const capture = encodePcap([
      { timestampMs: REPLAY_START_MS, data: frameAt(REPLAY_START_MS, 1, 1000) },
      { timestampMs: REPLAY_START_MS + 3000, data: frameAt(REPLAY_START_MS + 3000, 2, 1000) },
    ]);

    const before = rejected("ttl_expired");
    const backend = new GoosePcapReplayBackend({ buffer: capture, realtime: false });
    const subscriber = new GooseSubscriber({
      backend,
      subscriptions: [replaySubscription],
      onTagUpdate: () => {},
    });
    await subscriber.start();
    await backend.completion();
    await subscriber.stop();

    // The gap is judged in the capture's own time base, not against today's clock.
    expect(rejected("ttl_expired") - before).toBe(1);
  });

  it("expires a subscription from the watchdog sweep once TTL elapses", async () => {
    const capture = encodePcap([
      { timestampMs: REPLAY_START_MS, data: frameAt(REPLAY_START_MS, 1, 1000) },
    ]);
    const backend = new GoosePcapReplayBackend({ buffer: capture, realtime: false });
    const subscriber = new GooseSubscriber({
      backend,
      subscriptions: [replaySubscription],
      onTagUpdate: () => {},
    });
    await subscriber.start();
    await backend.completion();

    const before = rejected("ttl_expired");
    // Not yet expired: the frame armed an expiry at capture time + 1000 ms.
    expect(subscriber.sweepStaleSubscriptions(REPLAY_START_MS + 500)).toHaveLength(0);
    expect(rejected("ttl_expired") - before).toBe(0);

    expect(subscriber.sweepStaleSubscriptions(REPLAY_START_MS + 1500)).toHaveLength(1);
    expect(rejected("ttl_expired") - before).toBe(1);

    // The subscription was reset, so it is not re-counted on the next sweep.
    expect(subscriber.sweepStaleSubscriptions(REPLAY_START_MS + 9000)).toHaveLength(0);
    await subscriber.stop();
  });
});

describe("pcap replay backend — failure modes", () => {
  it("reports a missing capture file as unavailable rather than an error", async () => {
    const backend = new GoosePcapReplayBackend({ path: "does-not-exist.pcap" });
    expect(backend.availability().available).toBe(false);
    expect(backend.availability().reason).toMatch(/not found/i);

    const subscriber = new GooseSubscriber({ backend, subscriptions: [replaySubscription] });
    await expect(subscriber.start()).resolves.toBe("unavailable");
    await subscriber.stop();
  });

  it("transitions to 'error' when the capture is not an Ethernet link type", async () => {
    const capture = encodePcap([{ timestampMs: REPLAY_START_MS, data: Buffer.alloc(20) }], {
      linkType: 101, // LINKTYPE_RAW (IP, no link layer)
    });
    const backend = new GoosePcapReplayBackend({ buffer: capture });
    const subscriber = new GooseSubscriber({ backend, subscriptions: [replaySubscription] });
    await expect(subscriber.start()).resolves.toBe("error");
    // A capture that never loaded must still settle completion().
    await expect(backend.completion()).resolves.toMatchObject({ delivered: 0 });
    await subscriber.stop();
  });

  it("requires either a path or a buffer", () => {
    expect(() => new GoosePcapReplayBackend({})).toThrow(/path.*buffer/i);
  });

  it("rejects a non-positive replay speed", () => {
    expect(() => new GoosePcapReplayBackend({ buffer: Buffer.alloc(0), speed: 0 })).toThrow(
      /speed/i,
    );
  });

  it("refuses to be reopened", async () => {
    const capture = encodePcap([]);
    const backend = new GoosePcapReplayBackend({ buffer: capture, realtime: false });
    await backend.open(() => {});
    await expect(backend.open(() => {})).rejects.toThrow(/twice/i);
    await backend.close();
  });

  it("keeps replaying when the frame handler throws", async () => {
    const capture = await readFile(REPLAY_PCAP_PATH);
    const backend = new GoosePcapReplayBackend({ buffer: capture, realtime: false });
    await backend.open(() => {
      throw new Error("handler exploded");
    });
    const stats = await backend.completion();
    expect(stats.delivered).toBe(8);
    await backend.close();
  });
});

describe("default (null) capture backend", () => {
  it("start() reports 'unavailable' and does not throw", async () => {
    const subscriber = new GooseSubscriber({ subscriptions: [replaySubscription] });
    await expect(subscriber.start()).resolves.toBe("unavailable");
    expect(subscriber.getState()).toBe("unavailable");
    expect(subscriber.getBackendAvailability().available).toBe(false);
    await subscriber.stop();
    expect(subscriber.getState()).toBe("stopped");
  });

  it("explains what is missing, naming the interface it would have bound", () => {
    const backend = new NullGooseCaptureBackend({ iface: "eth3", platform: "linux", isRoot: true });
    const availability = backend.availability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toMatch(/native L2 capture binding/i);
    expect(availability.reason).toContain("eth3");
    expect(backend.getInterface()).toBe("eth3");
  });

  it("rejects open() with a typed error instead of pretending to run", async () => {
    const backend = new NullGooseCaptureBackend();
    await expect(backend.open()).rejects.toBeInstanceOf(GooseCaptureUnavailableError);
  });

  it("still decodes and validates frames handed to it directly", () => {
    const updates: GooseTagUpdate[] = [];
    const subscriber = new GooseSubscriber({
      subscriptions: [replaySubscription],
      onTagUpdate: (u) => updates.push(u),
    });
    const [first] = buildReplayScenario();
    expect(subscriber.handleFrame(first.data, first.timestampMs)).toHaveLength(3);
    expect(updates).toHaveLength(3);
  });

  it("names the host-specific reason live capture is impossible", () => {
    expect(detectRawSocketCapability("win32", false).reason).toMatch(/Linux/);
    expect(detectRawSocketCapability("linux", false).reason).toMatch(/CAP_NET_RAW/);
    expect(detectRawSocketCapability("linux", true).available).toBe(false);
  });
});
