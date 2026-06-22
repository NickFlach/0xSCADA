/**
 * Unit tests for GOOSE subscription validation + the subscriber service.
 *
 * Covers: dataset-shape validation, stNum/sqNum monotonicity, TTL/staleness,
 * quality-bit propagation, simulated/test handling, MAC/APPID matching, and
 * tag-update emission with origin="goose".
 *
 * Issue: #465
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  GooseSubscription,
  qualityToTagQuality,
  type GooseSubscriptionConfig,
} from "../subscription.js";
import { GooseSubscriber, detectRawSocketCapability } from "../index.js";
import { parseGooseFrame } from "../frame-parser.js";
import type { GooseTagUpdate } from "../types.js";
import { canonicalFrame, data, buildPdu, buildFrame } from "./fixtures.js";

const baseConfig: GooseSubscriptionConfig = {
  gocbRef: "IED1LD0/LLN0$GO$gcb01",
  appId: 0x3001,
  expectedDestMac: "01:0c:cd:01:00:01",
  expectedSrcMac: "00:11:22:33:44:55",
  dataset: [
    { tagName: "IED1/GGIO1.Ind1.stVal", type: "boolean" },
    { tagName: "IED1/GGIO1.Ind1.q", type: "quality", isQuality: true },
    { tagName: "IED1/MMXU1.A.mag.f", type: "float" },
  ],
};

function frameOf(parsed = canonicalFrame()) {
  return parseGooseFrame(parsed);
}

describe("GooseSubscription — config validation", () => {
  it("parses a valid config", () => {
    const sub = new GooseSubscription(baseConfig);
    expect(sub.config.gocbRef).toBe(baseConfig.gocbRef);
    expect(sub.config.simulationPolicy).toBe("accept-flagged"); // default applied
  });

  it("rejects an out-of-range appId", () => {
    expect(() => new GooseSubscription({ ...baseConfig, appId: 0x9999 })).toThrow();
  });

  it("rejects a malformed MAC", () => {
    expect(() => new GooseSubscription({ ...baseConfig, expectedDestMac: "zz:zz" })).toThrow();
  });

  it("requires at least one dataset member", () => {
    expect(() => new GooseSubscription({ ...baseConfig, dataset: [] })).toThrow();
  });
});

describe("GooseSubscription — matching", () => {
  it("matches on gocbRef + appId", () => {
    const sub = new GooseSubscription(baseConfig);
    expect(sub.matches(frameOf())).toBe(true);
  });

  it("does not match a different gocbRef", () => {
    const sub = new GooseSubscription({ ...baseConfig, gocbRef: "OTHER" });
    expect(sub.matches(frameOf())).toBe(false);
  });
});

describe("GooseSubscription — acceptance + tag updates", () => {
  it("accepts a valid frame and emits one update per dataset member", () => {
    const sub = new GooseSubscription(baseConfig);
    const result = sub.validate(frameOf(), 1_700_000_000_010);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;

    expect(result.updates).toHaveLength(3);
    expect(result.stateChanged).toBe(true); // first frame
    for (const u of result.updates) {
      expect(u.origin).toBe("goose");
      expect(u.gocbRef).toBe(baseConfig.gocbRef);
      expect(u.stNum).toBe(1);
    }
    const byName = Object.fromEntries(result.updates.map((u: GooseTagUpdate) => [u.tagName, u]));
    expect(byName["IED1/GGIO1.Ind1.stVal"].value).toBe(true);
    expect(byName["IED1/MMXU1.A.mag.f"].value).toBeCloseTo(42.5);
    expect(byName["IED1/GGIO1.Ind1.q"].value).toBe("good");
    expect(byName["IED1/GGIO1.Ind1.q"].quality).toBe("good");
  });

  it("computes a positive round-trip latency in microseconds", () => {
    const sub = new GooseSubscription(baseConfig);
    // canonical t = 1_700_000_000_000; receive 2ms later => 2000us
    const result = sub.validate(frameOf(), 1_700_000_000_002);
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.roundTripUs).toBeGreaterThanOrEqual(1000);
      expect(result.roundTripUs).toBeLessThanOrEqual(3000);
    }
  });
});

describe("GooseSubscription — dataset shape validation", () => {
  it("rejects a frame with the wrong member count", () => {
    const sub = new GooseSubscription(baseConfig);
    const pdu = buildPdu({
      gocbRef: baseConfig.gocbRef,
      timeAllowedToLive: 2000,
      datSet: "ds",
      stNum: 1,
      sqNum: 0,
      allData: [data.boolean(true)], // only 1 member, expected 3
    });
    const result = sub.validate(parseGooseFrame(buildFrame(pdu, { appId: 0x3001 })), 1);
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toBe("dataset_shape");
  });

  it("rejects a frame with a wrong member type", () => {
    const sub = new GooseSubscription(baseConfig);
    const pdu = buildPdu({
      gocbRef: baseConfig.gocbRef,
      timeAllowedToLive: 2000,
      datSet: "ds",
      stNum: 1,
      sqNum: 0,
      // member 0 should be boolean; send a float
      allData: [data.float32(1), data.quality(), data.float32(2)],
    });
    const result = sub.validate(parseGooseFrame(buildFrame(pdu, { appId: 0x3001 })), 1);
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toBe("dataset_shape");
  });
});

describe("GooseSubscription — stNum/sqNum monotonicity", () => {
  let sub: GooseSubscription;
  beforeEach(() => {
    sub = new GooseSubscription(baseConfig);
  });

  it("accepts increasing sqNum within the same stNum (retransmission)", () => {
    expect(sub.validate(frameOf(canonicalFrame({ stNum: 5, sqNum: 0 })), 100).accepted).toBe(true);
    const r = sub.validate(frameOf(canonicalFrame({ stNum: 5, sqNum: 1 })), 200);
    expect(r.accepted).toBe(true);
    if (r.accepted) expect(r.stateChanged).toBe(false); // same state, just retransmit
  });

  it("flags a state change when stNum increments", () => {
    sub.validate(frameOf(canonicalFrame({ stNum: 5, sqNum: 3 })), 100);
    const r = sub.validate(frameOf(canonicalFrame({ stNum: 6, sqNum: 0 })), 200);
    expect(r.accepted).toBe(true);
    if (r.accepted) expect(r.stateChanged).toBe(true);
  });

  it("rejects a regressing stNum", () => {
    sub.validate(frameOf(canonicalFrame({ stNum: 10, sqNum: 0 })), 100);
    const r = sub.validate(frameOf(canonicalFrame({ stNum: 9, sqNum: 0 })), 200);
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe("stnum_regression");
  });

  it("rejects a non-increasing sqNum within the same stNum", () => {
    sub.validate(frameOf(canonicalFrame({ stNum: 5, sqNum: 4 })), 100);
    const r = sub.validate(frameOf(canonicalFrame({ stNum: 5, sqNum: 4 })), 200);
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe("sqnum_regression");
  });
});

describe("GooseSubscription — TTL / staleness", () => {
  it("reports staleness once timeAllowedToLive elapses", () => {
    const sub = new GooseSubscription(baseConfig);
    // TTL 2000ms, received at t=1000 => expires at 3000
    sub.validate(frameOf(canonicalFrame({ timeAllowedToLive: 2000 })), 1000);
    expect(sub.isStale(2500)).toBe(false);
    expect(sub.isStale(3500)).toBe(true);
  });

  it("clears state on reset", () => {
    const sub = new GooseSubscription(baseConfig);
    sub.validate(frameOf(canonicalFrame({ timeAllowedToLive: 2000 })), 1000);
    sub.reset();
    expect(sub.isStale(10_000)).toBe(false);
  });

  it("marks wasStale when a frame arrives after the prior TTL elapsed", () => {
    const sub = new GooseSubscription(baseConfig);
    // first frame: TTL 1000ms, received at t=1000 => expires at 2000
    const first = sub.validate(frameOf(canonicalFrame({ stNum: 1, sqNum: 0, timeAllowedToLive: 1000 })), 1000);
    expect(first.accepted).toBe(true);
    if (first.accepted) expect(first.wasStale).toBe(false);

    // next frame arrives at t=5000, well past 2000 => stale gap
    const second = sub.validate(frameOf(canonicalFrame({ stNum: 1, sqNum: 1, timeAllowedToLive: 1000 })), 5000);
    expect(second.accepted).toBe(true);
    if (second.accepted) expect(second.wasStale).toBe(true);
  });
});

describe("GooseSubscription — quality bits", () => {
  it("propagates 'bad' tag quality for invalid validity", () => {
    const sub = new GooseSubscription(baseConfig);
    const frame = canonicalFrame({
      allData: [data.boolean(true), data.quality({ validity: "invalid", failure: true }), data.float32(1)],
    });
    const r = sub.validate(parseGooseFrame(frame), 100);
    expect(r.accepted).toBe(true);
    if (r.accepted) {
      const q = r.updates.find((u) => u.tagName === "IED1/GGIO1.Ind1.q")!;
      expect(q.quality).toBe("bad");
      expect(q.value).toBe("invalid");
    }
  });

  it("maps questionable validity to 'uncertain'", () => {
    expect(
      qualityToTagQuality({
        validity: "questionable",
        overflow: false,
        outOfRange: false,
        badReference: false,
        oscillatory: false,
        failure: false,
        oldData: false,
        inconsistent: false,
        inaccurate: false,
        source: "process",
        test: false,
        operatorBlocked: false,
      }),
    ).toBe("uncertain");
  });
});

describe("GooseSubscription — simulated / test bit", () => {
  it("rejects simulated frames when policy=reject", () => {
    const sub = new GooseSubscription({ ...baseConfig, simulationPolicy: "reject" });
    const r = sub.validate(frameOf(canonicalFrame({ simulation: true })), 100);
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe("simulation");
  });

  it("flags simulated frames when policy=accept-flagged", () => {
    const sub = new GooseSubscription({ ...baseConfig, simulationPolicy: "accept-flagged" });
    const r = sub.validate(frameOf(canonicalFrame({ simulation: true })), 100);
    expect(r.accepted).toBe(true);
    if (r.accepted) {
      expect(r.updates.every((u) => u.simulated === true)).toBe(true);
    }
  });
});

describe("GooseSubscription — MAC / confRev / ndsCom", () => {
  it("rejects a source MAC mismatch", () => {
    const sub = new GooseSubscription(baseConfig);
    const frame = canonicalFrame({}, { srcMac: "aa:bb:cc:dd:ee:ff" });
    const r = sub.validate(parseGooseFrame(frame), 100);
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe("mac_mismatch");
  });

  it("rejects a confRev mismatch when expectedConfRev is set", () => {
    const sub = new GooseSubscription({ ...baseConfig, expectedConfRev: 2 });
    const r = sub.validate(frameOf(canonicalFrame({ confRev: 1 })), 100);
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe("conf_rev_mismatch");
  });

  it("rejects frames flagged needsCommissioning", () => {
    const sub = new GooseSubscription(baseConfig);
    const r = sub.validate(frameOf(canonicalFrame({ ndsCom: true })), 100);
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe("nds_com");
  });
});

describe("GooseSubscriber — service", () => {
  it("never opens a raw socket on a non-Linux host (capability disabled)", () => {
    const cap = detectRawSocketCapability("win32", false);
    expect(cap.available).toBe(false);
    expect(cap.reason).toMatch(/Linux/);
  });

  it("reports the native-binding gap even on linux+root", () => {
    const cap = detectRawSocketCapability("linux", true);
    expect(cap.available).toBe(false);
    expect(cap.reason).toMatch(/native/i);
  });

  it("start() transitions to 'disabled' instead of throwing", () => {
    const sub = new GooseSubscriber({ iface: "eth0", subscriptions: [baseConfig] });
    const state = sub.start();
    expect(state).toBe("disabled");
    sub.stop();
  });

  it("decodes + validates a frame via handleFrame and invokes the sink", () => {
    const received: GooseTagUpdate[] = [];
    const sub = new GooseSubscriber({
      subscriptions: [baseConfig],
      onTagUpdate: (u) => received.push(u),
      now: () => 1_700_000_000_010,
    });
    const updates = sub.handleFrame(canonicalFrame());
    expect(updates).toHaveLength(3);
    expect(received).toHaveLength(3);
    expect(received.every((u) => u.origin === "goose")).toBe(true);
  });

  it("handleFrame returns [] for a frame with no matching subscription", () => {
    const sub = new GooseSubscriber({ subscriptions: [{ ...baseConfig, appId: 0x0001 }] });
    expect(sub.handleFrame(canonicalFrame())).toHaveLength(0);
  });

  it("handleFrame returns [] (no throw) for garbage bytes", () => {
    const sub = new GooseSubscriber({ subscriptions: [baseConfig] });
    expect(sub.handleFrame(Buffer.from([0x00, 0x01, 0x02]))).toHaveLength(0);
  });
});
