/**
 * Tests for the Sparkplug B topic namespace builder/parser (pure logic).
 * Issue #463.
 */

import { describe, it, expect } from "vitest";
import {
  SPARKPLUG_B_NAMESPACE,
  buildNodeTopic,
  buildDeviceTopic,
  buildStateTopic,
  buildCommandSubscriptionFilters,
  parseTopic,
  parseStateTopic,
  isStateTopic,
} from "../topic";

const node = { groupId: "Plant-North", edgeNodeId: "edge-01" };
const device = { ...node, deviceId: "pump-42" };

describe("topic builders", () => {
  it("builds node-scoped topics", () => {
    expect(buildNodeTopic(node, "NBIRTH")).toBe("spBv1.0/Plant-North/NBIRTH/edge-01");
    expect(buildNodeTopic(node, "NDEATH")).toBe("spBv1.0/Plant-North/NDEATH/edge-01");
    expect(buildNodeTopic(node, "NDATA")).toBe("spBv1.0/Plant-North/NDATA/edge-01");
  });

  it("builds device-scoped topics", () => {
    expect(buildDeviceTopic(device, "DBIRTH")).toBe("spBv1.0/Plant-North/DBIRTH/edge-01/pump-42");
    expect(buildDeviceTopic(device, "DDATA")).toBe("spBv1.0/Plant-North/DDATA/edge-01/pump-42");
    expect(buildDeviceTopic(device, "DDEATH")).toBe("spBv1.0/Plant-North/DDEATH/edge-01/pump-42");
  });

  it("builds the host STATE topic", () => {
    expect(buildStateTopic("primary-host")).toBe("spBv1.0/STATE/primary-host");
  });

  it("rejects a device message type on the node builder", () => {
    expect(() => buildNodeTopic(node, "DDATA")).toThrow(/not a node-scoped/);
  });

  it("rejects a node message type on the device builder", () => {
    expect(() => buildDeviceTopic(device, "NBIRTH")).toThrow(/not a device-scoped/);
  });

  it("rejects illegal characters in segments", () => {
    expect(() => buildNodeTopic({ groupId: "a/b", edgeNodeId: "x" }, "NBIRTH")).toThrow(/illegal/);
    expect(() => buildNodeTopic({ groupId: "g", edgeNodeId: "x+y" }, "NBIRTH")).toThrow(/illegal/);
    expect(() => buildDeviceTopic({ ...node, deviceId: "a#b" }, "DDATA")).toThrow(/illegal/);
  });

  it("rejects empty segments", () => {
    expect(() => buildNodeTopic({ groupId: "", edgeNodeId: "x" }, "NBIRTH")).toThrow(/empty/);
  });

  it("uses the canonical namespace constant", () => {
    expect(SPARKPLUG_B_NAMESPACE).toBe("spBv1.0");
  });
});

describe("subscription filters", () => {
  it("includes NCMD, DCMD wildcard and STATE wildcard", () => {
    const filters = buildCommandSubscriptionFilters(node);
    expect(filters).toContain("spBv1.0/Plant-North/NCMD/edge-01");
    expect(filters).toContain("spBv1.0/Plant-North/DCMD/edge-01/+");
    expect(filters).toContain("spBv1.0/STATE/+");
  });
});

describe("parseTopic", () => {
  it("parses a node-scoped topic", () => {
    expect(parseTopic("spBv1.0/Plant-North/NBIRTH/edge-01")).toEqual({
      namespace: "spBv1.0",
      groupId: "Plant-North",
      messageType: "NBIRTH",
      edgeNodeId: "edge-01",
    });
  });

  it("parses a device-scoped topic", () => {
    expect(parseTopic("spBv1.0/Plant-North/DDATA/edge-01/pump-42")).toEqual({
      namespace: "spBv1.0",
      groupId: "Plant-North",
      messageType: "DDATA",
      edgeNodeId: "edge-01",
      deviceId: "pump-42",
    });
  });

  it("round-trips with the builders", () => {
    expect(parseTopic(buildNodeTopic(node, "NDATA"))).toMatchObject({ messageType: "NDATA" });
    expect(parseTopic(buildDeviceTopic(device, "DBIRTH"))).toMatchObject({
      messageType: "DBIRTH",
      deviceId: "pump-42",
    });
  });

  it("returns null for a wrong namespace", () => {
    expect(parseTopic("spAv1.0/g/NBIRTH/e")).toBeNull();
  });

  it("returns null when a device topic is missing the device id", () => {
    expect(parseTopic("spBv1.0/g/DDATA/edge")).toBeNull();
  });

  it("returns null when a node topic has an extra device id", () => {
    expect(parseTopic("spBv1.0/g/NBIRTH/edge/extra")).toBeNull();
  });

  it("returns null for an unknown message type", () => {
    expect(parseTopic("spBv1.0/g/FOO/edge")).toBeNull();
  });

  it("returns null for a STATE topic (handled separately)", () => {
    expect(parseTopic("spBv1.0/STATE/host")).toBeNull();
  });
});

describe("parseStateTopic", () => {
  it("parses a STATE topic", () => {
    expect(parseStateTopic("spBv1.0/STATE/primary-host")).toEqual({
      namespace: "spBv1.0",
      hostApplicationId: "primary-host",
    });
  });

  it("returns null for a non-STATE topic", () => {
    expect(parseStateTopic("spBv1.0/g/NBIRTH/e")).toBeNull();
  });

  it("isStateTopic detects STATE topics", () => {
    expect(isStateTopic("spBv1.0/STATE/host")).toBe(true);
    expect(isStateTopic("spBv1.0/g/NDATA/e")).toBe(false);
  });
});
