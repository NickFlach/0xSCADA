/**
 * Tests for the Sparkplug B edge-node lifecycle state machine.
 *
 * Covers the acceptance criteria that are pure/testable here:
 *  - NBIRTH on connect with seq 0 and full metric definitions + bdSeq;
 *  - bdSeq increments per session and matches the Will/NDEATH;
 *  - DBIRTH on first publish, DDATA for updates, DDEATH on offline;
 *  - host STATE OFFLINE quiesces DATA publishing;
 *  - seq increments mod 256 across the session and resets on rebirth.
 *
 * Issue #463.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  EdgeNodeLifecycle,
  bdSeqMetric,
  rebirthControlMetric,
  NODE_CONTROL_REBIRTH,
  type DeviceDefinition,
} from "../lifecycle";
import { SparkplugDataType, type SparkplugMetric } from "../types";

const NODE = { groupId: "Plant-North", edgeNodeId: "edge-01" };

const NODE_METRICS: SparkplugMetric[] = [
  { name: "Node/Uptime", dataType: SparkplugDataType.Int64, value: 0 },
  { name: "Node/Firmware", dataType: SparkplugDataType.String, value: "1.0.0" },
];

const PUMP: DeviceDefinition = {
  deviceId: "pump-42",
  metrics: [
    { name: "FlowRate", dataType: SparkplugDataType.Double, value: 0 },
    { name: "Running", dataType: SparkplugDataType.Boolean, value: false },
  ],
};

/** Lifecycle with a fixed clock for deterministic timestamps. */
class FixedClockLifecycle extends EdgeNodeLifecycle {
  protected now(): number {
    return 1_700_000_000_000;
  }
}

function newLifecycle(): FixedClockLifecycle {
  return new FixedClockLifecycle(NODE, NODE_METRICS);
}

describe("session + bdSeq", () => {
  it("starts offline with bdSeq 0", () => {
    const lc = newLifecycle();
    expect(lc.getNodeState()).toBe("offline");
    expect(lc.getBdSeq()).toBe(0);
  });

  it("beginSession increments bdSeq and resets seq", () => {
    const lc = newLifecycle();
    expect(lc.beginSession()).toBe(1);
    expect(lc.getBdSeq()).toBe(1);
    expect(lc.getSeq()).toBe(0);
    expect(lc.getNodeState()).toBe("connecting");
  });

  it("the Will/NDEATH carries the session bdSeq", () => {
    const lc = newLifecycle();
    const bdSeq = lc.beginSession();
    const will = lc.buildWillPayload(bdSeq);
    expect(lc.buildWillTopic()).toBe("spBv1.0/Plant-North/NDEATH/edge-01");
    expect(will.metrics).toEqual([bdSeqMetric(1)]);
  });

  it("bdSeq rolls over at 256", () => {
    const lc = newLifecycle();
    for (let i = 0; i < 255; i++) lc.beginSession();
    expect(lc.getBdSeq()).toBe(255);
    expect(lc.beginSession()).toBe(0);
  });
});

describe("NBIRTH", () => {
  let lc: FixedClockLifecycle;
  beforeEach(() => {
    lc = newLifecycle();
    lc.beginSession();
  });

  it("publishes NBIRTH with seq 0, bdSeq, rebirth control, and all node metrics", () => {
    const msg = lc.onConnect();
    expect(msg.messageType).toBe("NBIRTH");
    expect(msg.topic).toBe("spBv1.0/Plant-North/NBIRTH/edge-01");
    expect(msg.qos).toBe(1);
    expect(msg.retain).toBe(false);
    expect(msg.payload.seq).toBe(0);

    const names = msg.payload.metrics.map((m) => m.name);
    expect(names).toContain("bdSeq");
    expect(names).toContain(NODE_CONTROL_REBIRTH);
    expect(names).toContain("Node/Uptime");
    expect(names).toContain("Node/Firmware");
    // bdSeq metric carries session bdSeq value 1
    expect(msg.payload.metrics.find((m) => m.name === "bdSeq")?.value).toBe(1);
  });

  it("keeps the node connecting until NBIRTH is confirmed", () => {
    lc.onConnect();
    expect(lc.getNodeState()).toBe("connecting");
    expect(lc.canPublishData()).toBe(false);
    expect(lc.confirmNodeBirth()).toBe(true);
    expect(lc.getNodeState()).toBe("online");
  });

  it("cannot confirm a failed or disconnected NBIRTH", () => {
    lc.onConnect();
    lc.failNodeBirth();
    expect(lc.confirmNodeBirth()).toBe(false);
    expect(lc.getNodeState()).toBe("offline");
  });

  it("seq advances after NBIRTH (next message is seq 1)", () => {
    lc.onConnect();
    expect(lc.getSeq()).toBe(1);
  });
});

describe("device lifecycle DBIRTH / DDATA / DDEATH", () => {
  let lc: FixedClockLifecycle;
  beforeEach(() => {
    lc = newLifecycle();
    lc.beginSession();
    lc.onConnect();
    lc.confirmNodeBirth();
  });

  it("DBIRTH announces the device with its full metric set", () => {
    const msg = lc.birthDevice(PUMP);
    expect(msg.messageType).toBe("DBIRTH");
    expect(msg.topic).toBe("spBv1.0/Plant-North/DBIRTH/edge-01/pump-42");
    expect(msg.qos).toBe(1);
    expect(msg.payload.seq).toBe(1); // follows NBIRTH(seq 0)
    expect(msg.payload.metrics.map((m) => m.name)).toEqual(["FlowRate", "Running"]);
    expect(lc.getDeviceState("pump-42")).toBe("offline");
    expect(lc.confirmDeviceBirth("pump-42")).toBe(true);
    expect(lc.getDeviceState("pump-42")).toBe("online");
  });

  it("rejects DBIRTH before NBIRTH", () => {
    const fresh = newLifecycle();
    fresh.beginSession();
    expect(() => fresh.birthDevice(PUMP)).toThrow(/before edge node NBIRTH/);
  });

  it("DDATA carries changed tags after DBIRTH", () => {
    lc.birthDevice(PUMP);
    lc.confirmDeviceBirth("pump-42");
    const changed: SparkplugMetric[] = [
      { name: "FlowRate", dataType: SparkplugDataType.Double, value: 12.5 },
    ];
    const msg = lc.publishDeviceData("pump-42", changed);
    expect(msg).not.toBeNull();
    expect(msg!.messageType).toBe("DDATA");
    expect(msg!.qos).toBe(0);
    expect(msg!.payload.seq).toBe(2);
    expect(msg!.payload.metrics).toEqual(changed);
  });

  it("DDATA before DBIRTH returns null", () => {
    expect(lc.publishDeviceData("pump-42", PUMP.metrics)).toBeNull();
  });

  it("commits DDEATH only after transport confirmation", () => {
    lc.birthDevice(PUMP);
    lc.confirmDeviceBirth("pump-42");
    const msg = lc.deathDevice("pump-42");
    expect(msg).not.toBeNull();
    expect(msg!.messageType).toBe("DDEATH");
    expect(msg!.qos).toBe(1);
    expect(lc.getDeviceState("pump-42")).toBe("online");
    expect(lc.publishDeviceData("pump-42", PUMP.metrics)).toBeNull();
    expect(lc.confirmDeviceDeath("pump-42", msg!.transitionId)).toBe(true);
    expect(lc.getDeviceState("pump-42")).toBe("offline");
  });

  it("DDEATH on an unknown/offline device returns null", () => {
    expect(lc.deathDevice("ghost")).toBeNull();
    lc.birthDevice(PUMP);
    lc.confirmDeviceBirth("pump-42");
    lc.deathDevice("pump-42");
    expect(lc.deathDevice("pump-42")).toBeNull();
  });

  it("failed DDEATH remains online and can be retried", () => {
    lc.birthDevice(PUMP);
    lc.confirmDeviceBirth("pump-42");
    const first = lc.deathDevice("pump-42")!;
    expect(lc.publishDeviceData("pump-42", PUMP.metrics)).toBeNull();
    lc.failDeviceDeath("pump-42", first.transitionId);
    expect(lc.getDeviceState("pump-42")).toBe("online");
    const retry = lc.deathDevice("pump-42");
    expect(retry).not.toBeNull();
    expect(retry!.transitionId).not.toBe(first.transitionId);
  });

  it("ignores stale DBIRTH transition callbacks", () => {
    const first = lc.birthDevice(PUMP);
    const second = lc.birthDevice(PUMP);
    expect(lc.confirmDeviceBirth("pump-42", first.transitionId)).toBe(false);
    expect(lc.getDeviceState("pump-42")).toBe("offline");
    expect(lc.confirmDeviceBirth("pump-42", second.transitionId)).toBe(true);
    expect(lc.getDeviceState("pump-42")).toBe("online");
  });

  it("does not let an older DDATA failure erase a newer device transition", () => {
    const initialBirth = lc.birthDevice(PUMP);
    lc.confirmDeviceBirth("pump-42", initialBirth.transitionId);
    expect(lc.publishDeviceData("pump-42", PUMP.metrics)).not.toBeNull();

    const replacementBirth = lc.birthDevice(PUMP);
    lc.failDeviceBirth("pump-42"); // deferred failure from the older DDATA
    expect(
      lc.confirmDeviceBirth("pump-42", replacementBirth.transitionId),
    ).toBe(true);
  });
});

describe("seq increments and rolls over mod 256", () => {
  it("advances by one per message", () => {
    const lc = newLifecycle();
    lc.beginSession();
    lc.onConnect(); // seq 0
    lc.confirmNodeBirth();
    lc.birthDevice(PUMP); // seq 1
    lc.confirmDeviceBirth("pump-42");
    expect(lc.getSeq()).toBe(2);
    lc.publishDeviceData("pump-42", PUMP.metrics); // seq 2
    expect(lc.getSeq()).toBe(3);
  });

  it("wraps after 255 back to 0", () => {
    const lc = newLifecycle();
    lc.beginSession();
    lc.onConnect(); // consumes seq 0, seq now 1
    lc.confirmNodeBirth();
    // Emit 255 more node-data messages to push seq through the rollover.
    for (let i = 0; i < 255; i++) {
      lc.publishNodeData([{ name: "Node/Uptime", dataType: SparkplugDataType.Int64, value: i }]);
    }
    expect(lc.getSeq()).toBe(0);
  });
});

describe("in-session rebirth (§7.6)", () => {
  it("resetSeq restarts seq at 0 without bumping bdSeq", () => {
    const lc = newLifecycle();
    lc.beginSession(); // bdSeq -> 1
    lc.onConnect(); // seq 0 consumed, seq now 1
    lc.confirmNodeBirth();
    lc.publishNodeData([{ name: "Node/Uptime", dataType: SparkplugDataType.Int64, value: 5 }]); // seq 1
    expect(lc.getSeq()).toBe(2);
    const bdSeqBefore = lc.getBdSeq();

    lc.resetSeq();
    expect(lc.getSeq()).toBe(0);
    expect(lc.getBdSeq()).toBe(bdSeqBefore); // bdSeq unchanged

    // The re-birth NBIRTH is seq 0 and carries the SAME bdSeq metric.
    const reBirth = lc.onConnect();
    expect(reBirth.payload.seq).toBe(0);
    expect(reBirth.payload.metrics.find((m) => m.name === "bdSeq")?.value).toBe(bdSeqBefore);
    expect(lc.getNodeState()).toBe("connecting");
  });
});

describe("host STATE gating (§10)", () => {
  let lc: FixedClockLifecycle;
  beforeEach(() => {
    lc = newLifecycle();
    lc.beginSession();
    lc.onConnect();
    lc.confirmNodeBirth();
    lc.birthDevice(PUMP);
    lc.confirmDeviceBirth("pump-42");
  });

  it("allows DATA when host unknown or online", () => {
    expect(lc.canPublishData()).toBe(true);
    lc.onHostState(true);
    expect(lc.canPublishData()).toBe(true);
    expect(lc.publishNodeData([{ name: "Node/Uptime", dataType: SparkplugDataType.Int64, value: 1 }])).not.toBeNull();
  });

  it("quiesces DATA when the primary host goes OFFLINE", () => {
    const r = lc.onHostState(false);
    expect(r.dataAllowedChanged).toBe(true);
    expect(lc.getHostState()).toBe("offline");
    expect(lc.canPublishData()).toBe(false);
    expect(lc.publishDeviceData("pump-42", PUMP.metrics)).toBeNull();
    expect(lc.publishNodeData([{ name: "Node/Uptime", dataType: SparkplugDataType.Int64, value: 1 }])).toBeNull();
  });

  it("resumes DATA when the host returns ONLINE", () => {
    lc.onHostState(false);
    const r = lc.onHostState(true);
    expect(r.dataAllowedChanged).toBe(true);
    expect(lc.canPublishData()).toBe(true);
  });
});

describe("disconnect", () => {
  it("marks node and devices offline", () => {
    const lc = newLifecycle();
    lc.beginSession();
    lc.onConnect();
    lc.confirmNodeBirth();
    lc.birthDevice(PUMP);
    lc.confirmDeviceBirth("pump-42");
    lc.onDisconnect();
    expect(lc.getNodeState()).toBe("offline");
    expect(lc.getDeviceState("pump-42")).toBe("offline");
  });

  it("DATA is disallowed once offline", () => {
    const lc = newLifecycle();
    lc.beginSession();
    lc.onConnect();
    lc.confirmNodeBirth();
    lc.onDisconnect();
    expect(lc.canPublishData()).toBe(false);
  });
});

describe("standard control metrics", () => {
  it("bdSeqMetric is an Int64 named bdSeq", () => {
    expect(bdSeqMetric(3)).toEqual({ name: "bdSeq", dataType: SparkplugDataType.Int64, value: 3 });
  });

  it("rebirthControlMetric is a Boolean false control point", () => {
    expect(rebirthControlMetric()).toEqual({
      name: NODE_CONTROL_REBIRTH,
      dataType: SparkplugDataType.Boolean,
      value: false,
    });
  });
});
