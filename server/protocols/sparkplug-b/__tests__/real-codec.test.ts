/**
 * Integration coverage for the installed `sparkplug-payload` codec.
 *
 * Keep this separate from the injected JSON-codec unit tests: the package's
 * public metric shape is part of our runtime contract, and a mock cannot catch
 * drift such as `type` versus `dataType`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SparkplugBridge,
  type MqttConnectOptions,
  type MqttLike,
} from "../index";
import {
  decodePayload,
  encodePayload,
  isCodecAvailable,
  setCodec,
} from "../payload";
import {
  SparkplugConfigSchema,
  SparkplugDataType,
  type SparkplugPayload,
} from "../types";

class InertMqttClient implements MqttLike {
  on(): void {}
  subscribe(): void {}
  publish(): void {}
  end(): void {}
}

describe("installed sparkplug-payload codec", () => {
  beforeEach(() => setCodec(null));
  afterEach(() => setCodec(null));

  it("prepares a real NDEATH Will without crashing bridge startup", () => {
    let connectOptions: MqttConnectOptions | undefined;
    const connect = vi.fn((_url: string, options: MqttConnectOptions): MqttLike => {
      connectOptions = options;
      return new InertMqttClient();
    });
    const config = SparkplugConfigSchema.parse({
      brokerUrl: "mqtt://localhost:1883",
      groupId: "Plant-North",
      edgeNodeId: "edge-01",
      enabled: true,
    });

    expect(isCodecAvailable()).toBe(true);
    const bridge = new SparkplugBridge(config, [], connect);
    expect(() => bridge.start()).not.toThrow();
    expect(connect).toHaveBeenCalledOnce();

    const decodedWill = decodePayload(connectOptions!.will.payload);
    expect(decodedWill.metrics).toEqual([
      expect.objectContaining({
        name: "bdSeq",
        dataType: SparkplugDataType.Int64,
        value: 1,
      }),
    ]);
  });

  it("round-trips signed and unsigned 64-bit boundary values exactly", () => {
    const payload: SparkplugPayload = {
      timestamp: 1_740_000_000_000,
      seq: 255,
      metrics: [
        {
          name: "signed-min",
          alias: 7,
          timestamp: 1_740_000_000_001,
          dataType: SparkplugDataType.Int64,
          value: -9_223_372_036_854_775_808n,
        },
        {
          name: "unsigned-max",
          dataType: SparkplugDataType.UInt64,
          value: 18_446_744_073_709_551_615n,
        },
        {
          name: "datetime-max",
          dataType: SparkplugDataType.DateTime,
          value: 18_446_744_073_709_551_615n,
        },
      ],
    };

    const decoded = decodePayload(encodePayload(payload));
    expect(decoded.timestamp).toBe(payload.timestamp);
    expect(decoded.seq).toBe(255);
    expect(decoded.metrics[0]).toMatchObject({
      alias: 7,
      timestamp: 1_740_000_000_001,
      dataType: SparkplugDataType.Int64,
      value: -9_223_372_036_854_775_808n,
    });
    expect(decoded.metrics[1]).toMatchObject({
      dataType: SparkplugDataType.UInt64,
      value: 18_446_744_073_709_551_615n,
    });
    expect(decoded.metrics[2]).toMatchObject({
      dataType: SparkplugDataType.DateTime,
      value: 18_446_744_073_709_551_615n,
    });
  });

  it("round-trips JSON-compatible integer strings without overflow", () => {
    const decoded = decodePayload(encodePayload({
      timestamp: 1_740_000_000_000,
      metrics: [
        {
          name: "signed-max-string",
          dataType: SparkplugDataType.Int64,
          value: "9223372036854775807",
        },
        {
          name: "unsigned-max-string",
          dataType: SparkplugDataType.UInt64,
          value: "18446744073709551615",
        },
      ],
    }));

    expect(decoded.metrics.map((metric) => metric.value)).toEqual([
      9_223_372_036_854_775_807n,
      18_446_744_073_709_551_615n,
    ]);
  });

  it("round-trips UInt32 high-bit values with the audited protobufjs 8 graph", () => {
    // sparkplug-payload imports Long 4 while protobufjs 8 decodes with Long 5.
    // Its instanceof/toInt branch therefore does not run; our structural
    // low/high adapter must preserve the unsigned words exactly.
    const decoded = decodePayload(encodePayload({
      timestamp: 1_740_000_000_000,
      metrics: [
        {
          name: "uint32-high-bit",
          dataType: SparkplugDataType.UInt32,
          value: 0x8000_0000,
        },
        {
          name: "uint32-max",
          dataType: SparkplugDataType.UInt32,
          value: 0xffff_ffff,
        },
      ],
    }));

    expect(decoded.metrics.map((metric) => metric.value)).toEqual([
      0x8000_0000,
      0xffff_ffff,
    ]);
  });

  it.each([
    [SparkplugDataType.Int64, "9223372036854775808"],
    [SparkplugDataType.Int64, "-9223372036854775809"],
    [SparkplugDataType.UInt64, "18446744073709551616"],
    [SparkplugDataType.UInt64, -1],
    [SparkplugDataType.UInt32, -1],
    [SparkplugDataType.UInt32, 4_294_967_296],
    [SparkplugDataType.UInt64, "01"],
  ])("rejects out-of-range or non-canonical %s input %s", (dataType, value) => {
    expect(() => encodePayload({
      timestamp: 1_740_000_000_000,
      metrics: [{ name: "invalid", dataType, value }],
    })).toThrow();
  });
});
